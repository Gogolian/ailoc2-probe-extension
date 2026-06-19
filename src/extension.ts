import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
    ChangeClassification,
    classifyWorkspaceFileChange
} from './changeClassification';
import {
    normalizeFsLikePath,
    resolveRepoLocationForDocument,
    resolveRepoRootForFsPath,
    resolveRepoLocationForUri
} from './metrics/repoResolver';
import {
    getMetricsManifestPath,
    getMetricsRoot,
    getRollingStatePath
} from './metrics/pathing';
import {
    METRICS_SCHEMA_VERSION,
    SaveCorrelationSummary,
    SessionBoundaryEvent,
    WorkspaceFileMetricEvent,
    FileLifecycleEvent
} from './metrics/schema';
import {
    refreshRepoHookSummary
} from './metrics/summary';
import { createLineDiffSegments } from './metrics/lineDiff';
import { RepoMetricsStore } from './metrics/store';
import { installRepoHooks, uninstallRepoHooks } from './hooks/management';
import { getTrackingExclusionReasonForPath as getSharedTrackingExclusionReasonForPath } from './trackingExclusions';

type DocumentSnapshot = {
    text: string;
    hash: string;
    charLength: number;
    lineCount: number;
    version: number;
    capturedAt: string;
};

type ChatSessionDescriptor = {
    external: string | null;
    path: string | null;
    scheme: string | null;
    authority: string | null;
};

type ChatEditingMetadata = {
    scheme: string;
    logicalPath: string | null;
    targetFileName: string;
    kind: string | null;
    documentId: string | null;
    requestId: string | null;
    undoStop: string | null;
    chatSession: ChatSessionDescriptor | null;
};

type ChatEditContext = {
    logicalPath: string;
    lastSeenAtMs: number;
    lastSeenAt: string;
    lastScheme: string;
    schemes: string[];
    kinds: string[];
    requestIds: string[];
    snapshotRequestIds: string[];
    documentIds: string[];
    lastVirtualDocumentUri: string;
    lastEventName: string;
    eventCount: number;
    lastSnapshotSeenAtMs: number | null;
    lastSnapshotSeenAt: string | null;
    chatSession: ChatSessionDescriptor | null;
};

type WillSaveContext = {
    seenAtMs: number;
    seenAt: string;
    reason: string;
    documentVersion: number;
};

type RecentChatEditCorrelation = {
    logicalPath: string;
    lastSeenAt: string;
    lastScheme: string;
    schemes: string[];
    kinds: string[];
    requestIds: string[];
    snapshotRequestIds: string[];
    documentIds: string[];
    lastVirtualDocumentUri: string;
    lastEventName: string;
    eventCount: number;
    lastSnapshotSeenAt: string | null;
    chatSession: ChatSessionDescriptor | null;
    ageMs: number;
    snapshotAgeMs: number | null;
    hasRecentSnapshotActivity: boolean;
    isRecent: true;
};

type ChatEditContextSummary = Omit<RecentChatEditCorrelation, 'ageMs' | 'snapshotAgeMs' | 'hasRecentSnapshotActivity' | 'isRecent'>;

type ChangeStats = {
    totalInsertedTextLength: number;
    totalRemovedTextLength: number;
    totalInsertedLineCount: number;
    totalRemovedLineCount: number;
    isNoOp: boolean;
    isWholeDocumentReplace: boolean;
    isSmallLocalizedEdit: boolean;
    isLargeBulkInsertion: boolean;
    isLargeBulkExpansion: boolean;
    replacementRatio: number | null;
};

type ChangeMetricCandidate = {
    logicalPath: string | null;
    documentCategory: string;
    signal: string;
    replacementRatio: number | null;
    totalInsertedTextLength: number;
    totalRemovedTextLength: number;
    totalInsertedLineCount: number;
    totalRemovedLineCount: number;
    isWholeDocumentReplace: boolean;
    isLargeBulkInsertion: boolean;
    isLargeBulkExpansion: boolean;
    hasRecentSnapshotActivity: boolean;
    snapshotRequestIds: string[];
    requestIds: string[];
    lastChatScheme: string | null;
    snapshotAgeMs: number | null;
};

type MetricPersistenceDecision = {
    shouldPersist: boolean;
    reason: string;
    repoRoot: string | null;
    repoRelativePath: string | null;
    logicalPath: string | null;
};

type RepoSelectionItem = vscode.QuickPickItem & {
    repoRoot: string;
    sortKey: string;
};

const OUTPUT_CHANNEL_NAME = 'AILoc2 Probe';
const SUMMARY_OUTPUT_CHANNEL_NAME = 'AILoc2 Summary';
const EXTENSION_CONFIGURATION_SECTION = 'ailoc2Probe';
const VERBOSE_OUTPUT_CHANNEL_CONFIGURATION_KEY = 'logging.verboseOutputChannel';
const TEXT_PREVIEW_LIMIT = 240;
const CHAT_CONTEXT_WINDOW_MS = 120_000;
const RECENT_WILL_SAVE_WINDOW_MS = 5_000;
const BULK_AI_INSERT_MINIMUM_TEXT_LENGTH = 400;
const BULK_AI_INSERT_MINIMUM_LINE_COUNT = 8;
const BULK_AI_EXPANSION_MULTIPLIER_THRESHOLD = 4;

type ExtensionRuntimeConfiguration = {
    verboseOutputChannel: boolean;
};

let outputChannel: vscode.OutputChannel | undefined;
let summaryOutputChannel: vscode.OutputChannel | undefined;
let metricsStore: RepoMetricsStore | undefined;
let extensionSessionId: string | undefined;
const trackedRepoRoots = new Set<string>();
let runtimeConfiguration: ExtensionRuntimeConfiguration = {
    verboseOutputChannel: false
};

