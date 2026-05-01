import * as path from 'path';

import { FILE_STATE_SUFFIX } from './schema';

export function getMetricsRoot(repoRoot: string): string {
    return path.join(repoRoot, '.ailoc2-metrics');
}

export function getMetricsSummaryFilePath(repoRoot: string): string {
    return path.join(getMetricsRoot(repoRoot), 'summary.json');
}

export function getMetricsStateDirectory(repoRoot: string): string {
    return path.join(getMetricsRoot(repoRoot), 'state');
}

export function getRepoSummaryStatePath(repoRoot: string): string {
    return path.join(getMetricsStateDirectory(repoRoot), 'repo-summary.json');
}

export function getPreparedCommitBaselinePath(repoRoot: string): string {
    return path.join(getMetricsStateDirectory(repoRoot), 'pending-commit-baseline.json');
}

export function getMetricsFilesStateDirectory(repoRoot: string): string {
    return path.join(getMetricsStateDirectory(repoRoot), 'files');
}

export function getMetricsManifestPath(repoRoot: string): string {
    return path.join(getMetricsRoot(repoRoot), 'manifest.json');
}

export function getRollingStatePath(repoRoot: string, repoRelativePath: string): string {
    const normalizedPath = path.normalize(repoRelativePath);
    const pathSegments = normalizedPath
        .split(path.sep)
        .filter((segment) => segment.length > 0);

    if (pathSegments.length === 0) {
        throw new Error(`Cannot derive rolling state path from repoRelativePath='${repoRelativePath}'.`);
    }

    const directorySegments = pathSegments.slice(0, -1);
    const fileName = `${pathSegments[pathSegments.length - 1]}${FILE_STATE_SUFFIX}`;
    return path.join(getMetricsFilesStateDirectory(repoRoot), ...directorySegments, fileName);
}