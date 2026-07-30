import * as fs from 'fs';

import { getMetricsSummaryFilePath } from '../metrics/pathing';
import { readRepoHookSummaryFile } from '../metrics/summary';

export const DEFAULT_AI_PLACEHOLDER_LABEL = 'unavailable';

const AI_SUBJECT_SUFFIX_PATTERN = /(?:^|\s+)(?:(?:\(AI:? [^)]*\)|\(AI lines: [^)]*\)|\(H lines: [^)]*\)|\(AI-Lines: [^)]*\))(?:\s+|$))+$/u;
const AI_LINES_BODY_PATTERN = /^\s*\(AI-Lines: [^)]*\)\s*$/u;
const UNSURE_BODY_PATTERN = /^\s*\(Unsure: [^)]*\)\s*$/u;
const AI_LINES_ANNOTATION_PATTERN = /^\(AI-Lines: (?:(\d+)\/(\d+)|([^)]*))\)$/u;

export type CommitMessageAnnotationResult = {
    messageFilePath: string;
    summaryFilePath: string;
    annotationText: string;
    unsureAnnotationText: string;
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
        annotationText: annotation.annotationText,
        unsureAnnotationText: annotation.unsureAnnotationText
    });

    return {
        messageFilePath: args.messageFilePath,
        summaryFilePath,
        annotationText: annotation.annotationText,
        unsureAnnotationText: annotation.unsureAnnotationText,
        usedPlaceholder: annotation.usedPlaceholder,
        summaryAvailable: hasGitSummary && !annotation.usedPlaceholder
    };
}

export async function applyAiLinesAnnotationToCommitMessageFile(args: {
    messageFilePath: string;
    annotationText: string;
    unsureAnnotationText: string;
}): Promise<void> {
    const currentMessageText = await fs.promises.readFile(args.messageFilePath, 'utf8');
    const nextMessageText = applyAiLinesAnnotationToCommitMessage(
        currentMessageText,
        args.annotationText,
        args.unsureAnnotationText
    );
    if (nextMessageText !== currentMessageText) {
        await fs.promises.writeFile(args.messageFilePath, nextMessageText, 'utf8');
    }
}

export function applyAiLinesAnnotationToCommitMessage(
    messageText: string,
    annotationText: string,
    unsureAnnotationText: string
): string {
    const newline = detectNewline(messageText);
    const lines = messageText.split(/\r\n|\r|\n/u);
    const normalizedSubject = appendAiSubjectSuffix(stripAiSuffix(lines[0] ?? ''), annotationText);
    const originalBodyLines = lines.slice(1);
    const bodyLines: string[] = [];
    for (let index = 0; index < originalBodyLines.length; index++) {
        const line = originalBodyLines[index];
        if (!AI_LINES_BODY_PATTERN.test(line) && !UNSURE_BODY_PATTERN.test(line)) {
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

    const annotatedLines = [normalizedSubject, '', annotationText, unsureAnnotationText];
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
    unsureAnnotationText: string;
    usedPlaceholder: boolean;
} {
    const totalLineCount = sumLineCounts(args.aiLineCount, args.humanLineCount);
    if (
        isValidLineCount(args.aiLineCount)
        && isValidLineCount(args.unknownLineCount)
        && args.unknownLineCount <= args.aiLineCount
        && totalLineCount !== null
    ) {
        return {
            annotationText: `(AI-Lines: ${args.aiLineCount}/${totalLineCount})`,
            unsureAnnotationText: `(Unsure: ${args.unknownLineCount}/${args.aiLineCount})`,
            usedPlaceholder: false
        };
    }

    const placeholderLabel = args.placeholderLabel ?? DEFAULT_AI_PLACEHOLDER_LABEL;
    return {
        annotationText: `(AI-Lines: ${placeholderLabel})`,
        unsureAnnotationText: `(Unsure: ${placeholderLabel})`,
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

function appendAiSubjectSuffix(subjectLine: string, annotationText: string): string {
    const suffix = createAiSubjectSuffix(annotationText);
    return subjectLine.length > 0 ? `${subjectLine} ${suffix}` : suffix;
}

function createAiSubjectSuffix(annotationText: string): string {
    const match = AI_LINES_ANNOTATION_PATTERN.exec(annotationText);
    const aiLineCount = Number(match?.[1]);
    const totalLineCount = Number(match?.[2]);
    if (
        match?.[1] !== undefined
        && match[2] !== undefined
        && isValidLineCount(aiLineCount)
        && isValidLineCount(totalLineCount)
        && aiLineCount <= totalLineCount
    ) {
        return `(AI: ${formatAiLinePercentage(aiLineCount, totalLineCount)}%)`;
    }

    const placeholderLabel = match?.[3]?.trim() || DEFAULT_AI_PLACEHOLDER_LABEL;
    return `(AI: ${placeholderLabel})`;
}

function formatAiLinePercentage(aiLineCount: number, totalLineCount: number): string {
    if (totalLineCount === 0) {
        return '0';
    }

    return ((aiLineCount / totalLineCount) * 100)
        .toFixed(2)
        .replace(/\.?0+$/u, '');
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
