import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

import {
    ClaudeCodeHooksInstallResult,
    installClaudeCodeHooks,
    uninstallClaudeCodeHooks
} from '../integrations/claudeCode/runtime';

const execFile = util.promisify(childProcess.execFile);

export const REPO_HOOKS_DIRECTORY_NAME = '.githooks';
export const REPO_HOOKS_PATH_VALUE = '.githooks';
export const MANAGED_HOOK_RUNTIME_FILE_NAME = 'ailoc2-hook-runtime.cjs';
export const MIGRATION_PACKAGE_DIRECTORY_NAME = 'migration-package';
export const REQUIRED_REPO_HOOK_FILES = [
    'pre-commit',
    'commit-msg',
    'post-commit'
] as const;

type RepoHookFileName = typeof REQUIRED_REPO_HOOK_FILES[number];

const CORE_HOOKS_PATH_CONFIG_KEY = 'core.hooksPath';
const PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY = 'ailoc2Probe.previousLocalHooksPath';
const DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY = 'ailoc2Probe.delegateLocalHooksPath';
const LEGACY_MANAGED_HOOK_RUNTIME_DIRECTORY_NAME = 'ailoc2-runtime';
const MANAGED_HOOK_MARKER_PREFIX = '# AILoc2 managed hook: ';
const WRAPPED_HOOK_DELEGATE_MARKER_PREFIX = '# AILoc2 wrapped hook delegate: ';
const WRAPPED_HOOK_DELEGATE_FILE_SUFFIX = '.ailoc2-delegate';
const MANAGED_GITIGNORE_PATTERNS = [
    '.ailoc2-metrics/',
    '.githooks/',
    '.claude/'
] as const;

type HookDelegateSpec = {
    path: string;
    wrapped: boolean;
};

type HookFileWrapResult = {
    wrappedHookFiles: RepoHookFileName[];
    manualMergeHookFiles: string[];
};

export type RepoHookInstallResult = {
    status: 'installed' | 'already-installed' | 'conflict' | 'hook-file-conflict' | 'manual-merge-required';
    repoRoot: string;
    hooksDirectoryPath: string;
    currentLocalHooksPath: string | null;
    currentEffectiveHooksPath: string | null;
    replacedPreviousLocalHooksPath: string | null;
    delegatedHooksPath: string | null;
    conflictingHookFiles: RepoHookFileName[];
    wrappedHookFiles: RepoHookFileName[];
    manualMergeHookFiles: string[];
    migrationPackagePath: string | null;
    migrationPackageFiles: string[];
    claudeCodeHooks: ClaudeCodeHooksInstallResult | null;
    gitignoreUpdated: boolean;
};

export type RepoHookUninstallResult = {
    status: 'uninstalled' | 'restored-previous' | 'not-installed';
    repoRoot: string;
    hooksDirectoryPath: string;
    currentLocalHooksPath: string | null;
    currentEffectiveHooksPath: string | null;
    restoredHooksPath: string | null;
    removedManagedHookAssets: boolean;
    removedClaudeCodeHooks: boolean;
};

