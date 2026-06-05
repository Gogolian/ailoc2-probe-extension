import { diffArrays } from 'diff';

import { LineDiffSegment } from './schema';

/**
 * Computes logical line-level diff segments between two document snapshots.
 *
 * Lines are compared **ignoring all whitespace**, so that a formatter or linter
 * that only reflows indentation or spacing (for example Prettier re-indentation,
 * gofmt tab/space changes, or spacing around operators) produces `equal`
 * segments instead of `removed` + `added` pairs.
 *
 * That distinction matters for attribution: the rolling per-line attribution
 * model preserves the previous attribution for `equal` segments but reassigns
 * `added` segments to the current event's bucket. Without whitespace-insensitive
 * matching, a human-triggered formatter run would silently rewrite previously
 * AI-attributed lines to Human. Ignoring whitespace here keeps the rolling line
 * model consistent with the summary layer, which already diffs Git content with
 * `--ignore-all-space`.
 *
 * Note: this only neutralizes *whitespace* reformatting. Non-whitespace linter
 * rewrites (quote normalization, semicolon insertion, import sorting) still
 * surface as real changes; see IMPROVEMENT_PLANS.md.
 */
export function createLineDiffSegments(beforeText: string | undefined, afterText: string): LineDiffSegment[] {
    const beforeLines = splitTextIntoLogicalLines(beforeText ?? '');
    const afterLines = splitTextIntoLogicalLines(afterText);

    return diffArrays(beforeLines, afterLines, { comparator: areLinesEqualIgnoringWhitespace }).map((part) => ({
        type: part.added ? 'added' : part.removed ? 'removed' : 'equal',
        lineCount: part.count ?? part.value.length
    }));
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

function stripAllWhitespace(line: string): string {
    return line.replace(/\s+/g, '');
}
