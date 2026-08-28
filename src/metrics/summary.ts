import * as fs from 'fs';
import * as path from 'path';

import {
    AI_SIGNAL_KEYS,
    FileRollingState,
    getAttributionBucketForSignal,
    HUMAN_SIGNAL_KEYS,
    LineAttributionSpan,
    METRICS_SCHEMA_VERSION,
    RepoCleanBaselineEntry,
    SaveAttributionCheckpoint,
    RepoSummaryState
} from './schema';
import {
    getMetricsFilesStateDirectory,
    getMetricsRoot,
    getPreparedCommitBaselinePath,
    getMetricsSummaryFilePath,
    getRepoSummaryStatePath,
    getRollingStatePath
} from './pathing';
import { getIndexGitBlobOid, getIndexGitBlobOids, getWorkingTreeGitBlobOids } from './git';
import { isRepoRelativePathTrackingIgnored } from './ignore';
import { ResolvedProbeConfig, readProbeConfig } from './probeConfig';
import { collectMarkerDiffPaths, parseMarkerDiffAttribution } from './markerAttribution';
import { MarkerStripResult, stripMarkersFromStagedFiles } from './markerStripping';
import { getTrackingExclusionReasonForPath } from '../trackingExclusions';
import { toGitRepoPath, tryRunGitCommand } from '../util/gitCommand';
import { pathExists, readTextFileIfExists } from '../util/fsUtils';
import { ProfileDetails, profileOperation } from '../util/profiling';

const NEW_FILE_AI_DOMINANCE_RATIO = 2;
const HISTORICAL_BULK_HUMAN_CHECKPOINT_MINIMUM_MAGNITUDE = 400;

type GitDiffStatEntry = {
    repoRelativePath: string;
    changedLines: number;
    addedLineCount: number;
    currentLineRanges: DiffLineRange[];
    isNewFile: boolean;
};

type DiffLineRange = {
    startLine: number;
    lineCount: number;
};

type RepoDiffInputs = {
    stagedEntries: GitDiffStatEntry[] | null;
    unstagedTrackedEntries: GitDiffStatEntry[] | null;
    unstagedUntrackedEntries: GitDiffStatEntry[] | null;
    stagedDiffText: string | null;
    unstagedDiffText: string | null;
};

type ChangedLineAttributionSummary = {
    repoRelativePath: string;
    aiWeight: number;
    humanWeight: number;
    unknownWeight: number;
    aiAddedLineCount: number;
    humanAddedLineCount: number;
    unknownAddedLineCount: number;
};

type CommitBaselineBuildResult = {
    summaryState: RepoSummaryState;
    resolvedFileCount: number;
    deletedFileCount: number;
    preservedFileCount: number;
    unresolvedRepoRelativePaths: string[];
};

type CommitBaselineResolution = {
    kind: 'resolved' | 'deleted';
    entry: RepoCleanBaselineEntry;
} | {
    kind: 'preserve-existing' | 'unresolved';
};

