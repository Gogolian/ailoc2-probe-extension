import * as childProcess from 'child_process';
import * as path from 'path';
import * as util from 'util';

const execFileAsync = util.promisify(childProcess.execFile);

const GIT_EXEC_OPTIONS = {
    windowsHide: true,
    maxBuffer: 1024 * 1024
} as const;

export async function runGitCommand(repoRoot: string, args: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', [...args], {
        cwd: repoRoot,
        ...GIT_EXEC_OPTIONS
    });
    return stdout;
}

export async function tryRunGitCommand(repoRoot: string, args: readonly string[]): Promise<string | null> {
    try {
        return await runGitCommand(repoRoot, args);
    }
    catch {
        return null;
    }
}

export function toGitRepoPath(repoRelativePath: string): string {
    return repoRelativePath.split(path.sep).join('/');
}

export function isGitBlobOid(candidate: string | null | undefined): candidate is string {
    return typeof candidate === 'string' && /^[0-9a-f]{40}$/i.test(candidate);
}
