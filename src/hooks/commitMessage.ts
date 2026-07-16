import * as fs from 'fs';

import { getMetricsSummaryFilePath } from '../metrics/pathing';
import { readRepoHookSummaryFile } from '../metrics/summary';

export const DEFAULT_AI_PLACEHOLDER_LABEL = 'unavailable';

const AI_SUBJECT_SUFFIX_PATTERN = /\s+\(AI:? [^)]*\)$/u;

export type CommitMessageAnnotationResult = {
    messageFilePath: string;
    summaryFilePath: string;
    suffixText: string;
    usedPlaceholder: boolean;
    summaryAvailable: boolean;
};

export async function annotateCommitMessageFile(args: {
    repoRoot: string;
    messageFilePath: string;
    placeholderLabel?: string;
}): Promise<CommitMessageAnnotationResult> {
    const summaryFilePath = getMetricsSummaryFilePath(args.repoRoot);
    const summary = await readRepoHookSummaryFile(args.repoRoot);
    const suffix = createAiCommitSuffix({
        aiPercentage: summary?.isGitSummaryAvailable ? summary.staged.aiPercentage : null,
        placeholderLabel: args.placeholderLabel
    });

    await applyAiSuffixToCommitMessageFile({
        messageFilePath: args.messageFilePath,
        suffixText: suffix.suffixText
    });

    return {
        messageFilePath: args.messageFilePath,
        summaryFilePath,
        suffixText: suffix.suffixText,
        usedPlaceholder: suffix.usedPlaceholder,
        summaryAvailable: summary?.isGitSummaryAvailable ?? false
    };
}

export async function applyAiSuffixToCommitMessageFile(args: {
    messageFilePath: string;
    suffixText: string;
}): Promise<void> {
    const currentMessageText = await fs.promises.readFile(args.messageFilePath, 'utf8');
    const nextMessageText = applyAiSuffixToCommitMessage(currentMessageText, args.suffixText);
    if (nextMessageText !== currentMessageText) {
        await fs.promises.writeFile(args.messageFilePath, nextMessageText, 'utf8');
    }
}

export function applyAiSuffixToCommitMessage(messageText: string, suffixText: string): string {
    const newline = detectNewline(messageText);
    const lines = messageText.split(/\r\n|\r|\n/u);

    const normalizedSubject = stripAiSuffix(lines[0] ?? '');
    lines[0] = normalizedSubject.length > 0
        ? `${normalizedSubject}${suffixText}`
        : suffixText.trimStart();

    return lines.join(newline);
}

export function createAiCommitSuffix(args: {
    aiPercentage: number | null;
    placeholderLabel?: string;
}): {
    suffixText: string;
    usedPlaceholder: boolean;
} {
    if (typeof args.aiPercentage === 'number' && Number.isFinite(args.aiPercentage)) {
        return {
            suffixText: ` (AI: ${args.aiPercentage.toFixed(2)}%)`,
            usedPlaceholder: false
        };
    }

    return {
        suffixText: ` (AI: ${args.placeholderLabel ?? DEFAULT_AI_PLACEHOLDER_LABEL})`,
        usedPlaceholder: true
    };
}

function stripAiSuffix(subjectLine: string): string {
    return subjectLine.replace(AI_SUBJECT_SUFFIX_PATTERN, '').trimEnd();
}

function detectNewline(text: string): string {
    if (text.includes('\r\n')) {
        return '\r\n';
    }

    if (text.includes('\r')) {
        return '\r';
    }

    return '\n';
}
