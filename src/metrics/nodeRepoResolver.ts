import * as fs from 'fs';
import * as path from 'path';

import { RepoLocation } from './schema';

export function resolveRepoLocationForFsPathNode(candidatePath: string): RepoLocation | null {
    if (!candidatePath) {
        return null;
    }

    const absolutePath = path.resolve(candidatePath);
    const repoRoot = resolveRepoRootForFsPathNode(absolutePath);
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
        logicalPath: normalizeFsLikePathNode(absolutePath) ?? absolutePath.toLowerCase()
    };
}

export function resolveRepoRootForFsPathNode(candidatePath: string): string | null {
    if (!candidatePath) {
        return null;
    }

    let currentDirectory = getSearchStartDirectory(path.resolve(candidatePath));
    while (true) {
        if (looksLikeRepoRoot(currentDirectory)) {
            return currentDirectory;
        }

        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) {
            return null;
        }

        currentDirectory = parentDirectory;
    }
}

export function normalizeFsLikePathNode(candidatePath: string | null | undefined): string | null {
    if (!candidatePath) {
        return null;
    }

    return path.normalize(candidatePath).toLowerCase();
}

function getSearchStartDirectory(candidatePath: string): string {
    try {
        return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()
            ? candidatePath
            : path.dirname(candidatePath);
    }
    catch {
        return path.dirname(candidatePath);
    }
}

function looksLikeRepoRoot(directoryPath: string): boolean {
    return fs.existsSync(path.join(directoryPath, '.git'));
}

function getRepoRelativePath(repoRoot: string, absolutePath: string): string | null {
    const relativePath = path.relative(repoRoot, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }

    return path.normalize(relativePath);
}

