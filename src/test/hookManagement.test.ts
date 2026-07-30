import assert from 'node:assert/strict';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import { installRepoHooks, uninstallRepoHooks } from '../hooks/management';
import { getRollingStatePath } from '../metrics/pathing';
import { METRICS_SCHEMA_VERSION } from '../metrics/schema';

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
    const commitMsgHook = fs.readFileSync(path.join(repoRoot, '.githooks', 'commit-msg'), 'utf8');

    assert.deepEqual({
        status: installResult.status,
        gitignoreUpdated: installResult.gitignoreUpdated,
        hasMetricsIgnore: gitignoreContents.includes('.ailoc2-metrics/'),
        hasHooksIgnoreAlreadyNormalized: gitignoreContents.includes('.githooks\n'),
        hasClaudeIgnore: gitignoreContents.includes('.claude/'),
        hasClaudeRuntime: fs.existsSync(path.join(repoRoot, '.claude', 'ailoc2-claude-code.cjs')),
        hasClaudeCaptureHook: claudeSettings.hooks?.PreToolUse?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes('capture-before'))),
        hasClaudeRecordHook: claudeSettings.hooks?.PostToolUse?.some((entry) => entry.hooks?.some((hook) => hook.command?.includes('record-edit'))),
        usesCombinedPreCommit: fs.readFileSync(path.join(repoRoot, '.githooks', 'pre-commit'), 'utf8').includes('prepare-commit >/dev/null'),
        hasUnavailableAnnotation: commitMsgHook.includes("PLACEHOLDER_ANNOTATION='(AI-Lines: unavailable)'"),
        hasUnavailableSubjectSuffix: commitMsgHook.includes("PLACEHOLDER_SUBJECT_SUFFIX=' (AI: unavailable)'"),
        stripsLegacySuffix: commitMsgHook.includes('AI:? [^)]*'),
        stripsLineSuffixes: commitMsgHook.includes('AI lines: [^)]*') && commitMsgHook.includes('H lines: [^)]*'),
        writesAnnotationToBody: commitMsgHook.includes("printf '%s%s\n\n%s\n%s\n'")
    }, {
        status: 'installed',
        gitignoreUpdated: true,
        hasMetricsIgnore: true,
        hasHooksIgnoreAlreadyNormalized: true,
        hasClaudeIgnore: true,
        hasClaudeRuntime: true,
        hasClaudeCaptureHook: true,
        hasClaudeRecordHook: true,
        usesCombinedPreCommit: true,
        hasUnavailableAnnotation: true,
        hasUnavailableSubjectSuffix: true,
        stripsLegacySuffix: true,
        stripsLineSuffixes: true,
        writesAnnotationToBody: true
    });
});

test('commit-msg refresh includes files staged by a delegated pre-commit hook', async () => {
    const repoRoot = createGitRepo('ailoc2-final-index-hook-');
    const aiGitPath = 'src/ai.ts';
    const humanGitPath = 'src/human.ts';
    const aiRepoRelativePath = path.normalize(aiGitPath);
    const humanRepoRelativePath = path.normalize(humanGitPath);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, aiGitPath), 'const value = "base";\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, humanGitPath), 'const value = "base";\n', 'utf8');
    runGit(repoRoot, ['add', aiGitPath, humanGitPath]);
    runGit(repoRoot, ['commit', '-m', 'add tracked files']);

    fs.writeFileSync(path.join(repoRoot, aiGitPath), 'const value = "next";\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, humanGitPath), 'const value = "next";\n', 'utf8');
    runGit(repoRoot, ['add', aiGitPath]);
    writeRollingState(repoRoot, aiRepoRelativePath, 'AI');
    writeRollingState(repoRoot, humanRepoRelativePath, 'Human');

    const hooksDirectoryPath = path.join(repoRoot, '.githooks');
    fs.mkdirSync(hooksDirectoryPath, { recursive: true });
    fs.writeFileSync(
        path.join(hooksDirectoryPath, 'pre-commit'),
        `#!/bin/sh\ngit add "${humanGitPath}"\n`,
        'utf8'
    );
    const installResult = await installRepoHooks({ repoRoot, wrapExistingHookFiles: true });

    runGit(repoRoot, ['commit', '-m', 'final index attribution']);
    const commitMessage = runGit(repoRoot, ['log', '-1', '--pretty=%B']).trim();

    assert.equal(installResult.status, 'installed');
    assert.equal(
        commitMessage,
        'final index attribution (AI: 50%)\n\n(AI-Lines: 1/2)\n(Unsure: 0/1)'
    );
});

