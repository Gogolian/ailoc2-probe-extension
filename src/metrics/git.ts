import { isGitBlobOid, toGitRepoPath, tryRunGitCommand } from '../util/gitCommand';
import * as path from 'path';

export async function getGitBlobOidForWorkingTreeFile(
    repoRoot: string,
    repoRelativePath: string
): Promise<string | null> {
    const gitPath = toGitRepoPath(repoRelativePath);
    const absolutePath = path.join(repoRoot, repoRelativePath);

    const stdout = await tryRunGitCommand(repoRoot, ['hash-object', '--path', gitPath, '--', absolutePath]);
    if (stdout === null) {
        return null;
    }

    const gitBlobOid = stdout.trim();
    return isGitBlobOid(gitBlobOid) ? gitBlobOid : null;
}

export async function getIndexGitBlobOid(
    repoRoot: string,
    repoRelativePath: string
): Promise<string | null> {
    const gitPath = toGitRepoPath(repoRelativePath);

    const stdout = await tryRunGitCommand(repoRoot, ['ls-files', '--stage', '--', gitPath]);
    if (stdout === null) {
        return null;
    }

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
