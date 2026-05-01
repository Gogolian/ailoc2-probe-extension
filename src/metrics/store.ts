import * as fs from 'fs';
import * as path from 'path';

import {
    FileLifecycleEvent,
    FileRollingState,
    getAttributionBucketForSignal,
    METRICS_SCHEMA_VERSION,
    MetricsRecord,
    RepoManifest,
    SaveCorrelationSummary,
    SessionBoundaryEvent,
    SIGNAL_COUNTER_KEYS,
    WorkspaceFileMetricEvent
} from './schema';
import { getGitBlobOidForWorkingTreeFile } from './git';
import {
    getDailyEventsFilePath,
    getMetricsEventsDirectory,
    getMetricsFilesStateDirectory,
    getMetricsManifestPath,
    getMetricsRoot,
    getRollingStatePath
} from './pathing';

const WRITE_DEBOUNCE_MS = 350;
const MAX_SAVE_ATTRIBUTION_CHECKPOINTS = 64;

type QueuedRecord = {
    record: MetricsRecord;
    rollingStatePath: string | null;
};

type RepoQueue = {
    pendingRecords: QueuedRecord[];
    flushTimer: NodeJS.Timeout | null;
    flushPromise: Promise<void>;
};

export type MetricsStoreLogger = (eventName: string, payload: unknown) => void;

export class RepoMetricsStore {
    private readonly repoQueues = new Map<string, RepoQueue>();

    public constructor(
        private readonly extensionSessionId: string,
        private readonly logEvent: MetricsStoreLogger
    ) {}

    public queueWorkspaceFileMetric(record: WorkspaceFileMetricEvent): void {
        const rollingStatePath = record.repoRelativePath
            ? getRollingStatePath(record.repoRoot, record.repoRelativePath)
            : null;
        this.enqueue(record.repoRoot, {
            record,
            rollingStatePath
        });
    }

    public queueFileLifecycleEvent(record: FileLifecycleEvent): void {
        const rollingStatePath = record.repoRelativePath
            ? getRollingStatePath(record.repoRoot, record.repoRelativePath)
            : null;
        this.enqueue(record.repoRoot, {
            record,
            rollingStatePath
        });
    }

    public queueSessionBoundaryEvent(record: SessionBoundaryEvent): void {
        this.enqueue(record.repoRoot, {
            record,
            rollingStatePath: null
        });
    }

    public async hasTrackedFile(repoRoot: string, repoRelativePath: string): Promise<boolean> {
        const hasPendingRecord = this.getOrCreateRepoQueue(repoRoot).pendingRecords.some(
            (entry) => entry.record.repoRelativePath === repoRelativePath
        );
        if (hasPendingRecord) {
            return true;
        }

        return this.pathExists(getRollingStatePath(repoRoot, repoRelativePath));
    }

