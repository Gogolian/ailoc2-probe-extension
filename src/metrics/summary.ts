import * as fs from 'fs';
import * as path from 'path';

import {
    AI_SIGNAL_KEYS,
    FileRollingState,
    getAttributionBucketForSignal,
    HUMAN_SIGNAL_KEYS,
    METRICS_SCHEMA_VERSION,
    RepoCleanBaselineEntry,
    SaveAttributionCheckpoint,
    RepoSummaryState
} from './schema';
import {
    getMetricsFilesStateDirectory,
    getMetricsRoot,
    getMetricsSummaryFilePath,
    getRepoSummaryStatePath,
    getRollingStatePath
} from './pathing';
import { getIndexGitBlobOid } from './git';
import { getTrackingExclusionReasonForPath } from '../trackingExclusions';
import * as childProcess from 'child_process';
import * as util from 'util';

const execFile = util.promisify(childProcess.execFile);

type GitDiffStatEntry = {
    repoRelativePath: string;
    changedLines: number;
};

export type DiffSliceAttributionSummary = {
    changedFileCount: number;
    attributedChangedFileCount: number;
    aiWeightedChangedLines: number;
    humanWeightedChangedLines: number;
    aiPercentage: number;
    humanPercentage: number;
    usedFallbackAttribution: boolean;
};

export type RepoUncommittedAttributionSummary = {
    repoRoot: string;
    repoName: string;
    staged: DiffSliceAttributionSummary;
    unstaged: DiffSliceAttributionSummary;
    baselineRefreshed: boolean;
    isGitSummaryAvailable: boolean;
};

export type RepoHookSummaryFile = RepoUncommittedAttributionSummary & {
    schemaVersion: typeof METRICS_SCHEMA_VERSION;
    recordType: 'hook-summary';
    generatedAt: string;
    summaryLine: string;
    sources: {
        internalMetricsRoot: string;
        summaryFilePath: string;
    };
};

export async function computeRepoUncommittedAttributionSummary(args: {
    repoRoot: string;
}): Promise<RepoUncommittedAttributionSummary> {
    const stagedEntries = await getGitDiffStatEntries(args.repoRoot, ['diff', '--cached', '--numstat', '--find-renames']);
    const unstagedEntries = await getGitDiffStatEntries(args.repoRoot, ['diff', '--numstat', '--find-renames']);
    const isGitSummaryAvailable = stagedEntries !== null && unstagedEntries !== null;

    if (!isGitSummaryAvailable) {
        return createEmptyRepoSummary(args.repoRoot, false, false);
    }

    if (stagedEntries.length === 0 && unstagedEntries.length === 0) {
        await refreshCleanBaseline(args.repoRoot);
        return createEmptyRepoSummary(args.repoRoot, true, true);
    }

    const summaryState = await readRepoSummaryState(args.repoRoot);
    const { staged, unstaged } = await summarizeDiffSlices(
        args.repoRoot,
        stagedEntries,
        unstagedEntries,
        summaryState
    );

    return {
        repoRoot: args.repoRoot,
        repoName: path.basename(args.repoRoot),
        staged,
        unstaged,
        baselineRefreshed: false,
        isGitSummaryAvailable: true
    };
}

export function formatRepoUncommittedAttributionSummary(summary: RepoUncommittedAttributionSummary): string {
    if (!summary.isGitSummaryAvailable) {
        return `${summary.repoName}: summary unavailable`;
    }

    return `${summary.repoName}: STAGED -> AI ${summary.staged.aiPercentage.toFixed(2)}% | Human ${summary.staged.humanPercentage.toFixed(2)}% ; UNSTAGED -> AI ${summary.unstaged.aiPercentage.toFixed(2)}% | Human ${summary.unstaged.humanPercentage.toFixed(2)}%`;
}

export async function writeRepoHookSummaryFile(summary: RepoUncommittedAttributionSummary): Promise<string> {
    const summaryFilePath = getMetricsSummaryFilePath(summary.repoRoot);
    const hookSummaryFile: RepoHookSummaryFile = {
        ...summary,
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'hook-summary',
        generatedAt: new Date().toISOString(),
        summaryLine: formatRepoUncommittedAttributionSummary(summary),
        sources: {
            internalMetricsRoot: getMetricsRoot(summary.repoRoot),
            summaryFilePath
        }
    };

    await writeJsonFileAtomic(summaryFilePath, hookSummaryFile);
    return summaryFilePath;
}

function createEmptyRepoSummary(
    repoRoot: string,
    baselineRefreshed: boolean,
    isGitSummaryAvailable: boolean
): RepoUncommittedAttributionSummary {
    return {
        repoRoot,
        repoName: path.basename(repoRoot),
        staged: createEmptyDiffSliceSummary(),
        unstaged: createEmptyDiffSliceSummary(),
        baselineRefreshed,
        isGitSummaryAvailable
    };
}

