import * as fs from 'fs';

import { getMetricsSummaryFilePath } from '../metrics/pathing';
import { readRepoHookSummaryFile } from '../metrics/summary';

export const DEFAULT_AI_PLACEHOLDER_LABEL = 'unavailable';

const AI_SUBJECT_SUFFIX_PATTERN = /(?:^|\s+)(?:(?:\(AI:? [^)]*\)|\(AI lines: [^)]*\)|\(H lines: [^)]*\)|\(AI-Lines: [^)]*\))(?:\s+|$))+$/u;
const AI_LINES_BODY_PATTERN = /^\s*\(AI-Lines: [^)]*\)\s*$/u;

export type CommitMessageAnnotationResult = {
    messageFilePath: string;
    summaryFilePath: string;
    annotationText: string;
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
    const annotation = createAiLinesAnnotation({
        aiLineCount: hasGitSummary ? summary.staged.aiAddedLineCount : null,
        humanLineCount: hasGitSummary ? summary.staged.humanAddedLineCount : null,
        unknownLineCount: hasGitSummary ? summary.staged.unknownAddedLineCount : null,
        placeholderLabel: args.placeholderLabel
    });

    await applyAiLinesAnnotationToCommitMessageFile({
        messageFilePath: args.messageFilePath,
        annotationText: annotation.annotationText
    });

    return {
        messageFilePath: args.messageFilePath,
        summaryFilePath,
        annotationText: annotation.annotationText,
        usedPlaceholder: annotation.usedPlaceholder,
        summaryAvailable: hasGitSummary && !annotation.usedPlaceholder
    };
}

export async function applyAiLinesAnnotationToCommitMessageFile(args: {
    messageFilePath: string;
    annotationText: string;
}): Promise<void> {
    const currentMessageText = await fs.promises.readFile(args.messageFilePath, 'utf8');
    const nextMessageText = applyAiLinesAnnotationToCommitMessage(currentMessageText, args.annotationText);
    if (nextMessageText !== currentMessageText) {
        await fs.promises.writeFile(args.messageFilePath, nextMessageText, 'utf8');
    }
}

export function applyAiLinesAnnotationToCommitMessage(messageText: string, annotationText: string): string {
    const newline = detectNewline(messageText);
    const lines = messageText.split(/\r\n|\r|\n/u);
    const normalizedSubject = stripAiSuffix(lines[0] ?? '');
    const originalBodyLines = lines.slice(1);
    const bodyLines: string[] = [];
    for (let index = 0; index < originalBodyLines.length; index++) {
        const line = originalBodyLines[index];
        if (!AI_LINES_BODY_PATTERN.test(line)) {
            bodyLines.push(line);
            continue;
        }

        if (
            bodyLines.at(-1)?.trim().length === 0
            && originalBodyLines[index + 1]?.trim().length === 0
        ) {
            bodyLines.pop();
        }
    }

    while (bodyLines.length > 0 && bodyLines[0].trim().length === 0) {
        bodyLines.shift();
    }

    const annotatedLines = [normalizedSubject, '', annotationText];
    if (bodyLines.length > 0) {
        annotatedLines.push('', ...bodyLines);
    } else if (endsWithNewline(messageText)) {
        annotatedLines.push('');
    }

    return annotatedLines.join(newline);
}

export function createAiLinesAnnotation(args: {
    aiLineCount: number | null;
    humanLineCount: number | null;
    unknownLineCount: number | null;
    placeholderLabel?: string;
}): {
    annotationText: string;
    usedPlaceholder: boolean;
} {
    const totalLineCount = sumLineCounts(args.aiLineCount, args.humanLineCount, args.unknownLineCount);
    if (isValidLineCount(args.aiLineCount) && totalLineCount !== null) {
        return {
            annotationText: `(AI-Lines: ${args.aiLineCount}/${totalLineCount})`,
            usedPlaceholder: false
        };
    }

    const placeholderLabel = args.placeholderLabel ?? DEFAULT_AI_PLACEHOLDER_LABEL;
    return {
        annotationText: `(AI-Lines: ${placeholderLabel})`,
        usedPlaceholder: true
    };
}

function sumLineCounts(...lineCounts: Array<number | null>): number | null {
    if (!lineCounts.every(isValidLineCount)) {
        return null;
    }

    const totalLineCount = lineCounts.reduce<number>((total, lineCount) => total + lineCount, 0);
    return Number.isSafeInteger(totalLineCount) ? totalLineCount : null;
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

function endsWithNewline(text: string): boolean {
    return /(?:\r\n|\r|\n)$/u.test(text);
}
