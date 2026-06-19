import * as crypto from 'crypto';
import * as path from 'path';

import { createLineDiffSegments, splitTextIntoLogicalLines } from '../../metrics/lineDiff';
import { resolveRepoLocationForFsPathNode } from '../../metrics/nodeRepoResolver';
import { METRICS_SCHEMA_VERSION, WorkspaceFileMetricEvent } from '../../metrics/schema';
import { RepoMetricsStore } from '../../metrics/store';

export type ClaudeCodeEditKind = 'Write' | 'Edit' | 'MultiEdit' | string;

export type ClaudeCodeEditRecordInput = {
    absoluteFilePath: string;
    beforeText: string;
    afterText: string;
    toolName: ClaudeCodeEditKind;
    invocationId: string;
    sessionId: string | null;
    cwd: string | null;
    recordedAt?: string;
};

export type ClaudeCodeEditRecordResult = {
    repoRoot: string;
    repoRelativePath: string;
    event: WorkspaceFileMetricEvent;
};

export async function recordClaudeCodeEdit(input: ClaudeCodeEditRecordInput): Promise<ClaudeCodeEditRecordResult> {
    const repoLocation = resolveRepoLocationForFsPathNode(input.absoluteFilePath);
    if (!repoLocation) {
        throw new Error(`Unable to resolve Git repository for Claude Code edit target: ${input.absoluteFilePath}`);
    }

    const event = createClaudeCodeWorkspaceFileMetricEvent({
        ...input,
        repoRoot: repoLocation.repoRoot,
        repoRelativePath: repoLocation.repoRelativePath,
        logicalPath: repoLocation.logicalPath
    });

    const store = new RepoMetricsStore(`claude-code:${input.sessionId ?? process.pid}`, () => {});
    store.queueWorkspaceFileMetric(event);
    store.noteDocumentSaved({
        repoRoot: repoLocation.repoRoot,
        repoRelativePath: repoLocation.repoRelativePath,
        savedAt: event.recordedAt,
        hash: event.afterHash ?? hashText(input.afterText),
        lineCount: event.lineCount,
        charLength: input.afterText.length,
        documentVersion: Date.now(),
        saveCorrelation: {
            hadRecentWillSave: false,
            possibleSaveWithoutWillSave: true
        }
    });
    await store.flushRepo(repoLocation.repoRoot);

    return {
        repoRoot: repoLocation.repoRoot,
        repoRelativePath: repoLocation.repoRelativePath,
        event
    };
}

export function createClaudeCodeWorkspaceFileMetricEvent(input: ClaudeCodeEditRecordInput & {
    repoRoot: string;
    repoRelativePath: string;
    logicalPath: string;
}): WorkspaceFileMetricEvent {
    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const beforeText = input.beforeText;
    const afterText = input.afterText;
    const languageId = inferLanguageId(input.absoluteFilePath);
    const signal = getClaudeCodeSignal(input.toolName, beforeText);
    const lineCount = splitTextIntoLogicalLines(afterText).length;

    return {
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'workspace-file-metric',
        eventId: `claude-code-${input.invocationId}-${hashText(input.absoluteFilePath)}`,
        recordedAt,
        extensionSessionId: `claude-code:${input.sessionId ?? 'unknown'}`,
        repoRoot: input.repoRoot,
        repoRelativePath: input.repoRelativePath,
        logicalPath: input.logicalPath,
        documentCategory: 'WorkspaceFile',
        signal,
        explanation: `Claude Code ${input.toolName} tool wrote this file.`,
        replacementRatio: getReplacementRatio(beforeText, afterText),
        totalInsertedTextLength: afterText.length,
        totalRemovedTextLength: beforeText.length,
        isWholeDocumentReplace: isWholeDocumentClaudeWrite(input.toolName),
        hasRecentSnapshotActivity: false,
        snapshotRequestIds: [],
        requestIds: [input.invocationId],
        lastChatScheme: 'claude-code',
        snapshotAgeMs: null,
        changeReason: 'ClaudeCodeToolUse',
        documentVersion: Date.now(),
        beforeHash: beforeText.length > 0 ? hashText(beforeText) : null,
        afterHash: hashText(afterText),
        beforeCharLength: beforeText.length,
        afterCharLength: afterText.length,
        lineCount,
        languageId,
        isDirty: false,
        lineDiffSegments: createLineDiffSegments(beforeText, afterText, { languageId }),
        chatCorrelation: {
            source: 'claude-code',
            toolName: input.toolName,
            invocationId: input.invocationId,
            sessionId: input.sessionId,
            cwd: input.cwd
        },
        saveCorrelation: null
    };
}

function getClaudeCodeSignal(toolName: string, beforeText: string): string {
    if (isWholeDocumentClaudeWrite(toolName) || beforeText.length === 0) {
        return 'ProbableAIApplyToWorkspaceFile';
    }

    return 'ProbableAIBulkWorkspaceEdit';
}

function isWholeDocumentClaudeWrite(toolName: string): boolean {
    return toolName.toLowerCase() === 'write';
}

function getReplacementRatio(beforeText: string, afterText: string): number | null {
    const baselineLength = Math.max(beforeText.length, afterText.length);
    return baselineLength > 0
        ? Math.max(beforeText.length, afterText.length) / baselineLength
        : null;
}

function inferLanguageId(filePath: string): string {
    switch (path.extname(filePath).toLowerCase()) {
        case '.js':
        case '.mjs':
        case '.cjs':
            return 'javascript';
        case '.jsx':
            return 'javascriptreact';
        case '.ts':
        case '.mts':
        case '.cts':
            return 'typescript';
        case '.tsx':
            return 'typescriptreact';
        case '.json':
            return 'json';
        case '.md':
        case '.markdown':
            return 'markdown';
        default:
            return 'plaintext';
    }
}

function hashText(text: string): string {
    return crypto
        .createHash('sha256')
        .update(text, 'utf8')
        .digest('hex')
        .slice(0, 16);
}

