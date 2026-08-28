import assert from 'node:assert/strict';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import {
    stripMarkerLinesPreservingBytes,
    stripMarkersFromStagedFiles
} from '../metrics/markerStripping';

const tempDirectories: string[] = [];

afterEach(() => {
    while (tempDirectories.length > 0) {
        const directoryPath = tempDirectories.pop();
        if (!directoryPath) {
            continue;
        }

        fs.rmSync(directoryPath, { recursive: true, force: true });
    }
});

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function createRepo(prefix: string): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirectories.push(repoRoot);
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ail*c2@example.com']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    return repoRoot;
}

function stageFile(repoRoot: string, gitPath: string, content: Buffer | string): void {
    const absolutePath = path.join(repoRoot, path.normalize(gitPath));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
    runGit(repoRoot, ['add', '--', gitPath]);
}

function readIndexContent(repoRoot: string, gitPath: string): Buffer {
    return childProcess.execFileSync('git', ['show', `:${gitPath}`], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
}

function readIndexMode(repoRoot: string, gitPath: string): string {
    return runGit(repoRoot, ['ls-files', '--stage', '--', gitPath]).split(/\s+/)[0];
}

test('stripMarkerLinesPreservingBytes keeps CRLF terminators on surviving lines', () => {
    const content = Buffer.from('const a = 1;\r\n// AI start\r\nconst b = 2;\r\n// AI stop\r\n', 'utf8');

    const stripped = stripMarkerLinesPreservingBytes(content);

    assert.equal(stripped.removedLineCount, 2);
    assert.equal(stripped.content.toString('utf8'), 'const a = 1;\r\nconst b = 2;\r\n');
});

test('stripMarkerLinesPreservingBytes does not add a trailing newline', () => {
    const content = Buffer.from('// AI start\nconst a = 1;', 'utf8');

    const stripped = stripMarkerLinesPreservingBytes(content);

    assert.equal(stripped.content.toString('utf8'), 'const a = 1;', 'no trailing newline is invented');
});

test('stripMarkerLinesPreservingBytes leaves marker-free content byte-identical', () => {
    const content = Buffer.from('const a = 1;\nconst b = 2;\n', 'utf8');

    const stripped = stripMarkerLinesPreservingBytes(content);

    assert.equal(stripped.removedLineCount, 0);
    assert.ok(stripped.content.equals(content));
});

test('stripping removes markers from the index and the matching working tree', async () => {
    const repoRoot = createRepo('ailoc2-strip-basic-');
    const gitPath = 'src/app.ts';
    stageFile(repoRoot, gitPath, 'const a = 1;\n// AI start\nconst b = 2;\n// AI stop\n');

    const result = await stripMarkersFromStagedFiles({
        repoRoot,
        repoRelativePaths: [path.normalize(gitPath)]
    });

    assert.equal(result.strippedFileCount, 1);
    assert.equal(result.outcomes[0].updatedWorkingTree, true);
    assert.equal(readIndexContent(repoRoot, gitPath).toString('utf8'), 'const a = 1;\nconst b = 2;\n');
    assert.equal(
        fs.readFileSync(path.join(repoRoot, path.normalize(gitPath)), 'utf8'),
        'const a = 1;\nconst b = 2;\n'
    );
});

test('stripping preserves the executable bit instead of forcing mode 100644', async () => {
    const repoRoot = createRepo('ailoc2-strip-mode-');
    const gitPath = 'scripts/run.sh';
    stageFile(repoRoot, gitPath, '#!/bin/sh\n# AI start\necho hi\n# AI stop\n');
    runGit(repoRoot, ['update-index', '--chmod=+x', '--', gitPath]);
    assert.equal(readIndexMode(repoRoot, gitPath), '100755');

    await stripMarkersFromStagedFiles({ repoRoot, repoRelativePaths: [path.normalize(gitPath)] });

    assert.equal(readIndexMode(repoRoot, gitPath), '100755', 'executable bit survives stripping');
    assert.equal(readIndexContent(repoRoot, gitPath).toString('utf8'), '#!/bin/sh\necho hi\n');
});

test('stripping preserves CRLF line endings in the committed blob', async () => {
    const repoRoot = createRepo('ailoc2-strip-crlf-');
    const gitPath = 'src/win.ts';
    stageFile(repoRoot, gitPath, Buffer.from('const a = 1;\r\n// AI start\r\nconst b = 2;\r\n// AI stop\r\n', 'utf8'));

    await stripMarkersFromStagedFiles({ repoRoot, repoRelativePaths: [path.normalize(gitPath)] });

    assert.equal(readIndexContent(repoRoot, gitPath).toString('utf8'), 'const a = 1;\r\nconst b = 2;\r\n');
});

test('stripping does not clobber unstaged working-tree edits', async () => {
    const repoRoot = createRepo('ailoc2-strip-unstaged-');
    const gitPath = 'src/app.ts';
    const absolutePath = path.join(repoRoot, path.normalize(gitPath));
    stageFile(repoRoot, gitPath, 'const a = 1;\n// AI start\nconst b = 2;\n// AI stop\n');

    const unstagedContent = 'const a = 1;\n// AI start\nconst b = 2;\n// AI stop\nconst inProgress = 3;\n';
    fs.writeFileSync(absolutePath, unstagedContent, 'utf8');

    const result = await stripMarkersFromStagedFiles({
        repoRoot,
        repoRelativePaths: [path.normalize(gitPath)]
    });

    assert.equal(result.outcomes[0].status, 'stripped');
    assert.equal(result.outcomes[0].updatedWorkingTree, false);
    assert.equal(fs.readFileSync(absolutePath, 'utf8'), unstagedContent, 'work in progress is preserved');
    assert.equal(readIndexContent(repoRoot, gitPath).toString('utf8'), 'const a = 1;\nconst b = 2;\n');
});

test('stripping skips binary content', async () => {
    const repoRoot = createRepo('ailoc2-strip-binary-');
    const gitPath = 'assets/blob.bin';
    stageFile(repoRoot, gitPath, Buffer.from([0x41, 0x00, 0x42, 0x0a]));

    const result = await stripMarkersFromStagedFiles({
        repoRoot,
        repoRelativePaths: [path.normalize(gitPath)]
    });

    assert.equal(result.outcomes[0].status, 'skipped-binary');
    assert.equal(result.strippedFileCount, 0);
});

test('dry run reports what would change without touching the repo', async () => {
    const repoRoot = createRepo('ailoc2-strip-dry-run-');
    const gitPath = 'src/app.ts';
    const original = 'const a = 1;\n// AI start\nconst b = 2;\n// AI stop\n';
    stageFile(repoRoot, gitPath, original);

    const result = await stripMarkersFromStagedFiles({
        repoRoot,
        repoRelativePaths: [path.normalize(gitPath)],
        dryRun: true
    });

    assert.equal(result.outcomes[0].status, 'would-strip');
    assert.equal(result.outcomes[0].removedLineCount, 2);
    assert.equal(readIndexContent(repoRoot, gitPath).toString('utf8'), original, 'index is untouched');
    assert.equal(fs.readFileSync(path.join(repoRoot, path.normalize(gitPath)), 'utf8'), original);
});

test('files without markers report no-markers and are left alone', async () => {
    const repoRoot = createRepo('ailoc2-strip-none-');
    const gitPath = 'src/plain.ts';
    stageFile(repoRoot, gitPath, 'const a = 1;\n');

    const result = await stripMarkersFromStagedFiles({
        repoRoot,
        repoRelativePaths: [path.normalize(gitPath)]
    });

    assert.equal(result.outcomes[0].status, 'no-markers');
    assert.equal(readIndexContent(repoRoot, gitPath).toString('utf8'), 'const a = 1;\n');
});
