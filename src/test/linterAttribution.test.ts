import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, test } from 'node:test';

import { createLineDiffSegments } from '../metrics/lineDiff';
import { getRollingStatePath } from '../metrics/pathing';
import {
    FileRollingState,
    LineAttributionSpan,
    METRICS_SCHEMA_VERSION,
    WorkspaceFileMetricEvent
} from '../metrics/schema';
import { RepoMetricsStore } from '../metrics/store';

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

/**
 * These tests exercise the "the linter must not steal attribution" property end
 * to end through the real rolling-state store, using the real line-diff logic.
 *
 * The scenario the team cares about: AI wrote half the code, a human wrote the
 * other half, then a linter/formatter ran. The per-line attribution model must
 * not silently reassign the AI-authored lines to the human (or vice versa) just
 * because a formatter touched them.
 */

test('whitespace-only reformat preserves the AI/Human line attribution split', async () => {
    const { repoRoot, repoRelativePath, store, queueEdit } = createScenario();

    // AI authors the first two lines.
    queueEdit('ProbableAIApplyToWorkspaceFile', '', 'const x=1\nconst y=2');
    await store.flushRepo(repoRoot);

    // Human appends the last two lines.
    queueEdit(
        'LikelyHumanOrRegularEditorEdit',
        'const x=1\nconst y=2',
        'const x=1\nconst y=2\nlet p=1\nlet q=2'
    );
    await store.flushRepo(repoRoot);

    assert.deepEqual(readSpans(repoRoot, repoRelativePath), [
        { attribution: 'AI', lineCount: 2 },
        { attribution: 'Human', lineCount: 2 }
    ]);

    // A formatter reindents the whole file and adds spaces around operators.
    // It is observed as a regular (human) edit because no AI context is active.
    queueEdit(
        'LikelyHumanOrRegularEditorEdit',
        'const x=1\nconst y=2\nlet p=1\nlet q=2',
        '    const x = 1\n    const y = 2\n    let p = 1\n    let q = 2'
    );
    await store.flushRepo(repoRoot);

    // The AI/Human split must be unchanged: the formatter earns no attribution.
    assert.deepEqual(readSpans(repoRoot, repoRelativePath), [
        { attribution: 'AI', lineCount: 2 },
        { attribution: 'Human', lineCount: 2 }
    ]);
});

test('known gap: a non-whitespace linter rewrite still moves attribution', async () => {
    // This is a CHARACTERIZATION test of a known limitation, not desired
    // behavior. Quote normalization (single -> double quotes) is not whitespace,
    // so today it is scored as a real human edit and steals AI attribution.
    // When token/AST-aware attribution lands (see IMPROVEMENT_PLANS.md), the AI
    // line should survive and this assertion will need to be tightened.
    const { repoRoot, repoRelativePath, store, queueEdit } = createScenario();

    queueEdit('ProbableAIApplyToWorkspaceFile', '', "const x = 'a'\nconst y = 'b'");
    await store.flushRepo(repoRoot);

    assert.deepEqual(readSpans(repoRoot, repoRelativePath), [
        { attribution: 'AI', lineCount: 2 }
    ]);

    queueEdit(
        'LikelyHumanOrRegularEditorEdit',
        "const x = 'a'\nconst y = 'b'",
        'const x = "a"\nconst y = "b"'
    );
    await store.flushRepo(repoRoot);

    // Documents the current loss: the AI lines flip to Human after the rewrite.
    assert.deepEqual(readSpans(repoRoot, repoRelativePath), [
        { attribution: 'Human', lineCount: 2 }
    ]);
});

function createScenario(): {
    repoRoot: string;
    repoRelativePath: string;
    store: RepoMetricsStore;
    queueEdit: (signal: string, before: string, after: string) => void;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ailoc2-linter-attribution-'));
    tempDirectories.push(repoRoot);

    const repoRelativePath = path.normalize('src/example.ts');
    const store = new RepoMetricsStore('linter-attribution-test', () => {});

    const queueEdit = (signal: string, before: string, after: string): void => {
        const event: WorkspaceFileMetricEvent = {
            schemaVersion: METRICS_SCHEMA_VERSION,
            recordType: 'workspace-file-metric',
            eventId: `${signal}-${Math.random()}`,
            recordedAt: new Date().toISOString(),
            extensionSessionId: 'linter-attribution-test',
            repoRoot,
            repoRelativePath,
            logicalPath: path.join(repoRoot, repoRelativePath),
            documentCategory: 'WorkspaceFile',
            signal,
            explanation: 'Synthetic edit for linter attribution coverage.',
            replacementRatio: 1,
            totalInsertedTextLength: after.length,
            totalRemovedTextLength: before.length,
            isWholeDocumentReplace: before.length === 0,
            hasRecentSnapshotActivity: signal.includes('AIApply'),
            snapshotRequestIds: [],
            requestIds: [],
            lastChatScheme: null,
            snapshotAgeMs: null,
            changeReason: 'RegularEditOrUnknown',
            documentVersion: 1,
            beforeHash: 'before',
            afterHash: 'after',
            beforeCharLength: before.length,
            afterCharLength: after.length,
            lineCount: after.split('\n').length,
            languageId: 'typescript',
            isDirty: false,
            lineDiffSegments: createLineDiffSegments(before, after),
            chatCorrelation: null,
            saveCorrelation: null
        };
        store.queueWorkspaceFileMetric(event);
    };

    return { repoRoot, repoRelativePath, store, queueEdit };
}

function readSpans(repoRoot: string, repoRelativePath: string): LineAttributionSpan[] {
    const rollingStatePath = getRollingStatePath(repoRoot, repoRelativePath);
    const rollingState = JSON.parse(fs.readFileSync(rollingStatePath, 'utf8')) as FileRollingState;
    return rollingState.lineAttributionSpans;
}
