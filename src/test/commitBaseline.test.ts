import assert from 'node:assert/strict';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import {
    getMetricsIgnoreFilePath,
    getPreparedCommitBaselinePath,
    getRepoSummaryStatePath,
    getRollingStatePath
} from '../metrics/pathing';
import { createLineDiffSegments } from '../metrics/lineDiff';
import { METRICS_SCHEMA_VERSION } from '../metrics/schema';
import { RepoMetricsStore } from '../metrics/store';
import { finalizeRepoCommit, prepareRepoCommitBaseline, prepareRepoPreCommit, refreshRepoHookSummary } from '../metrics/summary';

const tempDirectories: string[] = [];
const FLOATING_POINT_TOLERANCE = 0.000_001;

afterEach(() => {
    while (tempDirectories.length > 0) {
        const directoryPath = tempDirectories.pop();
        if (!directoryPath) {
            continue;
        }

        fs.rmSync(directoryPath, { recursive: true, force: true });
    }
});

test('finalizeRepoCommit advances the baseline to the committed index state', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-commit-baseline-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const gitRelativePath = 'src/example.txt';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'base\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    fs.writeFileSync(absoluteFilePath, 'committed\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    fs.writeFileSync(absoluteFilePath, 'committed\nleftover\n', 'utf8');

    const stagedBlobOid = readIndexBlobOid(repoRoot, gitRelativePath);
    const workingTreeBlobOid = runGit(repoRoot, ['hash-object', '--path', gitRelativePath, '--', absoluteFilePath]).trim();

    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: 'LikelyHumanOrRegularEditorEdit',
        signalCounters: {
            ProbableAIApplyToWorkspaceFile: 0,
            PossibleAIApplyToWorkspaceFile: 0,
            LikelyHumanEditWhileChatSessionOpen: 0,
            LikelyHumanOrRegularEditorEdit: 1
        },
        cumulativeAiChangeMagnitude: 10,
        cumulativeHumanChangeMagnitude: 6,
        saveAttributionCheckpoints: [
            {
                gitBlobOid: stagedBlobOid,
                cumulativeAiChangeMagnitude: 8,
                cumulativeHumanChangeMagnitude: 3,
                lineAttributionSpans: []
            },
            {
                gitBlobOid: workingTreeBlobOid,
                cumulativeAiChangeMagnitude: 10,
                cumulativeHumanChangeMagnitude: 6,
                lineAttributionSpans: []
            }
        ],
        lineAttributionSpans: [],
        deletedAt: null
    }, null, 2), 'utf8');

    await prepareRepoCommitBaseline({ repoRoot });

    const preparedBaselinePath = getPreparedCommitBaselinePath(repoRoot);
    const preparedBaseline = JSON.parse(fs.readFileSync(preparedBaselinePath, 'utf8')) as {
        cleanBaselineByRepoRelativePath: Record<string, { aiChangeMagnitude: number; humanChangeMagnitude: number; }>;
    };
    assert.deepEqual(preparedBaseline.cleanBaselineByRepoRelativePath[repoRelativePath], {
        aiChangeMagnitude: 8,
        humanChangeMagnitude: 3
    });

    runGit(repoRoot, ['commit', '-m', 'stage only']);

    const finalizationResult = await finalizeRepoCommit({ repoRoot });
    const repoSummaryState = JSON.parse(fs.readFileSync(getRepoSummaryStatePath(repoRoot), 'utf8')) as {
        cleanBaselineByRepoRelativePath: Record<string, { aiChangeMagnitude: number; humanChangeMagnitude: number; }>;
    };

    assert.equal(finalizationResult.baselineSource, 'prepared');
    assert.deepEqual(repoSummaryState.cleanBaselineByRepoRelativePath[repoRelativePath], {
        aiChangeMagnitude: 8,
        humanChangeMagnitude: 3
    });
    assert.equal(finalizationResult.clearedRollingStateFileCount, 0);
    assert.equal(finalizationResult.preservedUnstagedFileCount, 1);
    assert.equal(fs.existsSync(rollingStatePath), true);
    assert.ok(Math.abs(finalizationResult.summary.unstaged.aiPercentage - 40) < FLOATING_POINT_TOLERANCE);
    assert.ok(Math.abs(finalizationResult.summary.unstaged.humanPercentage - 60) < FLOATING_POINT_TOLERANCE);
});

