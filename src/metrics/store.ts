import * as fs from 'fs';
import * as path from 'path';

import {
    FileLifecycleEvent,
    FileRollingState,
    getAttributionBucketForSignal,
    LineAttribution,
    LineAttributionSpan,
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
    sequence: number;
};

type RepoQueue = {
    pendingRecords: QueuedRecord[];
    pendingSaveUpdates: PendingSaveUpdate[];
    flushTimer: NodeJS.Timeout | null;
    flushPromise: Promise<void>;
};

type RollingStateRecord = WorkspaceFileMetricEvent | FileLifecycleEvent;

type PendingSaveUpdate = {
    repoRoot: string;
    repoRelativePath: string;
    savedAt: string;
    hash: string;
    lineCount: number;
    charLength: number;
    documentVersion: number;
    saveCorrelation: SaveCorrelationSummary;
    sequence: number;
};

type RollingStateOperation = {
    kind: 'record';
    record: RollingStateRecord;
    sequence: number;
} | {
    kind: 'save-update';
    update: PendingSaveUpdate;
    sequence: number;
};

type RollingStateBatch = {
    rollingStatePath: string;
    repoRoot: string;
    repoRelativePath: string;
    operations: RollingStateOperation[];
};

export type MetricsStoreLogger = (eventName: string, payload: unknown) => void;