    public noteDocumentSaved(args: {
        repoRoot: string;
        repoRelativePath: string;
        savedAt: string;
        hash: string;
        lineCount: number;
        charLength: number;
        documentVersion: number;
        saveCorrelation: SaveCorrelationSummary;
    }): void {
        const repoQueue = this.getOrCreateRepoQueue(args.repoRoot);
        repoQueue.flushPromise = repoQueue.flushPromise
            .then(async () => {
                await this.ensureRepoLayout(args.repoRoot);
                const rollingStatePath = getRollingStatePath(args.repoRoot, args.repoRelativePath);
                if (!(await this.pathExists(rollingStatePath))) {
                    return;
                }

                const gitBlobOid = await getGitBlobOidForWorkingTreeFile(args.repoRoot, args.repoRelativePath);
                const rollingState = await this.readRollingState(rollingStatePath, args.repoRoot, args.repoRelativePath);
                rollingState.lastRecordedAt = args.savedAt;
                rollingState.lastSavedAt = args.savedAt;
                rollingState.lastSavedHash = args.hash;
                rollingState.lastSavedLineCount = args.lineCount;
                rollingState.lastSavedCharLength = args.charLength;
                rollingState.lastDocumentVersion = args.documentVersion;
                rollingState.lastSavedWillSaveReason = args.saveCorrelation.reason ?? null;
                const lastCheckpoint = rollingState.saveAttributionCheckpoints.at(-1);
                const nextCheckpoint = {
                    savedAt: args.savedAt,
                    documentHash: args.hash,
                    gitBlobOid,
                    documentVersion: args.documentVersion,
                    cumulativeAiChangeMagnitude: rollingState.cumulativeAiChangeMagnitude,
                    cumulativeHumanChangeMagnitude: rollingState.cumulativeHumanChangeMagnitude
                };

                if (lastCheckpoint
                    && lastCheckpoint.documentHash === nextCheckpoint.documentHash
                    && lastCheckpoint.gitBlobOid === nextCheckpoint.gitBlobOid
                    && lastCheckpoint.cumulativeAiChangeMagnitude === nextCheckpoint.cumulativeAiChangeMagnitude
                    && lastCheckpoint.cumulativeHumanChangeMagnitude === nextCheckpoint.cumulativeHumanChangeMagnitude) {
                    lastCheckpoint.savedAt = nextCheckpoint.savedAt;
                    lastCheckpoint.documentVersion = nextCheckpoint.documentVersion;
                }
                else {
                    rollingState.saveAttributionCheckpoints = [
                        ...rollingState.saveAttributionCheckpoints,
                        nextCheckpoint
                    ].slice(-MAX_SAVE_ATTRIBUTION_CHECKPOINTS);
                }

                await this.writeJsonFileAtomic(rollingStatePath, rollingState);
                await this.writeManifest(args.repoRoot, {
                    lastWriteAt: args.savedAt,
                    pendingQueueLength: this.getPendingQueueLength(args.repoRoot)
                });
                this.logEvent('METRICS_STORE_SAVED_STATE_UPDATED', {
                    repoRoot: args.repoRoot,
                    repoRelativePath: args.repoRelativePath,
                    rollingStatePath,
                    savedAt: args.savedAt,
                    hash: args.hash,
                    gitBlobOid,
                    lineCount: args.lineCount,
                    charLength: args.charLength,
                    documentVersion: args.documentVersion,
                    saveCorrelation: args.saveCorrelation
                });
            })
            .catch((error) => {
                this.logEvent('METRICS_STORE_SAVE_UPDATE_FAILED', {
                    repoRoot: args.repoRoot,
                    repoRelativePath: args.repoRelativePath,
                    error: error instanceof Error ? error.message : String(error)
                });
            });
    }

    public moveRollingState(args: {
        fromRepoRoot: string;
        fromRepoRelativePath: string;
        toRepoRoot: string;
        toRepoRelativePath: string;
        recordedAt: string;
    }): void {
        const sourceQueue = this.getOrCreateRepoQueue(args.fromRepoRoot);
        sourceQueue.flushPromise = sourceQueue.flushPromise
            .then(async () => {
                await this.ensureRepoLayout(args.fromRepoRoot);
                await this.ensureRepoLayout(args.toRepoRoot);
                const sourcePath = getRollingStatePath(args.fromRepoRoot, args.fromRepoRelativePath);
                if (!(await this.pathExists(sourcePath))) {
                    return;
                }

                const targetPath = getRollingStatePath(args.toRepoRoot, args.toRepoRelativePath);
                const state = await this.readRollingState(sourcePath, args.fromRepoRoot, args.fromRepoRelativePath);
                state.repoRoot = args.toRepoRoot;
                state.repoRelativePath = args.toRepoRelativePath;
                state.lastRecordedAt = args.recordedAt;
                state.deletedAt = null;

                await this.writeJsonFileAtomic(targetPath, state);
                await fs.promises.rm(sourcePath, { force: true });
                await this.removeEmptyParentDirectories(path.dirname(sourcePath), getMetricsFilesStateDirectory(args.fromRepoRoot));
                this.logEvent('METRICS_STORE_ROLLING_STATE_MOVED', {
                    fromRepoRoot: args.fromRepoRoot,
                    fromRepoRelativePath: args.fromRepoRelativePath,
                    toRepoRoot: args.toRepoRoot,
                    toRepoRelativePath: args.toRepoRelativePath,
                    sourcePath,
                    targetPath,
                    recordedAt: args.recordedAt
                });
            })
            .catch((error) => {
                this.logEvent('METRICS_STORE_MOVE_STATE_FAILED', {
                    fromRepoRoot: args.fromRepoRoot,
                    fromRepoRelativePath: args.fromRepoRelativePath,
                    toRepoRoot: args.toRepoRoot,
                    toRepoRelativePath: args.toRepoRelativePath,
                    error: error instanceof Error ? error.message : String(error)
                });
            });
    }