test('finalizeRepoCommit clears rolling state for fully committed files', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-commit-cleanup-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const gitRelativePath = 'src/example.txt';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'base\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    fs.writeFileSync(absoluteFilePath, 'committed\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);

    const stagedBlobOid = readIndexBlobOid(repoRoot, gitRelativePath);
    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: 'ProbableAIApplyToWorkspaceFile',
        signalCounters: {
            ProbableAIApplyToWorkspaceFile: 1,
            PossibleAIApplyToWorkspaceFile: 0,
            LikelyHumanEditWhileChatSessionOpen: 0,
            LikelyHumanOrRegularEditorEdit: 0
        },
        cumulativeAiChangeMagnitude: 12,
        cumulativeHumanChangeMagnitude: 0,
        saveAttributionCheckpoints: [
            {
                gitBlobOid: stagedBlobOid,
                cumulativeAiChangeMagnitude: 12,
                cumulativeHumanChangeMagnitude: 0,
                lineAttributionSpans: []
            }
        ],
        lineAttributionSpans: [],
        deletedAt: null
    }, null, 2), 'utf8');

    await prepareRepoCommitBaseline({ repoRoot });
    runGit(repoRoot, ['commit', '-m', 'stage only']);

    const finalizationResult = await finalizeRepoCommit({ repoRoot });
    const repoSummaryState = JSON.parse(fs.readFileSync(getRepoSummaryStatePath(repoRoot), 'utf8')) as {
        cleanBaselineByRepoRelativePath: Record<string, { aiChangeMagnitude: number; humanChangeMagnitude: number; }>;
    };

    assert.equal(finalizationResult.baselineSource, 'prepared');
    assert.equal(finalizationResult.clearedRollingStateFileCount, 1);
    assert.equal(finalizationResult.preservedUnstagedFileCount, 0);
    assert.equal(fs.existsSync(rollingStatePath), false);
    assert.equal(repoSummaryState.cleanBaselineByRepoRelativePath[repoRelativePath], undefined);
    assert.equal(finalizationResult.summary.staged.changedFileCount, 0);
    assert.equal(finalizationResult.summary.unstaged.changedFileCount, 0);
});

test('prepareRepoPreCommit resolves only staged rolling states and preserves unrelated baselines', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-staged-baseline-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const stagedPath = path.normalize('src/staged.txt');
    const unrelatedPath = path.normalize('src/unrelated.txt');
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, stagedPath), 'base staged\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, unrelatedPath), 'base unrelated\n', 'utf8');
    runGit(repoRoot, ['add', 'src/staged.txt', 'src/unrelated.txt']);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    fs.writeFileSync(path.join(repoRoot, stagedPath), 'next staged\n', 'utf8');
    runGit(repoRoot, ['add', 'src/staged.txt']);
    const stagedOid = readIndexBlobOid(repoRoot, 'src/staged.txt');
    const unrelatedOid = readIndexBlobOid(repoRoot, 'src/unrelated.txt');
    writeRollingState(repoRoot, stagedPath, stagedOid, 10, 0);
    writeRollingState(repoRoot, unrelatedPath, unrelatedOid, 99, 0);

    fs.mkdirSync(path.dirname(getRepoSummaryStatePath(repoRoot)), { recursive: true });
    fs.writeFileSync(getRepoSummaryStatePath(repoRoot), JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'repo-summary-state',
        repoRoot,
        lastComputedAt: new Date().toISOString(),
        lastCleanAt: null,
        cleanBaselineByRepoRelativePath: {
            [unrelatedPath]: {
                aiChangeMagnitude: 2,
                humanChangeMagnitude: 3
            }
        }
    }), 'utf8');

    const preparation = await prepareRepoPreCommit({ repoRoot });
    const preparedBaseline = JSON.parse(fs.readFileSync(getPreparedCommitBaselinePath(repoRoot), 'utf8')) as {
        cleanBaselineByRepoRelativePath: Record<string, { aiChangeMagnitude: number; humanChangeMagnitude: number; }>;
    };

    assert.equal(preparation.baseline.resolvedFileCount, 1);
    assert.equal(preparation.summary.summary.staged.changedFileCount, 1);
    assert.deepEqual(preparedBaseline.cleanBaselineByRepoRelativePath, {
        [unrelatedPath]: {
            aiChangeMagnitude: 2,
            humanChangeMagnitude: 3
        },
        [stagedPath]: {
            aiChangeMagnitude: 10,
            humanChangeMagnitude: 0
        }
    });
});

