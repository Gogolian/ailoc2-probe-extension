import * as path from 'path';

export const TRACKING_EXCLUDED_DIRECTORY_NAMES = new Set([
    '.ailoc2-metrics',
    '.ailoc-metrics'
]);

export const TRACKING_EXCLUDED_FILE_NAMES = new Set([
    '.gitignore'
]);

export function getTrackingExclusionReasonForPath(candidatePath: string | null | undefined): string | null {
    if (!candidatePath) {
        return null;
    }

    const normalizedPath = path.normalize(candidatePath);
    const lowerCaseSegments = normalizedPath
        .split(path.sep)
        .filter((segment) => segment.length > 0)
        .map((segment) => segment.toLowerCase());

    if (lowerCaseSegments.some((segment) => TRACKING_EXCLUDED_DIRECTORY_NAMES.has(segment))) {
        return 'MetricsArtifactsPath';
    }

    const fileName = path.basename(normalizedPath).toLowerCase();
    if (TRACKING_EXCLUDED_FILE_NAMES.has(fileName)) {
        return 'GitIgnoreFile';
    }

    return null;
}