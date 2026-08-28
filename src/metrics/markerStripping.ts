import * as fs from 'fs';
import * as path from 'path';

import { AI_MARKER_START_PATTERN, AI_MARKER_STOP_PATTERN } from './markerAttribution';
import {
    runGitCommandBuffer,
    runGitCommandWithInput,
    toGitRepoPath,
    tryRunGitCommand
} from '../util/gitCommand';

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

export type MarkerStripOutcome = {
    repoRelativePath: string;
    status: 'stripped' | 'would-strip' | 'no-markers' | 'skipped-unsupported-mode' | 'skipped-binary' | 'failed';
    removedLineCount: number;
    updatedWorkingTree: boolean;
};

export type MarkerStripResult = {
    outcomes: MarkerStripOutcome[];
    strippedFileCount: number;
};

/**
 * Removes `AI start` / `AI stop` lines from the index and, when it is safe, the working
 * tree — the legacy behavior where markers never reach a commit.
 *
 * Runs after counting so the recorded attribution matches what was committed.
 */
export async function stripMarkersFromStagedFiles(args: {
    repoRoot: string;
    repoRelativePaths: readonly string[];
    dryRun?: boolean;
}): Promise<MarkerStripResult> {
    const outcomes: MarkerStripOutcome[] = [];
    for (const repoRelativePath of args.repoRelativePaths) {
        outcomes.push(await stripMarkersFromStagedFile(args.repoRoot, repoRelativePath, args.dryRun === true));
    }

    return {
        outcomes,
        strippedFileCount: outcomes.filter((outcome) => outcome.status === 'stripped').length
    };
}

async function stripMarkersFromStagedFile(
    repoRoot: string,
    repoRelativePath: string,
    dryRun: boolean
): Promise<MarkerStripOutcome> {
    const gitPath = toGitRepoPath(repoRelativePath);
    const indexEntry = await readIndexEntry(repoRoot, gitPath);
    if (!indexEntry) {
        return createOutcome(repoRelativePath, 'failed');
    }

    // The legacy implementation hardcoded mode 100644, silently dropping the executable
    // bit and rewriting symlinks and gitlinks as regular files.
    if (!REGULAR_FILE_MODES.has(indexEntry.mode)) {
        return createOutcome(repoRelativePath, 'skipped-unsupported-mode');
    }

    let stagedContent: Buffer;
    try {
        stagedContent = await runGitCommandBuffer(repoRoot, ['show', `:${gitPath}`]);
    }
    catch {
        return createOutcome(repoRelativePath, 'failed');
    }

    if (stagedContent.includes(0)) {
        return createOutcome(repoRelativePath, 'skipped-binary');
    }

    const stripped = stripMarkerLinesPreservingBytes(stagedContent);
    if (stripped.removedLineCount === 0) {
        return createOutcome(repoRelativePath, 'no-markers');
    }

    if (dryRun) {
        return {
            ...createOutcome(repoRelativePath, 'would-strip'),
            removedLineCount: stripped.removedLineCount
        };
    }

    let blobOid: string;
    try {
        blobOid = (await runGitCommandWithInput(repoRoot, ['hash-object', '-w', '--stdin'], stripped.content)).trim();
    }
    catch {
        return createOutcome(repoRelativePath, 'failed');
    }

    const updateResult = await tryRunGitCommand(repoRoot, [
        'update-index',
        '--cacheinfo',
        `${indexEntry.mode},${blobOid},${gitPath}`
    ]);
    if (updateResult === null) {
        return createOutcome(repoRelativePath, 'failed');
    }

    // Only rewrite the working tree when it still matches the pre-strip index content,
    // otherwise unstaged edits would be silently clobbered.
    const absolutePath = path.join(repoRoot, repoRelativePath);
    let updatedWorkingTree = false;
    try {
        const workingTreeContent = await fs.promises.readFile(absolutePath);
        if (workingTreeContent.equals(stagedContent)) {
            await fs.promises.writeFile(absolutePath, stripped.content);
            updatedWorkingTree = true;
        }
    }
    catch {
        // A missing or unreadable working-tree file leaves the index change in place.
    }

    return {
        repoRelativePath,
        status: 'stripped',
        removedLineCount: stripped.removedLineCount,
        updatedWorkingTree
    };
}

/**
 * Splits on line boundaries while keeping each terminator attached, so CRLF files and
 * files without a trailing newline round-trip unchanged.
 */
export function stripMarkerLinesPreservingBytes(content: Buffer): {
    content: Buffer;
    removedLineCount: number;
} {
    const keptChunks: Buffer[] = [];
    let removedLineCount = 0;
    let lineStart = 0;

    for (let index = 0; index < content.length; index += 1) {
        if (content[index] !== 0x0a) {
            continue;
        }

        const lineEnd = index + 1;
        const chunk = content.subarray(lineStart, lineEnd);
        if (isMarkerChunk(chunk)) {
            removedLineCount += 1;
        }
        else {
            keptChunks.push(chunk);
        }

        lineStart = lineEnd;
    }

    if (lineStart < content.length) {
        const chunk = content.subarray(lineStart);
        if (isMarkerChunk(chunk)) {
            removedLineCount += 1;
        }
        else {
            keptChunks.push(chunk);
        }
    }

    return {
        content: Buffer.concat(keptChunks),
        removedLineCount
    };
}

function isMarkerChunk(chunk: Buffer): boolean {
    const text = chunk.toString('utf8');
    return AI_MARKER_START_PATTERN.test(text) || AI_MARKER_STOP_PATTERN.test(text);
}

async function readIndexEntry(repoRoot: string, gitPath: string): Promise<{ mode: string } | null> {
    const stdout = await tryRunGitCommand(repoRoot, ['ls-files', '--stage', '--', gitPath]);
    if (!stdout) {
        return null;
    }

    const mode = stdout.split(/\r?\n/)[0]?.split(/\s+/)[0];
    return mode ? { mode } : null;
}

function createOutcome(repoRelativePath: string, status: MarkerStripOutcome['status']): MarkerStripOutcome {
    return {
        repoRelativePath,
        status,
        removedLineCount: 0,
        updatedWorkingTree: false
    };
}