test('refreshRepoHookSummary needs flushed rolling state to attribute the first staged commit', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-first-commit-flush-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const gitRelativePath = 'src/example.txt';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'base\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    const aiText = 'ai line one\nai line two\n';
    fs.writeFileSync(absoluteFilePath, aiText, 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);

    const metricsStore = new RepoMetricsStore('test-session', () => {});
    const recordedAt = new Date().toISOString();

    metricsStore.queueWorkspaceFileMetric({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'workspace-file-metric',
        eventId: 'event-1',
        recordedAt,
        extensionSessionId: 'test-session',
        repoRoot,
        repoRelativePath,
        logicalPath: absoluteFilePath,
        documentCategory: 'WorkspaceFile',
        signal: 'ProbableAIApplyToWorkspaceFile',
        explanation: 'Synthetic AI edit for the first staged commit path.',
        replacementRatio: 1,
        totalInsertedTextLength: aiText.length,
        totalRemovedTextLength: 'base\n'.length,
        isWholeDocumentReplace: true,
        hasRecentSnapshotActivity: true,
        snapshotRequestIds: ['request-1'],
        requestIds: ['request-1'],
        lastChatScheme: 'chat-editing-snapshot-text-model',
        snapshotAgeMs: 0,
        changeReason: 'RegularEditOrUnknown',
        documentVersion: 2,
        beforeHash: 'before-hash',
        afterHash: 'after-hash',
        beforeCharLength: 'base\n'.length,
        afterCharLength: aiText.length,
        lineCount: 2,
        languageId: 'plaintext',
        isDirty: false,
        lineDiffSegments: [
            {
                type: 'removed',
                lineCount: 1
            },
            {
                type: 'added',
                lineCount: 2
            }
        ],
        chatCorrelation: null,
        saveCorrelation: null
    });
    metricsStore.noteDocumentSaved({
        repoRoot,
        repoRelativePath,
        savedAt: recordedAt,
        hash: 'after-hash',
        lineCount: 2,
        charLength: aiText.length,
        documentVersion: 2,
        saveCorrelation: {
            hadRecentWillSave: false,
            possibleSaveWithoutWillSave: true
        }
    });

    const repoQueue = (metricsStore as any).repoQueues.get(repoRoot) as {
        flushTimer: NodeJS.Timeout | null;
    } | undefined;
    if (repoQueue?.flushTimer) {
        clearTimeout(repoQueue.flushTimer);
        repoQueue.flushTimer = null;
    }

    const beforeFlush = await refreshRepoHookSummary({ repoRoot });
    assert.equal(beforeFlush.summary.isGitSummaryAvailable, true);
    assert.equal(beforeFlush.summary.staged.changedFileCount, 1);
    assert.equal(beforeFlush.summary.staged.attributedChangedFileCount, 0);
    assert.equal(beforeFlush.summary.staged.aiPercentage, 0);
    assert.equal(beforeFlush.summary.staged.aiAddedLineCount, 0);
    assert.equal(beforeFlush.summary.staged.humanAddedLineCount, 0);
    assert.equal(beforeFlush.summary.staged.unknownAddedLineCount, 2);

    await metricsStore.flushRepo(repoRoot);

    const afterFlush = await refreshRepoHookSummary({ repoRoot });
    assert.equal(afterFlush.summary.isGitSummaryAvailable, true);
    assert.equal(afterFlush.summary.staged.changedFileCount, 1);
    assert.equal(afterFlush.summary.staged.attributedChangedFileCount, 1);
    assert.ok(Math.abs(afterFlush.summary.staged.aiPercentage - 100) < FLOATING_POINT_TOLERANCE);
    assert.equal(afterFlush.summary.staged.humanPercentage, 0);
    assert.equal(afterFlush.summary.staged.aiAddedLineCount, 2);
    assert.equal(afterFlush.summary.staged.humanAddedLineCount, 0);
    assert.equal(afterFlush.summary.staged.unknownAddedLineCount, 0);
});

test('metrics ignore rules skip metrics files and diff attribution for ignored paths', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-metrics-ignore-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const ignoredGitPath = 'src/generated/ignored.txt';
    const includedGitPath = 'src/generated/included.txt';
    const ignoredRepoRelativePath = path.normalize(ignoredGitPath);
    const includedRepoRelativePath = path.normalize(includedGitPath);
    const ignoredAbsolutePath = path.join(repoRoot, ignoredRepoRelativePath);
    const includedAbsolutePath = path.join(repoRoot, includedRepoRelativePath);

    fs.mkdirSync(path.dirname(ignoredAbsolutePath), { recursive: true });
    fs.writeFileSync(ignoredAbsolutePath, 'base ignored\n', 'utf8');
    fs.writeFileSync(includedAbsolutePath, 'base included\n', 'utf8');
    runGit(repoRoot, ['add', ignoredGitPath, includedGitPath]);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    fs.mkdirSync(path.dirname(getMetricsIgnoreFilePath(repoRoot)), { recursive: true });
    fs.writeFileSync(getMetricsIgnoreFilePath(repoRoot), [
        'src/generated/',
        '!src/generated/included.txt'
    ].join('\n'), 'utf8');

    const ignoredText = 'ignored by metrics\n';
    const includedText = 'included by metrics\n';
    fs.writeFileSync(ignoredAbsolutePath, ignoredText, 'utf8');
    fs.writeFileSync(includedAbsolutePath, includedText, 'utf8');
    runGit(repoRoot, ['add', ignoredGitPath, includedGitPath]);

    const metricsStore = new RepoMetricsStore('test-session', () => {});
    const recordedAt = new Date().toISOString();
    queueSyntheticWorkspaceMetric(metricsStore, repoRoot, ignoredRepoRelativePath, ignoredAbsolutePath, ignoredText, recordedAt, 'event-ignore');
    queueSyntheticWorkspaceMetric(metricsStore, repoRoot, includedRepoRelativePath, includedAbsolutePath, includedText, recordedAt, 'event-include');

    await metricsStore.flushRepo(repoRoot);

    assert.equal(fs.existsSync(getRollingStatePath(repoRoot, ignoredRepoRelativePath)), false);
    assert.equal(fs.existsSync(getRollingStatePath(repoRoot, includedRepoRelativePath)), true);

    const refreshed = await refreshRepoHookSummary({ repoRoot });
    assert.equal(refreshed.summary.staged.changedFileCount, 1);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 1);
    assert.ok(Math.abs(refreshed.summary.staged.aiPercentage - 100) < FLOATING_POINT_TOLERANCE);
    assert.equal(refreshed.summary.staged.humanPercentage, 0);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, 1);
    assert.equal(refreshed.summary.staged.humanAddedLineCount, 0);
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
});

test('refreshRepoHookSummary ignores whitespace-only staged changes', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-whitespace-only-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const gitRelativePath = 'src/example.ts';
    const absoluteFilePath = path.join(repoRoot, gitRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'const value = 1;\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    fs.writeFileSync(absoluteFilePath, 'const    value    =    1;\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);

    const refreshed = await refreshRepoHookSummary({ repoRoot });
    assert.equal(refreshed.summary.isGitSummaryAvailable, true);
    assert.equal(refreshed.summary.staged.changedFileCount, 0);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 0);
    assert.equal(refreshed.summary.staged.aiPercentage, 0);
    assert.equal(refreshed.summary.staged.humanPercentage, 0);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, 0);
    assert.equal(refreshed.summary.staged.humanAddedLineCount, 0);
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
});

