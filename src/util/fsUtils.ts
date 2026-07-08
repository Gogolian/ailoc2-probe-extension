import * as fs from 'fs';
import * as path from 'path';

export async function makeFilesExecutable(
    directoryPath: string,
    fileNames: readonly string[]
): Promise<void> {
    await Promise.all(fileNames.map(async (fileName) => {
        try {
            await fs.promises.chmod(path.join(directoryPath, fileName), 0o755);
        }
        catch {
            // Best effort only; Git for Windows does not depend on POSIX executable bits.
        }
    }));
}

export async function pathExists(candidatePath: string): Promise<boolean> {
    try {
        await fs.promises.access(candidatePath);
        return true;
    }
    catch {
        return false;
    }
}

export async function readTextFileIfExists(filePath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