    public markDeleted(args: {
        repoRoot: string;
        repoRelativePath: string;
        recordedAt: string;
    }): void {
        const repoQueue = this.getOrCreateRepoQueue(args.repoRoot);
        repoQueue.flushPromise = repoQueue.flushPromise
            .then(async () => {
                await this.ensureRepoLayout(args.repoRoot);
                const rollingStatePath = getRollingStatePath(args.repoRoot, args.repoRelativePath);
                if (!(await this.pathExists(rollingStatePath))) {
                    return;
                }

                const rollingState = await this.readRollingState(rollingStatePath, args.repoRoot, args.repoRelativePath);
                rollingState.lastRecordedAt = args.recordedAt;
                rollingState.deletedAt = args.recordedAt;
                await this.writeJsonFileAtomic(rollingStatePath, rollingState);
                this.logEvent('METRICS_STORE_ROLLING_STATE_MARKED_DELETED', {
                    repoRoot: args.repoRoot,
                    repoRelativePath: args.repoRelativePath,
                    rollingStatePath,
                    recordedAt: args.recordedAt
                });
            })
            .catch((error) => {
                this.logEvent('METRICS_STORE_MARK_DELETE_FAILED', {
                    repoRoot: args.repoRoot,
                    repoRelativePath: args.repoRelativePath,
                    error: error instanceof Error ? error.message : String(error)
                });
            });
    }

    public flushRepo(repoRoot: string): Promise<void> {
        const repoQueue = this.getOrCreateRepoQueue(repoRoot);
        if (repoQueue.flushTimer) {
            clearTimeout(repoQueue.flushTimer);
            repoQueue.flushTimer = null;
        }

        repoQueue.flushPromise = repoQueue.flushPromise
            .then(() => this.flushPendingRecords(repoRoot))
            .catch((error) => {
                this.logEvent('METRICS_STORE_FLUSH_FAILED', {
                    repoRoot,
                    error: error instanceof Error ? error.message : String(error)
                });
            });

        return repoQueue.flushPromise;
    }

    public async flushAll(): Promise<void> {
        await Promise.all(
            Array.from(this.repoQueues.keys()).map((repoRoot) => this.flushRepo(repoRoot))
        );
    }

    private enqueue(repoRoot: string, queuedRecord: QueuedRecord): void {
        const repoQueue = this.getOrCreateRepoQueue(repoRoot);
        repoQueue.pendingRecords.push(queuedRecord);
        this.scheduleFlush(repoRoot);
    }

    private scheduleFlush(repoRoot: string): void {
        const repoQueue = this.getOrCreateRepoQueue(repoRoot);
        if (repoQueue.flushTimer) {
            clearTimeout(repoQueue.flushTimer);
        }

        repoQueue.flushTimer = setTimeout(() => {
            repoQueue.flushTimer = null;
            void this.flushRepo(repoRoot);
        }, WRITE_DEBOUNCE_MS);
    }