export type DiffSliceAttributionSummary = {
    changedFileCount: number;
    attributedChangedFileCount: number;
    aiWeightedChangedLines: number;
    humanWeightedChangedLines: number;
    aiAddedLineCount: number;
    humanAddedLineCount: number;
    unknownAddedLineCount: number;
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

export type RepoHookSummaryRefreshResult = {
    summary: RepoUncommittedAttributionSummary;
    summaryLine: string;
    summaryFilePath: string;
};

export type RepoCommitBaselinePreparationResult = {
    repoRoot: string;
    preparedBaselinePath: string;
    repoSummaryStatePath: string;
    resolvedFileCount: number;
    deletedFileCount: number;
    preservedFileCount: number;
    unresolvedRepoRelativePaths: string[];
};

export type RepoCommitFinalizationResult = RepoHookSummaryRefreshResult & {
    baselineSource: 'prepared' | 'current-index';
    preparedBaselinePath: string;
    repoSummaryStatePath: string;
    clearedRollingStateFileCount: number;
    preservedUnstagedFileCount: number;
};

export type RepoPreCommitPreparationResult = {
    baseline: RepoCommitBaselinePreparationResult;
    summary: RepoHookSummaryRefreshResult;
    markerStrip: MarkerStripResult | null;
};

async function stripMarkersForPreCommit(
    repoRoot: string,
    diffInputs: RepoDiffInputs
): Promise<MarkerStripResult | null> {
    const probeConfig = await readProbeConfig(repoRoot);
    if (probeConfig.attribution.mode !== 'markers' || !diffInputs.stagedDiffText) {
        return null;
    }

    const markerPaths = collectMarkerDiffPaths(diffInputs.stagedDiffText)
        .filter((repoRelativePath) => !probeConfig.isAttributionExcluded(repoRelativePath));
    if (markerPaths.length === 0) {
        return null;
    }

    return stripMarkersFromStagedFiles({ repoRoot, repoRelativePaths: markerPaths });
}

export async function computeRepoUncommittedAttributionSummary(args: {
    repoRoot: string;
}): Promise<RepoUncommittedAttributionSummary> {
    const diffInputs = await collectRepoDiffInputs(args.repoRoot);
    return computeRepoUncommittedAttributionSummaryFromInputs(args.repoRoot, diffInputs);
}

async function collectRepoDiffInputs(repoRoot: string): Promise<RepoDiffInputs> {
    const [stagedDiffText, unstagedDiffText, unstagedUntrackedEntries] = await Promise.all([
        getGitDiffStdout(repoRoot, ['diff', '--cached', '--unified=0', '--find-renames', '--no-color', '--ignore-all-space']),
        getGitDiffStdout(repoRoot, ['diff', '--unified=0', '--find-renames', '--no-color', '--ignore-all-space']),
        getGitUntrackedEntries(repoRoot)
    ]);

    const [stagedEntries, unstagedTrackedEntries] = await Promise.all([
        parseGitDiffStdout(repoRoot, stagedDiffText),
        parseGitDiffStdout(repoRoot, unstagedDiffText)
    ]);

    return {
        stagedEntries,
        unstagedTrackedEntries,
        unstagedUntrackedEntries,
        stagedDiffText,
        unstagedDiffText
    };
}

async function computeRepoUncommittedAttributionSummaryFromInputs(
    repoRoot: string,
    diffInputs: RepoDiffInputs
): Promise<RepoUncommittedAttributionSummary> {
    const { stagedEntries, unstagedTrackedEntries, unstagedUntrackedEntries } = diffInputs;
    const unstagedEntries = unstagedTrackedEntries !== null && unstagedUntrackedEntries !== null
        ? mergeGitDiffEntries(unstagedTrackedEntries, unstagedUntrackedEntries)
        : null;
    const isGitSummaryAvailable = stagedEntries !== null && unstagedEntries !== null;

    if (!isGitSummaryAvailable) {
        return createEmptyRepoSummary(repoRoot, false, false);
    }

    if (stagedEntries.length === 0 && unstagedEntries.length === 0) {
        await refreshCleanBaseline(repoRoot);
        return createEmptyRepoSummary(repoRoot, true, true);
    }

    const probeConfig = await readProbeConfig(repoRoot);
    if (probeConfig.attribution.mode === 'markers') {
        return {
            repoRoot,
            repoName: path.basename(repoRoot),
            staged: summarizeMarkerDiffSlice(diffInputs.stagedDiffText, probeConfig),
            unstaged: summarizeMarkerDiffSlice(diffInputs.unstagedDiffText, probeConfig),
            baselineRefreshed: false,
            isGitSummaryAvailable: true
        };
    }

    const summaryState = await readRepoSummaryState(repoRoot);
    const { staged, unstaged } = await summarizeDiffSlices(
        repoRoot,
        stagedEntries,
        unstagedEntries,
        summaryState
    );

    return {
        repoRoot,
        repoName: path.basename(repoRoot),
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

    return `${summary.repoName}: STAGED -> AI ${summary.staged.aiPercentage.toFixed(2)}% | Human ${summary.staged.humanPercentage.toFixed(2)}% | AI lines ${summary.staged.aiAddedLineCount} | Human lines ${summary.staged.humanAddedLineCount} | Unknown lines ${summary.staged.unknownAddedLineCount} ; UNSTAGED -> AI ${summary.unstaged.aiPercentage.toFixed(2)}% | Human ${summary.unstaged.humanPercentage.toFixed(2)}% | AI lines ${summary.unstaged.aiAddedLineCount} | Human lines ${summary.unstaged.humanAddedLineCount} | Unknown lines ${summary.unstaged.unknownAddedLineCount}`;
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

export async function refreshRepoHookSummary(args: {
    repoRoot: string;
}): Promise<RepoHookSummaryRefreshResult> {
    const profileDetails: ProfileDetails = {};
    return profileOperation(args.repoRoot, 'summary.refresh', profileDetails, async () => {
        const summary = await computeRepoUncommittedAttributionSummary(args);
        profileDetails.stagedFileCount = summary.staged.changedFileCount;
        profileDetails.unstagedFileCount = summary.unstaged.changedFileCount;
        const summaryLine = formatRepoUncommittedAttributionSummary(summary);
        const summaryFilePath = await writeRepoHookSummaryFile(summary);

        return {
            summary,
            summaryLine,
            summaryFilePath
        };
    });
}

async function refreshRepoHookSummaryFromInputs(
    repoRoot: string,
    diffInputs: RepoDiffInputs
): Promise<RepoHookSummaryRefreshResult> {
    const profileDetails: ProfileDetails = {};
    return profileOperation(repoRoot, 'summary.refresh', profileDetails, async () => {
        const summary = await computeRepoUncommittedAttributionSummaryFromInputs(repoRoot, diffInputs);
        profileDetails.stagedFileCount = summary.staged.changedFileCount;
        profileDetails.unstagedFileCount = summary.unstaged.changedFileCount;
        const summaryLine = formatRepoUncommittedAttributionSummary(summary);
        const summaryFilePath = await writeRepoHookSummaryFile(summary);
        return { summary, summaryLine, summaryFilePath };
    });
}

export async function prepareRepoCommitBaseline(args: {
    repoRoot: string;
}): Promise<RepoCommitBaselinePreparationResult> {
    const profileDetails: ProfileDetails = {};
    return profileOperation(args.repoRoot, 'baseline.prepare', profileDetails, async () => {
        const stagedRepoRelativePaths = await getStagedRepoRelativePaths(args.repoRoot);
        return prepareRepoCommitBaselineForPaths(args.repoRoot, stagedRepoRelativePaths, profileDetails);
    });
}

async function prepareRepoCommitBaselineForPaths(
    repoRoot: string,
    stagedRepoRelativePaths: readonly string[],
    profileDetails: ProfileDetails
): Promise<RepoCommitBaselinePreparationResult> {
    const preparedBaselinePath = getPreparedCommitBaselinePath(repoRoot);
    const repoSummaryStatePath = getRepoSummaryStatePath(repoRoot);
    profileDetails.stagedFileCount = stagedRepoRelativePaths.length;
    const buildResult = await buildRepoCommitBaselineState(repoRoot, stagedRepoRelativePaths);
    await writeJsonFileAtomic(preparedBaselinePath, buildResult.summaryState);
    profileDetails.resolvedFileCount = buildResult.resolvedFileCount;
    profileDetails.unresolvedFileCount = buildResult.unresolvedRepoRelativePaths.length;
    return {
        repoRoot,
        preparedBaselinePath,
        repoSummaryStatePath,
        resolvedFileCount: buildResult.resolvedFileCount,
        deletedFileCount: buildResult.deletedFileCount,
        preservedFileCount: buildResult.preservedFileCount,
        unresolvedRepoRelativePaths: buildResult.unresolvedRepoRelativePaths
    };
}

export async function prepareRepoPreCommit(args: {
    repoRoot: string;
}): Promise<RepoPreCommitPreparationResult> {
    return profileOperation(args.repoRoot, 'preCommit.prepare', {}, async () => {
        const diffInputs = await collectRepoDiffInputs(args.repoRoot);
        const stagedRepoRelativePaths = diffInputs.stagedEntries?.map((entry) => entry.repoRelativePath) ?? [];
        const baselineProfileDetails: ProfileDetails = {};
        const baseline = await profileOperation(args.repoRoot, 'baseline.prepare', baselineProfileDetails, () => (
            prepareRepoCommitBaselineForPaths(args.repoRoot, stagedRepoRelativePaths, baselineProfileDetails)
        ));
        const summary = await refreshRepoHookSummaryFromInputs(args.repoRoot, diffInputs);
        // Strip only after the summary is written, so the recorded attribution always
        // describes the content that is about to be committed.
        const markerStrip = await stripMarkersForPreCommit(args.repoRoot, diffInputs);
        return { baseline, summary, markerStrip };
    });
}

export async function finalizeRepoCommit(args: {
    repoRoot: string;
}): Promise<RepoCommitFinalizationResult> {
    const preparedBaselinePath = getPreparedCommitBaselinePath(args.repoRoot);
    const repoSummaryStatePath = getRepoSummaryStatePath(args.repoRoot);
    let baselineSource: 'prepared' | 'current-index' = 'prepared';
    let summaryStateToPromote = await readRepoSummaryStateFile(preparedBaselinePath, args.repoRoot);

    if (!summaryStateToPromote) {
        baselineSource = 'current-index';
        summaryStateToPromote = (await buildRepoCommitBaselineState(args.repoRoot)).summaryState;
    }

    const cleanupResult = await clearCommittedRollingState({
        repoRoot: args.repoRoot,
        summaryState: summaryStateToPromote
    });

    await writeJsonFileAtomic(repoSummaryStatePath, summaryStateToPromote);
    await removeFileIfExists(preparedBaselinePath);

    const refreshedSummary = await refreshRepoHookSummary(args);
    return {
        ...refreshedSummary,
        baselineSource,
        preparedBaselinePath,
        repoSummaryStatePath,
        clearedRollingStateFileCount: cleanupResult.clearedRollingStateFileCount,
        preservedUnstagedFileCount: cleanupResult.preservedUnstagedFileCount
    };
}

export async function readRepoHookSummaryFile(repoRoot: string): Promise<RepoHookSummaryFile | null> {
    const summaryFilePath = getMetricsSummaryFilePath(repoRoot);

    try {
        const fileContents = await fs.promises.readFile(summaryFilePath, 'utf8');
        return JSON.parse(fileContents) as RepoHookSummaryFile;
    }
    catch {
        return null;
    }
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

/**
 * Marker mode is an exclusive replacement: rolling state, chat correlation and Claude
 * provenance are all ignored, so nothing lands in Unknown.
 */
function summarizeMarkerDiffSlice(
    diffText: string | null,
    probeConfig: ResolvedProbeConfig
): DiffSliceAttributionSummary {
    const summary = createEmptyDiffSliceSummary();
    if (!diffText) {
        return summary;
    }

    const fileAttributions = parseMarkerDiffAttribution(diffText)
        .filter((attribution) => !probeConfig.isAttributionExcluded(attribution.repoRelativePath));

    for (const attribution of fileAttributions) {
        summary.changedFileCount += 1;
        if (attribution.aiAddedLineCount + attribution.humanAddedLineCount === 0) {
            continue;
        }

        summary.attributedChangedFileCount += 1;
        summary.aiAddedLineCount += attribution.aiAddedLineCount;
        summary.humanAddedLineCount += attribution.humanAddedLineCount;
        summary.aiWeightedChangedLines += attribution.aiWeight;
        summary.humanWeightedChangedLines += attribution.humanWeight;
    }

    finalizeDiffSliceSummary(summary);
    return summary;
}

function createEmptyDiffSliceSummary(): DiffSliceAttributionSummary {
    return {
        changedFileCount: 0,
        attributedChangedFileCount: 0,
        aiWeightedChangedLines: 0,
        humanWeightedChangedLines: 0,
        aiAddedLineCount: 0,
        humanAddedLineCount: 0,
        unknownAddedLineCount: 0,
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
    // Must run before changedFileCount is set and before the missing-rolling-state branch
    // below, which would otherwise charge an excluded file as entirely AI.
    const probeConfig = await readProbeConfig(repoRoot);
    const attributedStagedEntries = stagedEntries.filter(
        (entry) => !probeConfig.isAttributionExcluded(entry.repoRelativePath)
    );
    const attributedUnstagedEntries = unstagedEntries.filter(
        (entry) => !probeConfig.isAttributionExcluded(entry.repoRelativePath)
    );

    const stagedSummary = createEmptyDiffSliceSummary();
    stagedSummary.changedFileCount = attributedStagedEntries.length;

    const unstagedSummary = createEmptyDiffSliceSummary();
    unstagedSummary.changedFileCount = attributedUnstagedEntries.length;

    const stagedEntriesByPath = new Map(attributedStagedEntries.map((entry) => [entry.repoRelativePath, entry]));
    const unstagedEntriesByPath = new Map(attributedUnstagedEntries.map((entry) => [entry.repoRelativePath, entry]));
    const stagedLineWeightsByPath = new Map<string, number[] | null>();
    const workingTreeLineWeightsByPath = new Map<string, number[] | null>();
    const allRepoRelativePaths = Array.from(new Set([
        ...stagedEntriesByPath.keys(),
        ...unstagedEntriesByPath.keys()
    ]));

    for (const repoRelativePath of allRepoRelativePaths) {
        const rollingState = await readRollingState(repoRoot, repoRelativePath);
        if (!rollingState) {
            applyUnresolvedAddedLinesAsAi(stagedSummary, stagedEntriesByPath.get(repoRelativePath));
            applyUnresolvedAddedLinesAsAi(unstagedSummary, unstagedEntriesByPath.get(repoRelativePath));
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
            if (stagedEntry.isNewFile) {
                const stagedAttribution = deriveNewFileAttributionForSummary(rollingState, stagedCheckpointAttribution ?? {
                    ...currentAttribution,
                    usedFallbackAttribution: true
                });
                applyDiffSliceContribution(stagedSummary, stagedEntry, stagedAttribution);
            }
            else {
                const stagedLineWeights = await getCachedIndexLineWeights(
                    stagedLineWeightsByPath,
                    repoRoot,
                    repoRelativePath
                );
                const stagedChangedLineAttribution = stagedCheckpointAttribution?.lineAttributionSpans.length
                    && stagedLineWeights
                    ? deriveChangedLineAttributionFromSpans(
                        stagedCheckpointAttribution.lineAttributionSpans,
                        stagedEntry.currentLineRanges,
                        repoRelativePath,
                        stagedLineWeights
                    )
                    : !unstagedEntriesByPath.has(repoRelativePath)
                    && stagedLineWeights
                    ? deriveChangedLineAttributionFromSpans(
                        rollingState.lineAttributionSpans,
                        stagedEntry.currentLineRanges,
                        repoRelativePath,
                        stagedLineWeights
                    )
                    : null;

                if (stagedChangedLineAttribution && applyChangedLineAttributionSummary(stagedSummary, stagedChangedLineAttribution)) {
                    stagedSummary.usedFallbackAttribution = stagedSummary.usedFallbackAttribution || stagedChangedLineAttribution.unknownWeight > 0;
                }
                else {
                    const stagedAttribution = stagedCheckpointAttribution ?? {
                        ...currentAttribution,
                        usedFallbackAttribution: true
                    };
                    applyDiffSliceContribution(stagedSummary, stagedEntry, stagedAttribution);
                }
            }
        }

        const unstagedEntry = unstagedEntriesByPath.get(repoRelativePath);
        if (unstagedEntry) {
            if (unstagedEntry.isNewFile) {
                applyDiffSliceContribution(
                    unstagedSummary,
                    unstagedEntry,
                    deriveNewFileAttributionForSummary(rollingState, currentAttribution)
                );
                continue;
            }

            const workingTreeLineWeights = await getCachedWorkingTreeLineWeights(
                workingTreeLineWeightsByPath,
                repoRoot,
                repoRelativePath
            );
            const unstagedChangedLineAttribution = workingTreeLineWeights
                ? deriveChangedLineAttributionFromSpans(
                    rollingState.lineAttributionSpans,
                    unstagedEntry.currentLineRanges,
                    repoRelativePath,
                    workingTreeLineWeights
                )
                : null;

            if (unstagedChangedLineAttribution && applyChangedLineAttributionSummary(unstagedSummary, unstagedChangedLineAttribution)) {
                unstagedSummary.usedFallbackAttribution = unstagedSummary.usedFallbackAttribution || unstagedChangedLineAttribution.unknownWeight > 0;
            }
            else {
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
        unknownMagnitude: number;
        usedFallbackAttribution: boolean;
    }
): void {
    const unknownMagnitude = attribution.unknownMagnitude ?? 0;
    const totalMagnitude = attribution.aiMagnitude + attribution.humanMagnitude + unknownMagnitude;
    if (totalMagnitude <= 0) {
        applyUnresolvedAddedLinesAsAi(summary, diffEntry);
        return;
    }

    summary.attributedChangedFileCount += 1;
    summary.usedFallbackAttribution = summary.usedFallbackAttribution || attribution.usedFallbackAttribution;
    const allocatedLineCounts = allocateAddedLineCounts(
        diffEntry.addedLineCount,
        attribution.aiMagnitude,
        attribution.humanMagnitude,
        unknownMagnitude
    );
    const useAllocatedLineRatios = allocatedLineCounts.assignedUnresolvedToAi && diffEntry.addedLineCount > 0;
    const aiRatio = useAllocatedLineRatios
        ? allocatedLineCounts.ai / diffEntry.addedLineCount
        : (attribution.aiMagnitude + unknownMagnitude) / totalMagnitude;
    const humanRatio = useAllocatedLineRatios
        ? allocatedLineCounts.human / diffEntry.addedLineCount
        : attribution.humanMagnitude / totalMagnitude;
    summary.aiWeightedChangedLines += diffEntry.changedLines * aiRatio;
    summary.humanWeightedChangedLines += diffEntry.changedLines * humanRatio;
    summary.aiAddedLineCount += allocatedLineCounts.ai;
    summary.humanAddedLineCount += allocatedLineCounts.human;
    summary.unknownAddedLineCount += allocatedLineCounts.unknown;
}

function applyChangedLineAttributionSummary(
    summary: DiffSliceAttributionSummary,
    attribution: ChangedLineAttributionSummary
): boolean {
    const totalAttributedWeight = attribution.aiWeight + attribution.humanWeight + attribution.unknownWeight;
    if (totalAttributedWeight <= 0) {
        return false;
    }

    summary.attributedChangedFileCount += 1;
    summary.aiWeightedChangedLines += attribution.aiWeight + attribution.unknownWeight;
    summary.humanWeightedChangedLines += attribution.humanWeight;
    summary.aiAddedLineCount += attribution.aiAddedLineCount + attribution.unknownAddedLineCount;
    summary.humanAddedLineCount += attribution.humanAddedLineCount;
    summary.unknownAddedLineCount += attribution.unknownAddedLineCount;
    return true;
}

function applyUnresolvedAddedLinesAsAi(
    summary: DiffSliceAttributionSummary,
    diffEntry: GitDiffStatEntry | undefined
): void {
    if (!diffEntry || diffEntry.addedLineCount <= 0) {
        return;
    }

    summary.attributedChangedFileCount += 1;
    summary.aiWeightedChangedLines += diffEntry.changedLines;
    summary.aiAddedLineCount += diffEntry.addedLineCount;
    summary.unknownAddedLineCount += diffEntry.addedLineCount;
    summary.usedFallbackAttribution = true;
}

function allocateAddedLineCounts(
    addedLineCount: number,
    aiMagnitude: number,
    humanMagnitude: number,
    unknownMagnitude: number = 0
): { ai: number; human: number; unknown: number; assignedUnresolvedToAi: boolean; } {
    const normalizedAddedLineCount = Math.max(0, Math.trunc(addedLineCount));
    const normalizedAiMagnitude = Math.max(0, aiMagnitude);
    const normalizedHumanMagnitude = Math.max(0, humanMagnitude);
    const normalizedUnknownMagnitude = Math.max(0, unknownMagnitude ?? 0);
    const totalMagnitude = normalizedAiMagnitude + normalizedHumanMagnitude + normalizedUnknownMagnitude;
    if (normalizedAddedLineCount === 0 || totalMagnitude <= 0) {
        return {
            ai: normalizedAddedLineCount,
            human: 0,
            unknown: normalizedAddedLineCount,
            assignedUnresolvedToAi: normalizedAddedLineCount > 0
        };
    }

    const aiQuota = (normalizedAddedLineCount * normalizedAiMagnitude) / totalMagnitude;
    const humanQuota = (normalizedAddedLineCount * normalizedHumanMagnitude) / totalMagnitude;
    const unknownQuota = (normalizedAddedLineCount * normalizedUnknownMagnitude) / totalMagnitude;
    let ai = Math.floor(aiQuota);
    let human = Math.floor(humanQuota);
    let unknown = Math.floor(unknownQuota);
    let unresolved = normalizedAddedLineCount - ai - human - unknown;
    let assignedUnresolvedToAi = false;

    if (unresolved === 1) {
        const aiRemainder = aiQuota - ai;
        const humanRemainder = humanQuota - human;
        const unknownRemainder = unknownQuota - unknown;
        if (aiRemainder > humanRemainder && aiRemainder > unknownRemainder) {
            ai += 1;
            unresolved = 0;
        }
        else if (humanRemainder > aiRemainder && humanRemainder > unknownRemainder) {
            human += 1;
            unresolved = 0;
        }
        else if (unknownRemainder > aiRemainder && unknownRemainder > humanRemainder) {
            unknown += 1;
            unresolved = 0;
        }
    }

    assignedUnresolvedToAi = unresolved > 0;
    unknown += unresolved;
    ai += unknown;

    return { ai, human, unknown, assignedUnresolvedToAi };
}

function finalizeDiffSliceSummary(summary: DiffSliceAttributionSummary): void {
    const totalAddedLineCount = summary.aiAddedLineCount
        + summary.humanAddedLineCount;
    summary.aiPercentage = totalAddedLineCount > 0
        ? (summary.aiAddedLineCount / totalAddedLineCount) * 100
        : 0;
    summary.humanPercentage = totalAddedLineCount > 0
        ? (summary.humanAddedLineCount / totalAddedLineCount) * 100
        : 0;
}

function subtractAttribution(
    currentAttribution: {
        aiMagnitude: number;
        humanMagnitude: number;
        unknownMagnitude: number;
        usedFallbackAttribution: boolean;
    },
    previousAttribution: {
        aiMagnitude: number;
        humanMagnitude: number;
        unknownMagnitude: number;
        usedFallbackAttribution: boolean;
    }
): {
    aiMagnitude: number;
    humanMagnitude: number;
    unknownMagnitude: number;
    usedFallbackAttribution: boolean;
} {
    return {
        aiMagnitude: Math.max(0, currentAttribution.aiMagnitude - previousAttribution.aiMagnitude),
        humanMagnitude: Math.max(0, currentAttribution.humanMagnitude - previousAttribution.humanMagnitude),
        unknownMagnitude: Math.max(0, (currentAttribution.unknownMagnitude ?? 0) - (previousAttribution.unknownMagnitude ?? 0)),
        usedFallbackAttribution: currentAttribution.usedFallbackAttribution || previousAttribution.usedFallbackAttribution
    };
}

function deriveCurrentFileAttribution(
    rollingState: FileRollingState,
    baselineByRepoRelativePath: Record<string, RepoCleanBaselineEntry>
): {
    aiMagnitude: number;
    humanMagnitude: number;
    unknownMagnitude: number;
    usedFallbackAttribution: boolean;
} {
    const baseline = baselineByRepoRelativePath[rollingState.repoRelativePath] ?? {
        aiChangeMagnitude: 0,
        humanChangeMagnitude: 0
        , unknownChangeMagnitude: 0
    };

    let aiMagnitude = Math.max(
        0,
        rollingState.cumulativeAiChangeMagnitude - baseline.aiChangeMagnitude
    );
    let humanMagnitude = Math.max(
        0,
        rollingState.cumulativeHumanChangeMagnitude - baseline.humanChangeMagnitude
    );
    let unknownMagnitude = Math.max(
        0,
        rollingState.cumulativeUnknownChangeMagnitude - (baseline.unknownChangeMagnitude ?? 0)
    );

    let usedFallbackAttribution = false;
    if (aiMagnitude === 0 && humanMagnitude === 0 && unknownMagnitude === 0) {
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
            else if (attributionBucket === 'Unknown') {
                unknownMagnitude = 1;
                usedFallbackAttribution = true;
            }
        }
    }

    return {
        aiMagnitude,
        humanMagnitude,
        unknownMagnitude,
        usedFallbackAttribution
    };
}

function deriveNewFileAttributionForSummary(
    rollingState: FileRollingState,
    attribution: {
        aiMagnitude: number;
        humanMagnitude: number;
        unknownMagnitude: number;
        usedFallbackAttribution: boolean;
    }
): {
    aiMagnitude: number;
    humanMagnitude: number;
    unknownMagnitude: number;
    usedFallbackAttribution: boolean;
} {
    if (!shouldRepairHistoricalBulkAiNewFileAttribution(rollingState, attribution)) {
        return attribution;
    }

    return {
        aiMagnitude: attribution.aiMagnitude + attribution.humanMagnitude,
        humanMagnitude: 0,
        unknownMagnitude: attribution.unknownMagnitude,
        usedFallbackAttribution: true
    };
}

function shouldRepairHistoricalBulkAiNewFileAttribution(
    rollingState: FileRollingState,
    attribution: {
        aiMagnitude: number;
        humanMagnitude: number;
        unknownMagnitude: number;
    }
): boolean {
    if (attribution.aiMagnitude <= 0 || attribution.humanMagnitude <= 0) {
        return false;
    }

    const aiSignalCount = AI_SIGNAL_KEYS.reduce(
        (sum, signal) => sum + (rollingState.signalCounters[signal] ?? 0),
        0
    );
    if (aiSignalCount <= 0) {
        return false;
    }

    if (attribution.aiMagnitude < attribution.humanMagnitude * NEW_FILE_AI_DOMINANCE_RATIO) {
        return false;
    }

    return rollingState.saveAttributionCheckpoints.some((checkpoint) => (
        checkpoint.cumulativeAiChangeMagnitude === 0
        && checkpoint.cumulativeHumanChangeMagnitude >= HISTORICAL_BULK_HUMAN_CHECKPOINT_MINIMUM_MAGNITUDE
    ));
}

async function deriveStagedCheckpointAttribution(
    repoRoot: string,
    rollingState: FileRollingState,
    baselineByRepoRelativePath: Record<string, RepoCleanBaselineEntry>
): Promise<{
    aiMagnitude: number;
    humanMagnitude: number;
    unknownMagnitude: number;
    usedFallbackAttribution: boolean;
    lineAttributionSpans: LineAttributionSpan[];
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
        , unknownChangeMagnitude: 0
    };

    return {
        aiMagnitude: Math.max(0, matchingCheckpoint.cumulativeAiChangeMagnitude - baseline.aiChangeMagnitude),
        humanMagnitude: Math.max(0, matchingCheckpoint.cumulativeHumanChangeMagnitude - baseline.humanChangeMagnitude),
        unknownMagnitude: Math.max(0, matchingCheckpoint.cumulativeUnknownChangeMagnitude - (baseline.unknownChangeMagnitude ?? 0)),
        usedFallbackAttribution: false,
        lineAttributionSpans: matchingCheckpoint.lineAttributionSpans
    };
}

function deriveChangedLineAttributionFromSpans(
    spans: LineAttributionSpan[],
    ranges: DiffLineRange[],
    repoRelativePath: string,
    lineWeights: number[]
): ChangedLineAttributionSummary {
    const expandedLineAttribution = expandLineAttributionSpans(spans);
    let aiWeight = 0;
    let humanWeight = 0;
    let unknownWeight = 0;
    let aiAddedLineCount = 0;
    let humanAddedLineCount = 0;
    let unknownAddedLineCount = 0;

    for (const range of ranges) {
        for (let index = 0; index < range.lineCount; index += 1) {
            const lineIndex = range.startLine + index;
            const attribution = expandedLineAttribution[lineIndex] ?? 'Unknown';
            const lineWeight = getLineWeight(lineWeights[lineIndex]);
            if (attribution === 'AI') {
                aiWeight += lineWeight;
                aiAddedLineCount += lineWeight > 0 ? 1 : 0;
            }
            else if (attribution === 'Human') {
                humanWeight += lineWeight;
                humanAddedLineCount += lineWeight > 0 ? 1 : 0;
            }
            else {
                unknownWeight += lineWeight;
                unknownAddedLineCount += lineWeight > 0 ? 1 : 0;
            }
        }
    }

    return {
        repoRelativePath,
        aiWeight,
        humanWeight,
        unknownWeight,
        aiAddedLineCount,
        humanAddedLineCount,
        unknownAddedLineCount
    };
}

function expandLineAttributionSpans(spans: LineAttributionSpan[]): Array<LineAttributionSpan['attribution']> {
    const expanded: Array<LineAttributionSpan['attribution']> = [];

    for (const span of spans) {
        for (let index = 0; index < span.lineCount; index += 1) {
            expanded.push(span.attribution);
        }
    }

    return expanded;
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

async function getCachedIndexLineWeights(
    cache: Map<string, number[] | null>,
    repoRoot: string,
    repoRelativePath: string
): Promise<number[] | null> {
    const cacheKey = `${repoRoot}::${repoRelativePath}`;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey) ?? null;
    }

    const fileText = await readIndexFileText(repoRoot, repoRelativePath);
    const lineWeights = fileText === null ? null : createLineWeights(fileText);
    cache.set(cacheKey, lineWeights);
    return lineWeights;
}

async function getCachedWorkingTreeLineWeights(
    cache: Map<string, number[] | null>,
    repoRoot: string,
    repoRelativePath: string
): Promise<number[] | null> {
    const cacheKey = `${repoRoot}::${repoRelativePath}`;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey) ?? null;
    }

    const fileText = await readWorkingTreeFileText(repoRoot, repoRelativePath);
    const lineWeights = fileText === null ? null : createLineWeights(fileText);
    cache.set(cacheKey, lineWeights);
    return lineWeights;
}

async function readIndexFileText(repoRoot: string, repoRelativePath: string): Promise<string | null> {
    const gitPath = toGitRepoPath(repoRelativePath);
    return tryRunGitCommand(repoRoot, ['-c', 'core.quotepath=false', 'show', `:${gitPath}`]);
}

async function readWorkingTreeFileText(repoRoot: string, repoRelativePath: string): Promise<string | null> {
    return readTextFileIfExists(path.join(repoRoot, repoRelativePath));
}

function createLineWeights(text: string): number[] {
    if (text.length === 0) {
        return [];
    }

    return text.split(/\r\n|\r|\n/).map((line) => getLineWeight(getTextNonWhitespaceWeight(line)));
}

function getLineWeight(lineLength: number | undefined): number {
    if (typeof lineLength !== 'number' || !Number.isFinite(lineLength)) {
        return 0;
    }

    return Math.max(0, lineLength);
}

function getTextNonWhitespaceWeight(text: string): number {
    return text.replace(/\s/gu, '').length;
}

async function getGitDiffStdout(repoRoot: string, args: string[]): Promise<string | null> {
    return tryRunGitCommand(repoRoot, ['-c', 'core.quotepath=false', ...args]);
}

async function parseGitDiffStdout(repoRoot: string, stdout: string | null): Promise<GitDiffStatEntry[] | null> {
    if (stdout === null) {
        return null;
    }

    return filterIgnoredGitDiffEntries(repoRoot, parseGitDiffEntries(stdout));
}

async function getGitUntrackedEntries(repoRoot: string): Promise<GitDiffStatEntry[] | null> {
    const stdout = await tryRunGitCommand(repoRoot, ['ls-files', '--others', '--exclude-standard']);
    if (stdout === null) {
        return null;
    }

    const probeConfig = await readProbeConfig(repoRoot);
    const entries: GitDiffStatEntry[] = [];
    for (const line of stdout.split(/\r?\n/)) {
        const repoRelativePath = normalizeDiffPath(line.trim());
        if (!repoRelativePath) {
            continue;
        }

        if (await isRepoRelativePathTrackingIgnored(repoRoot, repoRelativePath)) {
            continue;
        }

        if (probeConfig.isAttributionExcluded(repoRelativePath)) {
            continue;
        }

        const fileContents = await readTextFileIfExists(path.join(repoRoot, repoRelativePath));
        if (fileContents === null) {
            continue;
        }

        const lineCount = countTextLines(fileContents);
        entries.push({
            repoRelativePath,
            changedLines: getTextNonWhitespaceWeight(fileContents),
            addedLineCount: countNonBlankTextLines(fileContents),
            currentLineRanges: lineCount > 0 ? [{ startLine: 0, lineCount }] : [],
            isNewFile: true
        });
    }

    return entries;
}

export function parseGitDiffEntries(stdout: string): GitDiffStatEntry[] {
    const entries = new Map<string, GitDiffStatEntry>();
    let currentRepoRelativePath: string | null = null;
    let pendingHeaderPath: string | null = null;
    let pendingIsNewFile = false;

    for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            pendingHeaderPath = parseGitDiffHeaderPath(line);
            currentRepoRelativePath = pendingHeaderPath;
            pendingIsNewFile = false;
            continue;
        }

        if (line.startsWith('--- ')) {
            pendingIsNewFile = normalizePatchPath(line.slice(4)) === null;
            continue;
        }

        if (line.startsWith('+++ ')) {
            currentRepoRelativePath = normalizePatchPath(line.slice(4)) ?? pendingHeaderPath;
            continue;
        }

        if (!currentRepoRelativePath) {
            continue;
        }

        if (line.startsWith('@@ ')) {
            const parsedHunk = parseGitDiffHunk(line);
            if (!parsedHunk) {
                continue;
            }

            const entry = entries.get(currentRepoRelativePath) ?? createGitDiffStatEntry(currentRepoRelativePath, pendingIsNewFile);
            entry.isNewFile = entry.isNewFile || pendingIsNewFile;

            if (parsedHunk.newLineCount > 0) {
                entry.currentLineRanges.push({
                    startLine: parsedHunk.newStartLine - 1,
                    lineCount: parsedHunk.newLineCount
                });
            }

            entries.set(currentRepoRelativePath, entry);
            continue;
        }

        if (!line.startsWith('+') && !line.startsWith('-')) {
            continue;
        }

        if (line.startsWith('+++ ') || line.startsWith('--- ')) {
            continue;
        }

        const entry = entries.get(currentRepoRelativePath) ?? createGitDiffStatEntry(currentRepoRelativePath, pendingIsNewFile);
        entry.isNewFile = entry.isNewFile || pendingIsNewFile;
        const lineWeight = getTextNonWhitespaceWeight(line.slice(1));
        entry.changedLines += lineWeight;
        if (line.startsWith('+') && lineWeight > 0) {
            entry.addedLineCount += 1;
        }
        entries.set(currentRepoRelativePath, entry);
    }

    return Array.from(entries.values());
}

