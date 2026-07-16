import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';

import { profileOperation } from '../util/profiling';

const tempDirectories: string[] = [];
const originalProfileValue = process.env.AILOC2_PROFILE;

afterEach(() => {
    if (originalProfileValue === undefined) {
        delete process.env.AILOC2_PROFILE;
    }
    else {
        process.env.AILOC2_PROFILE = originalProfileValue;
    }

    while (tempDirectories.length > 0) {
        fs.rmSync(tempDirectories.pop()!, { recursive: true, force: true });
    }
});

test('profileOperation writes JSONL only when profiling is enabled', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-profile-'));
    tempDirectories.push(repoRoot);
    const profilePath = path.join(repoRoot, '.ailoc2-metrics', 'performance.jsonl');

    delete process.env.AILOC2_PROFILE;
    await profileOperation(repoRoot, 'disabled.operation', {}, async () => 1);
    assert.equal(fs.existsSync(profilePath), false);

    process.env.AILOC2_PROFILE = '1';
    const result = await profileOperation(repoRoot, 'enabled.operation', { fileCount: 3 }, async () => 42);
    const events = fs.readFileSync(profilePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    assert.equal(result, 42);
    assert.deepEqual(events.map((event) => ({
        operation: event.operation,
        success: event.success,
        fileCount: event.details?.fileCount,
        hasDuration: typeof event.durationMs === 'number' && event.durationMs >= 0
    })), [{
        operation: 'enabled.operation',
        success: true,
        fileCount: 3,
        hasDuration: true
    }]);
});