    private async flushPendingRecords(repoRoot: string): Promise<void> {
        const repoQueue = this.getOrCreateRepoQueue(repoRoot);
        if (repoQueue.pendingRecords.length === 0) {
            return;
        }

        const recordsToFlush = repoQueue.pendingRecords.splice(0, repoQueue.pendingRecords.length);
        const latestRecord = recordsToFlush[recordsToFlush.length - 1]?.record;
        if (!latestRecord) {
            return;
        }

        await this.ensureRepoLayout(repoRoot);

        const eventGroups = new Map<string, MetricsRecord[]>();
        for (const entry of recordsToFlush) {
            const eventsPath = getDailyEventsFilePath(repoRoot, entry.record.recordedAt);
            const existingGroup = eventGroups.get(eventsPath) ?? [];
            existingGroup.push(entry.record);
            eventGroups.set(eventsPath, existingGroup);
        }

        for (const [eventsPath, records] of eventGroups) {
            const lines = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
            await fs.promises.appendFile(eventsPath, lines, 'utf8');
        }

        for (const entry of recordsToFlush) {
            await this.applyRecordToRollingState(entry);
        }

        await this.writeManifest(repoRoot, {
            lastWriteAt: latestRecord.recordedAt,
            lastEventAt: latestRecord.recordedAt,
            lastEventId: latestRecord.eventId,
            pendingQueueLength: repoQueue.pendingRecords.length
        });

        this.logEvent('METRICS_STORE_FLUSHED', {
            repoRoot,
            flushedRecordCount: recordsToFlush.length,
            flushedRecordTypes: Array.from(new Set(recordsToFlush.map((entry) => entry.record.recordType))),
            eventsFiles: Array.from(eventGroups.keys()),
            affectedRepoRelativePaths: Array.from(new Set(
                recordsToFlush
                    .map((entry) => entry.record.repoRelativePath)
                    .filter((repoRelativePath): repoRelativePath is string => repoRelativePath !== null)
            )),
            lastEventId: latestRecord.eventId,
            lastRecordedAt: latestRecord.recordedAt
        });
    }

    private async applyRecordToRollingState(entry: QueuedRecord): Promise<void> {
        if (!entry.rollingStatePath || !entry.record.repoRelativePath) {
            return;
        }

        if (entry.record.recordType === 'workspace-file-metric') {
            const rollingState = await this.readRollingState(
                entry.rollingStatePath,
                entry.record.repoRoot,
                entry.record.repoRelativePath
            );
            this.applyWorkspaceMetricToRollingState(rollingState, entry.record);
            await this.writeJsonFileAtomic(entry.rollingStatePath, rollingState);
            return;
        }

        if (entry.record.recordType === 'file-lifecycle') {
            const rollingState = await this.readRollingState(
                entry.rollingStatePath,
                entry.record.repoRoot,
                entry.record.repoRelativePath
            );
            this.applyLifecycleEventToRollingState(rollingState, entry.record);
            await this.writeJsonFileAtomic(entry.rollingStatePath, rollingState);
        }
    }

    private applyWorkspaceMetricToRollingState(
        rollingState: FileRollingState,
        record: WorkspaceFileMetricEvent
    ): void {
        if (rollingState.eventCount === 0) {
            rollingState.firstRecordedAt = record.recordedAt;
        }

        rollingState.lastRecordedAt = record.recordedAt;
        rollingState.eventCount += 1;
        rollingState.logicalPath = record.logicalPath;
        rollingState.latestSignal = record.signal;
        rollingState.latestReplacementRatio = record.replacementRatio;
        rollingState.latestRequestIds = record.requestIds;
        rollingState.latestSnapshotRequestIds = record.snapshotRequestIds;
        rollingState.lastChatScheme = record.lastChatScheme;
        rollingState.lastDocumentVersion = record.documentVersion;
        rollingState.deletedAt = null;

        if (SIGNAL_COUNTER_KEYS.includes(record.signal as typeof SIGNAL_COUNTER_KEYS[number])) {
            rollingState.signalCounters[record.signal] = (rollingState.signalCounters[record.signal] ?? 0) + 1;
        }

        const attributionBucket = getAttributionBucketForSignal(record.signal);
        const changeMagnitude = record.totalInsertedTextLength + record.totalRemovedTextLength;
        if (attributionBucket === 'AI') {
            rollingState.cumulativeAiChangeMagnitude += changeMagnitude;
        }
        else if (attributionBucket === 'Human') {
            rollingState.cumulativeHumanChangeMagnitude += changeMagnitude;
        }
    }

