export const METRICS_SCHEMA_VERSION = '1';

export const FILE_STATE_SUFFIX = '.metrics.json';

export const SIGNAL_COUNTER_KEYS = [
    'ProbableAIApplyToWorkspaceFile',
    'PossibleAIApplyToWorkspaceFile',
    'LikelyHumanEditWhileChatSessionOpen',
    'LikelyHumanOrRegularEditorEdit'
] as const;

export type SignalCounterKey = typeof SIGNAL_COUNTER_KEYS[number];

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

export type FileRenameHistoryEntry = {
    recordedAt: string;
    fromRepoRoot: string | null;
    fromRepoRelativePath: string | null;
    toRepoRoot: string | null;
    toRepoRelativePath: string | null;
};

export type FileRollingState = {
    schemaVersion: typeof METRICS_SCHEMA_VERSION;
    recordType: 'file-rolling-state';
    repoRoot: string;
    repoRelativePath: string;
    logicalPath: string | null;
    firstRecordedAt: string;
    lastRecordedAt: string;
    eventCount: number;
    latestSignal: string | null;
    latestReplacementRatio: number | null;
    latestRequestIds: string[];
    latestSnapshotRequestIds: string[];
    lastChatScheme: string | null;
    signalCounters: Record<string, number>;
    lastDocumentVersion: number | null;
    lastSavedAt: string | null;
    lastSavedHash: string | null;
    lastSavedLineCount: number | null;
    lastSavedCharLength: number | null;
    lastSavedWillSaveReason: string | null;
    deletedAt: string | null;
    renameHistory: FileRenameHistoryEntry[];
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