test('installRepoHooks upgrades a markerless legacy commit-msg hook', async () => {
    const repoRoot = createGitRepo('ailoc2-legacy-hook-upgrade-');
    const hooksDirectoryPath = path.join(repoRoot, '.githooks');
    const commitMsgPath = path.join(hooksDirectoryPath, 'commit-msg');
    fs.mkdirSync(hooksDirectoryPath, { recursive: true });
    fs.writeFileSync(commitMsgPath, createMarkerlessLegacyCommitMsgHook(), 'utf8');

    const installResult = await installRepoHooks({ repoRoot });
    const upgradedHook = fs.readFileSync(commitMsgPath, 'utf8');

    assert.equal(installResult.status, 'installed');
    assert.match(upgradedHook, /# AILoc2 managed hook: commit-msg/u);
    assert.ok(upgradedHook.includes('(AI-Lines: unavailable)'));
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
    const delegateIsExecutableAfterInstall = hasPosixExecutePermission(delegatePath);
    fs.chmodSync(delegatePath, 0o644);
    const rerunResult = await installRepoHooks({ repoRoot });
    const rerunPreCommitContents = fs.readFileSync(preCommitPath, 'utf8');
    const delegateIsExecutableAfterRerun = hasPosixExecutePermission(delegatePath);
    const hasPostCommitBeforeUninstall = fs.existsSync(path.join(hooksDirectoryPath, 'post-commit'));
    const uninstallResult = await uninstallRepoHooks({ repoRoot });

    assert.deepEqual({
        installStatus: installResult.status,
        installConflictingHookFiles: installResult.conflictingHookFiles,
        installWrappedHookFiles: installResult.wrappedHookFiles,
        wrappedPreCommitIsManaged: wrappedPreCommitContents.includes('# AILoc2 managed hook: pre-commit'),
        wrappedPreCommitDelegatesOriginal: wrappedPreCommitContents.includes('# AILoc2 wrapped hook delegate: .githooks/pre-commit.ailoc2-delegate'),
        delegateContents: delegateContentsBeforeUninstall,
        delegateIsExecutableAfterInstall,
        hasPostCommit: hasPostCommitBeforeUninstall,
        rerunStatus: rerunResult.status,
        rerunWrappedHookFiles: rerunResult.wrappedHookFiles,
        rerunPreservesDelegate: rerunPreCommitContents.includes('# AILoc2 wrapped hook delegate: .githooks/pre-commit.ailoc2-delegate'),
        delegateIsExecutableAfterRerun,
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
        delegateIsExecutableAfterInstall: true,
        hasPostCommit: true,
        rerunStatus: 'already-installed',
        rerunWrappedHookFiles: [],
        rerunPreservesDelegate: true,
        delegateIsExecutableAfterRerun: true,
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

function hasPosixExecutePermission(filePath: string): boolean {
    return process.platform === 'win32' || (fs.statSync(filePath).mode & 0o111) !== 0;
}

function writeRollingState(repoRoot: string, repoRelativePath: string, attribution: 'AI' | 'Human'): void {
    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    const aiMagnitude = attribution === 'AI' ? 1 : 0;
    const humanMagnitude = attribution === 'Human' ? 1 : 0;
    fs.mkdirSync(path.dirname(rollingStatePath), { recursive: true });
    fs.writeFileSync(rollingStatePath, JSON.stringify({
        schemaVersion: METRICS_SCHEMA_VERSION,
        recordType: 'file-rolling-state',
        repoRoot,
        repoRelativePath,
        lastRecordedAt: new Date().toISOString(),
        latestSignal: attribution === 'AI'
            ? 'ProbableAIApplyToWorkspaceFile'
            : 'LikelyHumanOrRegularEditorEdit',
        signalCounters: {},
        cumulativeAiChangeMagnitude: aiMagnitude,
        cumulativeHumanChangeMagnitude: humanMagnitude,
        saveAttributionCheckpoints: [],
        lineAttributionSpans: [{ attribution, lineCount: 1 }],
        deletedAt: null
    }), 'utf8');
}

function createMarkerlessLegacyCommitMsgHook(): string {
    return `#!/bin/sh

MESSAGE_FILE="$1"
CLI_PATH="./.githooks/ailoc2-runtime/out/cli/gitHookCli.js"
PLACEHOLDER_SUFFIX=' (AI: unavailable)'

append_placeholder_suffix() {
    if [ -z "$MESSAGE_FILE" ] || [ ! -f "$MESSAGE_FILE" ]; then
        return 0
    fi

    TEMP_FILE="\${MESSAGE_FILE}.ailoc2.$$"
    SUBJECT_LINE=$(sed -n '1p' "$MESSAGE_FILE" | sed -E 's/[[:space:]]+\\(AI:? [^)]*\\)$//')

    {
        if [ -n "$SUBJECT_LINE" ]; then
            printf '%s%s\\n' "$SUBJECT_LINE" "$PLACEHOLDER_SUFFIX"
        else
            printf '%s\\n' "\${PLACEHOLDER_SUFFIX# }"
        fi
        sed '1d' "$MESSAGE_FILE"
    } > "$TEMP_FILE" && mv "$TEMP_FILE" "$MESSAGE_FILE"
}

if [ -n "$MESSAGE_FILE" ] && command -v node >/dev/null 2>&1 && [ -f "$CLI_PATH" ]; then
    node "$CLI_PATH" annotate-commit-message "$MESSAGE_FILE" >/dev/null 2>&1 || append_placeholder_suffix
else
    append_placeholder_suffix
fi

exit 0
`;
}
