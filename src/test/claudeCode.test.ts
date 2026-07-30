import assert from 'node:assert/strict';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import { createLineDiffSegments } from '../metrics/lineDiff';
import { getIntellijStatePath, getRollingStatePath } from '../metrics/pathing';
import { METRICS_SCHEMA_VERSION, FileRollingState, WorkspaceFileMetricEvent } from '../metrics/schema';
import { RepoMetricsStore } from '../metrics/store';
import { refreshRepoHookSummary } from '../metrics/summary';
import {
    captureClaudeCodeBefore,
    installClaudeCodeHooks,
    recordClaudeCodePostEdit
} from '../integrations/claudeCode/runtime';

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

test('Claude Code Write records an AI rolling state in .ailoc2-metrics', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-write-');
    const gitRelativePath = 'src/claude.js';
    const absoluteFilePath = path.join(repoRoot, gitRelativePath);
    const afterText = [
        'export function generatedByClaude() {',
        '  return "ai";',
        '}',
        ''
    ].join('\n');
    const payload = createClaudePayload(repoRoot, 'Write', gitRelativePath, 'tool-write-1');

    const captureResults = await captureClaudeCodeBefore(payload);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, afterText, 'utf8');
    const recordResults = await recordClaudeCodePostEdit(payload);

    const rollingState = readRollingState(repoRoot, gitRelativePath);
    const intellijState = fs.readFileSync(getIntellijStatePath(repoRoot, path.normalize(gitRelativePath)), 'utf8');
    assert.deepEqual({
        captured: captureResults.map((result) => ({ existed: result.existed })),
        recorded: recordResults.map((result) => ({ skipped: result.skipped, repoRelativePath: result.repoRelativePath })),
        aiMagnitude: rollingState.cumulativeAiChangeMagnitude,
        humanMagnitude: rollingState.cumulativeHumanChangeMagnitude,
        latestSignal: rollingState.latestSignal,
        checkpointCount: rollingState.saveAttributionCheckpoints.length
    }, {
        captured: [{ existed: false }],
        recorded: [{ skipped: false, repoRelativePath: path.normalize(gitRelativePath) }],
        aiMagnitude: nonWhitespaceWeight(afterText),
        humanMagnitude: 0,
        latestSignal: 'ProbableAIApplyToWorkspaceFile',
        checkpointCount: 1
    });
    assert.match(intellijState, /^source\tCLAUDE_CODE$/m);
    assert.match(intellijState, /^line\t1\tAI$/m);
});

test('Claude Code Edit without before snapshot is skipped instead of over-attributing the whole file', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-missing-before-');
    const gitRelativePath = 'src/existing.js';
    const absoluteFilePath = path.join(repoRoot, gitRelativePath);
    fs.mkdirSync(path.dirname(absoluteFilePath), { recursive: true });
    fs.writeFileSync(absoluteFilePath, 'const value = "after";\n', 'utf8');

    const recordResults = await recordClaudeCodePostEdit(createClaudePayload(repoRoot, 'Edit', gitRelativePath, 'tool-edit-1'));

    assert.deepEqual(recordResults.map((result) => ({ skipped: result.skipped, reason: result.reason })), [
        { skipped: true, reason: 'MissingBeforeSnapshot' }
    ]);
    assert.equal(fs.existsSync(getRollingStatePath(repoRoot, path.normalize(gitRelativePath))), false);
});