test('refreshRepoHookSummary weights changed lines by non-whitespace content', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-non-whitespace-weights-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const gitRelativePath = 'src/example.ts';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'oldAi\noldHuman\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    fs.writeFileSync(absoluteFilePath, '            aiToken\nhumanToken\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    const stagedBlobOid = readIndexBlobOid(repoRoot, gitRelativePath);

    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: 'LikelyHumanOrRegularEditorEdit',
        signalCounters: {
            ProbableAIApplyToWorkspaceFile: 1,
            PossibleAIApplyToWorkspaceFile: 0,
            LikelyHumanEditWhileChatSessionOpen: 0,
            LikelyHumanOrRegularEditorEdit: 1
        },
        cumulativeAiChangeMagnitude: 7,
        cumulativeHumanChangeMagnitude: 10,
        saveAttributionCheckpoints: [
            {
                gitBlobOid: stagedBlobOid,
                cumulativeAiChangeMagnitude: 7,
                cumulativeHumanChangeMagnitude: 10,
                lineAttributionSpans: [
                    { attribution: 'AI', lineCount: 1 },
                    { attribution: 'Human', lineCount: 1 }
                ]
            }
        ],
        lineAttributionSpans: [
            { attribution: 'AI', lineCount: 1 },
            { attribution: 'Human', lineCount: 1 }
        ],
        deletedAt: null
    }, null, 2), 'utf8');

    const refreshed = await refreshRepoHookSummary({ repoRoot });
    assert.equal(refreshed.summary.isGitSummaryAvailable, true);
    assert.equal(refreshed.summary.staged.changedFileCount, 1);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 1);
    assert.ok(Math.abs(refreshed.summary.staged.aiPercentage - (7 / 17) * 100) < FLOATING_POINT_TOLERANCE);
    assert.ok(Math.abs(refreshed.summary.staged.humanPercentage - (10 / 17) * 100) < FLOATING_POINT_TOLERANCE);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, 1);
    assert.equal(refreshed.summary.staged.humanAddedLineCount, 1);
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
});

test('refreshRepoHookSummary keeps unresolved added lines unknown', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-unknown-lines-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const gitRelativePath = 'src/example.ts';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'oldAi\noldHuman\noldUnknown\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    fs.writeFileSync(absoluteFilePath, 'newAi\nnewHuman\nnewUnknown\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    const stagedBlobOid = readIndexBlobOid(repoRoot, gitRelativePath);
    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: 'LikelyHumanOrRegularEditorEdit',
        signalCounters: {
            ProbableAIApplyToWorkspaceFile: 1,
            LikelyHumanOrRegularEditorEdit: 1
        },
        cumulativeAiChangeMagnitude: 5,
        cumulativeHumanChangeMagnitude: 8,
        saveAttributionCheckpoints: [{
            gitBlobOid: stagedBlobOid,
            cumulativeAiChangeMagnitude: 5,
            cumulativeHumanChangeMagnitude: 8,
            lineAttributionSpans: [
                { attribution: 'AI', lineCount: 1 },
                { attribution: 'Human', lineCount: 1 },
                { attribution: 'Unknown', lineCount: 1 }
            ]
        }],
        lineAttributionSpans: [
            { attribution: 'AI', lineCount: 1 },
            { attribution: 'Human', lineCount: 1 },
            { attribution: 'Unknown', lineCount: 1 }
        ],
        deletedAt: null
    }), 'utf8');

    const refreshed = await refreshRepoHookSummary({ repoRoot });

    assert.deepEqual({
        aiAddedLineCount: refreshed.summary.staged.aiAddedLineCount,
        humanAddedLineCount: refreshed.summary.staged.humanAddedLineCount,
        unknownAddedLineCount: refreshed.summary.staged.unknownAddedLineCount
    }, {
        aiAddedLineCount: 1,
        humanAddedLineCount: 1,
        unknownAddedLineCount: 1
    });
});

test('refreshRepoHookSummary leaves a tied aggregate fallback line unknown', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-tied-fallback-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);
    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'initial\n', 'utf8');
    runGit(repoRoot, ['add', 'README.md']);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    const gitRelativePath = 'src/tied.ts';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'const tied = true;\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    writeRollingState(repoRoot, repoRelativePath, readIndexBlobOid(repoRoot, gitRelativePath), 10, 10);

    const refreshed = await refreshRepoHookSummary({ repoRoot });

    assert.ok(Math.abs(refreshed.summary.staged.aiPercentage - 50) < FLOATING_POINT_TOLERANCE);
    assert.deepEqual({
        aiAddedLineCount: refreshed.summary.staged.aiAddedLineCount,
        humanAddedLineCount: refreshed.summary.staged.humanAddedLineCount,
        unknownAddedLineCount: refreshed.summary.staged.unknownAddedLineCount
    }, {
        aiAddedLineCount: 0,
        humanAddedLineCount: 0,
        unknownAddedLineCount: 1
    });
});

