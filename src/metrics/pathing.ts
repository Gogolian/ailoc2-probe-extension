import * as path from 'path';

import { FILE_STATE_SUFFIX } from './schema';

export function getMetricsRoot(repoRoot: string): string {
    return path.join(repoRoot, '.ailoc2-metrics');
}

export function getMetricsIgnoreFilePath(repoRoot: string): string {
    return path.join(getMetricsRoot(repoRoot), '.ignore');
}

export function getRepoProbeConfigFilePath(repoRoot: string): string {
    return path.join(repoRoot, '.ailoc2-probe.json');
}

export function getLocalProbeConfigFilePath(repoRoot: string): string {
    return path.join(getMetricsRoot(repoRoot), 'config.json');
}

export function getResolvedConfigSidecarPath(repoRoot: string): string {
    return path.join(getMetricsRoot(repoRoot), 'resolved-config.env');
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

export function getIntellijStatePath(repoRoot: string, repoRelativePath: string): string {
    const safeFileName = repoRelativePath
        .replace(/\\/g, '/')
        .replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(getMetricsRoot(repoRoot), 'intellij-state', `${safeFileName}.tsv`);
}

export function getRollingStatePath(repoRoot: string, repoRelativePath: string): string {
    if (path.isAbsolute(repoRelativePath)) {
        throw new Error(`Cannot derive rolling state path from absolute repoRelativePath='${repoRelativePath}'.`);
    }

    const normalizedPath = path.normalize(repoRelativePath);
    const pathSegments = normalizedPath
        .split(/[\\/]/)
        .filter((segment) => segment.length > 0);

    if (pathSegments.length === 0) {
        throw new Error(`Cannot derive rolling state path from repoRelativePath='${repoRelativePath}'.`);
    }

    if (pathSegments.some((segment) => segment === '..')) {
        throw new Error(`Refusing to derive rolling state path that escapes the metrics directory from repoRelativePath='${repoRelativePath}'.`);
    }

    const directorySegments = pathSegments.slice(0, -1);
    const fileName = `${pathSegments[pathSegments.length - 1]}${FILE_STATE_SUFFIX}`;
    const filesStateDirectory = getMetricsFilesStateDirectory(repoRoot);
    const rollingStatePath = path.join(filesStateDirectory, ...directorySegments, fileName);

    const relativeToFilesStateDirectory = path.relative(filesStateDirectory, rollingStatePath);
    if (relativeToFilesStateDirectory.startsWith('..') || path.isAbsolute(relativeToFilesStateDirectory)) {
        throw new Error(`Refusing to derive rolling state path that escapes the metrics directory from repoRelativePath='${repoRelativePath}'.`);
    }

    return rollingStatePath;
}
