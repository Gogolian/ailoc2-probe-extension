import * as childProcess from 'child_process';
import * as path from 'path';
import * as util from 'util';

const execFile = util.promisify(childProcess.execFile);

export async function getGitBlobOidForWorkingTreeFile(
    repoRoot: string,
    repoRelativePath: string
): Promise<string | null> {
    const gitPath = toGitRepoPath(repoRelativePath);
    const absolutePath = path.join(repoRoot, repoRelativePath);

    try {
        const { stdout } = await execFile(
            'git',
            ['hash-object', '--path', gitPath, '--', absolutePath],
            {
                cwd: repoRoot,
                windowsHide: true,
                maxBuffer: 1024 * 1024
            }
        );

        const gitBlobOid = stdout.trim();
        return isGitBlobOid(gitBlobOid) ? gitBlobOid : null;
    }
    catch {
        return null;
    }
}

export async function getIndexGitBlobOid(
    repoRoot: string,
    repoRelativePath: string
): Promise<string | null> {
    const gitPath = toGitRepoPath(repoRelativePath);

    try {
        const { stdout } = await execFile(
            'git',
            ['ls-files', '--stage', '--', gitPath],
            {
                cwd: repoRoot,
                windowsHide: true,
                maxBuffer: 1024 * 1024
            }
        );

        const stageZeroLine = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0 && /\s0\t/.test(line));
        if (!stageZeroLine) {
            return null;
        }

        const fields = stageZeroLine.split(/\s+/);
        const gitBlobOid = fields[1] ?? null;
        return gitBlobOid && isGitBlobOid(gitBlobOid) ? gitBlobOid : null;
    }
    catch {
        return null;
    }
}

function toGitRepoPath(repoRelativePath: string): string {
    return repoRelativePath.split(path.sep).join('/');
}

function isGitBlobOid(candidate: string | null | undefined): candidate is string {
    return typeof candidate === 'string' && /^[0-9a-f]{40}$/i.test(candidate);
}