function createGitDiffStatEntry(repoRelativePath: string, isNewFile: boolean): GitDiffStatEntry {
    return {
        repoRelativePath,
        changedLines: 0,
        addedLineCount: 0,
        currentLineRanges: [],
        isNewFile
    };
}

function parseGitDiffHeaderPath(line: string): string | null {
    const quotedMatch = /^diff --git "a\/(.*)" "b\/(.*)"$/u.exec(line);
    if (quotedMatch) {
        return normalizeDiffPath(quotedMatch[2]);
    }

    const simpleMatch = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (simpleMatch) {
        return normalizeDiffPath(simpleMatch[2]);
    }

    return null;
}

function normalizePatchPath(rawPath: string): string | null {
    const trimmedPath = rawPath.trim();
    if (!trimmedPath || trimmedPath === '/dev/null') {
        return null;
    }

    const unquotedPath = trimmedPath.startsWith('"') && trimmedPath.endsWith('"')
        ? trimmedPath.slice(1, -1)
        : trimmedPath;

    if (unquotedPath.startsWith('a/') || unquotedPath.startsWith('b/')) {
        return normalizeDiffPath(unquotedPath.slice(2));
    }

    return normalizeDiffPath(unquotedPath);
}

function parseGitDiffHunk(line: string): {
    oldLineCount: number;
    newStartLine: number;
    newLineCount: number;
} | null {
    const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!match) {
        return null;
    }

    const oldLineCount = match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
    const newStartLine = Number.parseInt(match[2], 10);
    const newLineCount = match[3] === undefined ? 1 : Number.parseInt(match[3], 10);
    if (!Number.isFinite(oldLineCount) || !Number.isFinite(newStartLine) || !Number.isFinite(newLineCount)) {
        return null;
    }

    return {
        oldLineCount,
        newStartLine,
        newLineCount
    };
}

