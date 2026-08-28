/**
 * Comment-marker attribution, ported from the predecessor tool.
 *
 * The markers are matched anywhere in a line and the comment syntax is deliberately
 * irrelevant, which is how a single pattern covered `//`, `#`, `/* *\/`, `<!-- -->` and `--`.
 *
 * Two polarities are supported. `markers` tags AI code and treats everything else as human.
 * `human-markers` inverts that: unmarked lines are AI and only tagged blocks are human, which
 * suits workflows where AI writes most of the code and the human annotates their own edits.
 */

export const AI_MARKER_START_PATTERN = /ai[\s_\-]*start\b/i;
export const AI_MARKER_STOP_PATTERN = /ai[\s_\-]*stop\b/i;
export const HUMAN_MARKER_START_PATTERN = /human[\s_\-]*start\b/i;
export const HUMAN_MARKER_STOP_PATTERN = /human[\s_\-]*stop\b/i;

/**
 * Which author a marker block attributes its contents to. Lines outside any block get the
 * opposite bucket.
 */
export type MarkerPolarity = 'ai' | 'human';

export type MarkerFileAttribution = {
    repoRelativePath: string;
    aiAddedLineCount: number;
    humanAddedLineCount: number;
    aiWeight: number;
    humanWeight: number;
};

export function isAiMarkerLine(text: string): boolean {
    return AI_MARKER_START_PATTERN.test(text) || AI_MARKER_STOP_PATTERN.test(text);
}

export function isHumanMarkerLine(text: string): boolean {
    return HUMAN_MARKER_START_PATTERN.test(text) || HUMAN_MARKER_STOP_PATTERN.test(text);
}

export function isMarkerLineForPolarity(text: string, polarity: MarkerPolarity): boolean {
    return polarity === 'human' ? isHumanMarkerLine(text) : isAiMarkerLine(text);
}

export function stripAiMarkerLines(lines: readonly string[]): string[] {
    return lines.filter((line) => !isAiMarkerLine(line));
}

function getMarkerPatterns(polarity: MarkerPolarity): { start: RegExp; stop: RegExp } {
    return polarity === 'human'
        ? { start: HUMAN_MARKER_START_PATTERN, stop: HUMAN_MARKER_STOP_PATTERN }
        : { start: AI_MARKER_START_PATTERN, stop: AI_MARKER_STOP_PATTERN };
}

/**
 * Counts added lines per file from a unified diff. Lines inside a marker block are attributed
 * to `polarity`; every other added line gets the opposite bucket.
 *
 * Deliberately diverges from the legacy Python implementation, which: never reset block
 * state between files (so an unclosed block bled into every later file), did not support
 * nesting, and counted blank lines despite documenting otherwise. Marker lines themselves
 * are excluded from both the numerator and the denominator.
 */
export function parseMarkerDiffAttribution(
    diffText: string,
    polarity: MarkerPolarity = 'ai'
): MarkerFileAttribution[] {
    const { start: startPattern, stop: stopPattern } = getMarkerPatterns(polarity);
    const attributionByPath = new Map<string, MarkerFileAttribution>();
    let currentPath: string | null = null;
    let blockDepth = 0;

    for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            currentPath = null;
            blockDepth = 0;
            continue;
        }

        if (line.startsWith('+++ ')) {
            currentPath = normalizeDiffTargetPath(line.slice(4));
            blockDepth = 0;
            continue;
        }

        if (!currentPath || line.startsWith('---') || line.startsWith('@@')) {
            continue;
        }

        if (!line.startsWith('+') || line.startsWith('+++')) {
            continue;
        }

        const content = line.slice(1);

        if (startPattern.test(content)) {
            blockDepth += 1;
            continue;
        }

        if (stopPattern.test(content)) {
            blockDepth = Math.max(0, blockDepth - 1);
            continue;
        }

        const weight = getNonWhitespaceWeight(content);
        if (weight === 0) {
            continue;
        }

        const attribution = attributionByPath.get(currentPath) ?? {
            repoRelativePath: currentPath,
            aiAddedLineCount: 0,
            humanAddedLineCount: 0,
            aiWeight: 0,
            humanWeight: 0
        };

        const isInsideBlock = blockDepth > 0;
        const isAiLine = polarity === 'ai' ? isInsideBlock : !isInsideBlock;
        if (isAiLine) {
            attribution.aiAddedLineCount += 1;
            attribution.aiWeight += weight;
        }
        else {
            attribution.humanAddedLineCount += 1;
            attribution.humanWeight += weight;
        }

        attributionByPath.set(currentPath, attribution);
    }

    return Array.from(attributionByPath.values());
}

/**
 * Returns the repo-relative paths of files whose staged additions still contain markers.
 */
export function collectMarkerDiffPaths(diffText: string, polarity: MarkerPolarity = 'ai'): string[] {
    const paths = new Set<string>();
    let currentPath: string | null = null;

    for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith('+++ ')) {
            currentPath = normalizeDiffTargetPath(line.slice(4));
            continue;
        }

        if (!currentPath || !line.startsWith('+') || line.startsWith('+++')) {
            continue;
        }

        if (isMarkerLineForPolarity(line.slice(1), polarity)) {
            paths.add(currentPath);
        }
    }

    return Array.from(paths);
}

function normalizeDiffTargetPath(rawPath: string): string | null {
    let candidate = rawPath.trim();
    if (!candidate || candidate === '/dev/null') {
        return null;
    }

    if (candidate.startsWith('"') && candidate.endsWith('"') && candidate.length > 1) {
        candidate = candidate.slice(1, -1);
    }

    if (candidate.startsWith('b/')) {
        candidate = candidate.slice(2);
    }

    return candidate.length > 0 ? candidate : null;
}

function getNonWhitespaceWeight(text: string): number {
    return text.replace(/\s/gu, '').length;
}