test('refreshRepoHookSummary does not count deleted lines as authored additions', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-deletion-lines-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    const gitRelativePath = 'src/deleted.ts';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'const deleted = true;\n', 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    runGit(repoRoot, ['commit', '-m', 'initial']);
    writeRollingState(repoRoot, repoRelativePath, readIndexBlobOid(repoRoot, gitRelativePath), 0, 20);

    fs.rmSync(absoluteFilePath);
    runGit(repoRoot, ['add', gitRelativePath]);

    const refreshed = await refreshRepoHookSummary({ repoRoot });

    assert.equal(refreshed.summary.staged.humanPercentage, 100);
    assert.deepEqual({
        aiAddedLineCount: refreshed.summary.staged.aiAddedLineCount,
        humanAddedLineCount: refreshed.summary.staged.humanAddedLineCount,
        unknownAddedLineCount: refreshed.summary.staged.unknownAddedLineCount
    }, {
        aiAddedLineCount: 0,
        humanAddedLineCount: 0,
        unknownAddedLineCount: 0
    });
});

test('refreshRepoHookSummary uses aggregate attribution for newly staged files', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-new-file-aggregate-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'initial\n', 'utf8');
    runGit(repoRoot, ['add', 'README.md']);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    const gitRelativePath = 'src/generated-by-ai.ts';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    const fileText = [
        'export const generated = () => {',
        '  const first = "ai";',
        '  const second = "ai";',
        '  return `${first}-${second}`;',
        '};',
        ''
    ].join('\n');
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, fileText, 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);

    const stagedBlobOid = readIndexBlobOid(repoRoot, gitRelativePath);
    const lineCount = fileText.split(/\r\n|\r|\n/).length;
    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: 'ProbableAIBulkWorkspaceEdit',
        signalCounters: {
            ProbableAIApplyToWorkspaceFile: 0,
            PossibleAIApplyToWorkspaceFile: 0,
            ProbableAIBulkWorkspaceEdit: 1,
            LikelyHumanEditWhileChatSessionOpen: 0,
            LikelyHumanOrRegularEditorEdit: 1
        },
        cumulativeAiChangeMagnitude: fileText.length,
        cumulativeHumanChangeMagnitude: 0,
        saveAttributionCheckpoints: [
            {
                gitBlobOid: stagedBlobOid,
                cumulativeAiChangeMagnitude: fileText.length,
                cumulativeHumanChangeMagnitude: 0,
                lineAttributionSpans: [
                    { attribution: 'Human', lineCount }
                ]
            }
        ],
        lineAttributionSpans: [
            { attribution: 'Human', lineCount }
        ],
        deletedAt: null
    }, null, 2), 'utf8');

    const refreshed = await refreshRepoHookSummary({ repoRoot });
    assert.equal(refreshed.summary.isGitSummaryAvailable, true);
    assert.equal(refreshed.summary.staged.changedFileCount, 1);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 1);
    assert.ok(Math.abs(refreshed.summary.staged.aiPercentage - 100) < FLOATING_POINT_TOLERANCE);
    assert.equal(refreshed.summary.staged.humanPercentage, 0);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, countNonBlankLines(fileText));
    assert.equal(refreshed.summary.staged.humanAddedLineCount, 0);
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
});

test('refreshRepoHookSummary repairs historical human-labeled bulk checkpoints for AI-dominant new files', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-new-file-repair-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'initial\n', 'utf8');
    runGit(repoRoot, ['add', 'README.md']);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    const gitRelativePath = 'src/historical-ai-file.ts';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    const fileText = createLargeAiTestFileText();
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, fileText, 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);

    const stagedBlobOid = readIndexBlobOid(repoRoot, gitRelativePath);
    const lineCount = fileText.split(/\r\n|\r|\n/).length;
    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: 'LikelyHumanOrRegularEditorEdit',
        signalCounters: {
            ProbableAIApplyToWorkspaceFile: 1,
            PossibleAIApplyToWorkspaceFile: 0,
            LikelyHumanEditWhileChatSessionOpen: 0,
            LikelyHumanOrRegularEditorEdit: 2
        },
        cumulativeAiChangeMagnitude: 2_000,
        cumulativeHumanChangeMagnitude: 900,
        saveAttributionCheckpoints: [
            {
                gitBlobOid: '0000000000000000000000000000000000000000',
                cumulativeAiChangeMagnitude: 0,
                cumulativeHumanChangeMagnitude: 800,
                lineAttributionSpans: [
                    { attribution: 'Human', lineCount }
                ]
            },
            {
                gitBlobOid: stagedBlobOid,
                cumulativeAiChangeMagnitude: 2_000,
                cumulativeHumanChangeMagnitude: 900,
                lineAttributionSpans: [
                    { attribution: 'Human', lineCount }
                ]
            }
        ],
        lineAttributionSpans: [
            { attribution: 'Human', lineCount }
        ],
        deletedAt: null
    }, null, 2), 'utf8');

    const refreshed = await refreshRepoHookSummary({ repoRoot });
    assert.equal(refreshed.summary.isGitSummaryAvailable, true);
    assert.equal(refreshed.summary.staged.changedFileCount, 1);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 1);
    assert.ok(Math.abs(refreshed.summary.staged.aiPercentage - 100) < FLOATING_POINT_TOLERANCE);
    assert.equal(refreshed.summary.staged.humanPercentage, 0);
    assert.equal(refreshed.summary.staged.usedFallbackAttribution, true);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, countNonBlankLines(fileText));
    assert.equal(refreshed.summary.staged.humanAddedLineCount, 0);
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
});

