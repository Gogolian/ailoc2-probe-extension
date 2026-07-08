import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getMetricsRoot } from '../../metrics/pathing';
import { resolveRepoLocationForFsPathNode } from '../../metrics/nodeRepoResolver';
import { pathExists, readTextFileIfExists } from '../../util/fsUtils';
import { recordClaudeCodeEdit } from './metrics';

export type ClaudeCodeHookPayload = Record<string, unknown>;

export type ClaudeCodeCaptureResult = {
    absoluteFilePath: string;
    snapshotPath: string;
    existed: boolean;
};

export type ClaudeCodeRecordResult = {
    absoluteFilePath: string;
    repoRoot: string;
    repoRelativePath: string;
    skipped: boolean;
    reason?: string;
};

export type ClaudeCodeHooksInstallResult = {
    repoRoot: string;
    settingsPath: string;
    runtimePath: string;
    installedHookCount: number;
};

const CLAUDE_CODE_RUNTIME_FILE_NAME = 'ailoc2-claude-code.cjs';
const MANAGED_TOOL_MATCHER = 'Write|Edit|MultiEdit';

type ClaudeCodeEditTarget = {
    absoluteFilePath: string;
    toolName: string;
    invocationId: string;
    sessionId: string | null;
    cwd: string;
};

type PendingSnapshot = {
    schemaVersion: 1;
    source: 'claude-code';
    recordedAt: string;
    absoluteFilePath: string;
    repoRoot: string;
    repoRelativePath: string;
    toolName: string;
    invocationId: string;
    sessionId: string | null;
    cwd: string;
    existed: boolean;
    beforeText: string;
};

export async function loadClaudeCodeHookPayload(payloadPath: string | undefined): Promise<ClaudeCodeHookPayload> {
    const payloadText = payloadPath && payloadPath !== '-'
        ? await fs.promises.readFile(path.resolve(process.cwd(), payloadPath), 'utf8')
        : await readStdinIfAvailable();

    if (payloadText.trim().length === 0) {
        return {};
    }

    const parsed = JSON.parse(payloadText) as unknown;
    return isRecord(parsed) ? parsed : {};
}

export async function captureClaudeCodeBefore(payload: ClaudeCodeHookPayload): Promise<ClaudeCodeCaptureResult[]> {
    const results: ClaudeCodeCaptureResult[] = [];
    for (const target of extractClaudeCodeEditTargets(payload)) {
        const repoLocation = resolveRepoLocationForFsPathNode(target.absoluteFilePath);
        if (!repoLocation) {
            continue;
        }

        const beforeText = await readTextFileIfExists(target.absoluteFilePath);
        const snapshot: PendingSnapshot = {
            schemaVersion: 1,
            source: 'claude-code',
            recordedAt: new Date().toISOString(),
            absoluteFilePath: target.absoluteFilePath,
            repoRoot: repoLocation.repoRoot,
            repoRelativePath: repoLocation.repoRelativePath,
            toolName: target.toolName,
            invocationId: target.invocationId,
            sessionId: target.sessionId,
            cwd: target.cwd,
            existed: beforeText !== null,
            beforeText: beforeText ?? ''
        };
        const snapshotPath = getPendingSnapshotPath(repoLocation.repoRoot, target);
        await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
        await fs.promises.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
        results.push({
            absoluteFilePath: target.absoluteFilePath,
            snapshotPath,
            existed: snapshot.existed
        });
    }

    return results;
}

export async function recordClaudeCodePostEdit(payload: ClaudeCodeHookPayload): Promise<ClaudeCodeRecordResult[]> {
    if (isFailedToolUse(payload)) {
        return extractClaudeCodeEditTargets(payload).map((target) => ({
            absoluteFilePath: target.absoluteFilePath,
            repoRoot: '',
            repoRelativePath: '',
            skipped: true,
            reason: 'ClaudeToolUseFailed'
        }));
    }

    const results: ClaudeCodeRecordResult[] = [];
    for (const target of extractClaudeCodeEditTargets(payload)) {
        const repoLocation = resolveRepoLocationForFsPathNode(target.absoluteFilePath);
        if (!repoLocation) {
            results.push({
                absoluteFilePath: target.absoluteFilePath,
                repoRoot: '',
                repoRelativePath: '',
                skipped: true,
                reason: 'NoGitRepository'
            });
            continue;
        }

        const snapshotPath = getPendingSnapshotPath(repoLocation.repoRoot, target);
        const snapshot = await readPendingSnapshot(snapshotPath);
        if (!snapshot && target.toolName.toLowerCase() !== 'write') {
            results.push({
                absoluteFilePath: target.absoluteFilePath,
                repoRoot: repoLocation.repoRoot,
                repoRelativePath: repoLocation.repoRelativePath,
                skipped: true,
                reason: 'MissingBeforeSnapshot'
            });
            continue;
        }

        const afterText = await readTextFileIfExists(target.absoluteFilePath);
        if (afterText === null) {
            results.push({
                absoluteFilePath: target.absoluteFilePath,
                repoRoot: repoLocation.repoRoot,
                repoRelativePath: repoLocation.repoRelativePath,
                skipped: true,
                reason: 'FileMissingAfterToolUse'
            });
            continue;
        }

        const recordResult = await recordClaudeCodeEdit({
            absoluteFilePath: target.absoluteFilePath,
            beforeText: snapshot?.beforeText ?? '',
            afterText,
            toolName: target.toolName,
            invocationId: target.invocationId,
            sessionId: target.sessionId,
            cwd: target.cwd
        });
        await fs.promises.rm(snapshotPath, { force: true });
        results.push({
            absoluteFilePath: target.absoluteFilePath,
            repoRoot: recordResult.repoRoot,
            repoRelativePath: recordResult.repoRelativePath,
            skipped: false
        });
    }

    return results;
}

