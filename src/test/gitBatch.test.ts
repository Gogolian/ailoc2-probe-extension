import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';

import { getIndexGitBlobOids, getWorkingTreeGitBlobOids } from '../metrics/git';

const tempDirectories: string[] = [];

afterEach(() => {
    while (tempDirectories.length > 0) {
        fs.rmSync(tempDirectories.pop()!, { recursive: true, force: true });
    }
});

test('batch Git OID lookups resolve index and working-tree blobs', async () => {
    const repoRoot = createGitRepo();
    const firstPath = path.normalize('src/first file.txt');
    const secondPath = path.normalize('src/second.txt');
    const missingPath = path.normalize('src/missing.txt');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, firstPath), 'first\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, secondPath), 'second\n', 'utf8');
    runGit(repoRoot, ['add', '--', 'src/first file.txt', 'src/second.txt']);

    const paths = [firstPath, secondPath, missingPath];
    const indexOids = await getIndexGitBlobOids(repoRoot, paths);
    const workingTreeOids = await getWorkingTreeGitBlobOids(repoRoot, paths);

    assert.deepEqual({
        firstIndex: indexOids.get(firstPath),
        firstWorkingTree: workingTreeOids.get(firstPath),
        secondIndex: indexOids.get(secondPath),
        secondWorkingTree: workingTreeOids.get(secondPath),
        missingIndex: indexOids.get(missingPath),
        missingWorkingTree: workingTreeOids.get(missingPath)
    }, {
        firstIndex: readGitOid(repoRoot, ['rev-parse', ':src/first file.txt']),
        firstWorkingTree: readGitOid(repoRoot, ['hash-object', '--', 'src/first file.txt']),
        secondIndex: readGitOid(repoRoot, ['rev-parse', ':src/second.txt']),
        secondWorkingTree: readGitOid(repoRoot, ['hash-object', '--', 'src/second.txt']),
        missingIndex: null,
        missingWorkingTree: null
    });
});

function createGitRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-git-batch-'));
    tempDirectories.push(repoRoot);
    runGit(repoRoot, ['init']);
    return repoRoot;
}

function readGitOid(repoRoot: string, args: string[]): string {
    return runGit(repoRoot, args).trim();
}

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}
