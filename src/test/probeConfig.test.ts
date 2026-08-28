import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
    createDefaultProbeConfig,
    invalidateProbeConfigCache,
    readProbeConfig,
    readProbeConfigSync,
    writeLocalProbeConfigOverride
} from '../metrics/probeConfig';
import { getLocalProbeConfigFilePath, getRepoProbeConfigFilePath } from '../metrics/pathing';

function createTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-probe-config-'));
    invalidateProbeConfigCache(repoRoot);
    return repoRoot;
}

function writeRepoLayer(repoRoot: string, contents: unknown): void {
    const filePath = getRepoProbeConfigFilePath(repoRoot);
    fs.writeFileSync(filePath, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
    invalidateProbeConfigCache(repoRoot);
}

function writeLocalLayer(repoRoot: string, contents: unknown): void {
    const filePath = getLocalProbeConfigFilePath(repoRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
    invalidateProbeConfigCache(repoRoot);
}

test('readProbeConfig falls back to defaults when no config file exists', async () => {
    const repoRoot = createTempRepo();
    const config = await readProbeConfig(repoRoot);
    const defaults = createDefaultProbeConfig();

    assert.equal(config.attribution.mode, defaults.attribution.mode);
    assert.equal(config.attribution.largeFileIsAI, true);
    assert.equal(config.attribution.newFileIsAI, true);
    assert.deepEqual(config.attribution.excludePaths, []);
    assert.equal(config.isAttributionExcluded('src/index.ts'), false);
});

test('defaults preserve current behavior so existing repos are unaffected', () => {
    const defaults = createDefaultProbeConfig();

    assert.equal(defaults.attribution.mode, 'signals');
    assert.equal(defaults.attribution.largeFileIsAI, true);
    assert.equal(defaults.attribution.newFileIsAI, true);
});

test('readProbeConfig reads the committed repo layer', async () => {
    const repoRoot = createTempRepo();
    writeRepoLayer(repoRoot, {
        version: 1,
        attribution: { mode: 'markers', largeFileIsAI: false, newFileIsAI: false, excludePaths: ['vendor/**'] }
    });

    const config = await readProbeConfig(repoRoot);

    assert.equal(config.attribution.mode, 'markers');
    assert.equal(config.attribution.largeFileIsAI, false);
    assert.equal(config.attribution.newFileIsAI, false);
    assert.equal(config.isAttributionExcluded('vendor/lib/thing.js'), true);
});

test('local layer overrides the repo layer per leaf', async () => {
    const repoRoot = createTempRepo();
    writeRepoLayer(repoRoot, {
        attribution: { mode: 'markers', largeFileIsAI: false, newFileIsAI: false }
    });
    writeLocalLayer(repoRoot, {
        attribution: { mode: 'signals' }
    });

    const config = await readProbeConfig(repoRoot);

    assert.equal(config.attribution.mode, 'signals', 'local layer wins');
    assert.equal(config.attribution.largeFileIsAI, false, 'unspecified leaves fall through to the repo layer');
    assert.equal(config.attribution.newFileIsAI, false);
});

test('excludePaths concatenates team-then-local so local can re-include with negation', async () => {
    const repoRoot = createTempRepo();
    writeRepoLayer(repoRoot, {
        attribution: { excludePaths: ['vendor/**', '*.generated.ts'] }
    });
    writeLocalLayer(repoRoot, {
        attribution: { excludePaths: ['!vendor/keep-me.js', 'scratch/**'] }
    });

    const config = await readProbeConfig(repoRoot);

    assert.equal(config.isAttributionExcluded('vendor/lib/thing.js'), true, 'team exclusion still applies');
    assert.equal(config.isAttributionExcluded('vendor/keep-me.js'), false, 'local negation re-includes');
    assert.equal(config.isAttributionExcluded('scratch/notes.md'), true, 'local exclusion applies');
    assert.equal(config.isAttributionExcluded('src/api.generated.ts'), true, 'extension glob applies');
    assert.equal(config.isAttributionExcluded('src/api.ts'), false);
});

test('malformed JSON degrades to defaults instead of throwing into a git hook', async () => {
    const repoRoot = createTempRepo();
    writeRepoLayer(repoRoot, '{ this is not json');

    const config = await readProbeConfig(repoRoot);

    assert.equal(config.attribution.mode, 'signals');
    assert.equal(config.attribution.largeFileIsAI, true);
});

test('unknown mode values fall back instead of being trusted', async () => {
    const repoRoot = createTempRepo();
    writeRepoLayer(repoRoot, { attribution: { mode: 'wat', largeFileIsAI: 'yes' } });

    const config = await readProbeConfig(repoRoot);

    assert.equal(config.attribution.mode, 'signals');
    assert.equal(config.attribution.largeFileIsAI, true, 'non-boolean is rejected');
});

test('readProbeConfigSync agrees with the async reader', async () => {
    const repoRoot = createTempRepo();
    writeRepoLayer(repoRoot, {
        attribution: { mode: 'markers', largeFileIsAI: false, excludePaths: ['dist/**'] }
    });

    const asyncConfig = await readProbeConfig(repoRoot);
    const syncConfig = readProbeConfigSync(repoRoot);

    assert.equal(syncConfig.attribution.mode, asyncConfig.attribution.mode);
    assert.equal(syncConfig.attribution.largeFileIsAI, asyncConfig.attribution.largeFileIsAI);
    assert.equal(syncConfig.isAttributionExcluded('dist/bundle.js'), true);
});

test('writeLocalProbeConfigOverride toggles a leaf without touching team policy', async () => {
    const repoRoot = createTempRepo();
    const teamContents = `${JSON.stringify({
        version: 1,
        attribution: { mode: 'signals', largeFileIsAI: true, newFileIsAI: true, excludePaths: ['vendor/**'] }
    }, null, 2)}\n`;
    fs.writeFileSync(getRepoProbeConfigFilePath(repoRoot), teamContents, 'utf8');
    invalidateProbeConfigCache(repoRoot);

    await writeLocalProbeConfigOverride(repoRoot, { mode: 'markers' });
    const config = await readProbeConfig(repoRoot);

    assert.equal(config.attribution.mode, 'markers');
    assert.equal(config.attribution.largeFileIsAI, true, 'untouched leaves still come from team policy');
    assert.equal(config.isAttributionExcluded('vendor/thing.js'), true, 'team exclusions survive');
    assert.equal(
        fs.readFileSync(getRepoProbeConfigFilePath(repoRoot), 'utf8'),
        teamContents,
        'the committed file is never rewritten by a toggle'
    );
});

test('writeLocalProbeConfigOverride accumulates successive toggles', async () => {
    const repoRoot = createTempRepo();

    await writeLocalProbeConfigOverride(repoRoot, { largeFileIsAI: false });
    await writeLocalProbeConfigOverride(repoRoot, { newFileIsAI: false });
    const config = await readProbeConfig(repoRoot);

    assert.equal(config.attribution.largeFileIsAI, false, 'the earlier toggle is preserved');
    assert.equal(config.attribution.newFileIsAI, false);
});

test('invalidateProbeConfigCache picks up a same-millisecond rewrite', async () => {
    const repoRoot = createTempRepo();
    writeRepoLayer(repoRoot, { attribution: { mode: 'signals' } });
    assert.equal((await readProbeConfig(repoRoot)).attribution.mode, 'signals');

    // Same byte length as the value above, so an mtime-only signature could miss it.
    fs.writeFileSync(
        getRepoProbeConfigFilePath(repoRoot),
        JSON.stringify({ attribution: { mode: 'markers' } }),
        'utf8'
    );
    invalidateProbeConfigCache(repoRoot);

    assert.equal((await readProbeConfig(repoRoot)).attribution.mode, 'markers');
});