test('Claude Code Bash heredoc fallback records its redirected file as AI', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-bash-');
    const gitRelativePath = 'sample.txt';
    const absoluteFilePath = path.join(repoRoot, gitRelativePath);
    const beforeText = Array.from({ length: 10 }, (_, index) => `Original line ${index + 1}`).join('\n') + '\n';
    const afterText = Array.from({ length: 40 }, (_, index) => `Claude line ${index + 1}`).join('\n') + '\n';
    fs.writeFileSync(absoluteFilePath, beforeText, 'utf8');
    runGit(repoRoot, ['add', gitRelativePath]);
    runGit(repoRoot, ['commit', '-m', 'add sample']);
    const payload = createClaudeBashPayload(
        repoRoot,
        `cat > "${absoluteFilePath}" << 'EOF'\n${afterText}EOF`,
        'tool-bash-1'
    );

    const captureResults = await captureClaudeCodeBefore(payload);
    fs.writeFileSync(absoluteFilePath, afterText, 'utf8');
    const recordResults = await recordClaudeCodePostEdit(payload);
    const refreshed = await refreshRepoHookSummary({ repoRoot });

    assert.deepEqual({
        captured: captureResults.map((result) => ({ existed: result.existed })),
        recorded: recordResults.map((result) => ({ skipped: result.skipped, repoRelativePath: result.repoRelativePath })),
        aiAddedLineCount: refreshed.summary.unstaged.aiAddedLineCount,
        humanAddedLineCount: refreshed.summary.unstaged.humanAddedLineCount,
        unknownAddedLineCount: refreshed.summary.unstaged.unknownAddedLineCount
    }, {
        captured: [{ existed: true }],
        recorded: [{ skipped: false, repoRelativePath: path.normalize(gitRelativePath) }],
        aiAddedLineCount: 40,
        humanAddedLineCount: 0,
        unknownAddedLineCount: 0
    });
});

test('Claude Code read-only Bash commands do not create attribution targets', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-read-only-bash-');

    const captureResults = await captureClaudeCodeBefore(createClaudeBashPayload(
        repoRoot,
        'git status --short && cat README.md',
        'tool-bash-read-only'
    ));

    assert.deepEqual(captureResults, []);
});

test('Claude Code Bash parsing ignores quoted and heredoc content that resembles redirection', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-bash-content-');
    const actualPath = path.join(repoRoot, 'actual.txt');
    const payload = createClaudeBashPayload(
        repoRoot,
        `cat > "${actualPath}" << 'EOF'\nconst comparison = left > right;\nEOF\nprintf '%s' "literal > quoted.txt"`,
        'tool-bash-content'
    );

    const captureResults = await captureClaudeCodeBefore(payload);

    assert.deepEqual(captureResults.map((result) => result.absoluteFilePath), [actualPath]);
});

test('Claude Code Bash parsing supports numeric and escaped output paths but skips dynamic paths', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-bash-paths-');
    const payload = createClaudeBashPayload(
        repoRoot,
        'printf value > 2026.log; printf value > escaped\\ path.txt; printf value > "$TARGET"; printf value > /dev/null',
        'tool-bash-paths'
    );

    const captureResults = await captureClaudeCodeBefore(payload);

    assert.deepEqual(captureResults.map((result) => result.absoluteFilePath), [
        path.join(repoRoot, '2026.log'),
        path.join(repoRoot, 'escaped path.txt')
    ]);
});

test('Claude Code Bash parsing respects control operators, comments, multiline quotes, and descriptor output', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-bash-operators-');
    const payload = createClaudeBashPayload(
        repoRoot,
        [
            'printf value >tight.log&&true',
            'printf value >& combined.log',
            'printf value 2>&1',
            'printf value;# >comment.log',
            'printf "%s" "multiline',
            '> quoted.log"',
            'tee >(cat > process-output.log)'
        ].join('\n'),
        'tool-bash-operators'
    );

    const captureResults = await captureClaudeCodeBefore(payload);

    assert.deepEqual(captureResults.map((result) => result.absoluteFilePath), [
        path.join(repoRoot, 'tight.log'),
        path.join(repoRoot, 'combined.log'),
        path.join(repoRoot, 'process-output.log')
    ]);
});

test('Claude Code failed Bash commands remove their pending snapshots', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-bash-failed-');
    const payload = createClaudeBashPayload(repoRoot, 'printf value > output.log', 'tool-bash-failed');
    const captureResults = await captureClaudeCodeBefore(payload);

    const recordResults = await recordClaudeCodePostEdit({
        ...payload,
        tool_response: { is_error: true }
    });

    assert.deepEqual({
        result: recordResults.map((result) => ({ skipped: result.skipped, reason: result.reason })),
        snapshotExists: fs.existsSync(captureResults[0].snapshotPath)
    }, {
        result: [{ skipped: true, reason: 'ClaudeToolUseFailed' }],
        snapshotExists: false
    });
});