function mergeGitDiffEntries(...entrySets: GitDiffStatEntry[][]): GitDiffStatEntry[] {
    const mergedEntries = new Map<string, GitDiffStatEntry>();

    for (const entrySet of entrySets) {
        for (const entry of entrySet) {
            const existingEntry = mergedEntries.get(entry.repoRelativePath) ?? {
                repoRelativePath: entry.repoRelativePath,
                changedLines: 0,
                addedLineCount: 0,
                currentLineRanges: [],
                isNewFile: false
            };

            existingEntry.changedLines += entry.changedLines;
            existingEntry.addedLineCount += entry.addedLineCount;
            existingEntry.currentLineRanges.push(...entry.currentLineRanges);
            existingEntry.isNewFile = existingEntry.isNewFile || entry.isNewFile;
            mergedEntries.set(entry.repoRelativePath, existingEntry);
        }
    }

    return Array.from(mergedEntries.values());
}

function countTextLines(text: string): number {
    if (text.length === 0) {
        return 0;
    }

    return text.split(/\r\n|\r|\n/).length;
}

function countNonBlankTextLines(text: string): number {
    if (text.length === 0) {
        return 0;
    }

    return text.split(/\r\n|\r|\n/)
        .filter((line) => getTextNonWhitespaceWeight(line) > 0)
        .length;
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
    if (await isRepoRelativePathTrackingIgnored(repoRoot, repoRelativePath)) {
        return null;
    }

    return readRollingStateFile(getRollingStatePath(repoRoot, repoRelativePath), repoRoot);
}