function createEmptyDiffSliceSummary(): DiffSliceAttributionSummary {
    return {
        changedFileCount: 0,
        attributedChangedFileCount: 0,
        aiWeightedChangedLines: 0,
        humanWeightedChangedLines: 0,
        aiPercentage: 0,
        humanPercentage: 0,
        usedFallbackAttribution: false
    };
}

async function summarizeDiffSlices(
    repoRoot: string,
    stagedEntries: GitDiffStatEntry[],
    unstagedEntries: GitDiffStatEntry[],
    summaryState: RepoSummaryState
): Promise<{
    staged: DiffSliceAttributionSummary;
    unstaged: DiffSliceAttributionSummary;
}> {
    const stagedSummary = createEmptyDiffSliceSummary();
    stagedSummary.changedFileCount = stagedEntries.length;

    const unstagedSummary = createEmptyDiffSliceSummary();
    unstagedSummary.changedFileCount = unstagedEntries.length;

    const stagedEntriesByPath = new Map(stagedEntries.map((entry) => [entry.repoRelativePath, entry]));
    const unstagedEntriesByPath = new Map(unstagedEntries.map((entry) => [entry.repoRelativePath, entry]));
    const allRepoRelativePaths = Array.from(new Set([
        ...stagedEntriesByPath.keys(),
        ...unstagedEntriesByPath.keys()
    ]));

    for (const repoRelativePath of allRepoRelativePaths) {
        const rollingState = await readRollingState(repoRoot, repoRelativePath);
        if (!rollingState) {
            continue;
        }

        const currentAttribution = deriveCurrentFileAttribution(
            rollingState,
            summaryState.cleanBaselineByRepoRelativePath
        );

        const stagedCheckpointAttribution = stagedEntriesByPath.has(repoRelativePath)
            ? await deriveStagedCheckpointAttribution(
                repoRoot,
                rollingState,
                summaryState.cleanBaselineByRepoRelativePath
            )
            : null;

        const stagedEntry = stagedEntriesByPath.get(repoRelativePath);
        if (stagedEntry) {
            const stagedAttribution = stagedCheckpointAttribution ?? {
                ...currentAttribution,
                usedFallbackAttribution: true
            };
            applyDiffSliceContribution(stagedSummary, stagedEntry, stagedAttribution);
        }

        const unstagedEntry = unstagedEntriesByPath.get(repoRelativePath);
        if (unstagedEntry) {
            const unstagedAttribution = stagedCheckpointAttribution
                ? subtractAttribution(currentAttribution, stagedCheckpointAttribution)
                : {
                    ...currentAttribution,
                    usedFallbackAttribution: stagedEntriesByPath.has(repoRelativePath)
                        ? true
                        : currentAttribution.usedFallbackAttribution
                };
            applyDiffSliceContribution(unstagedSummary, unstagedEntry, unstagedAttribution);
        }
    }

    finalizeDiffSliceSummary(stagedSummary);
    finalizeDiffSliceSummary(unstagedSummary);

    return {
        staged: stagedSummary,
        unstaged: unstagedSummary
    };
}

function applyDiffSliceContribution(
    summary: DiffSliceAttributionSummary,
    diffEntry: GitDiffStatEntry,
    attribution: {
        aiMagnitude: number;
        humanMagnitude: number;
        usedFallbackAttribution: boolean;
    }
): void {
    const totalMagnitude = attribution.aiMagnitude + attribution.humanMagnitude;
    if (totalMagnitude <= 0) {
        return;
    }

    summary.attributedChangedFileCount += 1;
    summary.usedFallbackAttribution = summary.usedFallbackAttribution || attribution.usedFallbackAttribution;
    const aiRatio = attribution.aiMagnitude / totalMagnitude;
    const humanRatio = attribution.humanMagnitude / totalMagnitude;
    summary.aiWeightedChangedLines += diffEntry.changedLines * aiRatio;
    summary.humanWeightedChangedLines += diffEntry.changedLines * humanRatio;
}

function finalizeDiffSliceSummary(summary: DiffSliceAttributionSummary): void {
    const totalWeightedChangedLines = summary.aiWeightedChangedLines + summary.humanWeightedChangedLines;
    summary.aiPercentage = totalWeightedChangedLines > 0
        ? (summary.aiWeightedChangedLines / totalWeightedChangedLines) * 100
        : 0;
    summary.humanPercentage = totalWeightedChangedLines > 0
        ? (summary.humanWeightedChangedLines / totalWeightedChangedLines) * 100
        : 0;
}