test('Claude Code metrics combine with human metrics in staged summary', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-mixed-summary-');
    const humanGitPath = 'src/human.js';
    const claudeGitPath = 'src/claude.js';
    const humanText = [
        'export function writtenByHuman() {',
        '  return "human";',
        '}',
        ''
    ].join('\n');
    const claudeText = [
        'export function writtenByClaude() {',
        '  return "ai";',
        '}',
        ''
    ].join('\n');

    const humanAbsolutePath = path.join(repoRoot, humanGitPath);
    fs.mkdirSync(path.dirname(humanAbsolutePath), { recursive: true });
    fs.writeFileSync(humanAbsolutePath, humanText, 'utf8');
    await recordHumanEdit(repoRoot, humanGitPath, humanText);

    const claudeAbsolutePath = path.join(repoRoot, claudeGitPath);
    const payload = createClaudePayload(repoRoot, 'Write', claudeGitPath, 'tool-write-2');
    await captureClaudeCodeBefore(payload);
    fs.writeFileSync(claudeAbsolutePath, claudeText, 'utf8');
    await recordClaudeCodePostEdit(payload);

    runGit(repoRoot, ['add', humanGitPath, claudeGitPath]);
    const refreshed = await refreshRepoHookSummary({ repoRoot });
    const expectedAiLineCount = countNonBlankLines(claudeText);
    const expectedHumanLineCount = countNonBlankLines(humanText);
    const expectedAiPercentage = (expectedAiLineCount / (expectedAiLineCount + expectedHumanLineCount)) * 100;

    assert.equal(refreshed.summary.staged.changedFileCount, 2);
    assert.equal(refreshed.summary.staged.attributedChangedFileCount, 2);
    assert.ok(Math.abs(refreshed.summary.staged.aiPercentage - expectedAiPercentage) < FLOATING_POINT_TOLERANCE);
    assert.equal(refreshed.summary.staged.aiAddedLineCount, expectedAiLineCount);
    assert.equal(refreshed.summary.staged.humanAddedLineCount, expectedHumanLineCount);
    assert.equal(refreshed.summary.staged.unknownAddedLineCount, 0);
});

test('installClaudeCodeHooks merges AILoc2 hooks into existing Claude settings', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-hooks-');
    const runtimeSourcePath = path.join(repoRoot, 'runtime.cjs');
    fs.writeFileSync(runtimeSourcePath, 'console.log("runtime");\n', 'utf8');
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Bash(git status)'] },
        hooks: {
            PostToolUse: [{
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo keep-me' }]
            }]
        }
    }, null, 2), 'utf8');

    const installResult = await installClaudeCodeHooks({ repoRoot, runtimeSourcePath });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
        permissions?: { allow?: string[] };
        hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
    };

    assert.equal(fs.existsSync(installResult.runtimePath), true);
    assert.deepEqual(settings.permissions?.allow, ['Bash(git status)']);
    assert.equal(settings.hooks?.PreToolUse?.some((entry) => entry.matcher === 'Write|Edit|MultiEdit|Bash'
        && entry.hooks?.some((hook) => hook.command?.includes('capture-before'))), true);
    assert.equal(settings.hooks?.PostToolUse?.some((entry) => entry.matcher === 'Write|Edit|MultiEdit|Bash'
        && entry.hooks?.some((hook) => hook.command?.includes('record-edit'))), true);
    assert.equal(settings.hooks?.PostToolUse?.some((entry) => entry.hooks?.some((hook) => hook.command === 'echo keep-me')), true);
});