    private applyLifecycleEventToRollingState(
        rollingState: FileRollingState,
        record: FileLifecycleEvent
    ): void {
        if (rollingState.eventCount === 0) {
            rollingState.firstRecordedAt = record.recordedAt;
        }

        rollingState.lastRecordedAt = record.recordedAt;
        rollingState.eventCount += 1;
        rollingState.logicalPath = record.logicalPath;

        if (record.action === 'deleted') {
            rollingState.deletedAt = record.recordedAt;
            return;
        }

        if (record.action === 'renamed' || record.action === 'created-from-rename') {
            rollingState.deletedAt = null;
            rollingState.renameHistory.push({
                recordedAt: record.recordedAt,
                fromRepoRoot: record.previousRepoRoot,
                fromRepoRelativePath: record.previousRepoRelativePath,
                toRepoRoot: record.nextRepoRoot,
                toRepoRelativePath: record.nextRepoRelativePath
            });
        }
    }

    private async readRollingState(
        rollingStatePath: string,
        repoRoot: string,
        repoRelativePath: string
    ): Promise<FileRollingState> {
        if (await this.pathExists(rollingStatePath)) {
            try {
                const existing = JSON.parse(await fs.promises.readFile(rollingStatePath, 'utf8')) as FileRollingState;
                return {
                    ...this.createEmptyRollingState(repoRoot, repoRelativePath),
                    ...existing,
                    signalCounters: {
                        ...this.createSignalCounters(),
                        ...existing.signalCounters
                    },
                    renameHistory: existing.renameHistory ?? [],
                    latestRequestIds: existing.latestRequestIds ?? [],
                    latestSnapshotRequestIds: existing.latestSnapshotRequestIds ?? [],
                    saveAttributionCheckpoints: existing.saveAttributionCheckpoints ?? []
                };
            }
            catch {
                this.logEvent('METRICS_STORE_ROLLING_STATE_PARSE_FAILED', {
                    rollingStatePath
                });
            }
        }

        return this.createEmptyRollingState(repoRoot, repoRelativePath);
    }

    private createEmptyRollingState(repoRoot: string, repoRelativePath: string): FileRollingState {
        const nowIso = new Date().toISOString();
        return {
            schemaVersion: METRICS_SCHEMA_VERSION,
            recordType: 'file-rolling-state',
            repoRoot,
            repoRelativePath,
            logicalPath: null,
            firstRecordedAt: nowIso,
            lastRecordedAt: nowIso,
            eventCount: 0,
            latestSignal: null,
            latestReplacementRatio: null,
            latestRequestIds: [],
            latestSnapshotRequestIds: [],
            lastChatScheme: null,
            signalCounters: this.createSignalCounters(),
            cumulativeAiChangeMagnitude: 0,
            cumulativeHumanChangeMagnitude: 0,
            lastDocumentVersion: null,
            lastSavedAt: null,
            lastSavedHash: null,
            lastSavedLineCount: null,
            lastSavedCharLength: null,
            lastSavedWillSaveReason: null,
            saveAttributionCheckpoints: [],
            deletedAt: null,
            renameHistory: []
        };
    }

    private createSignalCounters(): Record<string, number> {
        return Object.fromEntries(SIGNAL_COUNTER_KEYS.map((signal) => [signal, 0]));
    }