test('refreshRepoHookSummary still scores unstaged edits when the same file is newly staged', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-new-file-with-unstaged-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'initial\n', 'utf8');
    runGit(repoRoot, ['add', 'README.md']);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    const gitRelativePath = 'src/new-with-leftover.ts';
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    const stagedText = 'const ai = "ai";\n';
    const workingTreeText = 'const ai = "ai";\nconst human = "human";\n';
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, stagedText, 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    const stagedBlobOid = readIndexBlobOid(repoRoot, gitRelativePath);
    fs.writeFileSync(absoluteFilePath, workingTreeText, 'utf8');

    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: 'LikelyHumanOrRegularEditorEdit',
        signalCounters: {
            ProbableAIApplyToWorkspaceFile: 1,
            PossibleAIApplyToWorkspaceFile: 0,
            ProbableAIBulkWorkspaceEdit: 0,
            LikelyHumanEditWhileChatSessionOpen: 0,
            LikelyHumanOrRegularEditorEdit: 1
        },
        cumulativeAiChangeMagnitude: stagedText.length,
        cumulativeHumanChangeMagnitude: workingTreeText.length - stagedText.length,
        saveAttributionCheckpoints: [
            {
                gitBlobOid: stagedBlobOid,
                cumulativeAiChangeMagnitude: stagedText.length,
                cumulativeHumanChangeMagnitude: 0,
                lineAttributionSpans: [
                    { attribution: 'AI', lineCount: 2 }
                ]
            }
        ],
        lineAttributionSpans: [
            { attribution: 'AI', lineCount: 1 },
            { attribution: 'Human', lineCount: 1 },
            { attribution: 'Unknown', lineCount: 1 }
        ],
        deletedAt: null
    }, null, 2), 'utf8');

    const refreshed = await refreshRepoHookSummary({ repoRoot });
    assert.equal(refreshed.summary.staged.changedFileCount, 1);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 1);
    assert.equal(refreshed.summary.staged.aiPercentage, 100);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, 1);
    assert.equal(refreshed.summary.staged.humanAddedLineCount, 0);
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
    assert.equal(refreshed.summary.unstaged.changedFileCount, 1);
    assert.equal(refreshed.summary.unstaged.attributedChangedFileCount, 1);
    assert.equal(refreshed.summary.unstaged.aiPercentage, 0);
    assert.equal(refreshed.summary.unstaged.humanPercentage, 100);
    assert.equal(refreshed.summary.unstaged.aiAddedLineCount, 0);
    assert.equal(refreshed.summary.unstaged.humanAddedLineCount, 1);
    assert.equal(refreshed.summary.unstaged.unknownAddedLineCount, 0);
});

test('refreshRepoHookSummary attributes a staged small human file plus large AI bulk file mostly to AI', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-user-aitest-ratio-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n', 'utf8');
    runGit(repoRoot, ['add', 'README.md']);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    const humanGitPath = 'aitest/Ai-test1.js';
    const aiGitPath = 'aitest/AI-test2.js';
    const humanRepoRelativePath = path.normalize(humanGitPath);
    const aiRepoRelativePath = path.normalize(aiGitPath);
    const humanAbsolutePath = path.join(repoRoot, humanRepoRelativePath);
    const aiAbsolutePath = path.join(repoRoot, aiRepoRelativePath);
    fs.mkdirSync(path.dirname(humanAbsolutePath), { recursive: true });

    const humanText = [
        'export default asd = () => {',
        '  const a1 = "123";',
        '  const b2 = "123";',
        '  const c3 = "123";',
        '  const d4 = "123";',
        '  const e5 = "123";',
        '  const f6 = "123";',
        '  const g7 = "123";',
        '  const h8 = "123";',
        '  return true;',
        '};',
        ''
    ].join('\n');
    const aiText = createLargeAiTestFileText();
    fs.writeFileSync(humanAbsolutePath, humanText, 'utf8');
    fs.writeFileSync(aiAbsolutePath, aiText, 'utf8');
    runGit(repoRoot, ['add', humanGitPath, aiGitPath]);

    const metricsStore = new RepoMetricsStore('test-session', () => {});
    const recordedAt = new Date().toISOString();
    queueSyntheticWorkspaceMetric(
        metricsStore,
        repoRoot,
        humanRepoRelativePath,
        humanAbsolutePath,
        humanText,
        recordedAt,
        'event-human-file',
        'LikelyHumanOrRegularEditorEdit'
    );
    queueSyntheticWorkspaceMetric(
        metricsStore,
        repoRoot,
        aiRepoRelativePath,
        aiAbsolutePath,
        aiText,
        recordedAt,
        'event-ai-bulk-file',
        'ProbableAIBulkWorkspaceEdit'
    );
    await metricsStore.flushRepo(repoRoot);

    const refreshed = await refreshRepoHookSummary({ repoRoot });
    const expectedAiWeight = nonWhitespaceWeight(aiText);
    const expectedHumanWeight = nonWhitespaceWeight(humanText);
    const expectedAiPercentage = (expectedAiWeight / (expectedAiWeight + expectedHumanWeight)) * 100;

    assert.equal(refreshed.summary.isGitSummaryAvailable, true);
    assert.equal(refreshed.summary.staged.changedFileCount, 2);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 2);
    assert.ok(Math.abs(refreshed.summary.staged.aiPercentage - expectedAiPercentage) < FLOATING_POINT_TOLERANCE);
    assert.ok(refreshed.summary.staged.aiPercentage > 98);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, countNonBlankLines(aiText));
    assert.equal(refreshed.summary.staged.humanAddedLineCount, countNonBlankLines(humanText));
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
});

