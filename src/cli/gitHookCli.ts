import * as path from 'path';

import {
    annotateCommitMessageFile,
    applyAiSuffixToCommitMessageFile,
    createAiCommitSuffix,
    DEFAULT_AI_PLACEHOLDER_LABEL
} from '../hooks/commitMessage';
import {
    finalizeRepoCommit,
    prepareRepoCommitBaseline,
    refreshRepoHookSummary
} from '../metrics/summary';
import { resolveRepoRootArgument, runCli } from './cliRuntime';
import { toErrorMessage } from '../util/errors';

async function main(): Promise<number> {
    const command = process.argv[2];

    switch (command) {
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
        const annotationResult = await annotateCommitMessageFile({
            repoRoot,
            messageFilePath,
            placeholderLabel: DEFAULT_AI_PLACEHOLDER_LABEL
        });
        console.log(annotationResult.suffixText);
        return 0;
    }
    catch (error) {
        console.error(`AILoc2 annotate-commit-message warning: ${toErrorMessage(error)}`);

        try {
            const placeholderSuffix = createAiCommitSuffix({
                aiPercentage: null,
                placeholderLabel: DEFAULT_AI_PLACEHOLDER_LABEL
            });
            await applyAiSuffixToCommitMessageFile({
                messageFilePath,
                suffixText: placeholderSuffix.suffixText
            });
            console.log(placeholderSuffix.suffixText);
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
    console.error('Usage: node <ailoc2-hook-runtime.cjs|out/cli/gitHookCli.js> <prepare-commit-baseline [repoRoot]|refresh-summary [repoRoot]|annotate-commit-message <messageFilePath> [repoRoot]|finalize-commit [repoRoot]>');
}

runCli('AILoc2 hook CLI', main);
