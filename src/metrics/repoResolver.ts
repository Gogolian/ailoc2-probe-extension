import * as path from 'path';
import * as vscode from 'vscode';

import { RepoLocation } from './schema';
import {
    buildRepoLocation,
    getSearchStartDirectory,
    looksLikeRepoRoot,
    normalizeFsLikePath
} from './repoResolverCore';

export function resolveRepoLocationForDocument(document: vscode.TextDocument): RepoLocation | null {
    if (document.uri.scheme !== 'file' || document.isUntitled) {
        return null;
    }

    return resolveRepoLocationForFsPath(document.uri.fsPath);
}

export function resolveRepoLocationForUri(uri: vscode.Uri): RepoLocation | null {
    if (uri.scheme !== 'file') {
        return null;
    }

    return resolveRepoLocationForFsPath(uri.fsPath);
}

export function resolveRepoLocationForFsPath(candidatePath: string): RepoLocation | null {
    return buildRepoLocation(candidatePath, resolveRepoRootForFsPath);
}

export { normalizeFsLikePath };

export function resolveRepoRootForFsPath(candidatePath: string): string | null {
    if (!candidatePath) {
        return null;
    }

    return findNearestRepoRoot(path.resolve(candidatePath));
}

function findNearestRepoRoot(candidatePath: string): string | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(candidatePath));
    const searchStart = getSearchStartDirectory(candidatePath);
    const workspaceBoundary = workspaceFolder ? path.resolve(workspaceFolder.uri.fsPath) : null;

    let currentDirectory = searchStart;
    while (true) {
        if (looksLikeRepoRoot(currentDirectory)) {
            return currentDirectory;
        }

        if (workspaceBoundary && areSamePath(currentDirectory, workspaceBoundary)) {
            break;
        }

        const parentDirectory = path.dirname(currentDirectory);
        if (areSamePath(parentDirectory, currentDirectory)) {
            break;
        }

        currentDirectory = parentDirectory;
    }

    if (workspaceBoundary && looksLikeRepoRoot(workspaceBoundary)) {
        return workspaceBoundary;
    }

    return null;
}

function areSamePath(left: string, right: string): boolean {
    return normalizeFsLikePath(left) === normalizeFsLikePath(right);
}