    private async ensureRepoLayout(repoRoot: string): Promise<void> {
        await fs.promises.mkdir(getMetricsRoot(repoRoot), { recursive: true });
        await fs.promises.mkdir(getMetricsEventsDirectory(repoRoot), { recursive: true });
        await fs.promises.mkdir(getMetricsFilesStateDirectory(repoRoot), { recursive: true });

        const manifestPath = getMetricsManifestPath(repoRoot);
        if (!(await this.pathExists(manifestPath))) {
            const manifest: RepoManifest = {
                schemaVersion: METRICS_SCHEMA_VERSION,
                extensionSessionId: this.extensionSessionId,
                repoRoot,
                createdAt: new Date().toISOString(),
                lastWriteAt: null,
                lastEventAt: null,
                lastEventId: null,
                pendingQueueLength: this.getPendingQueueLength(repoRoot)
            };
            await this.writeJsonFileAtomic(manifestPath, manifest);
            this.logEvent('METRICS_STORE_LAYOUT_INITIALIZED', {
                repoRoot,
                metricsRoot: getMetricsRoot(repoRoot),
                eventsDirectory: getMetricsEventsDirectory(repoRoot),
                filesStateDirectory: getMetricsFilesStateDirectory(repoRoot),
                manifestPath
            });
        }
    }

    private async writeManifest(
        repoRoot: string,
        patch: Partial<Pick<RepoManifest, 'lastWriteAt' | 'lastEventAt' | 'lastEventId' | 'pendingQueueLength'>>
    ): Promise<void> {
        const manifestPath = getMetricsManifestPath(repoRoot);
        const manifest = await this.readManifest(repoRoot);
        const nextManifest: RepoManifest = {
            ...manifest,
            lastWriteAt: patch.lastWriteAt ?? manifest.lastWriteAt,
            lastEventAt: patch.lastEventAt ?? manifest.lastEventAt,
            lastEventId: patch.lastEventId ?? manifest.lastEventId,
            pendingQueueLength: patch.pendingQueueLength ?? manifest.pendingQueueLength,
            extensionSessionId: this.extensionSessionId
        };
        await this.writeJsonFileAtomic(manifestPath, nextManifest);
    }

    private async readManifest(repoRoot: string): Promise<RepoManifest> {
        const manifestPath = getMetricsManifestPath(repoRoot);
        if (await this.pathExists(manifestPath)) {
            try {
                return JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as RepoManifest;
            }
            catch {
                this.logEvent('METRICS_STORE_MANIFEST_PARSE_FAILED', {
                    repoRoot,
                    manifestPath
                });
            }
        }

        return {
            schemaVersion: METRICS_SCHEMA_VERSION,
            extensionSessionId: this.extensionSessionId,
            repoRoot,
            createdAt: new Date().toISOString(),
            lastWriteAt: null,
            lastEventAt: null,
            lastEventId: null,
            pendingQueueLength: this.getPendingQueueLength(repoRoot)
        };
    }

    private async writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
        await fs.promises.rm(filePath, { force: true });
        await fs.promises.rename(tempPath, filePath);
    }

    private async removeEmptyParentDirectories(directoryPath: string, stopAt: string): Promise<void> {
        let currentPath = directoryPath;
        while (path.normalize(currentPath).toLowerCase() !== path.normalize(stopAt).toLowerCase()) {
            try {
                await fs.promises.rmdir(currentPath);
            }
            catch {
                break;
            }

            const parentPath = path.dirname(currentPath);
            if (parentPath === currentPath) {
                break;
            }

            currentPath = parentPath;
        }
    }

    private async pathExists(candidatePath: string): Promise<boolean> {
        try {
            await fs.promises.access(candidatePath);
            return true;
        }
        catch {
            return false;
        }
    }

    private getOrCreateRepoQueue(repoRoot: string): RepoQueue {
        const existing = this.repoQueues.get(repoRoot);
        if (existing) {
            return existing;
        }

        const created: RepoQueue = {
            pendingRecords: [],
            flushTimer: null,
            flushPromise: Promise.resolve()
        };
        this.repoQueues.set(repoRoot, created);
        return created;
    }

    private getPendingQueueLength(repoRoot: string): number {
        return this.repoQueues.get(repoRoot)?.pendingRecords.length ?? 0;
    }
}