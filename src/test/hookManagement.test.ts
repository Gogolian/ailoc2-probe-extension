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

test('installRepoHooks reports unmanaged repo hook files before mutating the repo', async () => {
    const repoRoot = createGitRepo('ailoc2-hook-file-conflict-');
    const hooksDirectoryPath = path.join(repoRoot, '.githooks');
    const preCommitPath = path.join(hooksDirectoryPath, 'pre-commit');
    fs.mkdirSync(hooksDirectoryPath);
    fs.writeFileSync(preCommitPath, '#!/bin/sh\nprintf "%s\\n" custom-pre-commit\n', 'utf8');
    runGit(repoRoot, ['config', '--local', 'core.hooksPath', '.githooks']);

    const installResult = await installRepoHooks({ repoRoot });

    assert.deepEqual({
        status: installResult.status,
        conflictingHookFiles: installResult.conflictingHookFiles,
        wrappedHookFiles: installResult.wrappedHookFiles,
        gitignoreExists: fs.existsSync(path.join(repoRoot, '.gitignore')),
        hasRuntime: fs.existsSync(path.join(hooksDirectoryPath, 'ailoc2-hook-runtime.cjs')),
        hasClaudeDirectory: fs.existsSync(path.join(repoRoot, '.claude')),
        preCommitContents: fs.readFileSync(preCommitPath, 'utf8'),
        coreHooksPath: runGit(repoRoot, ['config', '--local', '--get', 'core.hooksPath']).trim()
    }, {
        status: 'hook-file-conflict',
        conflictingHookFiles: ['pre-commit'],
        wrappedHookFiles: [],
        gitignoreExists: false,
        hasRuntime: false,
        hasClaudeDirectory: false,
        preCommitContents: '#!/bin/sh\nprintf "%s\\n" custom-pre-commit\n',
        coreHooksPath: '.githooks'
    });
});

test('installRepoHooks wraps existing unmanaged hook files and uninstall restores them', async () => {
    const repoRoot = createGitRepo('ailoc2-wrap-hook-files-');
    const hooksDirectoryPath = path.join(repoRoot, '.githooks');
    const preCommitPath = path.join(hooksDirectoryPath, 'pre-commit');
    const delegatePath = path.join(hooksDirectoryPath, 'pre-commit.ailoc2-delegate');
    const originalPreCommitContents = '#!/bin/sh\nprintf "%s\\n" custom-pre-commit\n';
    fs.mkdirSync(hooksDirectoryPath);
    fs.writeFileSync(preCommitPath, originalPreCommitContents, 'utf8');
    runGit(repoRoot, ['config', '--local', 'core.hooksPath', '.githooks']);

    const installResult = await installRepoHooks({ repoRoot, wrapExistingHookFiles: true });
    const wrappedPreCommitContents = fs.readFileSync(preCommitPath, 'utf8');
    const delegateContentsBeforeUninstall = fs.readFileSync(delegatePath, 'utf8');
    const rerunResult = await installRepoHooks({ repoRoot });
    const rerunPreCommitContents = fs.readFileSync(preCommitPath, 'utf8');
    const hasPostCommitBeforeUninstall = fs.existsSync(path.join(hooksDirectoryPath, 'post-commit'));
    const uninstallResult = await uninstallRepoHooks({ repoRoot });

    assert.deepEqual({
        installStatus: installResult.status,
        installConflictingHookFiles: installResult.conflictingHookFiles,
        installWrappedHookFiles: installResult.wrappedHookFiles,
        wrappedPreCommitIsManaged: wrappedPreCommitContents.includes('# AILoc2 managed hook: pre-commit'),
        wrappedPreCommitDelegatesOriginal: wrappedPreCommitContents.includes('# AILoc2 wrapped hook delegate: .githooks/pre-commit.ailoc2-delegate'),
        delegateContents: delegateContentsBeforeUninstall,
        hasPostCommit: hasPostCommitBeforeUninstall,
        rerunStatus: rerunResult.status,
        rerunWrappedHookFiles: rerunResult.wrappedHookFiles,
        rerunPreservesDelegate: rerunPreCommitContents.includes('# AILoc2 wrapped hook delegate: .githooks/pre-commit.ailoc2-delegate'),
        uninstallStatus: uninstallResult.status,
        restoredPreCommitContents: fs.readFileSync(preCommitPath, 'utf8'),
        delegateStillExists: fs.existsSync(delegatePath)
    }, {
        installStatus: 'already-installed',
        installConflictingHookFiles: ['pre-commit'],
        installWrappedHookFiles: ['pre-commit'],
        wrappedPreCommitIsManaged: true,
        wrappedPreCommitDelegatesOriginal: true,
        delegateContents: originalPreCommitContents,
        hasPostCommit: true,
        rerunStatus: 'already-installed',
        rerunWrappedHookFiles: [],
        rerunPreservesDelegate: true,
        uninstallStatus: 'uninstalled',
        restoredPreCommitContents: originalPreCommitContents,
        delegateStillExists: false
    });
});

