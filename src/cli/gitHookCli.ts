import * as path from 'path';

import {
    annotateCommitMessageFile,
    applyAiLinesAnnotationToCommitMessageFile,
    createAiLinesAnnotation,
    DEFAULT_AI_PLACEHOLDER_LABEL
} from '../hooks/commitMessage';
import {
    finalizeRepoCommit,
    prepareRepoCommitBaseline,
    prepareRepoPreCommit,
    refreshRepoHookSummary
} from '../metrics/summary';
import { readProbeConfig } from '../metrics/probeConfig';
import { resolveRepoRootArgument, runCli } from './cliRuntime';
import { toErrorMessage } from '../util/errors';

async function main(): Promise<number> {
    const command = process.argv[2];

    switch (command) {
        case 'prepare-commit':
            return runPrepareCommit(process.argv[3]);
        case 'prepare-commit-baseline':
            return runPrepareCommitBaseline(process.argv[3]);
        case 'refresh-summary':
            return runRefreshSummary(process.argv[3]);
        case 'annotate-commit-message':
            return runAnnotateCommitMessage(process.argv[3], process.argv[4]);
        case 'finalize-commit':
            return runFinalizeCommit(process.argv[3]);
        default:
            printUsage();
            return 1;
    }
}

async function runPrepareCommit(repoRootArgument: string | undefined): Promise<number> {
    const repoRoot = resolveRepoRoot(repoRootArgument);
    const preparationResult = await prepareRepoPreCommit({ repoRoot });
    console.log(preparationResult.summary.summaryLine);
    return 0;
}

async function runPrepareCommitBaseline(repoRootArgument: string | undefined): Promise<number> {
    const repoRoot = resolveRepoRoot(repoRootArgument);
    const preparedBaseline = await prepareRepoCommitBaseline({ repoRoot });
    console.log(preparedBaseline.preparedBaselinePath);
    return 0;
}

async function runRefreshSummary(repoRootArgument: string | undefined): Promise<number> {
    const repoRoot = resolveRepoRoot(repoRootArgument);
    const refreshedSummary = await refreshRepoHookSummary({ repoRoot });
    console.log(refreshedSummary.summaryLine);
    return 0;
}

async function runFinalizeCommit(repoRootArgument: string | undefined): Promise<number> {
    const repoRoot = resolveRepoRoot(repoRootArgument);
    const refreshResult = await finalizeRepoCommit({ repoRoot });
    console.log(refreshResult.summaryLine);
    return 0;
}

async function runAnnotateCommitMessage(
    messageFilePathArgument: string | undefined,
    repoRootArgument: string | undefined
): Promise<number> {
    if (!messageFilePathArgument) {
        printUsage();
        return 1;
    }

    const repoRoot = resolveRepoRoot(repoRootArgument);
    const messageFilePath = path.resolve(process.cwd(), messageFilePathArgument);

    try {
        // In markers mode the pre-commit step already counted and then stripped the markers,
        // so recomputing here would score marker-free content and report 0%.
        if ((await readProbeConfig(repoRoot)).attribution.mode !== 'markers') {
            await prepareRepoPreCommit({ repoRoot });
        }

        const annotationResult = await annotateCommitMessageFile({
            repoRoot,
            messageFilePath,
            placeholderLabel: DEFAULT_AI_PLACEHOLDER_LABEL
        });
        console.log(annotationResult.annotationText);
        return 0;
    }
    catch (error) {
        console.error(`AILoc2 annotate-commit-message warning: ${toErrorMessage(error)}`);

        try {
            const placeholderAnnotation = createAiLinesAnnotation({
                aiLineCount: null,
                humanLineCount: null,
                unknownLineCount: null,
                placeholderLabel: DEFAULT_AI_PLACEHOLDER_LABEL
            });
            await applyAiLinesAnnotationToCommitMessageFile({
                messageFilePath,
                annotationText: placeholderAnnotation.annotationText,
                unsureAnnotationText: placeholderAnnotation.unsureAnnotationText
            });
            console.log(placeholderAnnotation.annotationText);
            return 0;
        }
        catch (fallbackError) {
            console.error(
                `AILoc2 annotate-commit-message fallback warning: ${toErrorMessage(fallbackError)}`
            );
            return 0;
        }
    }
}

function resolveRepoRoot(repoRootArgument: string | undefined): string {
    return resolveRepoRootArgument(repoRootArgument);
}

function printUsage(): void {
    console.error('Usage: node <ailoc2-hook-runtime.cjs|out/cli/gitHookCli.js> <prepare-commit [repoRoot]|prepare-commit-baseline [repoRoot]|refresh-summary [repoRoot]|annotate-commit-message <messageFilePath> [repoRoot]|finalize-commit [repoRoot]>');
}

runCli('AILoc2 hook CLI', main);