async function readRepoSummaryState(repoRoot: string): Promise<RepoSummaryState> {
    const parsedState = await readRepoSummaryStateFile(getRepoSummaryStatePath(repoRoot), repoRoot);
    if (parsedState) {
        parsedState.cleanBaselineByRepoRelativePath = await filterIgnoredCleanBaselineEntries(
            repoRoot,
            parsedState.cleanBaselineByRepoRelativePath
        );
        return parsedState;
    }

    return {
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'repo-summary-state',
        repoRoot,
        lastComputedAt: new Date().toISOString(),
        lastCleanAt: null,
        cleanBaselineByRepoRelativePath: {}
    };
}

async function buildRepoCommitBaselineState(
    repoRoot: string,
    repoRelativePaths?: readonly string[]
): Promise<CommitBaselineBuildResult> {
    const existingSummaryState = await readRepoSummaryState(repoRoot);
    const cleanBaselineByRepoRelativePath = {
        ...existingSummaryState.cleanBaselineByRepoRelativePath
    };
    const rollingStatePaths = repoRelativePaths === undefined
        ? await collectRollingStatePaths(getMetricsFilesStateDirectory(repoRoot))
        : Array.from(new Set(repoRelativePaths.map((repoRelativePath) => path.normalize(repoRelativePath))))
            .map((repoRelativePath) => getRollingStatePath(repoRoot, repoRelativePath));
    const rollingStates: FileRollingState[] = [];
    for (const rollingStatePath of rollingStatePaths) {
        const rollingState = await readRollingStateFile(rollingStatePath, repoRoot);
        if (rollingState) {
            rollingStates.push(rollingState);
        }
    }

    const rollingStateRepoRelativePaths = rollingStates.map((rollingState) => rollingState.repoRelativePath);
    const indexGitBlobOids = await getIndexGitBlobOids(repoRoot, rollingStateRepoRelativePaths);
    const workingTreeOidPaths = rollingStates
        .filter((rollingState) => {
            const indexGitBlobOid = indexGitBlobOids.get(rollingState.repoRelativePath);
            return indexGitBlobOid !== null
                && indexGitBlobOid !== undefined
                && !findMatchingCheckpointByGitBlobOid(rollingState.saveAttributionCheckpoints, indexGitBlobOid);
        })
        .map((rollingState) => rollingState.repoRelativePath);
    const workingTreeGitBlobOids = await getWorkingTreeGitBlobOids(repoRoot, workingTreeOidPaths);
    let resolvedFileCount = 0;
    let deletedFileCount = 0;
    let preservedFileCount = 0;
    const unresolvedRepoRelativePaths: string[] = [];

    for (const rollingState of rollingStates) {
        const resolution = await resolveCommitBaselineForRollingState(
            repoRoot,
            rollingState,
            indexGitBlobOids.get(rollingState.repoRelativePath) ?? null,
            workingTreeGitBlobOids.get(rollingState.repoRelativePath) ?? null
        );
        if (resolution.kind === 'resolved') {
            cleanBaselineByRepoRelativePath[rollingState.repoRelativePath] = resolution.entry;
            resolvedFileCount += 1;
            continue;
        }

        if (resolution.kind === 'deleted') {
            cleanBaselineByRepoRelativePath[rollingState.repoRelativePath] = resolution.entry;
            resolvedFileCount += 1;
            deletedFileCount += 1;
            continue;
        }

        if (resolution.kind === 'preserve-existing') {
            preservedFileCount += 1;
            continue;
        }

        unresolvedRepoRelativePaths.push(rollingState.repoRelativePath);
    }

    return {
        summaryState: {
            schemaVersion: METRICS_SCHEMA_VERSION,
            recordType: 'repo-summary-state',
            repoRoot,
            lastComputedAt: new Date().toISOString(),
            lastCleanAt: existingSummaryState.lastCleanAt,
            cleanBaselineByRepoRelativePath
        },
        resolvedFileCount,
        deletedFileCount,
        preservedFileCount,
        unresolvedRepoRelativePaths
    };
}