export class RepoMetricsStore {
    private readonly repoQueues = new Map<string, RepoQueue>();
    private readonly manifestCache = new Map<string, RepoManifest>();
    private nextPendingOperationSequence = 0;

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
            rollingStatePath,
            sequence: this.getNextPendingOperationSequence()
        });
    }

    public queueFileLifecycleEvent(record: FileLifecycleEvent): void {
        const rollingStatePath = record.repoRelativePath
            ? getRollingStatePath(record.repoRoot, record.repoRelativePath)
            : null;
        this.enqueue(record.repoRoot, {
            record,
            rollingStatePath,
            sequence: this.getNextPendingOperationSequence()
        });
    }

    public queueSessionBoundaryEvent(record: SessionBoundaryEvent): void {
        this.enqueue(record.repoRoot, {
            record,
            rollingStatePath: null,
            sequence: this.getNextPendingOperationSequence()
        });
    }

    public async hasTrackedFile(repoRoot: string, repoRelativePath: string): Promise<boolean> {
        const repoQueue = this.getOrCreateRepoQueue(repoRoot);
        const hasPendingRecord = repoQueue.pendingRecords.some((entry) => entry.record.repoRelativePath === repoRelativePath);
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
        repoQueue.pendingSaveUpdates.push({
            ...args,
            sequence: this.getNextPendingOperationSequence()
        });
        this.scheduleFlush(args.repoRoot);
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
        if (repoQueue.pendingRecords.length === 0 && repoQueue.pendingSaveUpdates.length === 0) {
            return;
        }

        const recordsToFlush = repoQueue.pendingRecords.splice(0, repoQueue.pendingRecords.length);
        const saveUpdatesToFlush = repoQueue.pendingSaveUpdates.splice(0, repoQueue.pendingSaveUpdates.length);
        const latestRecord = recordsToFlush[recordsToFlush.length - 1]?.record;
        const latestSaveUpdate = saveUpdatesToFlush.at(-1) ?? null;

        await this.ensureRepoLayout(repoRoot);

        const rollingStateBatches = this.collectRollingStateBatches(recordsToFlush, saveUpdatesToFlush);
        const appliedSaveUpdateLogs: Array<Record<string, unknown>> = [];
        let actualRollingStateWriteCount = 0;
        let skippedSaveOnlyBatchCount = 0;
        for (const batch of rollingStateBatches.values()) {
            const hadExistingRollingState = await this.pathExists(batch.rollingStatePath);
            if (!hadExistingRollingState && batch.operations.every((operation) => operation.kind === 'save-update')) {
                skippedSaveOnlyBatchCount += 1;
                continue;
            }

            const rollingState = await this.readRollingState(
                batch.rollingStatePath,
                batch.repoRoot,
                batch.repoRelativePath
            );

            for (const operation of batch.operations) {
                if (operation.kind === 'record') {
                    this.applyRecordToRollingState(rollingState, operation.record);
                    continue;
                }

                const appliedSaveUpdate = await this.applySaveUpdateToRollingState(rollingState, operation.update, batch.rollingStatePath);
                if (appliedSaveUpdate) {
                    appliedSaveUpdateLogs.push(appliedSaveUpdate);
                }
            }

            await this.writeJsonFileAtomic(batch.rollingStatePath, rollingState);
            actualRollingStateWriteCount += 1;
        }

        await this.writeManifest(repoRoot, {
            lastWriteAt: latestSaveUpdate?.savedAt ?? latestRecord?.recordedAt ?? null,
            lastEventAt: latestRecord?.recordedAt,
            lastEventId: latestRecord?.eventId,
            pendingQueueLength: this.getPendingQueueLength(repoRoot)
        });

        this.logEvent('METRICS_STORE_FLUSHED', {
            repoRoot,
            flushedRecordCount: recordsToFlush.length,
            flushedSaveUpdateCount: saveUpdatesToFlush.length,
            flushedRecordTypes: Array.from(new Set(recordsToFlush.map((entry) => entry.record.recordType))),
            coalescedRollingStateWriteCount: actualRollingStateWriteCount,
            skippedSaveOnlyBatchCount,
            affectedRepoRelativePaths: Array.from(new Set(
                [
                    ...recordsToFlush
                        .map((entry) => entry.record.repoRelativePath)
                        .filter((repoRelativePath): repoRelativePath is string => repoRelativePath !== null),
                    ...saveUpdatesToFlush.map((entry) => entry.repoRelativePath)
                ]
            )),
            appliedSaveUpdates: appliedSaveUpdateLogs,
            lastEventId: latestRecord?.eventId ?? null,
            lastRecordedAt: latestSaveUpdate?.savedAt ?? latestRecord?.recordedAt ?? null
        });
    }

    private collectRollingStateBatches(
        records: QueuedRecord[],
        saveUpdates: PendingSaveUpdate[]
    ): Map<string, RollingStateBatch> {
        const batches = new Map<string, RollingStateBatch>();

        for (const entry of records) {
            if (!entry.rollingStatePath || !entry.record.repoRelativePath) {
                continue;
            }

            if (entry.record.recordType !== 'workspace-file-metric' && entry.record.recordType !== 'file-lifecycle') {
                continue;
            }

            const existingBatch = batches.get(entry.rollingStatePath) ?? {
                rollingStatePath: entry.rollingStatePath,
                repoRoot: entry.record.repoRoot,
                repoRelativePath: entry.record.repoRelativePath,
                operations: []
            };

            existingBatch.operations.push({
                kind: 'record',
                record: entry.record,
                sequence: entry.sequence
            });
            batches.set(entry.rollingStatePath, existingBatch);
        }

        for (const update of saveUpdates) {
            const rollingStatePath = getRollingStatePath(update.repoRoot, update.repoRelativePath);
            const existingBatch = batches.get(rollingStatePath) ?? {
                rollingStatePath,
                repoRoot: update.repoRoot,
                repoRelativePath: update.repoRelativePath,
                operations: []
            };

            existingBatch.operations.push({
                kind: 'save-update',
                update,
                sequence: update.sequence
            });
            batches.set(rollingStatePath, existingBatch);
        }

        for (const batch of batches.values()) {
            batch.operations.sort((left, right) => left.sequence - right.sequence);
        }

        return batches;
    }

    private applyRecordToRollingState(rollingState: FileRollingState, record: RollingStateRecord): void {
        if (record.recordType === 'workspace-file-metric') {
            this.applyWorkspaceMetricToRollingState(rollingState, record);
            return;
        }

        this.applyLifecycleEventToRollingState(rollingState, record);
    }

    private async applySaveUpdateToRollingState(
        rollingState: FileRollingState,
        update: PendingSaveUpdate,
        rollingStatePath: string
    ): Promise<Record<string, unknown> | null> {
        const gitBlobOid = await getGitBlobOidForWorkingTreeFile(update.repoRoot, update.repoRelativePath);
        rollingState.lastRecordedAt = update.savedAt;
        const lastCheckpoint = rollingState.saveAttributionCheckpoints.at(-1);
        const nextCheckpoint = {
            gitBlobOid,
            cumulativeAiChangeMagnitude: rollingState.cumulativeAiChangeMagnitude,
            cumulativeHumanChangeMagnitude: rollingState.cumulativeHumanChangeMagnitude,
            lineAttributionSpans: this.cloneLineAttributionSpans(rollingState.lineAttributionSpans)
        };

        const shouldSkipDuplicateCheckpoint = Boolean(
            gitBlobOid
            && lastCheckpoint
            && lastCheckpoint.gitBlobOid === gitBlobOid
            && lastCheckpoint.cumulativeAiChangeMagnitude === nextCheckpoint.cumulativeAiChangeMagnitude
            && lastCheckpoint.cumulativeHumanChangeMagnitude === nextCheckpoint.cumulativeHumanChangeMagnitude
            && this.areLineAttributionSpansEqual(lastCheckpoint.lineAttributionSpans, nextCheckpoint.lineAttributionSpans)
        );

        if (!shouldSkipDuplicateCheckpoint) {
            rollingState.saveAttributionCheckpoints = [
                ...rollingState.saveAttributionCheckpoints,
                nextCheckpoint
            ].slice(-MAX_SAVE_ATTRIBUTION_CHECKPOINTS);
        }

        return {
            repoRoot: update.repoRoot,
            repoRelativePath: update.repoRelativePath,
            rollingStatePath,
            savedAt: update.savedAt,
            hash: update.hash,
            gitBlobOid,
            lineCount: update.lineCount,
            charLength: update.charLength,
            documentVersion: update.documentVersion,
            saveCorrelation: update.saveCorrelation,
            skippedDuplicateCheckpoint: shouldSkipDuplicateCheckpoint
        };
    }

    private applyWorkspaceMetricToRollingState(
        rollingState: FileRollingState,
        record: WorkspaceFileMetricEvent
    ): void {
        rollingState.lastRecordedAt = record.recordedAt;
        rollingState.latestSignal = record.signal;
        rollingState.deletedAt = null;
        this.applyLineDiffSegmentsToRollingState(
            rollingState,
            record.lineDiffSegments,
            getAttributionBucketForSignal(record.signal) ?? 'Unknown'
        );

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
        rollingState.lastRecordedAt = record.recordedAt;

        if (record.action === 'deleted') {
            rollingState.deletedAt = record.recordedAt;
            rollingState.lineAttributionSpans = [];
            return;
        }

        if (record.action === 'renamed' || record.action === 'created-from-rename') {
            rollingState.deletedAt = null;
        }
    }

    private async readRollingState(
        rollingStatePath: string,
        repoRoot: string,
        repoRelativePath: string
    ): Promise<FileRollingState> {
        if (await this.pathExists(rollingStatePath)) {
            try {
                const existing = JSON.parse(await fs.promises.readFile(rollingStatePath, 'utf8')) as Partial<FileRollingState>;
                const emptyState = this.createEmptyRollingState(repoRoot, repoRelativePath);
                return {
                    ...emptyState,
                    repoRoot: existing.repoRoot ?? repoRoot,
                    repoRelativePath: existing.repoRelativePath ?? repoRelativePath,
                    lastRecordedAt: existing.lastRecordedAt ?? emptyState.lastRecordedAt,
                    latestSignal: existing.latestSignal ?? emptyState.latestSignal,
                    signalCounters: {
                        ...emptyState.signalCounters,
                        ...(existing.signalCounters ?? {})
                    },
                    cumulativeAiChangeMagnitude: existing.cumulativeAiChangeMagnitude ?? emptyState.cumulativeAiChangeMagnitude,
                    cumulativeHumanChangeMagnitude: existing.cumulativeHumanChangeMagnitude ?? emptyState.cumulativeHumanChangeMagnitude,
                    saveAttributionCheckpoints: (existing.saveAttributionCheckpoints ?? []).map((checkpoint) =>
                        this.normalizeSaveAttributionCheckpoint(checkpoint)
                    ),
                    lineAttributionSpans: this.normalizeLineAttributionSpans(existing.lineAttributionSpans ?? []),
                    deletedAt: existing.deletedAt ?? emptyState.deletedAt
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
            lastRecordedAt: nowIso,
            latestSignal: null,
            signalCounters: this.createSignalCounters(),
            cumulativeAiChangeMagnitude: 0,
            cumulativeHumanChangeMagnitude: 0,
            saveAttributionCheckpoints: [],
            lineAttributionSpans: [],
            deletedAt: null
        };
    }

    private createSignalCounters(): Record<string, number> {
        return Object.fromEntries(SIGNAL_COUNTER_KEYS.map((signal) => [signal, 0]));
    }

    private normalizeSaveAttributionCheckpoint(checkpoint: Partial<{
        gitBlobOid: string | null;
        cumulativeAiChangeMagnitude: number;
        cumulativeHumanChangeMagnitude: number;
        lineAttributionSpans: LineAttributionSpan[];
    }>): FileRollingState['saveAttributionCheckpoints'][number] {
        return {
            gitBlobOid: typeof checkpoint.gitBlobOid === 'string' ? checkpoint.gitBlobOid : null,
            cumulativeAiChangeMagnitude: typeof checkpoint.cumulativeAiChangeMagnitude === 'number'
                ? checkpoint.cumulativeAiChangeMagnitude
                : 0,
            cumulativeHumanChangeMagnitude: typeof checkpoint.cumulativeHumanChangeMagnitude === 'number'
                ? checkpoint.cumulativeHumanChangeMagnitude
                : 0,
            lineAttributionSpans: this.normalizeLineAttributionSpans(checkpoint.lineAttributionSpans ?? [])
        };
    }

    private normalizeLineAttributionSpans(spans: Partial<LineAttributionSpan>[]): LineAttributionSpan[] {
        const normalized: LineAttributionSpan[] = [];

        for (const span of spans) {
            const lineCount = typeof span.lineCount === 'number' && span.lineCount > 0
                ? Math.floor(span.lineCount)
                : 0;
            if (lineCount <= 0) {
                continue;
            }

            const attribution = span.attribution === 'AI' || span.attribution === 'Human' || span.attribution === 'Unknown'
                ? span.attribution
                : 'Unknown';

            const previous = normalized.at(-1);
            if (previous?.attribution === attribution) {
                previous.lineCount += lineCount;
                continue;
            }

            normalized.push({
                attribution,
                lineCount
            });
        }

        return normalized;
    }

    private applyLineDiffSegmentsToRollingState(
        rollingState: FileRollingState,
        diffSegments: WorkspaceFileMetricEvent['lineDiffSegments'],
        attribution: LineAttribution
    ): void {
        const sourceLineCount = diffSegments.reduce((sum, segment) => (
            segment.type === 'added' ? sum : sum + segment.lineCount
        ), 0);
        const currentLineAttribution = this.materializeLineAttribution(
            rollingState.lineAttributionSpans,
            sourceLineCount
        );
        const nextLineAttribution: LineAttribution[] = [];
        let sourceIndex = 0;

        for (const segment of diffSegments) {
            if (segment.type === 'equal') {
                nextLineAttribution.push(...currentLineAttribution.slice(sourceIndex, sourceIndex + segment.lineCount));
                sourceIndex += segment.lineCount;
                continue;
            }

            if (segment.type === 'removed') {
                sourceIndex += segment.lineCount;
                continue;
            }

            for (let index = 0; index < segment.lineCount; index += 1) {
                nextLineAttribution.push(attribution);
            }
        }

        if (sourceIndex < currentLineAttribution.length) {
            nextLineAttribution.push(...currentLineAttribution.slice(sourceIndex));
        }

        rollingState.lineAttributionSpans = this.compressLineAttribution(nextLineAttribution);
    }

    private materializeLineAttribution(spans: LineAttributionSpan[], expectedLineCount: number): LineAttribution[] {
        const lineAttribution: LineAttribution[] = [];

        for (const span of spans) {
            for (let index = 0; index < span.lineCount; index += 1) {
                lineAttribution.push(span.attribution);
            }
        }

        if (expectedLineCount <= 0) {
            return lineAttribution;
        }

        if (lineAttribution.length < expectedLineCount) {
            lineAttribution.push(...Array.from({ length: expectedLineCount - lineAttribution.length }, () => 'Unknown' as const));
        }

        if (lineAttribution.length > expectedLineCount) {
            return lineAttribution.slice(0, expectedLineCount);
        }

        return lineAttribution;
    }

    private compressLineAttribution(lineAttribution: LineAttribution[]): LineAttributionSpan[] {
        const spans: LineAttributionSpan[] = [];

        for (const attribution of lineAttribution) {
            const previous = spans.at(-1);
            if (previous?.attribution === attribution) {
                previous.lineCount += 1;
                continue;
            }

            spans.push({
                attribution,
                lineCount: 1
            });
        }

        return spans;
    }

    private cloneLineAttributionSpans(spans: LineAttributionSpan[]): LineAttributionSpan[] {
        return spans.map((span) => ({ ...span }));
    }

    private areLineAttributionSpansEqual(
        left: LineAttributionSpan[] | undefined,
        right: LineAttributionSpan[] | undefined
    ): boolean {
        if (!left && !right) {
            return true;
        }

        if (!left || !right || left.length !== right.length) {
            return false;
        }

        return left.every((span, index) => (
            span.attribution === right[index].attribution
            && span.lineCount === right[index].lineCount
        ));
    }

    private async ensureRepoLayout(repoRoot: string): Promise<void> {
        await fs.promises.mkdir(getMetricsRoot(repoRoot), { recursive: true });
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
            this.manifestCache.set(repoRoot, manifest);
            this.logEvent('METRICS_STORE_LAYOUT_INITIALIZED', {
                repoRoot,
                metricsRoot: getMetricsRoot(repoRoot),
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

        if (this.areManifestsEqual(manifest, nextManifest)) {
            return;
        }

        await this.writeJsonFileAtomic(manifestPath, nextManifest);
        this.manifestCache.set(repoRoot, nextManifest);
    }

    private async readManifest(repoRoot: string): Promise<RepoManifest> {
        const cachedManifest = this.manifestCache.get(repoRoot);
        if (cachedManifest) {
            return cachedManifest;
        }

        const manifestPath = getMetricsManifestPath(repoRoot);
        if (await this.pathExists(manifestPath)) {
            try {
                const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as RepoManifest;
                this.manifestCache.set(repoRoot, manifest);
                return manifest;
            }
            catch {
                this.logEvent('METRICS_STORE_MANIFEST_PARSE_FAILED', {
                    repoRoot,
                    manifestPath
                });
            }
        }

        const fallbackManifest: RepoManifest = {
            schemaVersion: METRICS_SCHEMA_VERSION,
            extensionSessionId: this.extensionSessionId,
            repoRoot,
            createdAt: new Date().toISOString(),
            lastWriteAt: null,
            lastEventAt: null,
            lastEventId: null,
            pendingQueueLength: this.getPendingQueueLength(repoRoot)
        };
        this.manifestCache.set(repoRoot, fallbackManifest);
        return fallbackManifest;
    }

    private areManifestsEqual(left: RepoManifest, right: RepoManifest): boolean {
        return left.schemaVersion === right.schemaVersion
            && left.extensionSessionId === right.extensionSessionId
            && left.repoRoot === right.repoRoot
            && left.createdAt === right.createdAt
            && left.lastWriteAt === right.lastWriteAt
            && left.lastEventAt === right.lastEventAt
            && left.lastEventId === right.lastEventId
            && left.pendingQueueLength === right.pendingQueueLength;
    }

    private async writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(data), 'utf8');
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
            pendingSaveUpdates: [],
            flushTimer: null,
            flushPromise: Promise.resolve()
        };
        this.repoQueues.set(repoRoot, created);
        return created;
    }

    private getNextPendingOperationSequence(): number {
        this.nextPendingOperationSequence += 1;
        return this.nextPendingOperationSequence;
    }

    private getPendingQueueLength(repoRoot: string): number {
        const queue = this.repoQueues.get(repoRoot);
        return (queue?.pendingRecords.length ?? 0) + (queue?.pendingSaveUpdates.length ?? 0);
    }
}