test('installRepoHooks wraps multiple unmanaged repo hook files', async () => {
    const repoRoot = createGitRepo('ailoc2-wrap-multiple-hooks-');
    const hooksDirectoryPath = path.join(repoRoot, '.githooks');
    fs.mkdirSync(hooksDirectoryPath);
    fs.writeFileSync(path.join(hooksDirectoryPath, 'pre-commit'), '#!/bin/sh\nprintf "%s\\n" custom-pre-commit\n', 'utf8');
    fs.writeFileSync(path.join(hooksDirectoryPath, 'commit-msg'), '#!/bin/sh\nprintf "%s\\n" custom-commit-msg\n', 'utf8');

    const installResult = await installRepoHooks({ repoRoot, wrapExistingHookFiles: true });

    assert.deepEqual({
        status: installResult.status,
        conflictingHookFiles: installResult.conflictingHookFiles,
        wrappedHookFiles: installResult.wrappedHookFiles,
        preCommitDelegateExists: fs.existsSync(path.join(hooksDirectoryPath, 'pre-commit.ailoc2-delegate')),
        commitMsgDelegateExists: fs.existsSync(path.join(hooksDirectoryPath, 'commit-msg.ailoc2-delegate')),
        preCommitWrapper: fs.readFileSync(path.join(hooksDirectoryPath, 'pre-commit'), 'utf8').includes('# AILoc2 wrapped hook delegate: .githooks/pre-commit.ailoc2-delegate'),
        commitMsgWrapper: fs.readFileSync(path.join(hooksDirectoryPath, 'commit-msg'), 'utf8').includes('# AILoc2 wrapped hook delegate: .githooks/commit-msg.ailoc2-delegate')
    }, {
        status: 'installed',
        conflictingHookFiles: ['pre-commit', 'commit-msg'],
        wrappedHookFiles: ['pre-commit', 'commit-msg'],
        preCommitDelegateExists: true,
        commitMsgDelegateExists: true,
        preCommitWrapper: true,
        commitMsgWrapper: true
    });
});

test('installRepoHooks creates a migration package when wrapping would overwrite a delegate', async () => {
    const repoRoot = createGitRepo('ailoc2-hook-manual-merge-');
    const hooksDirectoryPath = path.join(repoRoot, '.githooks');
    const preCommitPath = path.join(hooksDirectoryPath, 'pre-commit');
    const commitMsgPath = path.join(hooksDirectoryPath, 'commit-msg');
    const originalPreCommitContents = '#!/bin/sh\nprintf "%s\\n" custom-pre-commit\n';
    const originalCommitMsgContents = '#!/bin/sh\nprintf "%s\\n" custom-commit-msg\n';
    fs.mkdirSync(hooksDirectoryPath);
    fs.writeFileSync(preCommitPath, originalPreCommitContents, 'utf8');
    fs.writeFileSync(commitMsgPath, originalCommitMsgContents, 'utf8');
    fs.writeFileSync(path.join(hooksDirectoryPath, 'pre-commit.ailoc2-delegate'), '#!/bin/sh\nprintf "%s\\n" existing-delegate\n', 'utf8');

    const installResult = await installRepoHooks({ repoRoot, wrapExistingHookFiles: true });

    assert.deepEqual({
        status: installResult.status,
        conflictingHookFiles: installResult.conflictingHookFiles,
        wrappedHookFiles: installResult.wrappedHookFiles,
        manualMergeHookFiles: installResult.manualMergeHookFiles,
        migrationPackagePath: installResult.migrationPackagePath,
        migrationPackageFiles: installResult.migrationPackageFiles,
        preCommitContents: fs.readFileSync(preCommitPath, 'utf8'),
        commitMsgContents: fs.readFileSync(commitMsgPath, 'utf8'),
        packagedPreCommitIsManaged: fs.readFileSync(path.join(hooksDirectoryPath, 'migration-package', 'pre-commit'), 'utf8').includes('# AILoc2 managed hook: pre-commit'),
        packagedCommitMsgIsManaged: fs.readFileSync(path.join(hooksDirectoryPath, 'migration-package', 'commit-msg'), 'utf8').includes('# AILoc2 managed hook: commit-msg'),
        packagedPostCommitIsManaged: fs.readFileSync(path.join(hooksDirectoryPath, 'migration-package', 'post-commit'), 'utf8').includes('# AILoc2 managed hook: post-commit'),
        packagedRuntimeExists: fs.existsSync(path.join(hooksDirectoryPath, 'migration-package', 'ailoc2-hook-runtime.cjs')),
        packagedInstructionsMentionCopilot: fs.readFileSync(path.join(hooksDirectoryPath, 'migration-package', 'COPILOT-INSTRUCTIONS.md'), 'utf8').includes('For Copilot:'),
        coreHooksPath: runGitAllowFailure(repoRoot, ['config', '--local', '--get', 'core.hooksPath']).trim(),
        gitignoreExists: fs.existsSync(path.join(repoRoot, '.gitignore'))
    }, {
        status: 'manual-merge-required',
        conflictingHookFiles: ['pre-commit', 'commit-msg'],
        wrappedHookFiles: [],
        manualMergeHookFiles: [
            '.githooks/migration-package/pre-commit',
            '.githooks/migration-package/commit-msg',
            '.githooks/migration-package/post-commit',
            '.githooks/migration-package/ailoc2-hook-runtime.cjs',
            '.githooks/migration-package/COPILOT-INSTRUCTIONS.md'
        ],
        migrationPackagePath: '.githooks/migration-package',
        migrationPackageFiles: [
            '.githooks/migration-package/pre-commit',
            '.githooks/migration-package/commit-msg',
            '.githooks/migration-package/post-commit',
            '.githooks/migration-package/ailoc2-hook-runtime.cjs',
            '.githooks/migration-package/COPILOT-INSTRUCTIONS.md'
        ],
        preCommitContents: originalPreCommitContents,
        commitMsgContents: originalCommitMsgContents,
        packagedPreCommitIsManaged: true,
        packagedCommitMsgIsManaged: true,
        packagedPostCommitIsManaged: true,
        packagedRuntimeExists: true,
        packagedInstructionsMentionCopilot: true,
        coreHooksPath: '',
        gitignoreExists: false
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

function runGitAllowFailure(repoRoot: string, args: string[]): string {
    try {
        return runGit(repoRoot, args);
    }
    catch {
        return '';
    }
}