function subtractAttribution(
    currentAttribution: {
        aiMagnitude: number;
        humanMagnitude: number;
        usedFallbackAttribution: boolean;
    },
    previousAttribution: {
        aiMagnitude: number;
        humanMagnitude: number;
        usedFallbackAttribution: boolean;
    }
): {
    aiMagnitude: number;
    humanMagnitude: number;
    usedFallbackAttribution: boolean;
} {
    return {
        aiMagnitude: Math.max(0, currentAttribution.aiMagnitude - previousAttribution.aiMagnitude),
        humanMagnitude: Math.max(0, currentAttribution.humanMagnitude - previousAttribution.humanMagnitude),
        usedFallbackAttribution: currentAttribution.usedFallbackAttribution || previousAttribution.usedFallbackAttribution
    };
}

function deriveCurrentFileAttribution(
    rollingState: FileRollingState,
    baselineByRepoRelativePath: Record<string, RepoCleanBaselineEntry>
): {
    aiMagnitude: number;
    humanMagnitude: number;
    usedFallbackAttribution: boolean;
} {
    const baseline = baselineByRepoRelativePath[rollingState.repoRelativePath] ?? {
        aiChangeMagnitude: 0,
        humanChangeMagnitude: 0
    };

    let aiMagnitude = Math.max(
        0,
        rollingState.cumulativeAiChangeMagnitude - baseline.aiChangeMagnitude
    );
    let humanMagnitude = Math.max(
        0,
        rollingState.cumulativeHumanChangeMagnitude - baseline.humanChangeMagnitude
    );

    let usedFallbackAttribution = false;
    if (aiMagnitude === 0 && humanMagnitude === 0) {
        const aiSignalCount = AI_SIGNAL_KEYS.reduce(
            (sum, signal) => sum + (rollingState.signalCounters[signal] ?? 0),
            0
        );
        const humanSignalCount = HUMAN_SIGNAL_KEYS.reduce(
            (sum, signal) => sum + (rollingState.signalCounters[signal] ?? 0),
            0
        );

        if (aiSignalCount > 0 || humanSignalCount > 0) {
            aiMagnitude = aiSignalCount;
            humanMagnitude = humanSignalCount;
            usedFallbackAttribution = true;
        }
        else {
            const attributionBucket = rollingState.latestSignal
                ? getAttributionBucketForSignal(rollingState.latestSignal)
                : null;
            if (attributionBucket === 'AI') {
                aiMagnitude = 1;
                usedFallbackAttribution = true;
            }
            else if (attributionBucket === 'Human') {
                humanMagnitude = 1;
                usedFallbackAttribution = true;
            }
        }
    }

    return {
        aiMagnitude,
        humanMagnitude,
        usedFallbackAttribution
    };
}

async function deriveStagedCheckpointAttribution(
    repoRoot: string,
    rollingState: FileRollingState,
    baselineByRepoRelativePath: Record<string, RepoCleanBaselineEntry>
): Promise<{
    aiMagnitude: number;
    humanMagnitude: number;
    usedFallbackAttribution: boolean;
} | null> {
    const indexGitBlobOid = await getIndexGitBlobOid(repoRoot, rollingState.repoRelativePath);
    if (!indexGitBlobOid) {
        return null;
    }

    const matchingCheckpoint = findMatchingCheckpointByGitBlobOid(
        rollingState.saveAttributionCheckpoints,
        indexGitBlobOid
    );
    if (!matchingCheckpoint) {
        return null;
    }

    const baseline = baselineByRepoRelativePath[rollingState.repoRelativePath] ?? {
        aiChangeMagnitude: 0,
        humanChangeMagnitude: 0
    };

    return {
        aiMagnitude: Math.max(0, matchingCheckpoint.cumulativeAiChangeMagnitude - baseline.aiChangeMagnitude),
        humanMagnitude: Math.max(0, matchingCheckpoint.cumulativeHumanChangeMagnitude - baseline.humanChangeMagnitude),
        usedFallbackAttribution: false
    };
}

function findMatchingCheckpointByGitBlobOid(
    checkpoints: SaveAttributionCheckpoint[],
    gitBlobOid: string
): SaveAttributionCheckpoint | null {
    for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
        const checkpoint = checkpoints[index];
        if (checkpoint.gitBlobOid === gitBlobOid) {
            return checkpoint;
        }
    }

    return null;
}

async function getGitDiffStatEntries(repoRoot: string, args: string[]): Promise<GitDiffStatEntry[] | null> {
    try {
        const { stdout } = await execFile(
            'git',
            ['-c', 'core.quotepath=false', ...args],
            {
                cwd: repoRoot,
                windowsHide: true,
                maxBuffer: 1024 * 1024
            }
        );

        const mergedEntries = new Map<string, number>();
        for (const line of stdout.split(/\r?\n/)) {
            const parsedEntry = parseGitDiffStatLine(line);
            if (!parsedEntry) {
                continue;
            }

            mergedEntries.set(
                parsedEntry.repoRelativePath,
                (mergedEntries.get(parsedEntry.repoRelativePath) ?? 0) + parsedEntry.changedLines
            );
        }

        return Array.from(mergedEntries.entries()).map(([repoRelativePath, changedLines]) => ({
            repoRelativePath,
            changedLines
        }));
    }
    catch {
        return null;
    }
}

