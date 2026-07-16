import { isGitBlobOid, toGitRepoPath, tryRunGitCommand } from '../util/gitCommand';
import * as fs from 'fs';
import * as path from 'path';

const MAX_BATCH_PATH_COUNT = 200;
const MAX_BATCH_ARGUMENT_CHARACTERS = 24_000;

export async function getGitBlobOidForWorkingTreeFile(
    repoRoot: string,
    repoRelativePath: string
): Promise<string | null> {
    const gitPath = toGitRepoPath(repoRelativePath);
    const absolutePath = path.join(repoRoot, repoRelativePath);

    const stdout = await tryRunGitCommand(repoRoot, ['hash-object', '--path', gitPath, '--', absolutePath]);
    if (stdout === null) {
        return null;
    }

    const gitBlobOid = stdout.trim();
    return isGitBlobOid(gitBlobOid) ? gitBlobOid : null;
}

export async function getIndexGitBlobOid(
    repoRoot: string,
    repoRelativePath: string
): Promise<string | null> {
    const gitPath = toGitRepoPath(repoRelativePath);

    const stdout = await tryRunGitCommand(repoRoot, ['ls-files', '--stage', '--', gitPath]);
    if (stdout === null) {
        return null;
    }

    const stageZeroLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && /\s0\t/.test(line));
    if (!stageZeroLine) {
        return null;
    }

    const fields = stageZeroLine.split(/\s+/);
    const gitBlobOid = fields[1] ?? null;
    return gitBlobOid && isGitBlobOid(gitBlobOid) ? gitBlobOid : null;
}

export async function getIndexGitBlobOids(
    repoRoot: string,
    repoRelativePaths: readonly string[]
): Promise<Map<string, string | null>> {
    const result = createEmptyOidMap(repoRelativePaths);
    for (const pathBatch of createPathBatches(repoRelativePaths)) {
        const stdout = await tryRunGitCommand(repoRoot, [
            '-c',
            'core.quotepath=false',
            'ls-files',
            '--stage',
            '-z',
            '--',
            ...pathBatch.map(toGitRepoPath)
        ]);
        if (stdout === null) {
            continue;
        }

        for (const entry of stdout.split('\0')) {
            const match = /^\d+ ([0-9a-f]+) 0\t(.*)$/isu.exec(entry);
            if (!match || !isGitBlobOid(match[1])) {
                continue;
            }

            const repoRelativePath = path.normalize(match[2]);
            if (result.has(repoRelativePath)) {
                result.set(repoRelativePath, match[1]);
            }
        }
    }
    return result;
}

export async function getWorkingTreeGitBlobOids(
    repoRoot: string,
    repoRelativePaths: readonly string[]
): Promise<Map<string, string | null>> {
    const result = createEmptyOidMap(repoRelativePaths);
    const existingPaths: string[] = [];
    for (const repoRelativePath of repoRelativePaths) {
        try {
            const stats = await fs.promises.stat(path.join(repoRoot, repoRelativePath));
            if (stats.isFile()) {
                existingPaths.push(repoRelativePath);
            }
        }
        catch {
            continue;
        }
    }

    for (const pathBatch of createPathBatches(existingPaths)) {
        const stdout = await tryRunGitCommand(repoRoot, [
            'hash-object',
            '--',
            ...pathBatch.map(toGitRepoPath)
        ]);
        if (stdout === null) {
            continue;
        }

        const oidLines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
        if (oidLines.length !== pathBatch.length || oidLines.some((oid) => !isGitBlobOid(oid))) {
            continue;
        }

        for (let index = 0; index < pathBatch.length; index += 1) {
            result.set(path.normalize(pathBatch[index]), oidLines[index]);
        }
    }
    return result;
}

function createEmptyOidMap(repoRelativePaths: readonly string[]): Map<string, string | null> {
    return new Map(repoRelativePaths.map((repoRelativePath) => [path.normalize(repoRelativePath), null]));
}

function createPathBatches(repoRelativePaths: readonly string[]): string[][] {
    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentCharacterCount = 0;
    for (const repoRelativePath of repoRelativePaths) {
        const argumentLength = repoRelativePath.length + 1;
        if (
            currentBatch.length > 0
            && (currentBatch.length >= MAX_BATCH_PATH_COUNT
                || currentCharacterCount + argumentLength > MAX_BATCH_ARGUMENT_CHARACTERS)
        ) {
            batches.push(currentBatch);
            currentBatch = [];
            currentCharacterCount = 0;
        }

        currentBatch.push(repoRelativePath);
        currentCharacterCount += argumentLength;
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    return batches;
}