test('refreshRepoHookSummary keeps formatter-neutral staged new-file rewrites with their original author', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-formatted-new-file-'));
    tempDirectories.push(repoRoot);

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);

    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n', 'utf8');
    runGit(repoRoot, ['add', 'README.md']);
    runGit(repoRoot, ['commit', '-m', 'initial']);

    const metricsStore = new RepoMetricsStore('test-session', () => {});
    const humanGitPath = 'src/human.ts';
    const aiGitPath = 'src/ai.ts';
    const humanRepoRelativePath = path.normalize(humanGitPath);
    const aiRepoRelativePath = path.normalize(aiGitPath);
    const humanAbsolutePath = path.join(repoRoot, humanRepoRelativePath);
    const aiAbsolutePath = path.join(repoRoot, aiRepoRelativePath);
    const humanText = [
        'export const humanValue = () => {',
        "  const owner = 'human'",
        '  return owner',
        '}',
        ''
    ].join('\n');
    const aiBeforeFormatText = [
        'export const aiValue=()=>{',
        "const owner='ai'",
        'return owner',
        '}',
        ''
    ].join('\n');
    const aiAfterFormatText = [
        'export const aiValue = () => {',
        '  const owner = "ai";',
        '  return owner;',
        '};',
        ''
    ].join('\n');

    fs.mkdirSync(path.dirname(humanAbsolutePath), { recursive: true });
    fs.writeFileSync(humanAbsolutePath, humanText, 'utf8');
    queueSyntheticEditMetric(
        metricsStore,
        repoRoot,
        humanRepoRelativePath,
        humanAbsolutePath,
        '',
        humanText,
        'LikelyHumanOrRegularEditorEdit',
        'event-human-file'
    );
    await metricsStore.flushRepo(repoRoot);
    runGit(repoRoot, ['add', humanGitPath]);

    fs.writeFileSync(aiAbsolutePath, aiBeforeFormatText, 'utf8');
    queueSyntheticEditMetric(
        metricsStore,
        repoRoot,
        aiRepoRelativePath,
        aiAbsolutePath,
        '',
        aiBeforeFormatText,
        'ProbableAIApplyToWorkspaceFile',
        'event-ai-file'
    );
    await metricsStore.flushRepo(repoRoot);

    fs.writeFileSync(aiAbsolutePath, aiAfterFormatText, 'utf8');
    queueSyntheticEditMetric(
        metricsStore,
        repoRoot,
        aiRepoRelativePath,
        aiAbsolutePath,
        aiBeforeFormatText,
        aiAfterFormatText,
        'LikelyHumanOrRegularEditorEdit',
        'event-ai-file-formatted'
    );
    await metricsStore.flushRepo(repoRoot);
    runGit(repoRoot, ['add', aiGitPath]);

    const aiRollingState = JSON.parse(fs.readFileSync(getRollingStatePath(repoRoot, aiRepoRelativePath), 'utf8')) as {
        cumulativeAiChangeMagnitude: number;
        cumulativeHumanChangeMagnitude: number;
    };
    assert.equal(aiRollingState.cumulativeAiChangeMagnitude, nonWhitespaceWeight(aiBeforeFormatText));
    assert.equal(aiRollingState.cumulativeHumanChangeMagnitude, 0);

    const refreshed = await refreshRepoHookSummary({ repoRoot });
    const expectedAiWeight = nonWhitespaceWeight(aiAfterFormatText);
    const expectedHumanWeight = nonWhitespaceWeight(humanText);
    const expectedAiPercentage = (expectedAiWeight / (expectedAiWeight + expectedHumanWeight)) * 100;

    assert.equal(refreshed.summary.isGitSummaryAvailable, true);
    assert.equal(refreshed.summary.staged.changedFileCount, 2);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 2);
    assert.ok(Math.abs(refreshed.summary.staged.aiPercentage - expectedAiPercentage) < FLOATING_POINT_TOLERANCE);
    assert.ok(refreshed.summary.staged.aiPercentage > 45);
    assert.ok(refreshed.summary.staged.humanPercentage < 55);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, countNonBlankLines(aiAfterFormatText));
    assert.equal(refreshed.summary.staged.humanAddedLineCount, countNonBlankLines(humanText));
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
});

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

function readIndexBlobOid(repoRoot: string, repoRelativePath: string): string {
    const output = runGit(repoRoot, ['ls-files', '--stage', '--', repoRelativePath]).trim();
    const stageZeroLine = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && /\s0\t/.test(line));

    assert.ok(stageZeroLine, `Expected a stage-zero index entry for ${repoRelativePath}.`);
    const fields = stageZeroLine.split(/\s+/);
    const gitBlobOid = fields[1] ?? '';
    assert.match(gitBlobOid, /^[0-9a-f]{40}$/i);
    return gitBlobOid;
}

