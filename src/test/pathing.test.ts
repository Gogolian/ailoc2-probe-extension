import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { getMetricsFilesStateDirectory, getRollingStatePath } from '../metrics/pathing';

const repoRoot = path.resolve('/tmp/example-repo');

test('getRollingStatePath resolves inside the metrics files state directory', () => {
    const rollingStatePath = getRollingStatePath(repoRoot, path.join('src', 'index.ts'));
    const relative = path.relative(getMetricsFilesStateDirectory(repoRoot), rollingStatePath);

    assert.equal(relative.startsWith('..'), false);
    assert.equal(path.isAbsolute(relative), false);
});

test('getRollingStatePath rejects parent-directory traversal segments', () => {
    assert.throws(() => getRollingStatePath(repoRoot, path.join('..', '..', 'etc', 'passwd')));
    assert.throws(() => getRollingStatePath(repoRoot, path.join('src', '..', '..', '..', 'secret.txt')));
});

test('getRollingStatePath rejects forward-slash traversal on all platforms', () => {
    assert.throws(() => getRollingStatePath(repoRoot, '../../etc/passwd'));
});

test('getRollingStatePath rejects absolute repo-relative paths', () => {
    assert.throws(() => getRollingStatePath(repoRoot, path.resolve('/etc/passwd')));
});
