import assert from 'node:assert/strict';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import { installRepoHooks, uninstallRepoHooks } from '../hooks/management';

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

test('installRepoHooks installs Git hooks, Claude Code hooks, and managed gitignore entries', async () => {
    const repoRoot = createGitRepo('ailoc2-install-hooks-');
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'node_modules/\n.githooks\n', 'utf8');

    const installResult = await installRepoHooks({ repoRoot });
    const gitignoreContents = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    const claudeSettingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const claudeSettings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8')) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };

    assert.deepEqual({
        status: installResult.status,
        gitignoreUpdated: installResult.gitignoreUpdated,
        hasMetricsIgnore: gitignoreContents.includes('.ailoc2-metrics/'),
        hasHooksIgnoreAlreadyNormalized: gitignoreContents.includes('.githooks\n'),
        hasClaudeIgnore: gitignoreContents.includes('.claude/'),
        hasClaudeRuntime: fs.existsSync(path.join(repoRoot, '.claude', 'ailoc2-claude-code.cjs')),
        hasClaudeCaptureHook: claudeSettings.hooks?.PreToolUse?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes('capture-before'))),
        hasClaudeRecordHook: claudeSettings.hooks?.PostToolUse?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes('record-edit')))
    }, {
        status: 'installed',
        gitignoreUpdated: true,
        hasMetricsIgnore: true,
        hasHooksIgnoreAlreadyNormalized: true,
        hasClaudeIgnore: true,
        hasClaudeRuntime: true,
        hasClaudeCaptureHook: true,
        hasClaudeRecordHook: true
    });
});

test('uninstallRepoHooks removes managed Claude runtime without creating missing Claude settings', async () => {
    const repoRoot = createGitRepo('ailoc2-uninstall-hooks-');
    await installRepoHooks({ repoRoot });
    fs.rmSync(path.join(repoRoot, '.claude', 'settings.json'), { force: true });

    const uninstallResult = await uninstallRepoHooks({ repoRoot });

    assert.deepEqual({
        status: uninstallResult.status,
        removedClaudeCodeHooks: uninstallResult.removedClaudeCodeHooks,
        hasClaudeRuntime: fs.existsSync(path.join(repoRoot, '.claude', 'ailoc2-claude-code.cjs')),
        hasClaudeSettings: fs.existsSync(path.join(repoRoot, '.claude', 'settings.json'))
    }, {
        status: 'uninstalled',
        removedClaudeCodeHooks: true,
        hasClaudeRuntime: false,
        hasClaudeSettings: false
    });
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

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}
