import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    WorkspaceFileChangeClassificationInput,
    classifyWorkspaceFileChange
} from '../changeClassification';
import { getAttributionBucketForSignal } from '../metrics/schema';

function classify(overrides: Partial<WorkspaceFileChangeClassificationInput>) {
    return classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isInitialFilePopulation: false,
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: false,
        hasRecentChatCorrelation: false,
        hasRecentSnapshotActivity: false,
        largeFileIsAiEnabled: true,
        newFileIsAiEnabled: true,
        ...overrides
    });
}

test('large bulk insertion without chat evidence is treated as unsure', () => {
    const classification = classify({ isLargeBulkInsertion: true });

    assert.equal(classification.signal, 'UncorrelatedBulkOrNewFileEdit');
});

test('large bulk expansion without chat evidence is treated as unsure', () => {
    const classification = classify({ isLargeBulkExpansion: true });

    assert.equal(classification.signal, 'UncorrelatedBulkOrNewFileEdit');
});

test('large bulk insertion with chat evidence is treated as probable AI bulk edit', () => {
    const classification = classify({ isLargeBulkInsertion: true, hasRecentChatCorrelation: true });

    assert.equal(classification.signal, 'ProbableAIBulkWorkspaceEdit');
});

test('large bulk expansion with chat evidence is treated as probable AI bulk edit', () => {
    const classification = classify({ isLargeBulkExpansion: true, hasRecentChatCorrelation: true });

    assert.equal(classification.signal, 'ProbableAIBulkWorkspaceEdit');
});

test('whole-file replacement with recent snapshot remains probable AI apply', () => {
    const classification = classify({
        isWholeDocumentReplace: true,
        isLargeBulkExpansion: true,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: true
    });

    assert.equal(classification.signal, 'ProbableAIApplyToWorkspaceFile');
});

test('small localized edit while chat is open remains human', () => {
    const classification = classify({ isSmallLocalizedEdit: true, hasRecentChatCorrelation: true });

    assert.equal(classification.signal, 'LikelyHumanEditWhileChatSessionOpen');
});

test('non-whole-file edit with recent snapshot remains possible AI apply', () => {
    const classification = classify({
        isLargeBulkExpansion: true,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: true
    });

    assert.equal(classification.signal, 'PossibleAIApplyToWorkspaceFile');
});

test('small initial file population without chat evidence is treated as unsure', () => {
    const classification = classify({ isInitialFilePopulation: true });

    assert.equal(classification.signal, 'UncorrelatedBulkOrNewFileEdit');
});

// The Unknown bucket is folded into AI downstream (summary.ts applyChangedLineAttributionSummary),
// so these assert on the bucket rather than the signal name: landing in Unknown would leave the
// reported AI percentage unchanged and make the toggle a silent no-op.
test('disabling largeFileIsAI moves an uncorrelated bulk insertion out of the AI-counted buckets', () => {
    const classification = classify({ isLargeBulkInsertion: true, largeFileIsAiEnabled: false });

    assert.equal(classification.signal, 'LikelyHumanOrRegularEditorEdit');
    assert.equal(getAttributionBucketForSignal(classification.signal), 'Human');
});

test('disabling largeFileIsAI moves an uncorrelated bulk expansion out of the AI-counted buckets', () => {
    const classification = classify({ isLargeBulkExpansion: true, largeFileIsAiEnabled: false });

    assert.equal(getAttributionBucketForSignal(classification.signal), 'Human');
});

test('disabling largeFileIsAI also drops the chat-correlated bulk AI signal', () => {
    const classification = classify({
        isLargeBulkInsertion: true,
        hasRecentChatCorrelation: true,
        largeFileIsAiEnabled: false
    });

    assert.equal(getAttributionBucketForSignal(classification.signal), 'Human');
});

test('disabling largeFileIsAI does not affect stronger snapshot-based AI evidence', () => {
    const classification = classify({
        isWholeDocumentReplace: true,
        isLargeBulkInsertion: true,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: true,
        largeFileIsAiEnabled: false
    });

    assert.equal(classification.signal, 'ProbableAIApplyToWorkspaceFile');
    assert.equal(getAttributionBucketForSignal(classification.signal), 'AI');
});

test('disabling largeFileIsAI leaves new-file population attribution intact', () => {
    const classification = classify({ isInitialFilePopulation: true, largeFileIsAiEnabled: false });

    assert.equal(classification.signal, 'UncorrelatedBulkOrNewFileEdit');
});

test('disabling newFileIsAI moves an initial file population out of the AI-counted buckets', () => {
    const classification = classify({ isInitialFilePopulation: true, newFileIsAiEnabled: false });

    assert.equal(getAttributionBucketForSignal(classification.signal), 'Human');
});

test('disabling newFileIsAI leaves bulk-edit attribution intact', () => {
    const classification = classify({ isLargeBulkInsertion: true, newFileIsAiEnabled: false });

    assert.equal(classification.signal, 'UncorrelatedBulkOrNewFileEdit');
});

test('disabling both flags still reports a no-op event as lifecycle noise', () => {
    const classification = classify({
        isNoOp: true,
        largeFileIsAiEnabled: false,
        newFileIsAiEnabled: false
    });

    assert.equal(classification.signal, 'LifecycleNoiseOrDirtyStateFlip');
});
