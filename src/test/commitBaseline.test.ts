import assert from 'node:assert/strict';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import { getPreparedCommitBaselinePath, getRepoSummaryStatePath, getRollingStatePath } from '../metrics/pathing';
import { METRICS_SCHEMA_VERSION } from '../metrics/schema';
import { RepoMetricsStore } from '../metrics/store';
import { finalizeRepoCommit, prepareRepoCommitBaseline, refreshRepoHookSummary } from '../metrics/summary';

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
    assert.ok(Math.abs(finalizationResult.summary.unstaged.aiPercentage - 40) < 0.000_001);
    assert.ok(Math.abs(finalizationResult.summary.unstaged.humanPercentage - 60) < 0.000_001);
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

    await metricsStore.flushRepo(repoRoot);

    const afterFlush = await refreshRepoHookSummary({ repoRoot });
    assert.equal(afterFlush.summary.isGitSummaryAvailable, true);
    assert.equal(afterFlush.summary.staged.changedFileCount, 1);
    assert.equal(afterFlush.summary.staged.attributedChangedFileCount, 1);
    assert.ok(Math.abs(afterFlush.summary.staged.aiPercentage - 100) < 0.000_001);
    assert.equal(afterFlush.summary.staged.humanPercentage, 0);
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
