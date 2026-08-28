import * as childProcess from 'child_process';
import * as path from 'path';
import * as util from 'util';

import { profileOperation } from './profiling';

const execFileAsync = util.promisify(childProcess.execFile);

const GIT_EXEC_OPTIONS = {
    windowsHide: true,
    maxBuffer: 1024 * 1024
} as const;

export async function runGitCommand(repoRoot: string, args: readonly string[]): Promise<string> {
    const profile = getGitCommandProfile(args);
    return profileOperation(repoRoot, profile.operation, profile.details, async () => {
        const { stdout } = await execFileAsync('git', [...args], {
            cwd: repoRoot,
            ...GIT_EXEC_OPTIONS
        });
        return stdout;
    });
}

export async function tryRunGitCommand(repoRoot: string, args: readonly string[]): Promise<string | null> {
    try {
        return await runGitCommand(repoRoot, args);
    }
    catch {
        return null;
    }
}

/**
 * Byte-exact variant used by marker stripping, where re-encoding through a string
 * would rewrite line endings and corrupt non-UTF8 content.
 */
export async function runGitCommandBuffer(repoRoot: string, args: readonly string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync('git', [...args], {
        cwd: repoRoot,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'buffer'
    });
    return stdout;
}

export async function runGitCommandWithInput(
    repoRoot: string,
    args: readonly string[],
    input: Buffer
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = childProcess.execFile(
            'git',
            [...args],
            { cwd: repoRoot, windowsHide: true, maxBuffer: 1024 * 1024 },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(stdout);
            }
        );

        child.stdin?.end(input);
    });
}

export function toGitRepoPath(repoRelativePath: string): string {
    return repoRelativePath.split(path.sep).join('/');
}

export function isGitBlobOid(candidate: string | null | undefined): candidate is string {
    return typeof candidate === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(candidate);
}

function getGitCommandProfile(args: readonly string[]): {
    operation: string;
    details: Record<string, number>;
} {
    let commandName = 'unknown';
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '-c') {
            index += 1;
            continue;
        }

        if (!args[index].startsWith('-')) {
            commandName = args[index];
            break;
        }
    }

    let variant = '';
    if (commandName === 'diff') {
        variant = args.includes('--cached') ? '.cached' : '.unstaged';
    }
    else if (commandName === 'ls-files') {
        variant = args.includes('--stage') ? '.stage' : args.includes('--others') ? '.untracked' : '';
    }

    const separatorIndex = args.indexOf('--');
    return {
        operation: `git.${commandName}${variant}`,
        details: separatorIndex >= 0
            ? { pathCount: args.length - separatorIndex - 1 }
            : {}
    };
}