export function activate(context: vscode.ExtensionContext): void {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    summaryOutputChannel = vscode.window.createOutputChannel(SUMMARY_OUTPUT_CHANNEL_NAME);
    runtimeConfiguration = readExtensionRuntimeConfiguration();
    const snapshots = new Map<string, DocumentSnapshot>();
    const recentChatEdits = new Map<string, ChatEditContext>();
    const recentWillSaves = new Map<string, WillSaveContext>();

    const logEvent = (eventName: string, payload: unknown): void => {
        if (!outputChannel || !shouldLogEvent(eventName)) {
            return;
        }

        outputChannel.appendLine(`[${new Date().toISOString()}] ${eventName}`);
        outputChannel.appendLine(JSON.stringify(payload, null, 2));
        outputChannel.appendLine('');
    };

    extensionSessionId = crypto.randomUUID();
    metricsStore = new RepoMetricsStore(extensionSessionId, logEvent);
    trackedRepoRoots.clear();

    const logSummaryLine = (message: string): void => {
        if (!summaryOutputChannel) {
            return;
        }

        summaryOutputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    };

    const refreshRepoSummaryForCommand = async (repoRoot: string, reason: string) => {
        if (!metricsStore) {
            throw new Error('Metrics store is not available.');
        }

        await metricsStore.flushRepo(repoRoot);
        const refreshedSummary = await refreshRepoHookSummary({ repoRoot });
        logEvent('HOOK_SUMMARY_FILE_UPDATED', {
            repoRoot,
            reason,
            summaryFilePath: refreshedSummary.summaryFilePath,
            isGitSummaryAvailable: refreshedSummary.summary.isGitSummaryAvailable,
            staged: refreshedSummary.summary.staged,
            unstaged: refreshedSummary.summary.unstaged
        });
        logSummaryLine(`${refreshedSummary.summaryLine} [trigger: ${reason}]`);
        return refreshedSummary;
    };

    const upsertSnapshot = (document: vscode.TextDocument): DocumentSnapshot | undefined => {
        if (shouldIgnoreDocument(document)) {
            return undefined;
        }

        const snapshot = createSnapshot(document);
        snapshots.set(getDocumentKey(document), snapshot);
        return snapshot;
    };

    const getSnapshot = (document: vscode.TextDocument): DocumentSnapshot | undefined => {
        if (shouldIgnoreDocument(document)) {
            return undefined;
        }

        return snapshots.get(getDocumentKey(document));
    };

    const logDocumentSnapshot = (eventName: string, document: vscode.TextDocument): void => {
        const snapshot = upsertSnapshot(document);
        logEvent(eventName, {
            document: describeDocument(document),
            workspace: describeWorkspace(document.uri),
            editor: describeEditorForDocument(document),
            signals: describeDocumentSignals(document),
            recentChatEditCorrelation: getRecentChatEditCorrelation(recentChatEdits, document),
            snapshot: summarizeSnapshot(snapshot)
        });
    };

    for (const document of vscode.workspace.textDocuments) {
        upsertSnapshot(document);
    }

    context.subscriptions.push(
        outputChannel,
        summaryOutputChannel,
        vscode.commands.registerCommand('ailoc2Probe.showOutput', () => {
            outputChannel?.show(true);
        }),
        vscode.commands.registerCommand('ailoc2Probe.showSummaryOutput', () => {
            summaryOutputChannel?.show(true);
        }),
        vscode.commands.registerCommand('ailoc2Probe.logActiveDocumentSnapshot', () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                logEvent('COMMAND_LOG_ACTIVE_DOCUMENT_SNAPSHOT', {
                    message: 'No active text editor was available.'
                });
                outputChannel?.show(true);
                return;
            }

            logDocumentSnapshot('COMMAND_LOG_ACTIVE_DOCUMENT_SNAPSHOT', activeEditor.document);
            outputChannel?.show(true);
        }),
        vscode.commands.registerCommand('ailoc2Probe.logActiveDocumentMetricsTarget', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor) {
                logEvent('COMMAND_LOG_ACTIVE_DOCUMENT_METRICS_TARGET', {
                    message: 'No active text editor was available.'
                });
                outputChannel?.show(true);
                return;
            }

            const document = activeEditor.document;
            const trackingExclusionReason = getTrackingExclusionReasonForDocument(document);
            const repoLocation = resolveRepoLocationForDocument(document);
            const trackedState = repoLocation && metricsStore
                && trackingExclusionReason === null
                ? await metricsStore.hasTrackedFile(repoLocation.repoRoot, repoLocation.repoRelativePath)
                : false;

            logEvent('COMMAND_LOG_ACTIVE_DOCUMENT_METRICS_TARGET', {
                document: describeDocument(document),
                workspace: describeWorkspace(document.uri),
                trackingExclusionReason,
                repoLocation,
                metricsTarget: repoLocation && trackingExclusionReason === null
                    ? {
                        metricsRoot: getMetricsRoot(repoLocation.repoRoot),
                        manifestPath: getMetricsManifestPath(repoLocation.repoRoot),
                        rollingStatePath: getRollingStatePath(repoLocation.repoRoot, repoLocation.repoRelativePath),
                        isCurrentlyTracked: trackedState
                    }
                    : null,
                notes: trackingExclusionReason
                    ? `The active document is excluded from tracking: ${trackingExclusionReason}.`
                    : repoLocation
                    ? 'This is the repo-local .ailoc2-metrics target for the active file.'
                    : 'The active document is not currently eligible for repo-local metrics persistence.'
            });
            outputChannel?.show(true);
        }),
        vscode.commands.registerCommand('ailoc2Probe.recomputeRepoSummary', async () => {
            const repoRoot = await promptForRepoRootForCommand({
                title: 'AILoc2 Probe: Recompute Repo Summary',
                placeHolder: 'Select the repository to recompute the AILoc2 summary for.'
            });
            if (!repoRoot) {
                return;
            }

            summaryOutputChannel?.show(true);

            try {
                const refreshedSummary = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `AILoc2: Refreshing summary for ${path.basename(repoRoot)}`
                }, async () => refreshRepoSummaryForCommand(repoRoot, 'command:recompute-summary'));

                logEvent('COMMAND_RECOMPUTE_REPO_SUMMARY', {
                    repoRoot,
                    summaryFilePath: refreshedSummary.summaryFilePath,
                    summaryLine: refreshedSummary.summaryLine,
                    isGitSummaryAvailable: refreshedSummary.summary.isGitSummaryAvailable,
                    staged: refreshedSummary.summary.staged,
                    unstaged: refreshedSummary.summary.unstaged
                });

                const infoMessage = refreshedSummary.summary.isGitSummaryAvailable
                    ? `AILoc2 summary refreshed for ${path.basename(repoRoot)}. Staged AI: ${refreshedSummary.summary.staged.aiPercentage.toFixed(2)}%.`
                    : `AILoc2 summary refreshed for ${path.basename(repoRoot)}, but Git summary data is unavailable.`;
                void vscode.window.showInformationMessage(infoMessage);
            }
            catch (error) {
                logEvent('COMMAND_RECOMPUTE_REPO_SUMMARY_FAILED', {
                    repoRoot,
                    error: error instanceof Error ? error.message : String(error)
                });
                void vscode.window.showErrorMessage(
                    `AILoc2 failed to refresh the repo summary for ${path.basename(repoRoot)}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }),
        vscode.commands.registerCommand('ailoc2Probe.installHooks', async () => {
            const repoRoot = await promptForRepoRootForCommand({
                title: 'AILoc2 Probe: Install Repo Hooks',
                placeHolder: 'Select the repository to install AILoc2 Git hooks for.'
            });
            if (!repoRoot) {
                return;
            }

            try {
                let installResult = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `AILoc2: Installing hooks for ${path.basename(repoRoot)}`
                }, async () => installRepoHooks({ repoRoot }));

                if (installResult.status === 'conflict') {
                    const resolutionChoice = await vscode.window.showWarningMessage(
                        `${path.basename(repoRoot)} already uses a different local hooksPath (${installResult.currentLocalHooksPath}). Do you want AILoc2 to chain to that hooksPath or replace it?`,
                        { modal: true },
                        'Chain hooks',
                        'Replace hooksPath'
                    );
                    if (!resolutionChoice) {
                        logEvent('COMMAND_INSTALL_HOOKS_CANCELLED', {
                            repoRoot,
                            currentLocalHooksPath: installResult.currentLocalHooksPath
                        });
                        return;
                    }

                    installResult = await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: resolutionChoice === 'Chain hooks'
                            ? `AILoc2: Chaining hooks for ${path.basename(repoRoot)}`
                            : `AILoc2: Replacing hooksPath for ${path.basename(repoRoot)}`
                    }, async () => installRepoHooks({
                        repoRoot,
                        allowReplacingExistingLocalHooksPath: true,
                        chainExistingLocalHooksPath: resolutionChoice === 'Chain hooks'
                    }));
                }

                logEvent('COMMAND_INSTALL_HOOKS', installResult);

                let initialSummaryRefreshError: string | null = null;
                try {
                    await refreshRepoSummaryForCommand(repoRoot, 'command:install-hooks');
                }
                catch (summaryRefreshError) {
                    initialSummaryRefreshError = summaryRefreshError instanceof Error
                        ? summaryRefreshError.message
                        : String(summaryRefreshError);
                    logEvent('COMMAND_INSTALL_HOOKS_INITIAL_SUMMARY_FAILED', {
                        repoRoot,
                        error: initialSummaryRefreshError
                    });
                }

                const infoMessage = installResult.status === 'already-installed'
                    ? installResult.delegatedHooksPath
                        ? `AILoc2 hooks are already active for ${path.basename(repoRoot)} and chained to ${installResult.delegatedHooksPath}.`
                        : `AILoc2 hooks are already active for ${path.basename(repoRoot)}.`
                    : installResult.delegatedHooksPath
                    ? `AILoc2 hooks installed for ${path.basename(repoRoot)} and chained to ${installResult.delegatedHooksPath}.`
                    : installResult.replacedPreviousLocalHooksPath
                    ? `AILoc2 hooks installed for ${path.basename(repoRoot)}. Previous local hooksPath saved for restore on uninstall.`
                    : `AILoc2 hooks installed for ${path.basename(repoRoot)}.`;
                void vscode.window.showInformationMessage(infoMessage);

                if (initialSummaryRefreshError) {
                    void vscode.window.showWarningMessage(
                        `AILoc2 installed hooks for ${path.basename(repoRoot)}, but could not precompute the initial summary. The first commit may use stale attribution until the next successful refresh: ${initialSummaryRefreshError}`
                    );
                }
            }
            catch (error) {
                logEvent('COMMAND_INSTALL_HOOKS_FAILED', {
                    repoRoot,
                    error: error instanceof Error ? error.message : String(error)
                });
                void vscode.window.showErrorMessage(
                    `AILoc2 failed to install hooks for ${path.basename(repoRoot)}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }),
        vscode.commands.registerCommand('ailoc2Probe.uninstallHooks', async () => {
            const repoRoot = await promptForRepoRootForCommand({
                title: 'AILoc2 Probe: Uninstall Repo Hooks',
                placeHolder: 'Select the repository to uninstall AILoc2 Git hooks from.'
            });
            if (!repoRoot) {
                return;
            }

            try {
                const uninstallResult = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `AILoc2: Uninstalling hooks for ${path.basename(repoRoot)}`
                }, async () => uninstallRepoHooks({ repoRoot }));

                logEvent('COMMAND_UNINSTALL_HOOKS', uninstallResult);

                let infoMessage: string;
                if (uninstallResult.status === 'restored-previous') {
                    infoMessage = `AILoc2 hooks removed for ${path.basename(repoRoot)}. Restored the previous local hooksPath.`;
                }
                else if (uninstallResult.status === 'uninstalled') {
                    infoMessage = `AILoc2 hooks removed for ${path.basename(repoRoot)}.`;
                }
                else if (uninstallResult.removedManagedHookAssets && uninstallResult.currentLocalHooksPath) {
                    infoMessage = `AILoc2 removed its managed hook files from ${path.basename(repoRoot)}, but left the current repo-local hooksPath (${uninstallResult.currentLocalHooksPath}) unchanged.`;
                }
                else if (uninstallResult.removedManagedHookAssets) {
                    infoMessage = `AILoc2 removed its managed hook files from ${path.basename(repoRoot)}.`;
                }
                else if (uninstallResult.currentLocalHooksPath) {
                    infoMessage = `${path.basename(repoRoot)} is using a different repo-local hooksPath (${uninstallResult.currentLocalHooksPath}). AILoc2 left it unchanged.`;
                }
                else {
                    infoMessage = `No repo-local AILoc2 hooks are currently installed for ${path.basename(repoRoot)}.`;
                }

                void vscode.window.showInformationMessage(infoMessage);
            }
            catch (error) {
                logEvent('COMMAND_UNINSTALL_HOOKS_FAILED', {
                    repoRoot,
                    error: error instanceof Error ? error.message : String(error)
                });
                void vscode.window.showErrorMessage(
                    `AILoc2 failed to uninstall hooks for ${path.basename(repoRoot)}: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }),
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (shouldIgnoreDocument(document)) {
                return;
            }

            const snapshot = upsertSnapshot(document);
            const chatEditContext = rememberChatEditContext(recentChatEdits, document, 'TEXT_DOCUMENT_OPENED');
            logEvent('TEXT_DOCUMENT_OPENED', {
                document: describeDocument(document),
                workspace: describeWorkspace(document.uri),
                editor: describeEditorForDocument(document),
                signals: describeDocumentSignals(document),
                chatEditContext,
                recentChatEditCorrelation: getRecentChatEditCorrelation(recentChatEdits, document),
                snapshot: summarizeSnapshot(snapshot)
            });
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (shouldIgnoreDocument(document)) {
                return;
            }

            const previousSnapshot = snapshots.get(getDocumentKey(document));
            snapshots.delete(getDocumentKey(document));

            const repoLocation = resolveRepoLocationForDocument(document);
            if (repoLocation) {
                void metricsStore?.flushRepo(repoLocation.repoRoot);
            }

            logEvent('TEXT_DOCUMENT_CLOSED', {
                document: describeDocument(document),
                workspace: describeWorkspace(document.uri),
                signals: describeDocumentSignals(document),
                recentChatEditCorrelation: getRecentChatEditCorrelation(recentChatEdits, document),
                previousSnapshot: summarizeSnapshot(previousSnapshot)
            });
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const { document } = event;
            if (shouldIgnoreDocument(document)) {
                return;
            }

            const beforeSnapshot = getSnapshot(document);
            const afterSnapshot = upsertSnapshot(document);
            const chatEditContext = rememberChatEditContext(recentChatEdits, document, 'TEXT_DOCUMENT_CHANGED');
            const recentChatEditCorrelation = getRecentChatEditCorrelation(recentChatEdits, document);
            const changeStats = computeChangeStats(event, beforeSnapshot);
            const classification = classifyChangeEvent({
                document,
                changeStats,
                recentChatEditCorrelation
            });
            const metricCandidate = createChangeMetricCandidate({
                document,
                changeStats,
                classification,
                recentChatEditCorrelation
            });
            const persistenceDecision = getMetricPersistenceDecision(document, metricCandidate);
            const changeReason = describeTextDocumentChangeReason(event.reason);

            if (persistenceDecision.shouldPersist
                && persistenceDecision.repoRoot
                && persistenceDecision.repoRelativePath
                && extensionSessionId
                && metricsStore) {
                ensureRepoSessionStarted(persistenceDecision.repoRoot);
                metricsStore.queueWorkspaceFileMetric(createWorkspaceFileMetricEvent({
                    extensionSessionId,
                    repoRoot: persistenceDecision.repoRoot,
                    repoRelativePath: persistenceDecision.repoRelativePath,
                    logicalPath: persistenceDecision.logicalPath,
                    document,
                    classification,
                    metricCandidate,
                    beforeSnapshot,
                    afterSnapshot,
                    recentChatEditCorrelation,
                    changeReason,
                    saveCorrelation: null
                }));
            }

            logEvent('TEXT_DOCUMENT_CHANGED', {
                document: describeDocument(document),
                workspace: describeWorkspace(document.uri),
                editor: describeEditorForDocument(document),
                signals: describeDocumentSignals(document),
                chatEditContext,
                recentChatEditCorrelation,
                changeReason,
                changeCount: event.contentChanges.length,
                changeHeuristics: describeChangeHeuristics({
                    document,
                    changeStats,
                    classification,
                    metricCandidate,
                    recentChatEditCorrelation,
                    persistenceDecision
                }),
                beforeSnapshot: summarizeSnapshot(beforeSnapshot),
                afterSnapshot: summarizeSnapshot(afterSnapshot),
                contentChanges: event.contentChanges.map((change, index) =>
                    describeContentChange({
                        change,
                        index,
                        beforeText: beforeSnapshot?.text
                    })
                )
            });
        }),
        vscode.workspace.onWillSaveTextDocument((event) => {
            const { document } = event;
            if (shouldIgnoreDocument(document)) {
                return;
            }

            recentWillSaves.set(getDocumentKey(document), {
                seenAtMs: Date.now(),
                seenAt: new Date().toISOString(),
                reason: describeTextDocumentSaveReason(event.reason),
                documentVersion: document.version
            });

            logEvent('TEXT_DOCUMENT_WILL_SAVE', {
                document: describeDocument(document),
                workspace: describeWorkspace(document.uri),
                editor: describeEditorForDocument(document),
                signals: describeDocumentSignals(document),
                recentChatEditCorrelation: getRecentChatEditCorrelation(recentChatEdits, document),
                saveReason: describeTextDocumentSaveReason(event.reason),
                snapshot: summarizeSnapshot(getSnapshot(document) ?? upsertSnapshot(document)),
                fileStat: tryGetFileStat(document.uri)
            });
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (shouldIgnoreDocument(document)) {
                return;
            }

            const snapshot = upsertSnapshot(document);
            const recentWillSave = getRecentWillSaveCorrelation(recentWillSaves, document);

            const repoLocation = resolveRepoLocationForDocument(document);
            if (repoLocation && snapshot && metricsStore) {
                metricsStore.noteDocumentSaved({
                    repoRoot: repoLocation.repoRoot,
                    repoRelativePath: repoLocation.repoRelativePath,
                    savedAt: new Date().toISOString(),
                    hash: snapshot.hash,
                    lineCount: snapshot.lineCount,
                    charLength: snapshot.charLength,
                    documentVersion: snapshot.version,
                    saveCorrelation: recentWillSave
                });
                void metricsStore.flushRepo(repoLocation.repoRoot);
            }

            logEvent('TEXT_DOCUMENT_SAVED', {
                document: describeDocument(document),
                workspace: describeWorkspace(document.uri),
                editor: describeEditorForDocument(document),
                signals: describeDocumentSignals(document),
                recentChatEditCorrelation: getRecentChatEditCorrelation(recentChatEdits, document),
                recentWillSave,
                snapshot: summarizeSnapshot(snapshot),
                fileStat: tryGetFileStat(document.uri)
            });

            recentWillSaves.delete(getDocumentKey(document));
        }),
        vscode.workspace.onDidRenameFiles((event) => {
            if (!metricsStore || !extensionSessionId) {
                return;
            }

            const activeMetricsStore = metricsStore;
            const activeExtensionSessionId = extensionSessionId;
            void (async () => {
                const recordedAt = new Date().toISOString();
                const renameSummaries: Record<string, unknown>[] = [];

                for (const entry of event.files) {
                    const oldTrackingExclusionReason = getTrackingExclusionReasonForUri(entry.oldUri);
                    const newTrackingExclusionReason = getTrackingExclusionReasonForUri(entry.newUri);
                    if (oldTrackingExclusionReason || newTrackingExclusionReason) {
                        renameSummaries.push({
                            oldUri: entry.oldUri.toString(),
                            newUri: entry.newUri.toString(),
                            skipped: true,
                            reason: oldTrackingExclusionReason ?? newTrackingExclusionReason
                        });
                        continue;
                    }

                    const previousRepoLocation = resolveRepoLocationForUri(entry.oldUri);
                    const nextRepoLocation = resolveRepoLocationForUri(entry.newUri);

                    if (previousRepoLocation) {
                        await activeMetricsStore.flushRepo(previousRepoLocation.repoRoot);
                    }

                    const hasTrackedSourceFile = previousRepoLocation
                        ? await activeMetricsStore.hasTrackedFile(previousRepoLocation.repoRoot, previousRepoLocation.repoRelativePath)
                        : false;

                    if (!hasTrackedSourceFile) {
                        renameSummaries.push({
                            oldUri: entry.oldUri.toString(),
                            newUri: entry.newUri.toString(),
                            previousRepoLocation,
                            nextRepoLocation,
                            skipped: true,
                            reason: 'NoTrackedSourceFile'
                        });
                        continue;
                    }

                    if (previousRepoLocation) {
                        ensureRepoSessionStarted(previousRepoLocation.repoRoot);
                    }

                    if (nextRepoLocation) {
                        ensureRepoSessionStarted(nextRepoLocation.repoRoot);
                    }

                    if (previousRepoLocation && nextRepoLocation) {
                        activeMetricsStore.moveRollingState({
                            fromRepoRoot: previousRepoLocation.repoRoot,
                            fromRepoRelativePath: previousRepoLocation.repoRelativePath,
                            toRepoRoot: nextRepoLocation.repoRoot,
                            toRepoRelativePath: nextRepoLocation.repoRelativePath,
                            recordedAt
                        });

                        if (areSameNormalizedFsPath(previousRepoLocation.repoRoot, nextRepoLocation.repoRoot)) {
                            activeMetricsStore.queueFileLifecycleEvent(createFileLifecycleEvent({
                                extensionSessionId: activeExtensionSessionId,
                                recordedAt,
                                repoRoot: nextRepoLocation.repoRoot,
                                repoRelativePath: nextRepoLocation.repoRelativePath,
                                logicalPath: nextRepoLocation.logicalPath,
                                action: 'renamed',
                                previousRepoRoot: previousRepoLocation.repoRoot,
                                previousRepoRelativePath: previousRepoLocation.repoRelativePath,
                                nextRepoRoot: nextRepoLocation.repoRoot,
                                nextRepoRelativePath: nextRepoLocation.repoRelativePath
                            }));
                            await activeMetricsStore.flushRepo(nextRepoLocation.repoRoot);
                        }
                        else {
                            activeMetricsStore.queueFileLifecycleEvent(createFileLifecycleEvent({
                                extensionSessionId: activeExtensionSessionId,
                                recordedAt,
                                repoRoot: previousRepoLocation.repoRoot,
                                repoRelativePath: previousRepoLocation.repoRelativePath,
                                logicalPath: previousRepoLocation.logicalPath,
                                action: 'deleted',
                                previousRepoRoot: previousRepoLocation.repoRoot,
                                previousRepoRelativePath: previousRepoLocation.repoRelativePath,
                                nextRepoRoot: nextRepoLocation.repoRoot,
                                nextRepoRelativePath: nextRepoLocation.repoRelativePath
                            }));
                            activeMetricsStore.queueFileLifecycleEvent(createFileLifecycleEvent({
                                extensionSessionId: activeExtensionSessionId,
                                recordedAt,
                                repoRoot: nextRepoLocation.repoRoot,
                                repoRelativePath: nextRepoLocation.repoRelativePath,
                                logicalPath: nextRepoLocation.logicalPath,
                                action: 'created-from-rename',
                                previousRepoRoot: previousRepoLocation.repoRoot,
                                previousRepoRelativePath: previousRepoLocation.repoRelativePath,
                                nextRepoRoot: nextRepoLocation.repoRoot,
                                nextRepoRelativePath: nextRepoLocation.repoRelativePath
                            }));
                            await activeMetricsStore.flushRepo(previousRepoLocation.repoRoot);
                            await activeMetricsStore.flushRepo(nextRepoLocation.repoRoot);
                        }
                    }
                    else if (previousRepoLocation) {
                        activeMetricsStore.queueFileLifecycleEvent(createFileLifecycleEvent({
                            extensionSessionId: activeExtensionSessionId,
                            recordedAt,
                            repoRoot: previousRepoLocation.repoRoot,
                            repoRelativePath: previousRepoLocation.repoRelativePath,
                            logicalPath: previousRepoLocation.logicalPath,
                            action: 'deleted',
                            previousRepoRoot: previousRepoLocation.repoRoot,
                            previousRepoRelativePath: previousRepoLocation.repoRelativePath,
                            nextRepoRoot: null,
                            nextRepoRelativePath: null
                        }));
                        activeMetricsStore.markDeleted({
                            repoRoot: previousRepoLocation.repoRoot,
                            repoRelativePath: previousRepoLocation.repoRelativePath,
                            recordedAt
                        });
                        await activeMetricsStore.flushRepo(previousRepoLocation.repoRoot);
                    }

                    renameSummaries.push({
                        oldUri: entry.oldUri.toString(),
                        newUri: entry.newUri.toString(),
                        previousRepoLocation,
                        nextRepoLocation,
                        skipped: false
                    });
                }

                logEvent('WORKSPACE_FILES_RENAMED', {
                    renameCount: renameSummaries.length,
                    renames: renameSummaries
                });
            })().catch((error) => {
                logEvent('WORKSPACE_FILES_RENAMED_FAILED', {
                    renameCount: event.files.length,
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        }),
        vscode.workspace.onDidDeleteFiles((event) => {
            if (!metricsStore || !extensionSessionId) {
                return;
            }

            const activeMetricsStore = metricsStore;
            const activeExtensionSessionId = extensionSessionId;
            void (async () => {
                const recordedAt = new Date().toISOString();
                const deletions: Record<string, unknown>[] = [];

                for (const uri of event.files) {
                    const trackingExclusionReason = getTrackingExclusionReasonForUri(uri);
                    if (trackingExclusionReason) {
                        deletions.push({
                            uri: uri.toString(),
                            skipped: true,
                            reason: trackingExclusionReason
                        });
                        continue;
                    }

                    const repoLocation = resolveRepoLocationForUri(uri);
                    if (!repoLocation) {
                        deletions.push({
                            uri: uri.toString(),
                            repoLocation,
                            skipped: true,
                            reason: 'NoRepoRootResolved'
                        });
                        continue;
                    }

                    await activeMetricsStore.flushRepo(repoLocation.repoRoot);
                    const hasTrackedFile = await activeMetricsStore.hasTrackedFile(
                        repoLocation.repoRoot,
                        repoLocation.repoRelativePath
                    );

                    if (!hasTrackedFile) {
                        deletions.push({
                            uri: uri.toString(),
                            repoLocation,
                            skipped: true,
                            reason: 'NoTrackedSourceFile'
                        });
                        continue;
                    }

                    ensureRepoSessionStarted(repoLocation.repoRoot);
                    activeMetricsStore.queueFileLifecycleEvent(createFileLifecycleEvent({
                        extensionSessionId: activeExtensionSessionId,
                        recordedAt,
                        repoRoot: repoLocation.repoRoot,
                        repoRelativePath: repoLocation.repoRelativePath,
                        logicalPath: repoLocation.logicalPath,
                        action: 'deleted',
                        previousRepoRoot: repoLocation.repoRoot,
                        previousRepoRelativePath: repoLocation.repoRelativePath,
                        nextRepoRoot: null,
                        nextRepoRelativePath: null
                    }));
                    activeMetricsStore.markDeleted({
                        repoRoot: repoLocation.repoRoot,
                        repoRelativePath: repoLocation.repoRelativePath,
                        recordedAt
                    });
                    await activeMetricsStore.flushRepo(repoLocation.repoRoot);

                    deletions.push({
                        uri: uri.toString(),
                        repoLocation,
                        skipped: false
                    });
                }

                logEvent('WORKSPACE_FILES_DELETED', {
                    deleteCount: deletions.length,
                    deletions
                });
            })().catch((error) => {
                logEvent('WORKSPACE_FILES_DELETED_FAILED', {
                    deleteCount: event.files.length,
                    error: error instanceof Error ? error.message : String(error)
                });
            });
        }),
        new vscode.Disposable(() => {
            logEvent('EXTENSION_DEACTIVATED', {
                trackedDocumentCount: snapshots.size,
                trackedChatEditContextCount: recentChatEdits.size,
                trackedRepoCount: trackedRepoRoots.size
            });
        })
    );

    logEvent('EXTENSION_ACTIVATED', {
        extensionSessionId,
        runtimeConfiguration,
        extensionMode: describeExtensionMode(context.extensionMode),
        vscodeVersion: vscode.version,
        workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => ({
            name: folder.name,
            uri: folder.uri.toString(),
            fsPath: folder.uri.fsPath
        })) ?? [],
        openDocuments: vscode.workspace.textDocuments
            .filter((document) => !shouldIgnoreDocument(document))
            .map((document) => describeDocument(document))
    });

    if (runtimeConfiguration.verboseOutputChannel) {
        outputChannel.show(true);
    }
}

export async function deactivate(): Promise<void> {
    if (metricsStore && extensionSessionId) {
        for (const repoRoot of trackedRepoRoots) {
            metricsStore.queueSessionBoundaryEvent(createSessionBoundaryEvent({
                extensionSessionId,
                repoRoot,
                phase: 'ended',
                reason: 'extension-deactivate'
            }));
        }

        await metricsStore.flushAll();
    }

    if (!outputChannel || !runtimeConfiguration.verboseOutputChannel) {
        return;
    }

    outputChannel.appendLine(`[${new Date().toISOString()}] EXTENSION_DEACTIVATE_CALLED`);
    outputChannel.appendLine('');
}

function readExtensionRuntimeConfiguration(): ExtensionRuntimeConfiguration {
    const configuration = vscode.workspace.getConfiguration(EXTENSION_CONFIGURATION_SECTION);
    return {
        verboseOutputChannel: configuration.get<boolean>(VERBOSE_OUTPUT_CHANNEL_CONFIGURATION_KEY, false)
    };
}

function shouldLogEvent(eventName: string): boolean {
    return runtimeConfiguration.verboseOutputChannel || isAlwaysLoggedEvent(eventName);
}

function isAlwaysLoggedEvent(eventName: string): boolean {
    return eventName.startsWith('COMMAND_') || eventName.endsWith('_FAILED');
}

function shouldIgnoreDocument(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'output'
        || getTrackingExclusionReasonForDocument(document) !== null;
}

function describeDocumentSignals(document: vscode.TextDocument): Record<string, unknown> {
    const trackingExclusionReason = getTrackingExclusionReasonForDocument(document);

    return {
        category: describeDocumentCategory(document),
        logicalPath: getLogicalDocumentPath(document),
        isVirtualDocument: document.uri.scheme !== 'file',
        isWorkspaceFile: document.uri.scheme === 'file',
        isChatEditingDocument: isChatEditingDocument(document),
        isTrackingExcluded: trackingExclusionReason !== null,
        trackingExclusionReason,
        chatEditingMetadata: extractChatEditingMetadata(document)
    };
}

function describeDocumentCategory(document: vscode.TextDocument): string {
    switch (document.uri.scheme) {
        case 'file':
            return 'WorkspaceFile';
        case 'chat-editing-text-model':
            return 'ChatEditingVirtualDocument';
        case 'chat-editing-snapshot-text-model':
            return 'ChatEditingSnapshotVirtualDocument';
        case 'vscode-scm':
            return 'SourceControlInputDocument';
        case 'git':
            return 'GitVirtualDocument';
        case 'vscode-userdata':
            return 'UserDataDocument';
        default:
            return document.uri.scheme === 'output'
                ? 'OutputDocument'
                : `Other(${document.uri.scheme})`;
    }
}

function isChatEditingDocument(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'chat-editing-text-model'
        || document.uri.scheme === 'chat-editing-snapshot-text-model';
}

function getLogicalDocumentPath(document: vscode.TextDocument): string | null {
    if (document.uri.scheme === 'file') {
        return normalizeFsLikePath(document.uri.fsPath);
    }

    if (isChatEditingDocument(document) && path.isAbsolute(document.fileName)) {
        return normalizeFsLikePath(document.fileName);
    }

    return null;
}

function extractChatEditingMetadata(document: vscode.TextDocument): ChatEditingMetadata | null {
    if (!isChatEditingDocument(document)) {
        return null;
    }

    const queryRecord = tryParseUriQueryAsRecord(document.uri);
    const sessionRecord = asRecord(queryRecord?.chatSessionResource) ?? asRecord(queryRecord?.session);

    return {
        scheme: document.uri.scheme,
        logicalPath: getLogicalDocumentPath(document),
        targetFileName: document.fileName,
        kind: getRecordString(queryRecord, 'kind'),
        documentId: getRecordString(queryRecord, 'documentId'),
        requestId: getRecordString(queryRecord, 'requestId'),
        undoStop: getRecordString(queryRecord, 'undoStop'),
        chatSession: sessionRecord
            ? {
                external: getRecordString(sessionRecord, 'external'),
                path: getRecordString(sessionRecord, 'path'),
                scheme: getRecordString(sessionRecord, 'scheme'),
                authority: getRecordString(sessionRecord, 'authority')
            }
            : null
    };
}

function rememberChatEditContext(
    recentChatEdits: Map<string, ChatEditContext>,
    document: vscode.TextDocument,
    eventName: string
): Record<string, unknown> | null {
    pruneExpiredChatEditContexts(recentChatEdits);

    const metadata = extractChatEditingMetadata(document);
    if (!metadata?.logicalPath) {
        return null;
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const existing = recentChatEdits.get(metadata.logicalPath) ?? {
        logicalPath: metadata.logicalPath,
        lastSeenAtMs: nowMs,
        lastSeenAt: nowIso,
        lastScheme: metadata.scheme,
        schemes: [],
        kinds: [],
        requestIds: [],
        snapshotRequestIds: [],
        documentIds: [],
        lastVirtualDocumentUri: document.uri.toString(),
        lastEventName: eventName,
        eventCount: 0,
        lastSnapshotSeenAtMs: null,
        lastSnapshotSeenAt: null,
        chatSession: metadata.chatSession
    };

    existing.lastSeenAtMs = nowMs;
    existing.lastSeenAt = nowIso;
    existing.lastScheme = metadata.scheme;
    existing.lastVirtualDocumentUri = document.uri.toString();
    existing.lastEventName = eventName;
    existing.eventCount += 1;
    existing.chatSession = metadata.chatSession;

    addUniqueString(existing.schemes, metadata.scheme);
    addUniqueString(existing.kinds, metadata.kind);
    addUniqueString(existing.requestIds, metadata.requestId);
    addUniqueString(existing.documentIds, metadata.documentId);

    if (metadata.scheme === 'chat-editing-snapshot-text-model') {
        existing.lastSnapshotSeenAtMs = nowMs;
        existing.lastSnapshotSeenAt = nowIso;
        addUniqueString(existing.snapshotRequestIds, metadata.requestId);
    }

    recentChatEdits.set(metadata.logicalPath, existing);
    return summarizeChatEditContext(existing);
}

function getRecentChatEditCorrelation(
    recentChatEdits: Map<string, ChatEditContext>,
    document: vscode.TextDocument
): RecentChatEditCorrelation | null {
    pruneExpiredChatEditContexts(recentChatEdits);

    const logicalPath = getLogicalDocumentPath(document);
    if (!logicalPath) {
        return null;
    }

    const context = recentChatEdits.get(logicalPath);
    if (!context) {
        return null;
    }

    const ageMs = Date.now() - context.lastSeenAtMs;
    if (ageMs > CHAT_CONTEXT_WINDOW_MS) {
        recentChatEdits.delete(logicalPath);
        return null;
    }

    return {
        ...summarizeChatEditContext(context),
        ageMs,
        snapshotAgeMs: context.lastSnapshotSeenAtMs === null ? null : (Date.now() - context.lastSnapshotSeenAtMs),
        hasRecentSnapshotActivity: context.lastSnapshotSeenAtMs !== null
            && (Date.now() - context.lastSnapshotSeenAtMs) <= 1_500,
        isRecent: true
    };
}

function summarizeChatEditContext(context: ChatEditContext): ChatEditContextSummary {
    return {
        logicalPath: context.logicalPath,
        lastSeenAt: context.lastSeenAt,
        lastScheme: context.lastScheme,
        schemes: context.schemes,
        kinds: context.kinds,
        requestIds: context.requestIds,
        snapshotRequestIds: context.snapshotRequestIds,
        documentIds: context.documentIds,
        lastVirtualDocumentUri: context.lastVirtualDocumentUri,
        lastEventName: context.lastEventName,
        eventCount: context.eventCount,
        lastSnapshotSeenAt: context.lastSnapshotSeenAt,
        chatSession: context.chatSession
    };
}

function pruneExpiredChatEditContexts(recentChatEdits: Map<string, ChatEditContext>): void {
    const nowMs = Date.now();

    for (const [logicalPath, context] of recentChatEdits) {
        if ((nowMs - context.lastSeenAtMs) > CHAT_CONTEXT_WINDOW_MS) {
            recentChatEdits.delete(logicalPath);
        }
    }
}

function getRecentWillSaveCorrelation(
    recentWillSaves: Map<string, WillSaveContext>,
    document: vscode.TextDocument
): SaveCorrelationSummary {
    const context = recentWillSaves.get(getDocumentKey(document));
    if (!context) {
        return {
            hadRecentWillSave: false,
            possibleSaveWithoutWillSave: true
        };
    }

    const ageMs = Date.now() - context.seenAtMs;
    if (ageMs > RECENT_WILL_SAVE_WINDOW_MS) {
        return {
            hadRecentWillSave: false,
            possibleSaveWithoutWillSave: true,
            staleWillSaveContext: {
                ageMs,
                seenAt: context.seenAt,
                reason: context.reason,
                documentVersion: context.documentVersion
            }
        };
    }

    return {
        hadRecentWillSave: true,
        possibleSaveWithoutWillSave: false,
        ageMs,
        seenAt: context.seenAt,
        reason: context.reason,
        documentVersion: context.documentVersion
    };
}

function describeChangeHeuristics(input: {
    document: vscode.TextDocument;
    changeStats: ChangeStats;
    classification: ChangeClassification;
    metricCandidate: ChangeMetricCandidate;
    recentChatEditCorrelation: RecentChatEditCorrelation | null;
    persistenceDecision: MetricPersistenceDecision;
}): Record<string, unknown> {
    return {
        signal: input.classification.signal,
        explanation: input.classification.explanation,
        isNoOp: input.changeStats.isNoOp,
        isWholeDocumentReplace: input.changeStats.isWholeDocumentReplace,
        isSmallLocalizedEdit: input.changeStats.isSmallLocalizedEdit,
        replacementRatio: input.changeStats.replacementRatio,
        totalInsertedTextLength: input.changeStats.totalInsertedTextLength,
        totalRemovedTextLength: input.changeStats.totalRemovedTextLength,
        totalInsertedLineCount: input.changeStats.totalInsertedLineCount,
        totalRemovedLineCount: input.changeStats.totalRemovedLineCount,
        isLargeBulkInsertion: input.changeStats.isLargeBulkInsertion,
        isLargeBulkExpansion: input.changeStats.isLargeBulkExpansion,
        hasRecentChatCorrelation: input.recentChatEditCorrelation !== null,
        hasRecentSnapshotActivity: input.recentChatEditCorrelation?.hasRecentSnapshotActivity ?? false,
        snapshotAgeMs: input.recentChatEditCorrelation?.snapshotAgeMs ?? null,
        lastChatScheme: input.recentChatEditCorrelation?.lastScheme ?? null,
        affectedDocumentCategory: describeDocumentCategory(input.document),
        recentChatEditCorrelation: input.recentChatEditCorrelation,
        metricCandidate: input.metricCandidate,
        metricsPersistence: input.persistenceDecision
    };
}

/**
 * Computes stable change metrics that can later be written to `.ailoc2-metrics`
 * without re-deriving them from raw probe log payloads.
 */
function computeChangeStats(
    event: vscode.TextDocumentChangeEvent,
    beforeSnapshot: DocumentSnapshot | undefined
): ChangeStats {
    const totalInsertedTextLength = event.contentChanges.reduce((sum, change) => sum + change.text.length, 0);
    const totalRemovedTextLength = event.contentChanges.reduce((sum, change) => sum + change.rangeLength, 0);
    const totalInsertedLineCount = event.contentChanges.reduce((sum, change) => sum + (countTextLines(change.text) ?? 0), 0);
    const totalRemovedLineCount = event.contentChanges.reduce((sum, change) => {
        const removedText = beforeSnapshot?.text.slice(change.rangeOffset, change.rangeOffset + change.rangeLength);
        return sum + (countTextLines(removedText) ?? 0);
    }, 0);
    const isNoOp = event.contentChanges.length === 0;
    const isWholeDocumentReplace = Boolean(
        beforeSnapshot
        && event.contentChanges.length === 1
        && event.contentChanges[0].rangeOffset === 0
        && event.contentChanges[0].rangeLength === beforeSnapshot.text.length
        && event.contentChanges[0].text.length > 0
    );
    const isSmallLocalizedEdit = !isWholeDocumentReplace
        && event.contentChanges.length === 1
        && totalInsertedTextLength <= 8
        && totalRemovedTextLength <= 8;
    const isLargeBulkInsertion = totalRemovedTextLength === 0
        && totalInsertedTextLength >= BULK_AI_INSERT_MINIMUM_TEXT_LENGTH
        && totalInsertedLineCount >= BULK_AI_INSERT_MINIMUM_LINE_COUNT;
    const isLargeBulkExpansion = totalRemovedTextLength > 0
        && totalInsertedTextLength >= BULK_AI_INSERT_MINIMUM_TEXT_LENGTH
        && totalInsertedLineCount >= BULK_AI_INSERT_MINIMUM_LINE_COUNT
        && totalInsertedTextLength >= totalRemovedTextLength * BULK_AI_EXPANSION_MULTIPLIER_THRESHOLD;
    const baselineLength = Math.max(beforeSnapshot?.charLength ?? 0, totalInsertedTextLength, totalRemovedTextLength);
    const replacementRatio = baselineLength > 0
        ? Math.max(totalInsertedTextLength, totalRemovedTextLength) / baselineLength
        : null;

    return {
        totalInsertedTextLength,
        totalRemovedTextLength,
        totalInsertedLineCount,
        totalRemovedLineCount,
        isNoOp,
        isWholeDocumentReplace,
        isSmallLocalizedEdit,
        isLargeBulkInsertion,
        isLargeBulkExpansion,
        replacementRatio
    };
}

/**
 * Classifies a document change into a human/AI/noise-oriented bucket while keeping
 * the decision logic isolated from raw event logging.
 */
function classifyChangeEvent(input: {
    document: vscode.TextDocument;
    changeStats: ChangeStats;
    recentChatEditCorrelation: RecentChatEditCorrelation | null;
}): ChangeClassification {
    if (isChatEditingDocument(input.document)) {
        return {
            signal: 'ChatEditingVirtualDocument',
            explanation: 'The changed document itself uses a chat-editing URI scheme created by the VS Code chat editing flow.'
        };
    }

    if (input.changeStats.isNoOp) {
        return {
            signal: 'LifecycleNoiseOrDirtyStateFlip',
            explanation: 'The event has zero content changes and likely reflects a dirty/save lifecycle transition instead of new text.'
        };
    }

    if (input.document.uri.scheme === 'file') {
        return classifyWorkspaceFileChange({
            isNoOp: input.changeStats.isNoOp,
            isWholeDocumentReplace: input.changeStats.isWholeDocumentReplace,
            isSmallLocalizedEdit: input.changeStats.isSmallLocalizedEdit,
            isLargeBulkInsertion: input.changeStats.isLargeBulkInsertion,
            isLargeBulkExpansion: input.changeStats.isLargeBulkExpansion,
            hasRecentChatCorrelation: input.recentChatEditCorrelation !== null,
            hasRecentSnapshotActivity: input.recentChatEditCorrelation?.hasRecentSnapshotActivity ?? false
        });
    }

    return {
        signal: 'OtherVirtualOrNonWorkspaceDocument',
        explanation: 'The change occurred on a virtual or non-workspace document that is useful for context but not direct attribution.'
    };
}

/**
 * Produces a compact, persistence-oriented summary of a classified change. The
 * extension currently only logs this object, but the shape is intended to become
 * the bridge to future `.ailoc2-metrics` storage.
 */
function createChangeMetricCandidate(input: {
    document: vscode.TextDocument;
    changeStats: ChangeStats;
    classification: ChangeClassification;
    recentChatEditCorrelation: RecentChatEditCorrelation | null;
}): ChangeMetricCandidate {
    return {
        logicalPath: getLogicalDocumentPath(input.document),
        documentCategory: describeDocumentCategory(input.document),
        signal: input.classification.signal,
        replacementRatio: input.changeStats.replacementRatio,
        totalInsertedTextLength: input.changeStats.totalInsertedTextLength,
        totalRemovedTextLength: input.changeStats.totalRemovedTextLength,
        totalInsertedLineCount: input.changeStats.totalInsertedLineCount,
        totalRemovedLineCount: input.changeStats.totalRemovedLineCount,
        isWholeDocumentReplace: input.changeStats.isWholeDocumentReplace,
        isLargeBulkInsertion: input.changeStats.isLargeBulkInsertion,
        isLargeBulkExpansion: input.changeStats.isLargeBulkExpansion,
        hasRecentSnapshotActivity: input.recentChatEditCorrelation?.hasRecentSnapshotActivity ?? false,
        snapshotRequestIds: input.recentChatEditCorrelation?.snapshotRequestIds ?? [],
        requestIds: input.recentChatEditCorrelation?.requestIds ?? [],
        lastChatScheme: input.recentChatEditCorrelation?.lastScheme ?? null,
        snapshotAgeMs: input.recentChatEditCorrelation?.snapshotAgeMs ?? null
    };
}

function tryParseUriQueryAsRecord(uri: vscode.Uri): Record<string, unknown> | null {
    if (!uri.query) {
        return null;
    }

    try {
        return asRecord(JSON.parse(decodeURIComponent(uri.query)));
    }
    catch {
        try {
            return asRecord(JSON.parse(uri.query));
        }
        catch {
            return null;
        }
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }

    return value as Record<string, unknown>;
}

function getRecordString(record: Record<string, unknown> | null, key: string): string | null {
    const value = record?.[key];
    return typeof value === 'string' ? value : null;
}

function addUniqueString(target: string[], value: string | null): void {
    if (!value || target.includes(value)) {
        return;
    }

    target.push(value);
}

function getDocumentKey(document: vscode.TextDocument): string {
    return document.uri.toString();
}

function createSnapshot(document: vscode.TextDocument): DocumentSnapshot {
    const text = document.getText();

    return {
        text,
        hash: hashText(text),
        charLength: text.length,
        lineCount: document.lineCount,
        version: document.version,
        capturedAt: new Date().toISOString()
    };
}

function summarizeSnapshot(snapshot: DocumentSnapshot | undefined): Record<string, unknown> | null {
    if (!snapshot) {
        return null;
    }

    return {
        hash: snapshot.hash,
        charLength: snapshot.charLength,
        lineCount: snapshot.lineCount,
        version: snapshot.version,
        capturedAt: snapshot.capturedAt
    };
}

function describeDocument(document: vscode.TextDocument): Record<string, unknown> {
    return {
        uri: document.uri.toString(),
        fsPath: document.uri.scheme === 'file' ? document.uri.fsPath : null,
        relativePath: vscode.workspace.asRelativePath(document.uri, false),
        fileName: document.fileName,
        languageId: document.languageId,
        scheme: document.uri.scheme,
        version: document.version,
        isDirty: document.isDirty,
        isUntitled: document.isUntitled,
        isClosed: document.isClosed,
        lineCount: document.lineCount,
        endOfLine: document.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF'
    };
}

function describeWorkspace(uri: vscode.Uri): Record<string, unknown> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const repoLocation = resolveRepoLocationForUri(uri);

    return {
        workspaceFolder: workspaceFolder
            ? {
                name: workspaceFolder.name,
                uri: workspaceFolder.uri.toString(),
                fsPath: workspaceFolder.uri.fsPath
            }
            : null,
        relativePath: vscode.workspace.asRelativePath(uri, false),
        pathFromWorkspaceRoot: workspaceFolder ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath) : null,
        trackedRepo: repoLocation
            ? {
                repoRoot: repoLocation.repoRoot,
                repoRelativePath: repoLocation.repoRelativePath,
                logicalPath: repoLocation.logicalPath
            }
            : null
    };
}

function describeEditorForDocument(document: vscode.TextDocument): Record<string, unknown> | null {
    const matchingEditor = vscode.window.visibleTextEditors.find(
        (editor) => editor.document.uri.toString() === document.uri.toString()
    );

    if (!matchingEditor) {
        return null;
    }

    return {
        viewColumn: matchingEditor.viewColumn ?? null,
        selectionCount: matchingEditor.selections.length,
        selections: matchingEditor.selections.map((selection) => ({
            anchor: describePosition(selection.anchor),
            active: describePosition(selection.active),
            start: describePosition(selection.start),
            end: describePosition(selection.end),
            isReversed: selection.isReversed,
            isEmpty: selection.isEmpty
        })),
        visibleRanges: matchingEditor.visibleRanges.map(describeRange),
        options: {
            insertSpaces: matchingEditor.options.insertSpaces ?? null,
            tabSize: matchingEditor.options.tabSize ?? null
        }
    };
}

function describeTextDocumentChangeReason(reason: vscode.TextDocumentChangeReason | undefined): string {
    switch (reason) {
        case vscode.TextDocumentChangeReason.Redo:
            return 'Redo';
        case vscode.TextDocumentChangeReason.Undo:
            return 'Undo';
        case undefined:
            return 'RegularEditOrUnknown';
        default:
            return `Unknown(${String(reason)})`;
    }
}

function describeTextDocumentSaveReason(reason: vscode.TextDocumentSaveReason): string {
    switch (reason) {
        case vscode.TextDocumentSaveReason.Manual:
            return 'Manual';
        case vscode.TextDocumentSaveReason.AfterDelay:
            return 'AfterDelay';
        case vscode.TextDocumentSaveReason.FocusOut:
            return 'FocusOut';
        default:
            return `Unknown(${String(reason)})`;
    }
}

function describeExtensionMode(mode: vscode.ExtensionMode): string {
    switch (mode) {
        case vscode.ExtensionMode.Development:
            return 'Development';
        case vscode.ExtensionMode.Test:
            return 'Test';
        case vscode.ExtensionMode.Production:
            return 'Production';
        default:
            return `Unknown(${String(mode)})`;
    }
}

function describeContentChange(input: {
    change: vscode.TextDocumentContentChangeEvent;
    index: number;
    beforeText: string | undefined;
}): Record<string, unknown> {
    const removedText = input.beforeText?.slice(
        input.change.rangeOffset,
        input.change.rangeOffset + input.change.rangeLength
    );

    return {
        index: input.index,
        range: describeRange(input.change.range),
        rangeOffset: input.change.rangeOffset,
        rangeLength: input.change.rangeLength,
        removedTextLength: removedText?.length ?? null,
        removedTextPreview: previewText(removedText),
        insertedTextLength: input.change.text.length,
        insertedTextPreview: previewText(input.change.text),
        insertedLineCount: countTextLines(input.change.text),
        removedLineCount: countTextLines(removedText),
        isPureInsertion: input.change.rangeLength === 0 && input.change.text.length > 0,
        isPureDeletion: input.change.rangeLength > 0 && input.change.text.length === 0
    };
}

function describePosition(position: vscode.Position): Record<string, number> {
    return {
        line: position.line,
        character: position.character
    };
}

function describeRange(range: vscode.Range): Record<string, unknown> {
    return {
        start: describePosition(range.start),
        end: describePosition(range.end),
        isEmpty: range.isEmpty,
        isSingleLine: range.isSingleLine
    };
}

function countTextLines(text: string | undefined): number | null {
    if (text === undefined) {
        return null;
    }

    if (text.length === 0) {
        return 0;
    }

    return text.split(/\r\n|\r|\n/).length;
}

function previewText(text: string | undefined): string | null {
    if (text === undefined) {
        return null;
    }

    const escaped = text
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');

    if (escaped.length <= TEXT_PREVIEW_LIMIT) {
        return escaped;
    }

    return `${escaped.slice(0, TEXT_PREVIEW_LIMIT)}…`;
}

function hashText(text: string): string {
    return crypto
        .createHash('sha256')
        .update(text, 'utf8')
        .digest('hex')
        .slice(0, 16);
}

function tryGetFileStat(uri: vscode.Uri): Record<string, unknown> | null {
    if (uri.scheme !== 'file') {
        return null;
    }

    try {
        const stat = fs.statSync(uri.fsPath);
        return {
            size: stat.size,
            mtime: new Date(stat.mtimeMs).toISOString(),
            ctime: new Date(stat.ctimeMs).toISOString(),
            birthtime: new Date(stat.birthtimeMs).toISOString()
        };
    }
    catch {
        return null;
    }
}

function getMetricPersistenceDecision(
    document: vscode.TextDocument,
    metricCandidate: ChangeMetricCandidate
): MetricPersistenceDecision {
    const trackingExclusionReason = getTrackingExclusionReasonForDocument(document);
    if (trackingExclusionReason) {
        return {
            shouldPersist: false,
            reason: trackingExclusionReason,
            repoRoot: null,
            repoRelativePath: null,
            logicalPath: metricCandidate.logicalPath
        };
    }

    if (document.uri.scheme !== 'file') {
        return {
            shouldPersist: false,
            reason: 'NonFileDocument',
            repoRoot: null,
            repoRelativePath: null,
            logicalPath: metricCandidate.logicalPath
        };
    }

    if (document.isUntitled) {
        return {
            shouldPersist: false,
            reason: 'UntitledDocument',
            repoRoot: null,
            repoRelativePath: null,
            logicalPath: metricCandidate.logicalPath
        };
    }

    if (metricCandidate.signal === 'LifecycleNoiseOrDirtyStateFlip') {
        return {
            shouldPersist: false,
            reason: 'LifecycleNoiseFiltered',
            repoRoot: null,
            repoRelativePath: null,
            logicalPath: metricCandidate.logicalPath
        };
    }

    const repoLocation = resolveRepoLocationForDocument(document);
    if (!repoLocation) {
        return {
            shouldPersist: false,
            reason: 'NoRepoRootResolved',
            repoRoot: null,
            repoRelativePath: null,
            logicalPath: metricCandidate.logicalPath
        };
    }

    return {
        shouldPersist: true,
        reason: 'PersistWorkspaceFileMetric',
        repoRoot: repoLocation.repoRoot,
        repoRelativePath: repoLocation.repoRelativePath,
        logicalPath: repoLocation.logicalPath
    };
}

function createWorkspaceFileMetricEvent(input: {
    extensionSessionId: string;
    repoRoot: string;
    repoRelativePath: string;
    logicalPath: string | null;
    document: vscode.TextDocument;
    classification: ChangeClassification;
    metricCandidate: ChangeMetricCandidate;
    beforeSnapshot: DocumentSnapshot | undefined;
    afterSnapshot: DocumentSnapshot | undefined;
    recentChatEditCorrelation: RecentChatEditCorrelation | null;
    changeReason: string;
    saveCorrelation: SaveCorrelationSummary | null;
}): WorkspaceFileMetricEvent {
    return {
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'workspace-file-metric',
        eventId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
        extensionSessionId: input.extensionSessionId,
        repoRoot: input.repoRoot,
        repoRelativePath: input.repoRelativePath,
        logicalPath: input.logicalPath,
        documentCategory: input.metricCandidate.documentCategory,
        signal: input.metricCandidate.signal,
        explanation: input.classification.explanation,
        replacementRatio: input.metricCandidate.replacementRatio,
        totalInsertedTextLength: input.metricCandidate.totalInsertedTextLength,
        totalRemovedTextLength: input.metricCandidate.totalRemovedTextLength,
        isWholeDocumentReplace: input.metricCandidate.isWholeDocumentReplace,
        hasRecentSnapshotActivity: input.metricCandidate.hasRecentSnapshotActivity,
        snapshotRequestIds: input.metricCandidate.snapshotRequestIds,
        requestIds: input.metricCandidate.requestIds,
        lastChatScheme: input.metricCandidate.lastChatScheme,
        snapshotAgeMs: input.metricCandidate.snapshotAgeMs,
        changeReason: input.changeReason,
        documentVersion: input.document.version,
        beforeHash: input.beforeSnapshot?.hash ?? null,
        afterHash: input.afterSnapshot?.hash ?? null,
        beforeCharLength: input.beforeSnapshot?.charLength ?? null,
        afterCharLength: input.afterSnapshot?.charLength ?? null,
        lineCount: input.document.lineCount,
        languageId: input.document.languageId,
        isDirty: input.document.isDirty,
        lineDiffSegments: createLineDiffSegments(
            input.beforeSnapshot?.text,
            input.afterSnapshot?.text ?? input.document.getText(),
            { languageId: input.document.languageId }
        ),
        chatCorrelation: input.recentChatEditCorrelation ? { ...input.recentChatEditCorrelation } : null,
        saveCorrelation: input.saveCorrelation
    };
}

function createFileLifecycleEvent(input: {
    extensionSessionId: string;
    recordedAt: string;
    repoRoot: string;
    repoRelativePath: string;
    logicalPath: string | null;
    action: 'renamed' | 'deleted' | 'created-from-rename';
    previousRepoRoot: string | null;
    previousRepoRelativePath: string | null;
    nextRepoRoot: string | null;
    nextRepoRelativePath: string | null;
}): FileLifecycleEvent {
    return {
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-lifecycle',
        eventId: crypto.randomUUID(),
        recordedAt: input.recordedAt,
        extensionSessionId: input.extensionSessionId,
        repoRoot: input.repoRoot,
        repoRelativePath: input.repoRelativePath,
        logicalPath: input.logicalPath,
        action: input.action,
        previousRepoRoot: input.previousRepoRoot,
        previousRepoRelativePath: input.previousRepoRelativePath,
        nextRepoRoot: input.nextRepoRoot,
        nextRepoRelativePath: input.nextRepoRelativePath
    };
}

function createSessionBoundaryEvent(input: {
    extensionSessionId: string;
    repoRoot: string;
    phase: 'started' | 'ended';
    reason: string;
}): SessionBoundaryEvent {
    return {
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'session-boundary',
        eventId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
        extensionSessionId: input.extensionSessionId,
        repoRoot: input.repoRoot,
        repoRelativePath: null,
        logicalPath: null,
        phase: input.phase,
        reason: input.reason
    };
}

function ensureRepoSessionStarted(repoRoot: string): void {
    if (!metricsStore || !extensionSessionId || trackedRepoRoots.has(repoRoot)) {
        return;
    }

    trackedRepoRoots.add(repoRoot);
    metricsStore.queueSessionBoundaryEvent(createSessionBoundaryEvent({
        extensionSessionId,
        repoRoot,
        phase: 'started',
        reason: 'first-persisted-repo-activity'
    }));
}

function areSameNormalizedFsPath(left: string, right: string): boolean {
    return normalizeFsLikePath(left) === normalizeFsLikePath(right);
}

function getTrackingExclusionReasonForDocument(document: vscode.TextDocument): string | null {
    if (document.uri.scheme === 'output') {
        return 'OutputDocument';
    }

    const logicalPath = getLogicalDocumentPath(document);
    if (logicalPath) {
        return getTrackingExclusionReasonForPath(logicalPath);
    }

    if (document.uri.scheme === 'file') {
        return getTrackingExclusionReasonForPath(document.uri.fsPath);
    }

    return null;
}

function getTrackingExclusionReasonForUri(uri: vscode.Uri): string | null {
    if (uri.scheme !== 'file') {
        return null;
    }

    return getTrackingExclusionReasonForPath(uri.fsPath);
}

function getTrackingExclusionReasonForPath(candidatePath: string | null | undefined): string | null {
    return getSharedTrackingExclusionReasonForPath(candidatePath);
}

async function promptForRepoRootForCommand(args: {
    title: string;
    placeHolder: string;
}): Promise<string | null> {
    const selectionItems = collectRepoSelectionItems();
    if (selectionItems.length === 0) {
        void vscode.window.showWarningMessage('AILoc2 could not find any Git repositories in the current workspace.');
        return null;
    }

    const selectedRepo = await vscode.window.showQuickPick(selectionItems, {
        title: args.title,
        placeHolder: args.placeHolder,
        ignoreFocusOut: true,
        matchOnDescription: true,
        matchOnDetail: true
    });

    return selectedRepo?.repoRoot ?? null;
}

function collectRepoSelectionItems(): RepoSelectionItem[] {
    const candidates = new Map<string, {
        repoRoot: string;
        sources: Set<string>;
    }>();

    const activeEditorRepoRoot = vscode.window.activeTextEditor
        ? resolveRepoLocationForDocument(vscode.window.activeTextEditor.document)?.repoRoot ?? null
        : null;
    addRepoSelectionCandidate(candidates, activeEditorRepoRoot, 'Active editor');

    for (const repoRoot of trackedRepoRoots) {
        addRepoSelectionCandidate(candidates, repoRoot, 'Tracked repo activity');
    }

    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
        addRepoSelectionCandidate(
            candidates,
            resolveRepoRootForFsPath(workspaceFolder.uri.fsPath),
            `Workspace folder: ${workspaceFolder.name}`
        );
    }

    return Array.from(candidates.values())
        .map((candidate) => ({
            label: path.basename(candidate.repoRoot) || candidate.repoRoot,
            description: Array.from(candidate.sources).sort().join(' • '),
            detail: candidate.repoRoot,
            repoRoot: candidate.repoRoot,
            sortKey: normalizeFsLikePath(candidate.repoRoot) ?? candidate.repoRoot.toLowerCase()
        }))
        .sort((left, right) => left.sortKey.localeCompare(right.sortKey));
}

function addRepoSelectionCandidate(
    candidates: Map<string, { repoRoot: string; sources: Set<string>; }>,
    repoRoot: string | null | undefined,
    source: string
): void {
    if (!repoRoot) {
        return;
    }

    const normalizedRepoRoot = normalizeFsLikePath(repoRoot) ?? repoRoot.toLowerCase();
    const existingCandidate = candidates.get(normalizedRepoRoot) ?? {
        repoRoot,
        sources: new Set<string>()
    };

    existingCandidate.repoRoot = repoRoot;
    existingCandidate.sources.add(source);
    candidates.set(normalizedRepoRoot, existingCandidate);
}