export async function installClaudeCodeHooks(args: {
    repoRoot: string;
    runtimeSourcePath: string;
}): Promise<ClaudeCodeHooksInstallResult> {
    const claudeDirectory = path.join(args.repoRoot, '.claude');
    const settingsPath = path.join(claudeDirectory, 'settings.json');
    const runtimePath = path.join(claudeDirectory, CLAUDE_CODE_RUNTIME_FILE_NAME);
    await fs.promises.mkdir(claudeDirectory, { recursive: true });
    await fs.promises.copyFile(args.runtimeSourcePath, runtimePath);

    const settings = await readClaudeSettings(settingsPath);
    const hooks = normalizeHooks(settings.hooks);
    removeManagedClaudeHooks(hooks);
    addManagedClaudeHook(hooks, 'PreToolUse', createManagedCommand(runtimePath, 'capture-before'));
    addManagedClaudeHook(hooks, 'PostToolUse', createManagedCommand(runtimePath, 'record-edit'));
    settings.hooks = hooks;
    await fs.promises.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

    return {
        repoRoot: args.repoRoot,
        settingsPath,
        runtimePath,
        installedHookCount: 2
    };
}

export async function uninstallClaudeCodeHooks(repoRoot: string): Promise<ClaudeCodeHooksInstallResult> {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const runtimePath = path.join(repoRoot, '.claude', CLAUDE_CODE_RUNTIME_FILE_NAME);
    const hadSettingsFile = await pathExists(settingsPath);
    const settings = await readClaudeSettings(settingsPath);
    const hooks = normalizeHooks(settings.hooks);
    removeManagedClaudeHooks(hooks);
    settings.hooks = hooks;
    if (hadSettingsFile) {
        await fs.promises.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    }
    await fs.promises.rm(runtimePath, { force: true });

    return {
        repoRoot,
        settingsPath,
        runtimePath,
        installedHookCount: 0
    };
}

export function extractClaudeCodeEditTargets(payload: ClaudeCodeHookPayload): ClaudeCodeEditTarget[] {
    const toolName = getToolName(payload);
    if (!isTrackedClaudeTool(toolName)) {
        return [];
    }

    const cwd = getString(payload.cwd) ?? process.cwd();
    const sessionId = getString(payload.session_id) ?? getString(payload.sessionId);
    const toolInput = getToolInput(payload);
    const invocationSeed = getInvocationSeed(payload, toolName);

    return Array.from(new Set(extractFilePathCandidates(toolInput)))
        .map((candidatePath) => path.resolve(cwd, candidatePath))
        .map((absoluteFilePath) => ({
            absoluteFilePath,
            toolName,
            invocationId: invocationSeed ?? createStableInvocationId(sessionId, toolName, absoluteFilePath),
            sessionId,
            cwd
        }));
}

function getPendingSnapshotPath(repoRoot: string, target: ClaudeCodeEditTarget): string {
    const key = hashText(`${target.sessionId ?? ''}:${target.invocationId}:${target.absoluteFilePath}`);
    return path.join(getMetricsRoot(repoRoot), 'claude-code', 'pending', `${key}.json`);
}

async function readPendingSnapshot(snapshotPath: string): Promise<PendingSnapshot | null> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(snapshotPath, 'utf8')) as Partial<PendingSnapshot>;
        return typeof parsed.beforeText === 'string' ? parsed as PendingSnapshot : null;
    }
    catch {
        return null;
    }
}

async function readClaudeSettings(settingsPath: string): Promise<Record<string, unknown>> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')) as unknown;
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}

