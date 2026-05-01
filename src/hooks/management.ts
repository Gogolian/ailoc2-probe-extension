import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

const execFile = util.promisify(childProcess.execFile);

export const REPO_HOOKS_DIRECTORY_NAME = '.githooks';
export const REPO_HOOKS_PATH_VALUE = '.githooks';
export const MANAGED_HOOK_RUNTIME_FILE_NAME = 'ailoc2-hook-runtime.cjs';
export const REQUIRED_REPO_HOOK_FILES = [
    'pre-commit',
    'commit-msg'
] as const;

type RepoHookFileName = typeof REQUIRED_REPO_HOOK_FILES[number];

const CORE_HOOKS_PATH_CONFIG_KEY = 'core.hooksPath';
const PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY = 'ailoc2Probe.previousLocalHooksPath';
const DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY = 'ailoc2Probe.delegateLocalHooksPath';
const LEGACY_MANAGED_HOOK_RUNTIME_DIRECTORY_NAME = 'ailoc2-runtime';
const MANAGED_HOOK_MARKER_PREFIX = '# AILoc2 managed hook: ';

export type RepoHookInstallResult = {
    status: 'installed' | 'already-installed' | 'conflict';
    repoRoot: string;
    hooksDirectoryPath: string;
    currentLocalHooksPath: string | null;
    currentEffectiveHooksPath: string | null;
    replacedPreviousLocalHooksPath: string | null;
    delegatedHooksPath: string | null;
};

export type RepoHookUninstallResult = {
    status: 'uninstalled' | 'restored-previous' | 'not-installed';
    repoRoot: string;
    hooksDirectoryPath: string;
    currentLocalHooksPath: string | null;
    currentEffectiveHooksPath: string | null;
    restoredHooksPath: string | null;
    removedManagedHookAssets: boolean;
};

