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
const MANAGED_TOOL_MATCHER = 'Write|Edit|MultiEdit|Bash';

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
        const targets = extractClaudeCodeEditTargets(payload);
        await removePendingSnapshots(targets);
        return targets.map((target) => ({
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
            await fs.promises.rm(snapshotPath, { force: true });
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

async function removePendingSnapshots(targets: ClaudeCodeEditTarget[]): Promise<void> {
    await Promise.all(targets.map(async (target) => {
        const repoLocation = resolveRepoLocationForFsPathNode(target.absoluteFilePath);
        if (repoLocation) {
            await fs.promises.rm(getPendingSnapshotPath(repoLocation.repoRoot, target), { force: true });
        }
    }));
}

export async function installClaudeCodeHooks(args: {
    repoRoot: string;
    runtimeSourcePath: string;
}): Promise<ClaudeCodeHooksInstallResult> {
    const claudeDirectory = path.join(args.repoRoot, '.claude');
    const settingsPath = path.join(claudeDirectory, 'settings.json');
    const runtimePath = path.join(claudeDirectory, CLAUDE_CODE_RUNTIME_FILE_NAME);

    const settings = await readClaudeSettings(settingsPath);
    await fs.promises.mkdir(claudeDirectory, { recursive: true });
    await fs.promises.copyFile(args.runtimeSourcePath, runtimePath);

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

    return Array.from(new Set(extractFilePathCandidates(toolInput, toolName)))
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
    let fileContents: string;
    try {
        fileContents = await fs.promises.readFile(settingsPath, 'utf8');
    }
    catch (error) {
        if (isMissingFileError(error)) {
            return {};
        }
        throw error;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fileContents);
    }
    catch (error) {
        throw new Error(
            `AILoc2 could not parse the existing Claude settings at ${settingsPath}, so it will not overwrite them. Fix or remove the file, then retry. Underlying error: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (!isRecord(parsed)) {
        throw new Error(
            `AILoc2 will not overwrite the existing Claude settings at ${settingsPath} because they are not a JSON object. Fix or remove the file, then retry.`
        );
    }

    return parsed;
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
    return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Bash';
}

function getToolInput(payload: ClaudeCodeHookPayload): Record<string, unknown> {
    return asRecord(payload.tool_input)
        ?? asRecord(payload.toolInput)
        ?? asRecord(payload.input)
        ?? {};
}

function extractFilePathCandidates(toolInput: Record<string, unknown>, toolName: string): string[] {
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

    const bashMutationCandidates = toolName === 'Bash'
        ? extractBashRedirectionPathCandidates(getString(toolInput.command) ?? '')
        : [];

    return [...directCandidates, ...arrayCandidates, ...bashMutationCandidates];
}

function extractBashRedirectionPathCandidates(command: string): string[] {
    const candidates: string[] = [];
    const pendingHeredocs: Array<{ delimiter: string; stripLeadingTabs: boolean }> = [];
    let quote: 'single' | 'double' | null = null;
    for (const line of command.split(/\r\n|\r|\n/u)) {
        const pendingHeredoc = pendingHeredocs[0];
        if (pendingHeredoc) {
            const candidateDelimiter = pendingHeredoc.stripLeadingTabs ? line.replace(/^\t+/u, '') : line;
            if (candidateDelimiter === pendingHeredoc.delimiter) {
                pendingHeredocs.shift();
            }
            continue;
        }

        const parsedLine = parseBashCommandLineRedirections(line, quote);
        candidates.push(...parsedLine.outputPaths);
        pendingHeredocs.push(...parsedLine.heredocs);
        quote = parsedLine.quote;
    }
    return candidates;
}

function parseBashCommandLineRedirections(line: string, initialQuote: 'single' | 'double' | null): {
    outputPaths: string[];
    heredocs: Array<{ delimiter: string; stripLeadingTabs: boolean }>;
    quote: 'single' | 'double' | null;
} {
    const outputPaths: string[] = [];
    const heredocs: Array<{ delimiter: string; stripLeadingTabs: boolean }> = [];
    let quote = initialQuote;
    let inConditionalExpression = false;
    let inArithmeticExpression = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (quote === 'single') {
            if (character === "'") {
                quote = null;
            }
            continue;
        }
        if (quote === 'double') {
            if (character === '\\' && isDoubleQuoteEscapable(line[index + 1])) {
                index += 1;
            }
            else if (character === '"') {
                quote = null;
            }
            continue;
        }
        if (character === '\\') {
            index += 1;
            continue;
        }
        if (character === "'") {
            quote = 'single';
            continue;
        }
        if (character === '"') {
            quote = 'double';
            continue;
        }
        if (character === '#' && isBashTokenBoundary(line[index - 1])) {
            break;
        }
        if (line.startsWith('[[', index)) {
            inConditionalExpression = true;
            index += 1;
            continue;
        }
        if (inConditionalExpression && line.startsWith(']]', index)) {
            inConditionalExpression = false;
            index += 1;
            continue;
        }
        if (line.startsWith('((', index)) {
            inArithmeticExpression = true;
            index += 1;
            continue;
        }
        if (inArithmeticExpression && line.startsWith('))', index)) {
            inArithmeticExpression = false;
            index += 1;
            continue;
        }
        if (inConditionalExpression || inArithmeticExpression) {
            continue;
        }
        if (line.startsWith('<<<', index)) {
            index += 2;
            continue;
        }
        if (line.startsWith('<<', index)) {
            const stripLeadingTabs = line[index + 2] === '-';
            const delimiter = parseBashWord(line, index + (stripLeadingTabs ? 3 : 2));
            if (delimiter?.value) {
                heredocs.push({ delimiter: delimiter.value, stripLeadingTabs });
                index = delimiter.endIndex - 1;
            }
            continue;
        }
        if (character !== '>') {
            continue;
        }
        if (line[index + 1] === '(') {
            continue;
        }

        let destinationStart = index + 1;
        if (line[destinationStart] === '>' || line[destinationStart] === '|') {
            destinationStart += 1;
        }
        if (line[destinationStart] === '&') {
            destinationStart += 1;
        }
        const destination = parseBashWord(line, destinationStart);
        if (destination) {
            if (!/^\d+$/u.test(destination.value)
                && !destination.dynamic
                && !isDiscardedBashOutputPath(destination.value)) {
                outputPaths.push(destination.value);
            }
            index = destination.endIndex - 1;
        }
    }

    return { outputPaths, heredocs, quote };
}

function parseBashWord(line: string, startIndex: number): { value: string; dynamic: boolean; endIndex: number } | null {
    let index = startIndex;
    while (index < line.length && /\s/u.test(line[index])) {
        index += 1;
    }
    if (index >= line.length || line[index] === '&' || line[index] === '#') {
        return null;
    }

    let value = '';
    let dynamic = false;
    let quote: 'single' | 'double' | null = null;
    for (; index < line.length; index += 1) {
        const character = line[index];
        if (quote === 'single') {
            if (character === "'") {
                quote = null;
            }
            else {
                value += character;
            }
            continue;
        }
        if (quote === 'double') {
            if (character === '"') {
                quote = null;
            }
            else if (character === '\\' && isDoubleQuoteEscapable(line[index + 1])) {
                index += 1;
                value += line[index];
            }
            else {
                dynamic ||= character === '$' || character === '`';
                value += character;
            }
            continue;
        }
        if (/\s/u.test(character) || ';&|<>()'.includes(character)) {
            break;
        }
        if (character === "'") {
            quote = 'single';
        }
        else if (character === '"') {
            quote = 'double';
        }
        else if (character === '\\' && index + 1 < line.length) {
            index += 1;
            value += line[index];
        }
        else {
            dynamic ||= character === '$' || character === '`' || character === '*' || character === '?' || character === '[';
            value += character;
        }
    }

    dynamic ||= value.startsWith('~');
    return value.length > 0 && quote === null ? { value, dynamic, endIndex: index } : null;
}

function isBashTokenBoundary(character: string | undefined): boolean {
    return character === undefined || /\s/u.test(character) || ';&|()'.includes(character);
}

function isDoubleQuoteEscapable(character: string | undefined): boolean {
    return character === '$' || character === '`' || character === '"' || character === '\\' || character === '\n';
}

function isDiscardedBashOutputPath(candidatePath: string): boolean {
    const normalizedPath = candidatePath.replace(/\\/gu, '/').toLowerCase();
    return normalizedPath === 'nul'
        || normalizedPath === '/dev/null'
        || normalizedPath === '/dev/stdout'
        || normalizedPath === '/dev/stderr';
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

function isMissingFileError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && (error as { code?: unknown }).code === 'ENOENT';
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

