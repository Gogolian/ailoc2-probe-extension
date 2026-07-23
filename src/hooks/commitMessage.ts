import * as fs from 'fs';

import { getMetricsSummaryFilePath } from '../metrics/pathing';
import { readRepoHookSummaryFile } from '../metrics/summary';

export const DEFAULT_AI_PLACEHOLDER_LABEL = 'unavailable';

const AI_SUBJECT_SUFFIX_PATTERN = /(?:^|\s+)(?:(?:\(AI:? [^)]*\)|\(AI lines: [^)]*\)|\(H lines: [^)]*\))(?:\s+|$))+$/u;

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
    const hasGitSummary = summary?.isGitSummaryAvailable === true;
    const suffix = createAiCommitSuffix({
        aiPercentage: hasGitSummary ? summary.staged.aiPercentage : null,
        aiLineCount: hasGitSummary ? summary.staged.aiAddedLineCount : null,
        humanLineCount: hasGitSummary ? summary.staged.humanAddedLineCount : null,
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
        summaryAvailable: hasGitSummary && !suffix.usedPlaceholder
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
    aiLineCount: number | null;
    humanLineCount: number | null;
    placeholderLabel?: string;
}): {
    suffixText: string;
    usedPlaceholder: boolean;
} {
    if (
        isValidPercentage(args.aiPercentage)
        && isValidLineCount(args.aiLineCount)
        && isValidLineCount(args.humanLineCount)
    ) {
        return {
            suffixText: ` (AI: ${args.aiPercentage.toFixed(2)}%) (AI lines: ${args.aiLineCount}) (H lines: ${args.humanLineCount})`,
            usedPlaceholder: false
        };
    }

    const placeholderLabel = args.placeholderLabel ?? DEFAULT_AI_PLACEHOLDER_LABEL;
    return {
        suffixText: ` (AI: ${placeholderLabel}) (AI lines: ${placeholderLabel}) (H lines: ${placeholderLabel})`,
        usedPlaceholder: true
    };
}

function isValidPercentage(value: number | null): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 0
        && value <= 100;
}

function isValidLineCount(value: number | null): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
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