export async function installRepoHooks(args: {
    repoRoot: string;
    allowReplacingExistingLocalHooksPath?: boolean;
    chainExistingLocalHooksPath?: boolean;
}): Promise<RepoHookInstallResult> {
    const repoRoot = path.resolve(args.repoRoot);
    await assertGitRepositoryRoot(repoRoot);

    const currentLocalHooksPath = await getGitConfigValue(repoRoot, CORE_HOOKS_PATH_CONFIG_KEY, 'local');
    const currentEffectiveHooksPath = await getGitConfigValue(repoRoot, CORE_HOOKS_PATH_CONFIG_KEY, 'effective');
    const existingDelegatedHooksPath = await getGitConfigValue(repoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, 'local');
    const hooksDirectoryPath = getRepoHooksDirectoryPath(repoRoot);
    const isAlreadyInstalled = isRepoManagedHooksPath(repoRoot, currentLocalHooksPath)
        || (!currentLocalHooksPath && isRepoManagedHooksPath(repoRoot, currentEffectiveHooksPath));
    const delegatedHooksPath = isAlreadyInstalled
        ? existingDelegatedHooksPath
        : args.chainExistingLocalHooksPath && currentLocalHooksPath
        ? currentLocalHooksPath
        : null;

    if (currentLocalHooksPath && !isRepoManagedHooksPath(repoRoot, currentLocalHooksPath) && !args.allowReplacingExistingLocalHooksPath) {
        return {
            status: 'conflict',
            repoRoot,
            hooksDirectoryPath,
            currentLocalHooksPath,
            currentEffectiveHooksPath,
            replacedPreviousLocalHooksPath: null,
            delegatedHooksPath: null
        };
    }

    await ensureManagedRepoHookAssetsInstalled(repoRoot, delegatedHooksPath);

    if (isAlreadyInstalled) {
        return {
            status: 'already-installed',
            repoRoot,
            hooksDirectoryPath,
            currentLocalHooksPath,
            currentEffectiveHooksPath,
            replacedPreviousLocalHooksPath: null,
            delegatedHooksPath
        };
    }

    let replacedPreviousLocalHooksPath: string | null = null;
    if (currentLocalHooksPath) {
        replacedPreviousLocalHooksPath = currentLocalHooksPath;
        await setLocalGitConfigValue(repoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, currentLocalHooksPath);
    }
    else {
        await unsetLocalGitConfigValue(repoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
    }

    if (delegatedHooksPath) {
        await setLocalGitConfigValue(repoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, delegatedHooksPath);
    }
    else {
        await unsetLocalGitConfigValue(repoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
    }

    await setLocalGitConfigValue(repoRoot, CORE_HOOKS_PATH_CONFIG_KEY, REPO_HOOKS_PATH_VALUE);

    return {
        status: 'installed',
        repoRoot,
        hooksDirectoryPath,
        currentLocalHooksPath: REPO_HOOKS_PATH_VALUE,
        currentEffectiveHooksPath: REPO_HOOKS_PATH_VALUE,
        replacedPreviousLocalHooksPath,
        delegatedHooksPath
    };
}

export async function uninstallRepoHooks(args: {
    repoRoot: string;
}): Promise<RepoHookUninstallResult> {
    const repoRoot = path.resolve(args.repoRoot);
    const hooksDirectoryPath = getRepoHooksDirectoryPath(repoRoot);
    const currentLocalHooksPath = await getGitConfigValue(repoRoot, CORE_HOOKS_PATH_CONFIG_KEY, 'local');
    const currentEffectiveHooksPath = await getGitConfigValue(repoRoot, CORE_HOOKS_PATH_CONFIG_KEY, 'effective');
    const removedManagedHookAssets = await removeManagedHookAssets(repoRoot);

    if (!isRepoManagedHooksPath(repoRoot, currentLocalHooksPath)) {
        if (removedManagedHookAssets) {
            await unsetLocalGitConfigValue(repoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
            await unsetLocalGitConfigValue(repoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
        }

        return {
            status: 'not-installed',
            repoRoot,
            hooksDirectoryPath,
            currentLocalHooksPath,
            currentEffectiveHooksPath,
            restoredHooksPath: null,
            removedManagedHookAssets
        };
    }

    const previousLocalHooksPath = await getGitConfigValue(repoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, 'local');
    if (previousLocalHooksPath) {
        await setLocalGitConfigValue(repoRoot, CORE_HOOKS_PATH_CONFIG_KEY, previousLocalHooksPath);
        await unsetLocalGitConfigValue(repoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
        await unsetLocalGitConfigValue(repoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
        return {
            status: 'restored-previous',
            repoRoot,
            hooksDirectoryPath,
            currentLocalHooksPath,
            currentEffectiveHooksPath: previousLocalHooksPath,
            restoredHooksPath: previousLocalHooksPath,
            removedManagedHookAssets
        };
    }

    await unsetLocalGitConfigValue(repoRoot, CORE_HOOKS_PATH_CONFIG_KEY, true);
    await unsetLocalGitConfigValue(repoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
    await unsetLocalGitConfigValue(repoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);

    return {
        status: 'uninstalled',
        repoRoot,
        hooksDirectoryPath,
        currentLocalHooksPath: null,
        currentEffectiveHooksPath: await getGitConfigValue(repoRoot, CORE_HOOKS_PATH_CONFIG_KEY, 'effective'),
        restoredHooksPath: null,
        removedManagedHookAssets
    };
}

export function getRepoHooksDirectoryPath(repoRoot: string): string {
    return path.join(repoRoot, REPO_HOOKS_DIRECTORY_NAME);
}

export function getManagedHookRuntimeFilePath(repoRoot: string): string {
    return path.join(getRepoHooksDirectoryPath(repoRoot), MANAGED_HOOK_RUNTIME_FILE_NAME);
}

function isRepoManagedHooksPath(repoRoot: string, candidateHooksPath: string | null): boolean {
    if (!candidateHooksPath) {
        return false;
    }

    const resolvedCandidatePath = path.isAbsolute(candidateHooksPath)
        ? candidateHooksPath
        : path.resolve(repoRoot, candidateHooksPath);
    return normalizePath(resolvedCandidatePath) === normalizePath(getRepoHooksDirectoryPath(repoRoot));
}

async function assertGitRepositoryRoot(repoRoot: string): Promise<void> {
    if (!(await pathExists(path.join(repoRoot, '.git')))) {
        throw new Error(`The selected path is not a Git repository root: ${repoRoot}`);
    }
}

async function ensureManagedRepoHookAssetsInstalled(repoRoot: string, delegatedHooksPath: string | null): Promise<void> {
    await fs.promises.mkdir(getRepoHooksDirectoryPath(repoRoot), { recursive: true });
    await ensureManagedHookFile(repoRoot, 'pre-commit', delegatedHooksPath);
    await ensureManagedHookFile(repoRoot, 'commit-msg', delegatedHooksPath);
    await installManagedRuntimeAssets(repoRoot);
    await removeLegacyManagedRuntimeAssets(repoRoot);

    await Promise.all(REQUIRED_REPO_HOOK_FILES.map(async (hookFileName) => {
        try {
            await fs.promises.chmod(path.join(getRepoHooksDirectoryPath(repoRoot), hookFileName), 0o755);
        }
        catch {
            // Best effort only; Git for Windows does not depend on POSIX executable bits.
        }
    }));
}

async function ensureManagedHookFile(
    repoRoot: string,
    hookFileName: RepoHookFileName,
    delegatedHooksPath: string | null
): Promise<void> {
    const expectedContents = createManagedHookFileContents(hookFileName, delegatedHooksPath);
    const hookFilePath = path.join(getRepoHooksDirectoryPath(repoRoot), hookFileName);
    if (await pathExists(hookFilePath)) {
        const existingContents = await fs.promises.readFile(hookFilePath, 'utf8');
        if (!isManagedHookFileText(hookFileName, existingContents)) {
            throw new Error(
                `The repo-local ${path.join(REPO_HOOKS_DIRECTORY_NAME, hookFileName)} file already exists and is not managed by AILoc2.`
            );
        }

        if (normalizeHookFileText(existingContents) === normalizeHookFileText(expectedContents)) {
            return;
        }
    }

    await fs.promises.writeFile(hookFilePath, expectedContents, 'utf8');
}

async function installManagedRuntimeAssets(repoRoot: string): Promise<void> {
    const sourceRuntimeFilePath = getExtensionRuntimeFilePath();
    if (!(await pathExists(sourceRuntimeFilePath))) {
        throw new Error(`AILoc2 runtime asset is missing at ${sourceRuntimeFilePath}. Build the extension before installing hooks.`);
    }

    const managedRuntimeFilePath = getManagedHookRuntimeFilePath(repoRoot);
    await fs.promises.mkdir(path.dirname(managedRuntimeFilePath), { recursive: true });
    await fs.promises.copyFile(sourceRuntimeFilePath, managedRuntimeFilePath);
}

async function removeManagedRuntimeAssets(repoRoot: string): Promise<boolean> {
    const removedManagedRuntimeFile = await removePathIfExists(getManagedHookRuntimeFilePath(repoRoot));
    const removedLegacyManagedRuntimeAssets = await removeLegacyManagedRuntimeAssets(repoRoot);
    return removedManagedRuntimeFile || removedLegacyManagedRuntimeAssets;
}

async function removeLegacyManagedRuntimeAssets(repoRoot: string): Promise<boolean> {
    return removePathIfExists(getLegacyManagedHookRuntimeDirectoryPath(repoRoot), true);
}

async function removeManagedHookAssets(repoRoot: string): Promise<boolean> {
    const removedManagedHookFiles = await Promise.all(REQUIRED_REPO_HOOK_FILES.map((hookFileName) => removeManagedHookFile(repoRoot, hookFileName)));
    const removedManagedRuntimeAssets = await removeManagedRuntimeAssets(repoRoot);
    await removeEmptyHookDirectoryIfPossible(repoRoot);
    return removedManagedHookFiles.some(Boolean) || removedManagedRuntimeAssets;
}

async function removeManagedHookFile(repoRoot: string, hookFileName: RepoHookFileName): Promise<boolean> {
    const hookFilePath = path.join(getRepoHooksDirectoryPath(repoRoot), hookFileName);
    if (!(await pathExists(hookFilePath))) {
        return false;
    }

    const existingContents = await fs.promises.readFile(hookFilePath, 'utf8');
    if (!isManagedHookFileText(hookFileName, existingContents)) {
        return false;
    }

    await fs.promises.rm(hookFilePath, { force: true });
    return true;
}

async function removeEmptyHookDirectoryIfPossible(repoRoot: string): Promise<void> {
    const hookDirectoryPath = getRepoHooksDirectoryPath(repoRoot);

    try {
        const remainingEntries = await fs.promises.readdir(hookDirectoryPath);
        if (remainingEntries.length === 0) {
            await fs.promises.rmdir(hookDirectoryPath);
        }
    }
    catch {
        // Nothing to do if the hook directory is already gone or cannot be removed.
    }
}

function getExtensionRuntimeFilePath(): string {
    return path.resolve(__dirname, '..', 'hook-runtime', MANAGED_HOOK_RUNTIME_FILE_NAME);
}

function getLegacyManagedHookRuntimeDirectoryPath(repoRoot: string): string {
    return path.join(getRepoHooksDirectoryPath(repoRoot), LEGACY_MANAGED_HOOK_RUNTIME_DIRECTORY_NAME);
}

function createManagedHookFileContents(hookFileName: RepoHookFileName, delegatedHooksPath: string | null): string {
    switch (hookFileName) {
        case 'pre-commit':
            return createManagedPreCommitHookScript(delegatedHooksPath);
        case 'commit-msg':
            return createManagedCommitMsgHookScript(delegatedHooksPath);
        default:
            throw new Error(`Unsupported managed hook file: ${hookFileName}`);
    }
}

function createManagedPreCommitHookScript(delegatedHooksPath: string | null): string {
    const delegatedHookPath = createDelegatedHookScriptPath(delegatedHooksPath, 'pre-commit');
    return `#!/bin/sh
# AILoc2 managed hook: pre-commit

CLI_PATH="./.githooks/${MANAGED_HOOK_RUNTIME_FILE_NAME}"
DELEGATE_HOOK_PATH="${escapeForDoubleQuotedShell(delegatedHookPath)}"

run_delegate_hook() {
    if [ -z "$DELEGATE_HOOK_PATH" ] || [ ! -f "$DELEGATE_HOOK_PATH" ]; then
        return 0
    fi

    "$DELEGATE_HOOK_PATH" "$@"
}

if command -v node >/dev/null 2>&1 && [ -f "$CLI_PATH" ]; then
    node "$CLI_PATH" refresh-summary >/dev/null 2>&1 || printf '%s\n' 'AILoc2 pre-commit warning: summary refresh failed; continuing without blocking the commit.' >&2
else
    printf '%s\n' 'AILoc2 pre-commit warning: Node CLI is unavailable; skipping summary refresh.' >&2
fi

run_delegate_hook "$@"
exit $?
`;
}

function createManagedCommitMsgHookScript(delegatedHooksPath: string | null): string {
    const delegatedHookPath = createDelegatedHookScriptPath(delegatedHooksPath, 'commit-msg');
    return `#!/bin/sh
# AILoc2 managed hook: commit-msg

MESSAGE_FILE="$1"
CLI_PATH="./.githooks/${MANAGED_HOOK_RUNTIME_FILE_NAME}"
DELEGATE_HOOK_PATH="${escapeForDoubleQuotedShell(delegatedHookPath)}"
PLACEHOLDER_SUFFIX=' (AI unavailable)'

run_delegate_hook() {
    if [ -z "$DELEGATE_HOOK_PATH" ] || [ ! -f "$DELEGATE_HOOK_PATH" ]; then
        return 0
    fi

    "$DELEGATE_HOOK_PATH" "$@"
}

append_placeholder_suffix() {
    if [ -z "$MESSAGE_FILE" ] || [ ! -f "$MESSAGE_FILE" ]; then
        return 0
    fi

    TEMP_FILE="\${MESSAGE_FILE}.ailoc2.$$"
    SUBJECT_LINE=$(sed -n '1p' "$MESSAGE_FILE" | sed -E 's/[[:space:]]+\(AI [^)]*\)$//')

    {
        if [ -n "$SUBJECT_LINE" ]; then
            printf '%s%s\n' "$SUBJECT_LINE" "$PLACEHOLDER_SUFFIX"
        else
            printf '%s\n' "\${PLACEHOLDER_SUFFIX# }"
        fi
        sed '1d' "$MESSAGE_FILE"
    } > "$TEMP_FILE" && mv "$TEMP_FILE" "$MESSAGE_FILE"
}

if [ -n "$MESSAGE_FILE" ] && command -v node >/dev/null 2>&1 && [ -f "$CLI_PATH" ]; then
    node "$CLI_PATH" annotate-commit-message "$MESSAGE_FILE" >/dev/null 2>&1 || append_placeholder_suffix
else
    append_placeholder_suffix
fi

run_delegate_hook "$@"
exit $?
`;
}

function createLegacyManagedPreCommitHookScript(): string {
    return `#!/bin/sh

CLI_PATH="./.githooks/${LEGACY_MANAGED_HOOK_RUNTIME_DIRECTORY_NAME}/out/cli/gitHookCli.js"

if command -v node >/dev/null 2>&1 && [ -f "$CLI_PATH" ]; then
    node "$CLI_PATH" refresh-summary >/dev/null 2>&1 || printf '%s\n' 'AILoc2 pre-commit warning: summary refresh failed; continuing without blocking the commit.' >&2
else
    printf '%s\n' 'AILoc2 pre-commit warning: Node CLI is unavailable; skipping summary refresh.' >&2
fi

exit 0
`;
}

function createLegacyManagedCommitMsgHookScript(): string {
    return `#!/bin/sh

MESSAGE_FILE="$1"
CLI_PATH="./.githooks/${LEGACY_MANAGED_HOOK_RUNTIME_DIRECTORY_NAME}/out/cli/gitHookCli.js"
PLACEHOLDER_SUFFIX=' (AI unavailable)'

append_placeholder_suffix() {
    if [ -z "$MESSAGE_FILE" ] || [ ! -f "$MESSAGE_FILE" ]; then
        return 0
    fi

    TEMP_FILE="\${MESSAGE_FILE}.ailoc2.$$"
    SUBJECT_LINE=$(sed -n '1p' "$MESSAGE_FILE" | sed -E 's/[[:space:]]+\(AI [^)]*\)$//')

    {
        if [ -n "$SUBJECT_LINE" ]; then
            printf '%s%s\n' "$SUBJECT_LINE" "$PLACEHOLDER_SUFFIX"
        else
            printf '%s\n' "\${PLACEHOLDER_SUFFIX# }"
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

function createDelegatedHookScriptPath(delegatedHooksPath: string | null, hookFileName: RepoHookFileName): string {
    if (!delegatedHooksPath) {
        return '';
    }

    return path.posix.join(delegatedHooksPath.replace(/\\/g, '/'), hookFileName);
}

function escapeForDoubleQuotedShell(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`');
}

function isManagedHookFileText(hookFileName: RepoHookFileName, text: string): boolean {
    const normalizedText = normalizeHookFileText(text);
    if (normalizedText.split('\n').some((line) => line.trim() === `${MANAGED_HOOK_MARKER_PREFIX}${hookFileName}`)) {
        return true;
    }

    const legacyVariants = hookFileName === 'pre-commit'
        ? [createLegacyManagedPreCommitHookScript()]
        : [createLegacyManagedCommitMsgHookScript()];

    return [
        createManagedHookFileContents(hookFileName, null),
        ...legacyVariants
    ].some((candidate) => normalizeHookFileText(candidate) === normalizedText);
}

function normalizeHookFileText(text: string): string {
    return text.replace(/\r\n/g, '\n').trim();
}

async function getGitConfigValue(
    repoRoot: string,
    key: string,
    scope: 'local' | 'effective'
): Promise<string | null> {
    const args = scope === 'local'
        ? ['config', '--local', '--get', key]
        : ['config', '--get', key];

    try {
        const { stdout } = await execFile('git', args, {
            cwd: repoRoot,
            windowsHide: true,
            maxBuffer: 1024 * 1024
        });
        const value = stdout.trim();
        return value.length > 0 ? value : null;
    }
    catch {
        return null;
    }
}

async function setLocalGitConfigValue(repoRoot: string, key: string, value: string): Promise<void> {
    await execFile('git', ['config', '--local', key, value], {
        cwd: repoRoot,
        windowsHide: true,
        maxBuffer: 1024 * 1024
    });
}

async function unsetLocalGitConfigValue(repoRoot: string, key: string, ignoreMissing: boolean): Promise<void> {
    try {
        await execFile('git', ['config', '--local', '--unset', key], {
            cwd: repoRoot,
            windowsHide: true,
            maxBuffer: 1024 * 1024
        });
    }
    catch (error) {
        if (!ignoreMissing) {
            throw error;
        }
    }
}

async function pathExists(candidatePath: string): Promise<boolean> {
    try {
        await fs.promises.access(candidatePath);
        return true;
    }
    catch {
        return false;
    }
}

async function removePathIfExists(candidatePath: string, recursive = false): Promise<boolean> {
    if (!(await pathExists(candidatePath))) {
        return false;
    }

    await fs.promises.rm(candidatePath, { force: true, recursive });
    return true;
}

function normalizePath(candidatePath: string): string {
    return path.normalize(candidatePath).toLowerCase();
}