export async function installRepoHooks(args: {
    repoRoot: string;
    allowReplacingExistingLocalHooksPath?: boolean;
    chainExistingLocalHooksPath?: boolean;
    wrapExistingHookFiles?: boolean;
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
            delegatedHooksPath: null,
            conflictingHookFiles: [],
            wrappedHookFiles: [],
            manualMergeHookFiles: [],
            migrationPackagePath: null,
            migrationPackageFiles: [],
            claudeCodeHooks: null,
            gitignoreUpdated: false
        };
    }

    const conflictingHookFiles = await findUnmanagedHookFileConflicts(repoRoot);
    if (conflictingHookFiles.length > 0 && !args.wrapExistingHookFiles) {
        return {
            status: 'hook-file-conflict',
            repoRoot,
            hooksDirectoryPath,
            currentLocalHooksPath,
            currentEffectiveHooksPath,
            replacedPreviousLocalHooksPath: null,
            delegatedHooksPath,
            conflictingHookFiles,
            wrappedHookFiles: [],
            manualMergeHookFiles: [],
            migrationPackagePath: null,
            migrationPackageFiles: [],
            claudeCodeHooks: null,
            gitignoreUpdated: false
        };
    }

    await assertManagedRuntimeAssetsAvailable();

    let wrappedHookFiles: RepoHookFileName[] = [];
    if (conflictingHookFiles.length > 0) {
        const wrapResult = await wrapUnmanagedHookFiles(repoRoot, conflictingHookFiles, delegatedHooksPath);
        if (wrapResult.manualMergeHookFiles.length > 0) {
            const migrationPackagePath = getMigrationPackageDisplayPath();
            return {
                status: 'manual-merge-required',
                repoRoot,
                hooksDirectoryPath,
                currentLocalHooksPath,
                currentEffectiveHooksPath,
                replacedPreviousLocalHooksPath: null,
                delegatedHooksPath,
                conflictingHookFiles,
                wrappedHookFiles: [],
                manualMergeHookFiles: wrapResult.manualMergeHookFiles,
                migrationPackagePath,
                migrationPackageFiles: wrapResult.manualMergeHookFiles,
                claudeCodeHooks: null,
                gitignoreUpdated: false
            };
        }
        wrappedHookFiles = wrapResult.wrappedHookFiles;
    }

    const gitignoreUpdated = await ensureManagedPathsIgnored(repoRoot);
    try {
        await ensureManagedRepoHookAssetsInstalled(repoRoot, delegatedHooksPath, wrappedHookFiles);
    }
    catch (error) {
        if (isUnmanagedHookFileConflictError(error)) {
            await writeMigrationPackage(repoRoot, delegatedHooksPath);
            throw new Error(`${error.message} Prepared migration package at ${getMigrationPackageDisplayPath()}.`);
        }

        throw error;
    }
    const claudeCodeHooks = await ensureClaudeCodeHooksInstalled(repoRoot);

    if (isAlreadyInstalled) {
        return {
            status: 'already-installed',
            repoRoot,
            hooksDirectoryPath,
            currentLocalHooksPath,
            currentEffectiveHooksPath,
            replacedPreviousLocalHooksPath: null,
            delegatedHooksPath,
            conflictingHookFiles,
            wrappedHookFiles,
            manualMergeHookFiles: [],
            migrationPackagePath: null,
            migrationPackageFiles: [],
            claudeCodeHooks,
            gitignoreUpdated
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
        delegatedHooksPath,
        conflictingHookFiles,
        wrappedHookFiles,
        manualMergeHookFiles: [],
        migrationPackagePath: null,
        migrationPackageFiles: [],
        claudeCodeHooks,
        gitignoreUpdated
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
    const removedClaudeCodeHooks = await removeClaudeCodeHooks(repoRoot);

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
            removedManagedHookAssets,
            removedClaudeCodeHooks
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
            removedManagedHookAssets,
            removedClaudeCodeHooks
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
        removedManagedHookAssets,
        removedClaudeCodeHooks
    };
}

export function getRepoHooksDirectoryPath(repoRoot: string): string {
    return path.join(repoRoot, REPO_HOOKS_DIRECTORY_NAME);
}

export function getManagedHookRuntimeFilePath(repoRoot: string): string {
    return path.join(getRepoHooksDirectoryPath(repoRoot), MANAGED_HOOK_RUNTIME_FILE_NAME);
}