function writeRollingState(
    repoRoot: string,
    repoRelativePath: string,
    gitBlobOid: string,
    aiChangeMagnitude: number,
    humanChangeMagnitude: number
): void {
    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: 'ProbableAIApplyToWorkspaceFile',
        signalCounters: {},
        cumulativeAiChangeMagnitude: aiChangeMagnitude,
        cumulativeHumanChangeMagnitude: humanChangeMagnitude,
        saveAttributionCheckpoints: [{
            gitBlobOid,
            cumulativeAiChangeMagnitude: aiChangeMagnitude,
            cumulativeHumanChangeMagnitude: humanChangeMagnitude,
            lineAttributionSpans: []
        }],
        lineAttributionSpans: [],
        deletedAt: null
    }), 'utf8');
}

function queueSyntheticWorkspaceMetric(
    metricsStore: RepoMetricsStore,
    repoRoot: string,
    repoRelativePath: string,
    absoluteFilePath: string,
    fileText: string,
    recordedAt: string,
    eventId: string,
    signal = 'ProbableAIApplyToWorkspaceFile'
): void {
    const lineCount = countSyntheticTextLines(fileText);
    metricsStore.queueWorkspaceFileMetric({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'workspace-file-metric',
        eventId,
        recordedAt,
        extensionSessionId: 'test-session',
        repoRoot,
        repoRelativePath,
        logicalPath: absoluteFilePath,
        documentCategory: 'WorkspaceFile',
        signal,
        explanation: 'Synthetic AI edit for metrics ignore coverage.',
        replacementRatio: 1,
        totalInsertedTextLength: fileText.length,
        totalRemovedTextLength: 0,
        isWholeDocumentReplace: true,
        hasRecentSnapshotActivity: signal === 'ProbableAIApplyToWorkspaceFile',
        snapshotRequestIds: signal === 'ProbableAIApplyToWorkspaceFile' ? ['request-1'] : [],
        requestIds: signal === 'ProbableAIApplyToWorkspaceFile' ? ['request-1'] : [],
        lastChatScheme: signal === 'ProbableAIApplyToWorkspaceFile' ? 'chat-editing-snapshot-text-model' : null,
        snapshotAgeMs: signal === 'ProbableAIApplyToWorkspaceFile' ? 0 : null,
        changeReason: 'RegularEditOrUnknown',
        documentVersion: 2,
        beforeHash: 'before-hash',
        afterHash: 'after-hash',
        beforeCharLength: 0,
        afterCharLength: fileText.length,
        lineCount,
        languageId: 'plaintext',
        isDirty: false,
        lineDiffSegments: [
            {
                type: 'added',
                lineCount
            }
        ],
        chatCorrelation: null,
        saveCorrelation: null
    });
}

function queueSyntheticEditMetric(
    metricsStore: RepoMetricsStore,
    repoRoot: string,
    repoRelativePath: string,
    absoluteFilePath: string,
    beforeText: string,
    afterText: string,
    signal: string,
    eventId: string
): void {
    metricsStore.queueWorkspaceFileMetric({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'workspace-file-metric',
        eventId,
        recordedAt: new Date().toISOString(),
        extensionSessionId: 'test-session',
        repoRoot,
        repoRelativePath,
        logicalPath: absoluteFilePath,
        documentCategory: 'WorkspaceFile',
        signal,
        explanation: 'Synthetic before/after edit for formatter-neutral attribution coverage.',
        replacementRatio: beforeText.length > 0
            ? Math.max(beforeText.length, afterText.length) / beforeText.length
            : 1,
        totalInsertedTextLength: afterText.length,
        totalRemovedTextLength: beforeText.length,
        isWholeDocumentReplace: beforeText.length === 0,
        hasRecentSnapshotActivity: signal === 'ProbableAIApplyToWorkspaceFile',
        snapshotRequestIds: signal === 'ProbableAIApplyToWorkspaceFile' ? ['request-1'] : [],
        requestIds: signal === 'ProbableAIApplyToWorkspaceFile' ? ['request-1'] : [],
        lastChatScheme: signal === 'ProbableAIApplyToWorkspaceFile' ? 'chat-editing-snapshot-text-model' : null,
        snapshotAgeMs: signal === 'ProbableAIApplyToWorkspaceFile' ? 0 : null,
        changeReason: 'RegularEditOrUnknown',
        documentVersion: 2,
        beforeHash: beforeText.length > 0 ? 'before-hash' : null,
        afterHash: 'after-hash',
        beforeCharLength: beforeText.length,
        afterCharLength: afterText.length,
        lineCount: countSyntheticTextLines(afterText),
        languageId: 'typescript',
        isDirty: false,
        lineDiffSegments: createLineDiffSegments(beforeText, afterText, { languageId: 'typescript' }),
        chatCorrelation: null,
        saveCorrelation: null
    });
}

function countSyntheticTextLines(text: string): number {
    return Math.max(1, text.split('\n').filter((line, index, lines) => !(index === lines.length - 1 && line === '')).length);
}

function createLargeAiTestFileText(): string {
    const chunks: string[] = [];
    for (const functionName of ['a', 'b', 'c', 'd', 'e']) {
        chunks.push(`export const AI_test2_${functionName} = () => {`);
        for (let index = 1; index <= 100; index += 1) {
            chunks.push(`  const ${functionName}${index} = "123";`);
        }
        chunks.push('  return true;');
        chunks.push('};');
        chunks.push('');
    }

    return chunks.join('\n');
}

function nonWhitespaceWeight(text: string): number {
    return text.replace(/\s/gu, '').length;
}

function countNonBlankLines(text: string): number {
    return text.split(/\r\n|\r|\n/)
        .filter((line) => nonWhitespaceWeight(line) > 0)
        .length;
}
