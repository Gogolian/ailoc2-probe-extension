import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { RepoLocation } from './schema';

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
    if (!candidatePath) {
        return null;
    }

    const absolutePath = path.resolve(candidatePath);
    const repoRoot = resolveRepoRootForFsPath(absolutePath);
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

export function normalizeFsLikePath(candidatePath: string | null | undefined): string | null {
    if (!candidatePath) {
        return null;
    }

    return path.normalize(candidatePath).toLowerCase();
}

export function resolveRepoRootForFsPath(candidatePath: string): string | null {
    if (!candidatePath) {
        return null;
    }

    return findNearestRepoRoot(path.resolve(candidatePath));
}

function findNearestRepoRoot(candidatePath: string): string | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(candidatePath));
    const searchStart = fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()
        ? candidatePath
        : path.dirname(candidatePath);
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

function looksLikeRepoRoot(directoryPath: string): boolean {
    const gitPath = path.join(directoryPath, '.git');
    return fs.existsSync(gitPath);
}

function getRepoRelativePath(repoRoot: string, absolutePath: string): string | null {
    const relativePath = path.relative(repoRoot, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return null;
    }

    return path.normalize(relativePath);
}

function areSamePath(left: string, right: string): boolean {
    return normalizeFsLikePath(left) === normalizeFsLikePath(right);
}