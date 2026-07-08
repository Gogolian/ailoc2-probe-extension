import * as path from 'path';

import {
    captureClaudeCodeBefore,
    installClaudeCodeHooks,
    loadClaudeCodeHookPayload,
    recordClaudeCodePostEdit,
    uninstallClaudeCodeHooks
} from '../integrations/claudeCode/runtime';
import { resolveRepoRootArgument, runCli } from './cliRuntime';
import { toErrorMessage } from '../util/errors';

async function main(): Promise<number> {
    const command = process.argv[2];

    try {
        switch (command) {
            case 'capture-before':
                return runCaptureBefore(process.argv[3]);
            case 'record-edit':
                return runRecordEdit(process.argv[3]);
            case 'install-claude-hooks':
                return runInstallClaudeHooks(process.argv[3], process.argv[4]);
            case 'uninstall-claude-hooks':
                return runUninstallClaudeHooks(process.argv[3]);
            default:
                printUsage();
                return 1;
        }
    }
    catch (error) {
        console.error(`AILoc2 Claude Code warning: ${toErrorMessage(error)}`);
        return command === 'install-claude-hooks' || command === 'uninstall-claude-hooks' ? 1 : 0;
    }
}

async function runCaptureBefore(payloadPath: string | undefined): Promise<number> {
    const payload = await loadClaudeCodeHookPayload(payloadPath);
    const results = await captureClaudeCodeBefore(payload);
    console.log(JSON.stringify({ captured: results.length, results }));
    return 0;
}

async function runRecordEdit(payloadPath: string | undefined): Promise<number> {
    const payload = await loadClaudeCodeHookPayload(payloadPath);
    const results = await recordClaudeCodePostEdit(payload);
    console.log(JSON.stringify({ recorded: results.filter((result) => !result.skipped).length, results }));
    return 0;
}

async function runInstallClaudeHooks(repoRootArgument: string | undefined, runtimeSourcePathArgument: string | undefined): Promise<number> {
    const repoRoot = resolveRepoRootArgument(repoRootArgument);
    const runtimeSourcePath = path.resolve(process.cwd(), runtimeSourcePathArgument ?? process.argv[1]);
    const result = await installClaudeCodeHooks({ repoRoot, runtimeSourcePath });
    console.log(JSON.stringify(result));
    return 0;
}

async function runUninstallClaudeHooks(repoRootArgument: string | undefined): Promise<number> {
    const repoRoot = resolveRepoRootArgument(repoRootArgument);
    const result = await uninstallClaudeCodeHooks(repoRoot);
    console.log(JSON.stringify(result));
    return 0;
}

function printUsage(): void {
    console.error('Usage: node <ailoc2-claude-code.cjs|out/cli/claudeCodeCli.js> <capture-before [payloadJsonPath|-]|record-edit [payloadJsonPath|-]|install-claude-hooks [repoRoot] [runtimeSourcePath]|uninstall-claude-hooks [repoRoot]>');
}

runCli('AILoc2 Claude Code CLI', main);