async function clearCommittedRollingState(args: {
    repoRoot: string;
    summaryState: RepoSummaryState;
}): Promise<{
    clearedRollingStateFileCount: number;
    preservedUnstagedFileCount: number;
}> {
    const committedRepoRelativePaths = await getLastCommitRepoRelativePaths(args.repoRoot);
    if (committedRepoRelativePaths.length === 0) {
        return {
            clearedRollingStateFileCount: 0,
            preservedUnstagedFileCount: 0
        };
    }

    const unstagedRepoRelativePaths = await getUnstagedRepoRelativePathSet(args.repoRoot);
    let clearedRollingStateFileCount = 0;
    let preservedUnstagedFileCount = 0;

    for (const repoRelativePath of committedRepoRelativePaths) {
        if (unstagedRepoRelativePaths.has(repoRelativePath)) {
            preservedUnstagedFileCount += 1;
            continue;
        }

        const rollingStatePath = getRollingStatePath(args.repoRoot, repoRelativePath);
        const hadRollingState = await pathExists(rollingStatePath);
        await removeFileIfExists(rollingStatePath);
        await removeEmptyParentDirectories(path.dirname(rollingStatePath), getMetricsFilesStateDirectory(args.repoRoot));
        delete args.summaryState.cleanBaselineByRepoRelativePath[repoRelativePath];
        if (hadRollingState) {
            clearedRollingStateFileCount += 1;
        }
    }

    return {
        clearedRollingStateFileCount,
        preservedUnstagedFileCount
    };
}