test('installClaudeCodeHooks refuses to overwrite unparseable Claude settings', async () => {
    const repoRoot = createGitRepo('ailoc2-claude-corrupt-settings-');
    const runtimeSourcePath = path.join(repoRoot, 'runtime.cjs');
    fs.writeFileSync(runtimeSourcePath, 'console.log("runtime");\n', 'utf8');
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const corruptContents = '{ "hooks": [ this is not valid json';
    fs.writeFileSync(settingsPath, corruptContents, 'utf8');

    await assert.rejects(
        installClaudeCodeHooks({ repoRoot, runtimeSourcePath }),
        /could not parse the existing Claude settings/
    );

    assert.equal(fs.readFileSync(settingsPath, 'utf8'), corruptContents);
});

function createGitRepo(prefix: string): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirectories.push(repoRoot);
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'AILoc2 Test']);
    runGit(repoRoot, ['config', 'user.email', 'ailoc2@example.com']);
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n', 'utf8');
    runGit(repoRoot, ['add', 'README.md']);
    runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function createClaudePayload(repoRoot: string, toolName: string, gitRelativePath: string, invocationId: string): Record<string, unknown> {
    return {
        session_id: 'claude-session-1',
        tool_name: toolName,
        tool_use_id: invocationId,
        cwd: repoRoot,
        tool_input: {
            file_path: gitRelativePath
        },
        tool_response: {
            is_error: false
        }
    };
}

function createClaudeBashPayload(repoRoot: string, command: string, invocationId: string): Record<string, unknown> {
    return {
        session_id: 'claude-session-1',
        tool_name: 'Bash',
        tool_use_id: invocationId,
        cwd: repoRoot,
        tool_input: { command },
        tool_response: {
            is_error: false
        }
    };
}

async function recordHumanEdit(repoRoot: string, gitRelativePath: string, fileText: string): Promise<void> {
    const repoRelativePath = path.normalize(gitRelativePath);
    const absoluteFilePath = path.join(repoRoot, repoRelativePath);
    const store = new RepoMetricsStore('human-test-session', () => {});
    const event: WorkspaceFileMetricEvent = {
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'workspace-file-metric',
        eventId: 'human-edit',
        recordedAt: new Date().toISOString(),
        extensionSessionId: 'human-test-session',
        repoRoot,
        repoRelativePath,
        logicalPath: absoluteFilePath.toLowerCase(),
        documentCategory: 'WorkspaceFile',
        signal: 'LikelyHumanOrRegularEditorEdit',
        explanation: 'Synthetic human edit for Claude Code integration coverage.',
        replacementRatio: 1,
        totalInsertedTextLength: fileText.length,
        totalRemovedTextLength: 0,
        isWholeDocumentReplace: true,
        hasRecentSnapshotActivity: false,
        snapshotRequestIds: [],
        requestIds: [],
        lastChatScheme: null,
        snapshotAgeMs: null,
        changeReason: 'RegularEditOrUnknown',
        documentVersion: 1,
        beforeHash: null,
        afterHash: 'after',
        beforeCharLength: 0,
        afterCharLength: fileText.length,
        lineCount: fileText.split('\n').length,
        languageId: 'javascript',
        isDirty: false,
        lineDiffSegments: createLineDiffSegments('', fileText, { languageId: 'javascript' }),
        chatCorrelation: null,
        saveCorrelation: null
    };
    store.queueWorkspaceFileMetric(event);
    store.noteDocumentSaved({
        repoRoot,
        repoRelativePath,
        savedAt: event.recordedAt,
        hash: 'after',
        lineCount: event.lineCount,
        charLength: fileText.length,
        documentVersion: 1,
        saveCorrelation: {
            hadRecentWillSave: false,
            possibleSaveWithoutWillSave: true
        }
    });
    await store.flushRepo(repoRoot);
}

function readRollingState(repoRoot: string, gitRelativePath: string): FileRollingState {
    return JSON.parse(fs.readFileSync(getRollingStatePath(repoRoot, path.normalize(gitRelativePath)), 'utf8')) as FileRollingState;
}

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

function nonWhitespaceWeight(text: string): number {
    return text.replace(/\s/gu, '').length;
}

function countNonBlankLines(text: string): number {
    return text.split(/\r\n|\r|\n/)
        .filter((line) => nonWhitespaceWeight(line) > 0)
        .length;
}
