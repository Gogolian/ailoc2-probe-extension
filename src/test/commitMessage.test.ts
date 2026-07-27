import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import {
    annotateCommitMessageFile,
    applyAiLinesAnnotationToCommitMessage,
    applyAiLinesAnnotationToCommitMessageFile,
    createAiLinesAnnotation,
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

test('createAiLinesAnnotation formats AI and total line counts', () => {
    assert.deepEqual(createAiLinesAnnotation({
        aiLineCount: 7,
        humanLineCount: 3,
        unknownLineCount: 2
    }), {
        annotationText: '(AI-Lines: 7/12)',
        usedPlaceholder: false
    });
});

test('createAiLinesAnnotation supports zero and all-AI totals', () => {
    assert.equal(createAiLinesAnnotation({ aiLineCount: 0, humanLineCount: 0, unknownLineCount: 0 }).annotationText, '(AI-Lines: 0/0)');
    assert.equal(createAiLinesAnnotation({ aiLineCount: 9, humanLineCount: 0, unknownLineCount: 0 }).annotationText, '(AI-Lines: 9/9)');
});

test('createAiLinesAnnotation falls back when a line count is missing or invalid', () => {
    assert.deepEqual(createAiLinesAnnotation({
        aiLineCount: null,
        humanLineCount: null,
        unknownLineCount: null
    }), {
        annotationText: `(AI-Lines: ${DEFAULT_AI_PLACEHOLDER_LABEL})`,
        usedPlaceholder: true
    });
    assert.equal(createAiLinesAnnotation({ aiLineCount: -1, humanLineCount: 1, unknownLineCount: 0 }).usedPlaceholder, true);
    assert.equal(createAiLinesAnnotation({ aiLineCount: 1.5, humanLineCount: 1, unknownLineCount: 0 }).usedPlaceholder, true);
    assert.equal(createAiLinesAnnotation({ aiLineCount: 1, humanLineCount: 1, unknownLineCount: null }).usedPlaceholder, true);
    assert.equal(createAiLinesAnnotation({ aiLineCount: Number.MAX_SAFE_INTEGER, humanLineCount: 1, unknownLineCount: 0 }).usedPlaceholder, true);
});

test('createAiLinesAnnotation uses a custom placeholder label', () => {
    assert.equal(createAiLinesAnnotation({
        aiLineCount: null,
        humanLineCount: null,
        unknownLineCount: null,
        placeholderLabel: 'no git'
    }).annotationText, '(AI-Lines: no git)');
});

test('applyAiLinesAnnotationToCommitMessage adds the annotation to the body', () => {
    assert.equal(
        applyAiLinesAnnotationToCommitMessage('Fix bug', '(AI-Lines: 3/10)'),
        'Fix bug\n\n(AI-Lines: 3/10)'
    );
});

test('applyAiLinesAnnotationToCommitMessage migrates legacy subject suffixes', () => {
    assert.equal(
        applyAiLinesAnnotationToCommitMessage(
            'Fix bug (AI: 10.00%) (AI lines: 1) (H lines: 9)\n\nDetails',
            '(AI-Lines: 5/10)'
        ),
        'Fix bug\n\n(AI-Lines: 5/10)\n\nDetails'
    );
});

test('applyAiLinesAnnotationToCommitMessage replaces an existing body annotation', () => {
    const message = 'Fix bug\n\nContext\n\n(AI-Lines: 1/10)\n\nFooter';

    assert.equal(
        applyAiLinesAnnotationToCommitMessage(message, '(AI-Lines: 5/10)'),
        'Fix bug\n\n(AI-Lines: 5/10)\n\nContext\n\nFooter'
    );
});

test('applyAiLinesAnnotationToCommitMessage preserves CRLF and trailing newline', () => {
    const result = applyAiLinesAnnotationToCommitMessage(
        'Subject\r\n\r\nBody\r\n',
        '(AI-Lines: 2/4)'
    );

    assert.equal(result, 'Subject\r\n\r\n(AI-Lines: 2/4)\r\n\r\nBody\r\n');
    assert.equal(/(?<!\r)\n/u.test(result), false);
});

test('applyAiLinesAnnotationToCommitMessage preserves lone CR newlines', () => {
    assert.equal(
        applyAiLinesAnnotationToCommitMessage('Subject\rBody', '(AI-Lines: 2/4)'),
        'Subject\r\r(AI-Lines: 2/4)\r\rBody'
    );
});

test('applyAiLinesAnnotationToCommitMessage is idempotent', () => {
    const annotated = applyAiLinesAnnotationToCommitMessage(
        'Subject\n\nBody\n',
        '(AI-Lines: 2/4)'
    );

    assert.equal(applyAiLinesAnnotationToCommitMessage(annotated, '(AI-Lines: 2/4)'), annotated);
});

test('applyAiLinesAnnotationToCommitMessageFile writes the annotation to the body', async () => {
    const repoRoot = createTempDirectory('ailoc2-commit-message-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Implement thing\n', 'utf8');

    await applyAiLinesAnnotationToCommitMessageFile({
        messageFilePath,
        annotationText: '(AI-Lines: 6/9)'
    });

    assert.equal(fs.readFileSync(messageFilePath, 'utf8'), 'Implement thing\n\n(AI-Lines: 6/9)\n');
});

test('annotateCommitMessageFile uses all staged line buckets in the total', async () => {
    const repoRoot = createTempDirectory('ailoc2-annotate-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Ship it\n', 'utf8');
    writeSummaryFile(repoRoot, {
        isGitSummaryAvailable: true,
        stagedAiLineCount: 8,
        stagedHumanLineCount: 5,
        stagedUnknownLineCount: 2
    });

    const result = await annotateCommitMessageFile({ repoRoot, messageFilePath });

    assert.deepEqual({
        annotationText: result.annotationText,
        usedPlaceholder: result.usedPlaceholder,
        summaryAvailable: result.summaryAvailable,
        summaryFilePath: result.summaryFilePath,
        message: fs.readFileSync(messageFilePath, 'utf8')
    }, {
        annotationText: '(AI-Lines: 8/15)',
        usedPlaceholder: false,
        summaryAvailable: true,
        summaryFilePath: getMetricsSummaryFilePath(repoRoot),
        message: 'Ship it\n\n(AI-Lines: 8/15)\n'
    });
});

test('annotateCommitMessageFile falls back when no summary file exists', async () => {
    const repoRoot = createTempDirectory('ailoc2-annotate-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Ship it\n', 'utf8');

    const result = await annotateCommitMessageFile({ repoRoot, messageFilePath });

    assert.equal(result.annotationText, `(AI-Lines: ${DEFAULT_AI_PLACEHOLDER_LABEL})`);
    assert.equal(result.usedPlaceholder, true);
    assert.equal(result.summaryAvailable, false);
    assert.equal(fs.readFileSync(messageFilePath, 'utf8'), 'Ship it\n\n(AI-Lines: unavailable)\n');
});

test('annotateCommitMessageFile treats a legacy summary without all line counts as unavailable', async () => {
    const repoRoot = createTempDirectory('ailoc2-annotate-legacy-');
    const messageFilePath = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(messageFilePath, 'Ship it\n', 'utf8');
    writeSummaryFile(repoRoot, {
        isGitSummaryAvailable: true,
        stagedAiLineCount: 8,
        stagedHumanLineCount: 5
    });

    const result = await annotateCommitMessageFile({ repoRoot, messageFilePath });

    assert.equal(result.usedPlaceholder, true);
    assert.equal(result.summaryAvailable, false);
    assert.equal(fs.readFileSync(messageFilePath, 'utf8'), 'Ship it\n\n(AI-Lines: unavailable)\n');
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

    assert.equal(result.annotationText, '(AI-Lines: offline)');
    assert.equal(fs.readFileSync(messageFilePath, 'utf8'), 'Ship it\n\n(AI-Lines: offline)\n');
});

function createTempDirectory(prefix: string): string {
    const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirectories.push(directoryPath);
    return directoryPath;
}

function writeSummaryFile(repoRoot: string, args: {
    isGitSummaryAvailable: boolean;
    stagedAiLineCount?: number;
    stagedHumanLineCount?: number;
    stagedUnknownLineCount?: number;
}): void {
    const summaryFilePath = getMetricsSummaryFilePath(repoRoot);
    const stagedSummary: Record<string, number> = { aiPercentage: 0 };
    if (args.stagedAiLineCount !== undefined) {
        stagedSummary.aiAddedLineCount = args.stagedAiLineCount;
    }
    if (args.stagedHumanLineCount !== undefined) {
        stagedSummary.humanAddedLineCount = args.stagedHumanLineCount;
    }
    if (args.stagedUnknownLineCount !== undefined) {
        stagedSummary.unknownAddedLineCount = args.stagedUnknownLineCount;
    }
    fs.mkdirSync(path.dirname(summaryFilePath), { recursive: true });
    fs.writeFileSync(summaryFilePath, JSON.stringify({
        repoRoot,
        repoName: path.basename(repoRoot),
        isGitSummaryAvailable: args.isGitSummaryAvailable,
        staged: stagedSummary,
        unstaged: { aiPercentage: 0 }
    }), 'utf8');
}
