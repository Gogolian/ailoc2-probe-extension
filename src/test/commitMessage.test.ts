import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import {
    annotateCommitMessageFile,
    applyAiSuffixToCommitMessage,
    applyAiSuffixToCommitMessageFile,
    createAiCommitSuffix,
    DEFAULT_AI_PLACEHOLDER_LABEL
} from '../hooks/commitMessage';
import { getMetricsSummaryFilePath } from '../metrics/pathing';

const tempDirectories: string[] = [];

afterEach(() => {
    while (tempDirectories.length > 0) {
        const directoryPath = tempDirectories.pop();
        if (!directoryPath) {
            continue;
        }

        fs.rmSync(directoryPath, { recursive: true, force: true });
    }
});

test('createAiCommitSuffix formats a finite percentage with two decimals', () => {
    const suffix = createAiCommitSuffix({ aiPercentage: 42 });

    assert.deepEqual(suffix, {
        suffixText: ' (AI 42.00%)',
        usedPlaceholder: false
    });
});

test('createAiCommitSuffix rounds and pads fractional percentages', () => {
    assert.equal(createAiCommitSuffix({ aiPercentage: 12.3456 }).suffixText, ' (AI 12.35%)');
    assert.equal(createAiCommitSuffix({ aiPercentage: 0 }).suffixText, ' (AI 0.00%)');
    assert.equal(createAiCommitSuffix({ aiPercentage: 100 }).suffixText, ' (AI 100.00%)');
});

test('createAiCommitSuffix falls back to the default placeholder when percentage is null', () => {
    const suffix = createAiCommitSuffix({ aiPercentage: null });

    assert.deepEqual(suffix, {
        suffixText: ` (AI ${DEFAULT_AI_PLACEHOLDER_LABEL})`,
        usedPlaceholder: true
    });
});

test('createAiCommitSuffix uses a custom placeholder label when provided', () => {
    const suffix = createAiCommitSuffix({ aiPercentage: null, placeholderLabel: 'no git' });

    assert.deepEqual(suffix, {
        suffixText: ' (AI no git)',
        usedPlaceholder: true
    });
});

test('createAiCommitSuffix treats non-finite percentages as placeholders', () => {
    assert.equal(createAiCommitSuffix({ aiPercentage: Number.NaN }).usedPlaceholder, true);
    assert.equal(createAiCommitSuffix({ aiPercentage: Number.POSITIVE_INFINITY }).usedPlaceholder, true);
});

test('applyAiSuffixToCommitMessage appends the suffix to the subject line', () => {
    const result = applyAiSuffixToCommitMessage('Fix bug', ' (AI 30.00%)');

    assert.equal(result, 'Fix bug (AI 30.00%)');
});

test('applyAiSuffixToCommitMessage replaces an existing AI suffix instead of duplicating it', () => {
    const result = applyAiSuffixToCommitMessage('Fix bug (AI 10.00%)', ' (AI 55.00%)');

    assert.equal(result, 'Fix bug (AI 55.00%)');
});

test('applyAiSuffixToCommitMessage replaces a placeholder AI suffix', () => {
    const result = applyAiSuffixToCommitMessage('Fix bug (AI unavailable)', ' (AI 55.00%)');

    assert.equal(result, 'Fix bug (AI 55.00%)');
});

test('applyAiSuffixToCommitMessage only annotates the subject and preserves the body', () => {
    const message = 'Add feature\n\nDetailed body line\nSecond body line\n';
    const result = applyAiSuffixToCommitMessage(message, ' (AI 20.00%)');
    const lines = result.split('\n');

    assert.equal(lines[0], 'Add feature (AI 20.00%)');
    assert.equal(lines[1], '');
    assert.ok(result.includes('Detailed body line'));
    assert.ok(result.includes('Second body line'));
});

test('applyAiSuffixToCommitMessage trims the leading space when the subject is empty', () => {
    const result = applyAiSuffixToCommitMessage('', ' (AI unavailable)');

    assert.equal(result, '(AI unavailable)');
});

test('applyAiSuffixToCommitMessage keeps the CRLF newline style', () => {
    const message = 'Subject\r\n\r\nBody\r\n';
    const result = applyAiSuffixToCommitMessage(message, ' (AI 5.00%)');

    assert.ok(result.startsWith('Subject (AI 5.00%)\r\n'));
    assert.ok(result.includes('Body'));
    assert.equal(/(?<!\r)\n/u.test(result), false);
});

test('applyAiSuffixToCommitMessage preserves lone CR newlines', () => {
    const message = 'Subject\rBody';
    const result = applyAiSuffixToCommitMessage(message, ' (AI 5.00%)');

    assert.equal(result, 'Subject (AI 5.00%)\rBody');
});

