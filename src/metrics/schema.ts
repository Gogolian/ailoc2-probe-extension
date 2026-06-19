export const METRICS_SCHEMA_VERSION = '1';

export const FILE_STATE_SUFFIX = '.metrics.json';

export const AI_SIGNAL_KEYS = [
    'ProbableAIApplyToWorkspaceFile',
    'PossibleAIApplyToWorkspaceFile',
    'ProbableAIBulkWorkspaceEdit'
] as const;

export const HUMAN_SIGNAL_KEYS = [
    'LikelyHumanEditWhileChatSessionOpen',
    'LikelyHumanOrRegularEditorEdit'
] as const;

export const SIGNAL_COUNTER_KEYS = [
    ...AI_SIGNAL_KEYS,
    ...HUMAN_SIGNAL_KEYS
] as const;

export type SignalCounterKey = typeof SIGNAL_COUNTER_KEYS[number];
export type AttributionBucket = 'AI' | 'Human';
export type LineAttribution = AttributionBucket | 'Unknown';

export type LineDiffSegment = {
    type: 'equal' | 'added' | 'removed';
    lineCount: number;
};

export type LineAttributionSpan = {
    attribution: LineAttribution;
    lineCount: number;
};

export function getAttributionBucketForSignal(signal: string): AttributionBucket | null {
    if ((AI_SIGNAL_KEYS as readonly string[]).includes(signal)) {
        return 'AI';
    }

    if ((HUMAN_SIGNAL_KEYS as readonly string[]).includes(signal)) {
        return 'Human';
    }

    return null;
}

export type RecordType = 'workspace-file-metric' | 'file-lifecycle' | 'session-boundary';

export type SaveCorrelationSummary = {
    hadRecentWillSave: boolean;
    possibleSaveWithoutWillSave: boolean;
    ageMs?: number;
    seenAt?: string;
    reason?: string;
    documentVersion?: number;
    staleWillSaveContext?: {
        ageMs: number;
        seenAt: string;
        reason: string;
        documentVersion: number;
    };
};

export type MetricsRecordBase = {
    schemaVersion: typeof METRICS_SCHEMA_VERSION;
    recordType: RecordType;
    eventId: string;
    recordedAt: string;
    extensionSessionId: string;
    repoRoot: string;
    repoRelativePath: string | null;
    logicalPath: string | null;
};

export type WorkspaceFileMetricEvent = MetricsRecordBase & {
    recordType: 'workspace-file-metric';
    documentCategory: string;
    signal: string;
    explanation: string;
    replacementRatio: number | null;
    totalInsertedTextLength: number;
    totalRemovedTextLength: number;
    isWholeDocumentReplace: boolean;
    hasRecentSnapshotActivity: boolean;
    snapshotRequestIds: string[];
    requestIds: string[];
    lastChatScheme: string | null;
    snapshotAgeMs: number | null;
    changeReason: string;
    documentVersion: number;
    beforeHash: string | null;
    afterHash: string | null;
    beforeCharLength: number | null;
    afterCharLength: number | null;
    lineCount: number;
    languageId: string;
    isDirty: boolean;
    lineDiffSegments: LineDiffSegment[];
    chatCorrelation: Record<string, unknown> | null;
    saveCorrelation: SaveCorrelationSummary | null;
};

export type FileLifecycleAction = 'renamed' | 'deleted' | 'created-from-rename';

export type FileLifecycleEvent = MetricsRecordBase & {
    recordType: 'file-lifecycle';
    action: FileLifecycleAction;
    previousRepoRoot: string | null;
    previousRepoRelativePath: string | null;
    nextRepoRoot: string | null;
    nextRepoRelativePath: string | null;
};

export type SessionBoundaryEvent = MetricsRecordBase & {
    recordType: 'session-boundary';
    phase: 'started' | 'ended';
    reason: string;
};

export type MetricsRecord = WorkspaceFileMetricEvent | FileLifecycleEvent | SessionBoundaryEvent;

export type SaveAttributionCheckpoint = {
    gitBlobOid: string | null;
    cumulativeAiChangeMagnitude: number;
    cumulativeHumanChangeMagnitude: number;
    lineAttributionSpans: LineAttributionSpan[];
};

export type FileRollingState = {
    schemaVersion: typeof METRICS_SCHEMA_VERSION;
    recordType: 'file-rolling-state';
    repoRoot: string;
    repoRelativePath: string;
    lastRecordedAt: string;
    latestSignal: string | null;
    signalCounters: Record<string, number>;
    cumulativeAiChangeMagnitude: number;
    cumulativeHumanChangeMagnitude: number;
    saveAttributionCheckpoints: SaveAttributionCheckpoint[];
    lineAttributionSpans: LineAttributionSpan[];
    deletedAt: string | null;
};

export type RepoCleanBaselineEntry = {
    aiChangeMagnitude: number;
    humanChangeMagnitude: number;
};

export type RepoSummaryState = {
    schemaVersion: typeof METRICS_SCHEMA_VERSION;
    recordType: 'repo-summary-state';
    repoRoot: string;
    lastComputedAt: string;
    lastCleanAt: string | null;
    cleanBaselineByRepoRelativePath: Record<string, RepoCleanBaselineEntry>;
};

export type RepoManifest = {
    schemaVersion: typeof METRICS_SCHEMA_VERSION;
    extensionSessionId: string;
    repoRoot: string;
    createdAt: string;
    lastWriteAt: string | null;
    lastEventAt: string | null;
    lastEventId: string | null;
    pendingQueueLength: number;
};

export type RepoLocation = {
    repoRoot: string;
    repoRelativePath: string;
    logicalPath: string;
};