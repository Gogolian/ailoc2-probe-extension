import { diffArrays } from 'diff';

import { LineDiffSegment } from './schema';

type LineDiffOptions = {
    languageId?: string | null;
};

/**
 * Computes logical line-level diff segments between two document snapshots.
 *
 * Lines are compared using a conservative formatter-stable key, so common
 * formatter output produces `equal` segments instead of `removed` + `added`
 * pairs.
 *
 * That distinction matters for attribution: the rolling per-line attribution
 * model preserves the previous attribution for `equal` segments but reassigns
 * `added` segments to the current event's bucket. Without formatter-aware
 * matching, a human-triggered linter run would silently rewrite previously
 * AI-attributed lines to Human.
 */
export function createLineDiffSegments(
    beforeText: string | undefined,
    afterText: string,
    options: LineDiffOptions = {}
): LineDiffSegment[] {
    const beforeLines = splitTextIntoLogicalLines(beforeText ?? '');
    const afterLines = splitTextIntoLogicalLines(afterText);

    return diffArrays(beforeLines, afterLines, {
        comparator: (left, right) => areLinesEquivalentForAttribution(left, right, options.languageId)
    }).map((part) => createLineDiffSegment(
        part.added ? 'added' : part.removed ? 'removed' : 'equal',
        part.value
    ));
}

export function splitTextIntoLogicalLines(text: string): string[] {
    if (text.length === 0) {
        return [];
    }

    return text.split(/\r\n|\r|\n/);
}

export function areLinesEqualIgnoringWhitespace(left: string, right: string): boolean {
    return stripAllWhitespace(left) === stripAllWhitespace(right);
}

export function areLinesEquivalentForAttribution(
    left: string,
    right: string,
    languageId?: string | null
): boolean {
    if (areLinesEqualIgnoringWhitespace(left, right)) {
        return true;
    }

    if (!shouldUseFormatterStableNormalization(languageId)) {
        return false;
    }

    return createFormatterStableLineKey(left) === createFormatterStableLineKey(right);
}

function createLineDiffSegment(type: LineDiffSegment['type'], lines: string[]): LineDiffSegment {
    const segment: LineDiffSegment = {
        type,
        lineCount: lines.length
    };

    if (type === 'added') {
        segment.addedNonWhitespaceTextLength = sumNonWhitespaceTextLength(lines);
    }
    else if (type === 'removed') {
        segment.removedNonWhitespaceTextLength = sumNonWhitespaceTextLength(lines);
    }

    return segment;
}

function stripAllWhitespace(line: string): string {
    return line.replace(/\s+/g, '');
}

function shouldUseFormatterStableNormalization(languageId: string | null | undefined): boolean {
    return languageId === 'javascript'
        || languageId === 'javascriptreact'
        || languageId === 'typescript'
        || languageId === 'typescriptreact';
}

function createFormatterStableLineKey(line: string): string {
    const whitespaceFreeLine = stripAllWhitespace(line);
    const quoteStableLine = normalizeStringLiteralDelimiters(whitespaceFreeLine);
    return quoteStableLine.replace(/[;,]+$/u, '');
}

function normalizeStringLiteralDelimiters(line: string): string {
    return line.replace(/(['"])((?:\\.|(?!\1).)*)\1/gu, (_match, _quote, body: string) => `"${body}"`);
}

function sumNonWhitespaceTextLength(lines: string[]): number {
    return lines.reduce((sum, line) => sum + line.replace(/\s/gu, '').length, 0);
}
