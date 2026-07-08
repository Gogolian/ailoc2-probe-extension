import * as fs from 'fs';
import * as path from 'path';

import { RepoLocation } from './schema';

export function normalizeFsLikePath(candidatePath: string | null | undefined): string | null {
    if (!candidatePath) {
        return null;
    }

    return path.normalize(candidatePath).toLowerCase();
}

export function looksLikeRepoRoot(directoryPath: string): boolean {
    return fs.existsSync(path.join(directoryPath, '.git'));
}

export function getRepoRelativePath(repoRoot: string, absolutePath: string): string | null {
    const relativePath = path.relative(repoRoot, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }

    return path.normalize(relativePath);
}

export function getSearchStartDirectory(candidatePath: string): string {
    try {
        return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()
            ? candidatePath
            : path.dirname(candidatePath);
    }
    catch {
        return path.dirname(candidatePath);
    }
}

export function buildRepoLocation(
    candidatePath: string,
    resolveRepoRoot: (absolutePath: string) => string | null
): RepoLocation | null {
    if (!candidatePath) {
        return null;
    }

    const absolutePath = path.resolve(candidatePath);
    const repoRoot = resolveRepoRoot(absolutePath);
    if (!repoRoot) {
        return null;
    }

    const repoRelativePath = getRepoRelativePath(repoRoot, absolutePath);
    if (!repoRelativePath) {
        return null;
    }

    return {
        repoRoot,
        repoRelativePath,
        logicalPath: normalizeFsLikePath(absolutePath) ?? absolutePath.toLowerCase()
    };
}