function normalizeHooks(value: unknown): Record<string, unknown[]> {
    if (!isRecord(value)) {
        return {};
    }

    const hooks: Record<string, unknown[]> = {};
    for (const [eventName, eventHooks] of Object.entries(value)) {
        hooks[eventName] = Array.isArray(eventHooks) ? [...eventHooks] : [];
    }
    return hooks;
}

function addManagedClaudeHook(hooks: Record<string, unknown[]>, eventName: string, command: string): void {
    const eventHooks = hooks[eventName] ?? [];
    eventHooks.push({
        matcher: MANAGED_TOOL_MATCHER,
        hooks: [{
            type: 'command',
            command
        }]
    });
    hooks[eventName] = eventHooks;
}

function removeManagedClaudeHooks(hooks: Record<string, unknown[]>): void {
    for (const [eventName, eventHooks] of Object.entries(hooks)) {
        hooks[eventName] = eventHooks
            .map(removeManagedCommandsFromHookGroup)
            .filter((hookGroup): hookGroup is Record<string, unknown> => hookGroup !== null);
    }
}

function removeManagedCommandsFromHookGroup(hookGroup: unknown): Record<string, unknown> | null {
    if (!isRecord(hookGroup)) {
        return null;
    }

    const commands = Array.isArray(hookGroup.hooks) ? hookGroup.hooks : [];
    const unmanagedCommands = commands.filter((hook) => !isManagedCommandHook(hook));
    if (unmanagedCommands.length === 0) {
        return null;
    }

    return {
        ...hookGroup,
        hooks: unmanagedCommands
    };
}

function isManagedCommandHook(hook: unknown): boolean {
    if (!isRecord(hook)) {
        return false;
    }

    const command = getString(hook.command);
    return command?.includes(CLAUDE_CODE_RUNTIME_FILE_NAME) ?? false;
}

function createManagedCommand(runtimePath: string, command: string): string {
    return `node ${quoteShellPath(runtimePath)} ${command}`;
}

function quoteShellPath(filePath: string): string {
    return `"${filePath.replace(/"/g, '\\"')}"`;
}

function getToolName(payload: ClaudeCodeHookPayload): string {
    return getString(payload.tool_name)
        ?? getString(payload.toolName)
        ?? getString(asRecord(payload.tool)?.name)
        ?? '';
}

function isTrackedClaudeTool(toolName: string): boolean {
    return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function getToolInput(payload: ClaudeCodeHookPayload): Record<string, unknown> {
    return asRecord(payload.tool_input)
        ?? asRecord(payload.toolInput)
        ?? asRecord(payload.input)
        ?? {};
}

function extractFilePathCandidates(toolInput: Record<string, unknown>): string[] {
    const directCandidates = [
        getString(toolInput.file_path),
        getString(toolInput.filePath),
        getString(toolInput.path),
        getString(toolInput.filename)
    ].filter((candidate): candidate is string => Boolean(candidate));

    const arrayCandidates = [toolInput.files, toolInput.paths]
        .flatMap((value) => Array.isArray(value) ? value : [])
        .flatMap((value) => {
            if (typeof value === 'string') {
                return [value];
            }
            if (isRecord(value)) {
                return [getString(value.file_path), getString(value.filePath), getString(value.path)]
                    .filter((candidate): candidate is string => Boolean(candidate));
            }
            return [];
        });

    return [...directCandidates, ...arrayCandidates];
}

function getInvocationSeed(payload: ClaudeCodeHookPayload, toolName: string): string | null {
    return getString(payload.tool_use_id)
        ?? getString(payload.toolUseId)
        ?? getString(payload.invocation_id)
        ?? getString(payload.invocationId)
        ?? getString(asRecord(payload.tool_use)?.id)
        ?? getString(asRecord(payload.toolUse)?.id)
        ?? null;
}

function createStableInvocationId(sessionId: string | null, toolName: string, absoluteFilePath: string): string {
    return hashText(`${sessionId ?? ''}:${toolName}:${absoluteFilePath}`);
}

function isFailedToolUse(payload: ClaudeCodeHookPayload): boolean {
    const toolResponse = asRecord(payload.tool_response) ?? asRecord(payload.toolResponse);
    return Boolean(
        payload.error
        || payload.status === 'error'
        || toolResponse?.is_error === true
        || toolResponse?.isError === true
        || toolResponse?.error
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

function getString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function hashText(text: string): string {
    return crypto
        .createHash('sha256')
        .update(text, 'utf8')
        .digest('hex')
        .slice(0, 32);
}

async function readStdinIfAvailable(): Promise<string> {
    if (process.stdin.isTTY) {
        return '';
    }

    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