test('applyAiSuffixToCommitMessageFile writes the annotated subject back to disk', async () => {
    const repoRoot = createTempDirectory('ailoc2-commit-message-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Implement thing\n', 'utf8');

    await applyAiSuffixToCommitMessageFile({
        messageFilePath,
        suffixText: ' (AI 75.00%)'
    });

    assert.equal(fs.readFileSync(messageFilePath, 'utf8').split('\n')[0], 'Implement thing (AI 75.00%)');
});

test('applyAiSuffixToCommitMessageFile replaces a stale suffix without duplicating it', async () => {
    const repoRoot = createTempDirectory('ailoc2-commit-message-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Implement thing (AI 10.00%)\n', 'utf8');

    await applyAiSuffixToCommitMessageFile({
        messageFilePath,
        suffixText: ' (AI 75.00%)'
    });

    const contents = fs.readFileSync(messageFilePath, 'utf8');
    assert.equal(contents.split('\n')[0], 'Implement thing (AI 75.00%)');
    assert.equal(contents.match(/\(AI /gu)?.length, 1);
});

test('annotateCommitMessageFile uses the staged percentage from an available summary', async () => {
    const repoRoot = createTempDirectory('ailoc2-annotate-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Ship it\n', 'utf8');
    writeSummaryFile(repoRoot, { isGitSummaryAvailable: true, stagedAiPercentage: 63.5 });

    const result = await annotateCommitMessageFile({ repoRoot, messageFilePath });

    assert.deepEqual({
        suffixText: result.suffixText,
        usedPlaceholder: result.usedPlaceholder,
        summaryAvailable: result.summaryAvailable,
        summaryFilePath: result.summaryFilePath,
        subjectLine: fs.readFileSync(messageFilePath, 'utf8').split('\n')[0]
    }, {
        suffixText: ' (AI 63.50%)',
        usedPlaceholder: false,
        summaryAvailable: true,
        summaryFilePath: getMetricsSummaryFilePath(repoRoot),
        subjectLine: 'Ship it (AI 63.50%)'
    });
});

test('annotateCommitMessageFile falls back to the placeholder when no summary file exists', async () => {
    const repoRoot = createTempDirectory('ailoc2-annotate-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Ship it\n', 'utf8');

    const result = await annotateCommitMessageFile({ repoRoot, messageFilePath });

    assert.deepEqual({
        suffixText: result.suffixText,
        usedPlaceholder: result.usedPlaceholder,
        summaryAvailable: result.summaryAvailable,
        subjectLine: fs.readFileSync(messageFilePath, 'utf8').split('\n')[0]
    }, {
        suffixText: ` (AI ${DEFAULT_AI_PLACEHOLDER_LABEL})`,
        usedPlaceholder: true,
        summaryAvailable: false,
        subjectLine: `Ship it (AI ${DEFAULT_AI_PLACEHOLDER_LABEL})`
    });
});

test('annotateCommitMessageFile uses the placeholder when git summary is unavailable', async () => {
    const repoRoot = createTempDirectory('ailoc2-annotate-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Ship it\n', 'utf8');
    writeSummaryFile(repoRoot, { isGitSummaryAvailable: false, stagedAiPercentage: 99 });

    const result = await annotateCommitMessageFile({ repoRoot, messageFilePath });

    assert.equal(result.usedPlaceholder, true);
    assert.equal(result.summaryAvailable, false);
    assert.equal(result.suffixText, ` (AI ${DEFAULT_AI_PLACEHOLDER_LABEL})`);
});

test('annotateCommitMessageFile honors a custom placeholder label', async () => {
    const repoRoot = createTempDirectory('ailoc2-annotate-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Ship it\n', 'utf8');

    const result = await annotateCommitMessageFile({
        repoRoot,
        messageFilePath,
        placeholderLabel: 'offline'
    });

    assert.equal(result.suffixText, ' (AI offline)');
    assert.equal(fs.readFileSync(messageFilePath, 'utf8').split('\n')[0], 'Ship it (AI offline)');
});

function createTempDirectory(prefix: string): string {
    const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirectories.push(directoryPath);
    return directoryPath;
}

function writeSummaryFile(repoRoot: string, args: {
    isGitSummaryAvailable: boolean;
    stagedAiPercentage: number;
}): void {
    const summaryFilePath = getMetricsSummaryFilePath(repoRoot);
    fs.mkdirSync(path.dirname(summaryFilePath), { recursive: true });
    fs.writeFileSync(summaryFilePath, JSON.stringify({
        repoRoot,
        repoName: path.basename(repoRoot),
        isGitSummaryAvailable: args.isGitSummaryAvailable,
        staged: { aiPercentage: args.stagedAiPercentage },
        unstaged: { aiPercentage: 0 }
    }), 'utf8');
}