export function getMigrationPackageDirectoryPath(repoRoot: string): string {
    return path.join(getRepoHooksDirectoryPath(repoRoot), MIGRATION_PACKAGE_DIRECTORY_NAME);
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

async function ensureManagedRepoHookAssetsInstalled(
    repoRoot: string,
    delegatedHooksPath: string | null,
    wrappedHookFiles: readonly RepoHookFileName[]
): Promise<void> {
    await fs.promises.mkdir(getRepoHooksDirectoryPath(repoRoot), { recursive: true });
    for (const hookFileName of REQUIRED_REPO_HOOK_FILES) {
        await ensureManagedHookFile(repoRoot, hookFileName, createHookDelegateSpecs(hookFileName, delegatedHooksPath, wrappedHookFiles));
    }
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
    delegateSpecs: readonly HookDelegateSpec[]
): Promise<void> {
    const hookFilePath = path.join(getRepoHooksDirectoryPath(repoRoot), hookFileName);
    let expectedDelegateSpecs = [...delegateSpecs];
    if (await pathExists(hookFilePath)) {
        const existingContents = await fs.promises.readFile(hookFilePath, 'utf8');
        if (!isManagedHookFileText(hookFileName, existingContents)) {
            throw new Error(
                `The repo-local ${path.join(REPO_HOOKS_DIRECTORY_NAME, hookFileName)} file already exists and is not managed by AILoc2.`
            );
        }

        expectedDelegateSpecs = mergeHookDelegateSpecs(extractWrappedHookDelegateSpecs(existingContents), expectedDelegateSpecs);
        const expectedContents = createManagedHookFileContents(hookFileName, expectedDelegateSpecs);
        if (normalizeHookFileText(existingContents) === normalizeHookFileText(expectedContents)) {
            return;
        }

        await fs.promises.writeFile(hookFilePath, expectedContents, 'utf8');
        return;
    }

    const expectedContents = createManagedHookFileContents(hookFileName, expectedDelegateSpecs);
    await fs.promises.writeFile(hookFilePath, expectedContents, 'utf8');
}

async function findUnmanagedHookFileConflicts(repoRoot: string): Promise<RepoHookFileName[]> {
    const conflictingHookFiles: RepoHookFileName[] = [];
    for (const hookFileName of REQUIRED_REPO_HOOK_FILES) {
        const hookFilePath = path.join(getRepoHooksDirectoryPath(repoRoot), hookFileName);
        if (!(await pathExists(hookFilePath))) {
            continue;
        }

        try {
            const hookFileStat = await fs.promises.stat(hookFilePath);
            if (!hookFileStat.isFile()) {
                conflictingHookFiles.push(hookFileName);
                continue;
            }

            const existingContents = await fs.promises.readFile(hookFilePath, 'utf8');
            if (!isManagedHookFileText(hookFileName, existingContents)) {
                conflictingHookFiles.push(hookFileName);
            }
        }
        catch {
            conflictingHookFiles.push(hookFileName);
        }
    }

    return conflictingHookFiles;
}

async function wrapUnmanagedHookFiles(
    repoRoot: string,
    hookFileNames: readonly RepoHookFileName[],
    delegatedHooksPath: string | null
): Promise<HookFileWrapResult> {
    const unsafeHookFiles: RepoHookFileName[] = [];
    for (const hookFileName of hookFileNames) {
        const hookFilePath = path.join(getRepoHooksDirectoryPath(repoRoot), hookFileName);
        const delegateFilePath = getWrappedHookDelegateFilePath(repoRoot, hookFileName);
        if (await pathExists(delegateFilePath)) {
            unsafeHookFiles.push(hookFileName);
            continue;
        }

        try {
            const hookFileStat = await fs.promises.stat(hookFilePath);
            if (!hookFileStat.isFile()) {
                unsafeHookFiles.push(hookFileName);
            }
        }
        catch {
            unsafeHookFiles.push(hookFileName);
        }
    }

    if (unsafeHookFiles.length > 0) {
        const manualMergeHookFiles = await writeManualMergeHookFiles(repoRoot, hookFileNames, delegatedHooksPath);
        return {
            wrappedHookFiles: [],
            manualMergeHookFiles
        };
    }

    for (const hookFileName of hookFileNames) {
        await fs.promises.rename(
            path.join(getRepoHooksDirectoryPath(repoRoot), hookFileName),
            getWrappedHookDelegateFilePath(repoRoot, hookFileName)
        );
    }

    return {
        wrappedHookFiles: [...hookFileNames],
        manualMergeHookFiles: []
    };
}

async function writeManualMergeHookFiles(
    repoRoot: string,
    _hookFileNames: readonly RepoHookFileName[],
    delegatedHooksPath: string | null
): Promise<string[]> {
    return writeMigrationPackage(repoRoot, delegatedHooksPath);
}

async function writeMigrationPackage(
    repoRoot: string,
    delegatedHooksPath: string | null,
    hookFileNames: readonly RepoHookFileName[] = REQUIRED_REPO_HOOK_FILES
): Promise<string[]> {
    const migrationPackageDirectoryPath = getMigrationPackageDirectoryPath(repoRoot);
    await fs.promises.mkdir(migrationPackageDirectoryPath, { recursive: true });

    const migrationPackageFiles: string[] = [];
    for (const hookFileName of hookFileNames) {
        const hookFilePath = path.join(migrationPackageDirectoryPath, hookFileName);
        const hookContents = createManagedHookFileContents(
            hookFileName,
            createHookDelegateSpecs(hookFileName, delegatedHooksPath, [])
        );
        await fs.promises.writeFile(hookFilePath, hookContents, 'utf8');
        migrationPackageFiles.push(getMigrationPackageDisplayPath(hookFileName));
    }

    const runtimePackagePath = path.join(migrationPackageDirectoryPath, MANAGED_HOOK_RUNTIME_FILE_NAME);
    await fs.promises.copyFile(getExtensionRuntimeFilePath(), runtimePackagePath);
    migrationPackageFiles.push(getMigrationPackageDisplayPath(MANAGED_HOOK_RUNTIME_FILE_NAME));

    const instructionsFileName = 'COPILOT-INSTRUCTIONS.md';
    await fs.promises.writeFile(
        path.join(migrationPackageDirectoryPath, instructionsFileName),
        createMigrationPackageInstructions(delegatedHooksPath, hookFileNames),
        'utf8'
    );
    migrationPackageFiles.push(getMigrationPackageDisplayPath(instructionsFileName));

    await Promise.all(hookFileNames.map(async (hookFileName) => {
        try {
            await fs.promises.chmod(path.join(migrationPackageDirectoryPath, hookFileName), 0o755);
        }
        catch {
            // Best effort only; Git for Windows does not depend on POSIX executable bits.
        }
    }));

    return migrationPackageFiles;
}

function createMigrationPackageInstructions(
    delegatedHooksPath: string | null,
    hookFileNames: readonly RepoHookFileName[]
): string {
    const hookFileList = hookFileNames.map((hookFileName) => `- \`${hookFileName}\``).join('\n');
    const delegatedHooksNote = delegatedHooksPath
        ? `\nThe generated hook files also chain to the existing local \`core.hooksPath\` value: \`${delegatedHooksPath}\`. Preserve that chaining behavior unless the target repo no longer needs it.\n`
        : '';

    return `# AILoc2 hook migration package

AILoc2 prepared this package because it could not safely replace existing repo-local Git hooks automatically.

The hook files in this folder are the AILoc2-managed hooks that need to be chained or woven into the repo's existing hooks:

${hookFileList}

The bundled runtime file is \`${MANAGED_HOOK_RUNTIME_FILE_NAME}\`. Copy it to \`${path.posix.join(REPO_HOOKS_PATH_VALUE, MANAGED_HOOK_RUNTIME_FILE_NAME)}\` when the merge is complete, or update the generated hook \`CLI_PATH\` values if you intentionally keep it elsewhere.${delegatedHooksNote}

For Copilot:

1. Compare each existing repo hook in \`${REPO_HOOKS_PATH_VALUE}/\` with the matching file in this migration package.
2. Preserve all existing hook behavior and exit-code semantics.
3. Add the AILoc2 runtime calls from the generated hook files so AILoc2 runs before any existing delegated hook logic.
4. Do not blindly overwrite unmanaged hook files.
5. After merging, rerun \`AILoc2 Probe: Install Repo Hooks\` to let AILoc2 verify and refresh managed assets.
`;
}

function getMigrationPackageDisplayPath(fileName?: string): string {
    return fileName
        ? path.posix.join(REPO_HOOKS_PATH_VALUE, MIGRATION_PACKAGE_DIRECTORY_NAME, fileName)
        : path.posix.join(REPO_HOOKS_PATH_VALUE, MIGRATION_PACKAGE_DIRECTORY_NAME);
}

function isUnmanagedHookFileConflictError(error: unknown): error is Error {
    return error instanceof Error
        && error.message.includes('file already exists and is not managed by AILoc2');
}

async function assertManagedRuntimeAssetsAvailable(): Promise<void> {
    const sourceRuntimeFilePath = getExtensionRuntimeFilePath();
    if (!(await pathExists(sourceRuntimeFilePath))) {
        throw new Error(`AILoc2 runtime asset is missing at ${sourceRuntimeFilePath}. Build the extension before installing hooks.`);
    }

    const runtimeSourcePath = getExtensionClaudeCodeRuntimeFilePath();
    if (!(await pathExists(runtimeSourcePath))) {
        throw new Error(`AILoc2 Claude Code runtime asset is missing at ${runtimeSourcePath}. Build the extension before installing hooks.`);
    }
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

    const restorableDelegate = extractWrappedHookDelegateSpecs(existingContents)
        .find((delegateSpec) => delegateSpec.path === getWrappedHookDelegateScriptPath(hookFileName));
    if (restorableDelegate) {
        const restorableDelegatePath = path.resolve(repoRoot, restorableDelegate.path);
        if (await pathExists(restorableDelegatePath)) {
            await fs.promises.rm(hookFilePath, { force: true });
            await fs.promises.rename(restorableDelegatePath, hookFilePath);
            return true;
        }
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

async function ensureManagedPathsIgnored(repoRoot: string): Promise<boolean> {
    const gitignorePath = path.join(repoRoot, '.gitignore');
    let existingContents = '';
    try {
        existingContents = await fs.promises.readFile(gitignorePath, 'utf8');
    }
    catch {
        existingContents = '';
    }

    const existingPatterns = new Set(existingContents
        .split(/\r\n|\r|\n/)
        .map(normalizeGitignorePattern)
        .filter((line) => line.length > 0));
    const missingPatterns = MANAGED_GITIGNORE_PATTERNS.filter((pattern) => !existingPatterns.has(normalizeGitignorePattern(pattern)));
    if (missingPatterns.length === 0) {
        return false;
    }

    const separator = existingContents.length === 0 || existingContents.endsWith('\n') || existingContents.endsWith('\r') ? '' : '\n';
    await fs.promises.writeFile(
        gitignorePath,
        `${existingContents}${separator}${missingPatterns.join('\n')}\n`,
        'utf8'
    );
    return true;
}

function normalizeGitignorePattern(pattern: string): string {
    return pattern.trim()
        .replace(/^\.\//u, '')
        .replace(/\\/gu, '/')
        .replace(/\/+$/u, '');
}

async function ensureClaudeCodeHooksInstalled(repoRoot: string): Promise<ClaudeCodeHooksInstallResult> {
    const runtimeSourcePath = getExtensionClaudeCodeRuntimeFilePath();
    if (!(await pathExists(runtimeSourcePath))) {
        throw new Error(`AILoc2 Claude Code runtime asset is missing at ${runtimeSourcePath}. Build the extension before installing hooks.`);
    }

    return installClaudeCodeHooks({
        repoRoot,
        runtimeSourcePath
    });
}

async function removeClaudeCodeHooks(repoRoot: string): Promise<boolean> {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const runtimePath = path.join(repoRoot, '.claude', 'ailoc2-claude-code.cjs');
    const hadManagedClaudeCodeFiles = await pathExists(settingsPath) || await pathExists(runtimePath);
    if (!hadManagedClaudeCodeFiles) {
        return false;
    }

    await uninstallClaudeCodeHooks(repoRoot);
    return true;
}

function getExtensionClaudeCodeRuntimeFilePath(): string {
    return path.resolve(__dirname, '..', 'claude-code', 'ailoc2-claude-code.cjs');
}

function getLegacyManagedHookRuntimeDirectoryPath(repoRoot: string): string {
    return path.join(getRepoHooksDirectoryPath(repoRoot), LEGACY_MANAGED_HOOK_RUNTIME_DIRECTORY_NAME);
}

function createManagedHookFileContents(hookFileName: RepoHookFileName, delegateSpecs: readonly HookDelegateSpec[]): string {
    switch (hookFileName) {
        case 'pre-commit':
            return createManagedPreCommitHookScript(delegateSpecs);
        case 'commit-msg':
            return createManagedCommitMsgHookScript(delegateSpecs);
        case 'post-commit':
            return createManagedPostCommitHookScript(delegateSpecs);
        default:
            throw new Error(`Unsupported managed hook file: ${hookFileName}`);
    }
}

function createManagedPreCommitHookScript(delegateSpecs: readonly HookDelegateSpec[]): string {
    return `#!/bin/sh
# AILoc2 managed hook: pre-commit
${createWrappedDelegateMarkerBlock(delegateSpecs)}

CLI_PATH="./.githooks/${MANAGED_HOOK_RUNTIME_FILE_NAME}"

${createDelegateHookFunction(delegateSpecs)}

if command -v node >/dev/null 2>&1 && [ -f "$CLI_PATH" ]; then
    node "$CLI_PATH" prepare-commit-baseline >/dev/null 2>&1 || printf '%s\n' 'AILoc2 pre-commit warning: commit baseline snapshot failed; later commits may retain older attribution until the next successful baseline refresh.' >&2
    node "$CLI_PATH" refresh-summary >/dev/null 2>&1 || printf '%s\n' 'AILoc2 pre-commit warning: summary refresh failed; continuing without blocking the commit.' >&2
else
    printf '%s\n' 'AILoc2 pre-commit warning: Node CLI is unavailable; skipping summary refresh.' >&2
fi

run_delegate_hooks "$@"
exit $?
`;
}

function createManagedPostCommitHookScript(delegateSpecs: readonly HookDelegateSpec[]): string {
    return `#!/bin/sh
# AILoc2 managed hook: post-commit
${createWrappedDelegateMarkerBlock(delegateSpecs)}

CLI_PATH="./.githooks/${MANAGED_HOOK_RUNTIME_FILE_NAME}"

${createDelegateHookFunction(delegateSpecs)}

if command -v node >/dev/null 2>&1 && [ -f "$CLI_PATH" ]; then
    node "$CLI_PATH" finalize-commit >/dev/null 2>&1 || printf '%s\n' 'AILoc2 post-commit warning: baseline advance failed; later commits may still include already committed attribution until the next successful refresh.' >&2
else
    printf '%s\n' 'AILoc2 post-commit warning: Node CLI is unavailable; skipping baseline advance.' >&2
fi

run_delegate_hooks "$@"
exit $?
`;
}

function createManagedCommitMsgHookScript(delegateSpecs: readonly HookDelegateSpec[]): string {
    return `#!/bin/sh
# AILoc2 managed hook: commit-msg
${createWrappedDelegateMarkerBlock(delegateSpecs)}

MESSAGE_FILE="$1"
CLI_PATH="./.githooks/${MANAGED_HOOK_RUNTIME_FILE_NAME}"
PLACEHOLDER_SUFFIX=' (AI unavailable)'

${createDelegateHookFunction(delegateSpecs)}

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

run_delegate_hooks "$@"
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

function createHookDelegateSpecs(
    hookFileName: RepoHookFileName,
    delegatedHooksPath: string | null,
    wrappedHookFiles: readonly RepoHookFileName[]
): HookDelegateSpec[] {
    const delegateSpecs: HookDelegateSpec[] = [];
    if (wrappedHookFiles.includes(hookFileName)) {
        delegateSpecs.push({
            path: getWrappedHookDelegateScriptPath(hookFileName),
            wrapped: true
        });
    }

    const delegatedHookPath = createDelegatedHookScriptPath(delegatedHooksPath, hookFileName);
    if (delegatedHookPath) {
        delegateSpecs.push({
            path: delegatedHookPath,
            wrapped: false
        });
    }

    return delegateSpecs;
}

function createDelegateHookFunction(delegateSpecs: readonly HookDelegateSpec[]): string {
    const delegateBlocks = delegateSpecs.map((delegateSpec) => `    DELEGATE_HOOK_PATH="${escapeForDoubleQuotedShell(delegateSpec.path)}"
    if [ -n "$DELEGATE_HOOK_PATH" ] && [ -f "$DELEGATE_HOOK_PATH" ]; then
        "$DELEGATE_HOOK_PATH" "$@" || return $?
    fi`).join('\n\n');
    const body = delegateBlocks.length > 0
        ? `${delegateBlocks}\n\n    return 0`
        : '    return 0';

    return `run_delegate_hooks() {
${body}
}`;
}

function createWrappedDelegateMarkerBlock(delegateSpecs: readonly HookDelegateSpec[]): string {
    const wrappedDelegateMarkers = delegateSpecs
        .filter((delegateSpec) => delegateSpec.wrapped)
        .map((delegateSpec) => `${WRAPPED_HOOK_DELEGATE_MARKER_PREFIX}${delegateSpec.path}`);
    return wrappedDelegateMarkers.length > 0
        ? `${wrappedDelegateMarkers.join('\n')}\n`
        : '';
}

function mergeHookDelegateSpecs(...delegateSpecGroups: readonly HookDelegateSpec[][]): HookDelegateSpec[] {
    const mergedDelegateSpecs: HookDelegateSpec[] = [];
    for (const delegateSpecGroup of delegateSpecGroups) {
        for (const delegateSpec of delegateSpecGroup) {
            const existingDelegateSpec = mergedDelegateSpecs.find((candidate) => candidate.path === delegateSpec.path);
            if (existingDelegateSpec) {
                existingDelegateSpec.wrapped = existingDelegateSpec.wrapped || delegateSpec.wrapped;
                continue;
            }

            mergedDelegateSpecs.push({ ...delegateSpec });
        }
    }

    return mergedDelegateSpecs;
}

function extractWrappedHookDelegateSpecs(text: string): HookDelegateSpec[] {
    return normalizeHookFileText(text)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(WRAPPED_HOOK_DELEGATE_MARKER_PREFIX))
        .map((line) => ({
            path: line.slice(WRAPPED_HOOK_DELEGATE_MARKER_PREFIX.length).trim(),
            wrapped: true
        }))
        .filter((delegateSpec) => delegateSpec.path.length > 0);
}

function getWrappedHookDelegateFilePath(repoRoot: string, hookFileName: RepoHookFileName): string {
    return path.join(getRepoHooksDirectoryPath(repoRoot), getWrappedHookDelegateFileName(hookFileName));
}

function getWrappedHookDelegateScriptPath(hookFileName: RepoHookFileName): string {
    return path.posix.join(REPO_HOOKS_PATH_VALUE, getWrappedHookDelegateFileName(hookFileName));
}

function getWrappedHookDelegateFileName(hookFileName: RepoHookFileName): string {
    return `${hookFileName}${WRAPPED_HOOK_DELEGATE_FILE_SUFFIX}`;
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
        : hookFileName === 'commit-msg'
        ? [createLegacyManagedCommitMsgHookScript()]
        : [];

    return [
        createManagedHookFileContents(hookFileName, []),
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