function parseGitDiffStatLine(line: string): GitDiffStatEntry | null {
    if (!line.trim()) {
        return null;
    }

    const fields = line.split('\t');
    if (fields.length < 3) {
        return null;
    }

    const [addedField, deletedField, ...pathFields] = fields;
    if (addedField === '-' || deletedField === '-') {
        return null;
    }

    const addedLines = Number.parseInt(addedField, 10);
    const deletedLines = Number.parseInt(deletedField, 10);
    if (!Number.isFinite(addedLines) || !Number.isFinite(deletedLines)) {
        return null;
    }

    const rawPath = pathFields.join('\t').trim();
    const repoRelativePath = normalizeDiffPath(rawPath);
    if (!repoRelativePath) {
        return null;
    }

    return {
        repoRelativePath,
        changedLines: addedLines + deletedLines
    };
}

function normalizeDiffPath(rawPath: string): string | null {
    if (!rawPath) {
        return null;
    }

    let normalizedPath = rawPath.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2');
    if (normalizedPath.includes(' => ')) {
        normalizedPath = normalizedPath.split(' => ').at(-1) ?? normalizedPath;
    }

    normalizedPath = path.normalize(normalizedPath);
    if (getTrackingExclusionReasonForPath(normalizedPath) !== null) {
        return null;
    }

    return normalizedPath;
}

async function readRollingState(repoRoot: string, repoRelativePath: string): Promise<FileRollingState | null> {
    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    try {
        const fileContents = await fs.promises.readFile(rollingStatePath, 'utf8');
        return JSON.parse(fileContents) as FileRollingState;
    }
    catch {
        return null;
    }
}

async function readRepoSummaryState(repoRoot: string): Promise<RepoSummaryState> {
    const summaryStatePath = getRepoSummaryStatePath(repoRoot);
    try {
        const fileContents = await fs.promises.readFile(summaryStatePath, 'utf8');
        const parsed = JSON.parse(fileContents) as RepoSummaryState;
        return {
            schemaVersion: METRICS_SCHEMA_VERSION,
            recordType: 'repo-summary-state',
            repoRoot,
            lastComputedAt: parsed.lastComputedAt,
            lastCleanAt: parsed.lastCleanAt ?? null,
            cleanBaselineByRepoRelativePath: parsed.cleanBaselineByRepoRelativePath ?? {}
        };
    }
    catch {
        return {
            schemaVersion: METRICS_SCHEMA_VERSION,
            recordType: 'repo-summary-state',
            repoRoot,
            lastComputedAt: new Date().toISOString(),
            lastCleanAt: null,
            cleanBaselineByRepoRelativePath: {}
        };
    }
}

async function refreshCleanBaseline(repoRoot: string): Promise<void> {
    const baselineByRepoRelativePath: Record<string, RepoCleanBaselineEntry> = {};
    const rollingStatePaths = await collectRollingStatePaths(getMetricsFilesStateDirectory(repoRoot));

    for (const rollingStatePath of rollingStatePaths) {
        try {
            const fileContents = await fs.promises.readFile(rollingStatePath, 'utf8');
            const rollingState = JSON.parse(fileContents) as FileRollingState;
            baselineByRepoRelativePath[rollingState.repoRelativePath] = {
                aiChangeMagnitude: rollingState.cumulativeAiChangeMagnitude ?? 0,
                humanChangeMagnitude: rollingState.cumulativeHumanChangeMagnitude ?? 0
            };
        }
        catch {
            continue;
        }
    }

    const nowIso = new Date().toISOString();
    const summaryState: RepoSummaryState = {
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'repo-summary-state',
        repoRoot,
        lastComputedAt: nowIso,
        lastCleanAt: nowIso,
        cleanBaselineByRepoRelativePath: baselineByRepoRelativePath
    };

    await writeJsonFileAtomic(getRepoSummaryStatePath(repoRoot), summaryState);
}

async function collectRollingStatePaths(directoryPath: string): Promise<string[]> {
    try {
        const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
        const nestedPaths = await Promise.all(entries.map(async (entry) => {
            const entryPath = path.join(directoryPath, entry.name);
            if (entry.isDirectory()) {
                return collectRollingStatePaths(entryPath);
            }

            if (entry.isFile() && entry.name.endsWith('.metrics.json')) {
                return [entryPath];
            }

            return [] as string[];
        }));

        return nestedPaths.flat();
    }
    catch {
        return [];
    }
}

async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rm(filePath, { force: true });
    await fs.promises.rename(tempPath, filePath);
}