async function getLastCommitRepoRelativePaths(repoRoot: string): Promise<string[]> {
    const stdout = await tryRunGitCommand(repoRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']);
    if (stdout === null) {
        return [];
    }

    return Array.from(new Set(
        stdout
            .split(/\r?\n/)
            .map((line) => normalizeDiffPath(line.trim()))
            .filter((repoRelativePath): repoRelativePath is string => repoRelativePath !== null)
    ));
}

async function getUnstagedRepoRelativePathSet(repoRoot: string): Promise<Set<string>> {
    const unstagedTrackedEntries = await parseGitDiffStdout(
        repoRoot,
        await getGitDiffStdout(repoRoot, ['diff', '--unified=0', '--find-renames', '--no-color', '--ignore-all-space'])
    );
    const unstagedUntrackedEntries = await getGitUntrackedEntries(repoRoot);
    return new Set([
        ...(unstagedTrackedEntries ?? []).map((entry) => entry.repoRelativePath),
        ...(unstagedUntrackedEntries ?? []).map((entry) => entry.repoRelativePath)
    ]);
}

async function getStagedRepoRelativePaths(repoRoot: string): Promise<string[]> {
    const stdout = await tryRunGitCommand(repoRoot, [
        '-c',
        'core.quotepath=false',
        'diff',
        '--cached',
        '--name-only',
        '-z',
        '--find-renames'
    ]);
    if (stdout === null) {
        return [];
    }

    return Array.from(new Set(
        stdout
            .split('\0')
            .map(normalizeDiffPath)
            .filter((repoRelativePath): repoRelativePath is string => repoRelativePath !== null)
    ));
}

async function resolveCommitBaselineForRollingState(
    repoRoot: string,
    rollingState: FileRollingState,
    indexGitBlobOid: string | null,
    workingTreeGitBlobOid: string | null
): Promise<CommitBaselineResolution> {
    if (indexGitBlobOid) {
        const matchingCheckpoint = findMatchingCheckpointByGitBlobOid(
            rollingState.saveAttributionCheckpoints,
            indexGitBlobOid
        );
        if (matchingCheckpoint) {
            return {
                kind: 'resolved',
                entry: createBaselineEntryFromCheckpoint(matchingCheckpoint)
            };
        }

        if (workingTreeGitBlobOid && workingTreeGitBlobOid === indexGitBlobOid) {
            return {
                kind: 'resolved',
                entry: createBaselineEntryFromRollingState(rollingState)
            };
        }

        return {
            kind: 'unresolved'
        };
    }

    const repoAbsolutePath = path.join(repoRoot, rollingState.repoRelativePath);
    if (!(await pathExists(repoAbsolutePath))) {
        return {
            kind: 'deleted',
            entry: createBaselineEntryFromRollingState(rollingState)
        };
    }

    return {
        kind: 'preserve-existing'
    };
}

function createBaselineEntryFromCheckpoint(checkpoint: SaveAttributionCheckpoint): RepoCleanBaselineEntry {
    return {
        aiChangeMagnitude: checkpoint.cumulativeAiChangeMagnitude,
        humanChangeMagnitude: checkpoint.cumulativeHumanChangeMagnitude,
        unknownChangeMagnitude: checkpoint.cumulativeUnknownChangeMagnitude
    };
}

function createBaselineEntryFromRollingState(rollingState: FileRollingState): RepoCleanBaselineEntry {
    return {
        aiChangeMagnitude: rollingState.cumulativeAiChangeMagnitude,
        humanChangeMagnitude: rollingState.cumulativeHumanChangeMagnitude,
        unknownChangeMagnitude: rollingState.cumulativeUnknownChangeMagnitude
    };
}

async function readRollingStateFile(rollingStatePath: string, repoRoot: string): Promise<FileRollingState | null> {
    try {
        const fileContents = await fs.promises.readFile(rollingStatePath, 'utf8');
        const parsed = JSON.parse(fileContents) as Partial<FileRollingState>;
        if (typeof parsed.repoRelativePath !== 'string' || parsed.repoRelativePath.length === 0) {
            return null;
        }

        if (await isRepoRelativePathTrackingIgnored(repoRoot, parsed.repoRelativePath)) {
            return null;
        }

        return {
            schemaVersion: METRICS_SCHEMA_VERSION,
            recordType: 'file-rolling-state',
            repoRoot,
            repoRelativePath: parsed.repoRelativePath,
            lastRecordedAt: typeof parsed.lastRecordedAt === 'string'
                ? parsed.lastRecordedAt
                : new Date().toISOString(),
            latestSignal: typeof parsed.latestSignal === 'string' ? parsed.latestSignal : null,
            signalCounters: typeof parsed.signalCounters === 'object' && parsed.signalCounters !== null
                ? parsed.signalCounters as Record<string, number>
                : {},
            cumulativeAiChangeMagnitude: typeof parsed.cumulativeAiChangeMagnitude === 'number'
                ? parsed.cumulativeAiChangeMagnitude
                : 0,
            cumulativeHumanChangeMagnitude: typeof parsed.cumulativeHumanChangeMagnitude === 'number'
                ? parsed.cumulativeHumanChangeMagnitude
                : 0,
            cumulativeUnknownChangeMagnitude: typeof parsed.cumulativeUnknownChangeMagnitude === 'number'
                ? parsed.cumulativeUnknownChangeMagnitude
                : 0,
            saveAttributionCheckpoints: Array.isArray(parsed.saveAttributionCheckpoints)
                ? parsed.saveAttributionCheckpoints.map((checkpoint: any) => ({
                    gitBlobOid: typeof checkpoint?.gitBlobOid === 'string' ? checkpoint.gitBlobOid : null,
                    cumulativeAiChangeMagnitude: typeof checkpoint?.cumulativeAiChangeMagnitude === 'number'
                        ? checkpoint.cumulativeAiChangeMagnitude
                        : 0,
                    cumulativeHumanChangeMagnitude: typeof checkpoint?.cumulativeHumanChangeMagnitude === 'number'
                        ? checkpoint.cumulativeHumanChangeMagnitude
                        : 0,
                    cumulativeUnknownChangeMagnitude: typeof checkpoint?.cumulativeUnknownChangeMagnitude === 'number'
                        ? checkpoint.cumulativeUnknownChangeMagnitude
                        : 0,
                    lineAttributionSpans: Array.isArray(checkpoint?.lineAttributionSpans)
                        ? checkpoint.lineAttributionSpans.filter((span: any): span is LineAttributionSpan => (
                            typeof span?.lineCount === 'number'
                            && span.lineCount > 0
                            && (span.attribution === 'AI' || span.attribution === 'Human' || span.attribution === 'Unknown')
                        ))
                        : []
                }))
                : [],
            lineAttributionSpans: Array.isArray(parsed.lineAttributionSpans)
                ? parsed.lineAttributionSpans.filter((span: any): span is LineAttributionSpan => (
                    typeof span?.lineCount === 'number'
                    && span.lineCount > 0
                    && (span.attribution === 'AI' || span.attribution === 'Human' || span.attribution === 'Unknown')
                ))
                : [],
            deletedAt: typeof parsed.deletedAt === 'string' ? parsed.deletedAt : null
        };
    }
    catch {
        return null;
    }
}

async function readRepoSummaryStateFile(filePath: string, repoRoot: string): Promise<RepoSummaryState | null> {
    try {
        const fileContents = await fs.promises.readFile(filePath, 'utf8');
        const parsed = JSON.parse(fileContents) as Partial<RepoSummaryState>;
        return {
            schemaVersion: METRICS_SCHEMA_VERSION,
            recordType: 'repo-summary-state',
            repoRoot,
            lastComputedAt: typeof parsed.lastComputedAt === 'string'
                ? parsed.lastComputedAt
                : new Date().toISOString(),
            lastCleanAt: typeof parsed.lastCleanAt === 'string' ? parsed.lastCleanAt : null,
            cleanBaselineByRepoRelativePath: typeof parsed.cleanBaselineByRepoRelativePath === 'object'
                && parsed.cleanBaselineByRepoRelativePath !== null
                ? parsed.cleanBaselineByRepoRelativePath
                : {}
        };
    }
    catch {
        return null;
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
                humanChangeMagnitude: rollingState.cumulativeHumanChangeMagnitude ?? 0,
                unknownChangeMagnitude: rollingState.cumulativeUnknownChangeMagnitude ?? 0
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

async function filterIgnoredGitDiffEntries(repoRoot: string, entries: GitDiffStatEntry[]): Promise<GitDiffStatEntry[]> {
    const filteredEntries: GitDiffStatEntry[] = [];
    for (const entry of entries) {
        if (!(await isRepoRelativePathTrackingIgnored(repoRoot, entry.repoRelativePath))) {
            filteredEntries.push(entry);
        }
    }

    return filteredEntries;
}

async function filterIgnoredCleanBaselineEntries(
    repoRoot: string,
    baselineByRepoRelativePath: Record<string, RepoCleanBaselineEntry>
): Promise<Record<string, RepoCleanBaselineEntry>> {
    const filteredEntries: Record<string, RepoCleanBaselineEntry> = {};
    for (const [repoRelativePath, entry] of Object.entries(baselineByRepoRelativePath)) {
        if (!(await isRepoRelativePathTrackingIgnored(repoRoot, repoRelativePath))) {
            filteredEntries[repoRelativePath] = entry;
        }
    }

    return filteredEntries;
}

async function removeFileIfExists(filePath: string): Promise<void> {
    try {
        await fs.promises.rm(filePath, { force: true });
    }
    catch {
        // Best effort cleanup only.
    }
}

async function removeEmptyParentDirectories(startDirectoryPath: string, stopDirectoryPath: string): Promise<void> {
    const normalizedStopDirectoryPath = path.resolve(stopDirectoryPath);
    let currentDirectoryPath = path.resolve(startDirectoryPath);

    while (
        currentDirectoryPath !== normalizedStopDirectoryPath
        && !path.relative(normalizedStopDirectoryPath, currentDirectoryPath).startsWith('..')
    ) {
        try {
            await fs.promises.rmdir(currentDirectoryPath);
        }
        catch {
            return;
        }

        currentDirectoryPath = path.dirname(currentDirectoryPath);
    }
}

async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rm(filePath, { force: true });
    await fs.promises.rename(tempPath, filePath);
}
