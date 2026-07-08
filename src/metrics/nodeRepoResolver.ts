import * as path from 'path';

import { RepoLocation } from './schema';
import {
    buildRepoLocation,
    getSearchStartDirectory,
    looksLikeRepoRoot,
    normalizeFsLikePath
} from './repoResolverCore';

export function resolveRepoLocationForFsPathNode(candidatePath: string): RepoLocation | null {
    return buildRepoLocation(candidatePath, resolveRepoRootForFsPathNode);
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
    return normalizeFsLikePath(candidatePath);
}
