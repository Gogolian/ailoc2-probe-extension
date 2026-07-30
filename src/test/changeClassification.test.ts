import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyWorkspaceFileChange } from '../changeClassification';

test('large bulk insertion without chat evidence is treated as unsure', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isInitialFilePopulation: false,
        isLargeBulkInsertion: true,
        isLargeBulkExpansion: false,
        hasRecentChatCorrelation: false,
        hasRecentSnapshotActivity: false
    });

    assert.equal(classification.signal, 'UncorrelatedBulkOrNewFileEdit');
});

test('large bulk expansion without chat evidence is treated as unsure', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isInitialFilePopulation: false,
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: true,
        hasRecentChatCorrelation: false,
        hasRecentSnapshotActivity: false
    });

    assert.equal(classification.signal, 'UncorrelatedBulkOrNewFileEdit');
});

test('large bulk insertion with chat evidence is treated as probable AI bulk edit', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isInitialFilePopulation: false,
        isLargeBulkInsertion: true,
        isLargeBulkExpansion: false,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: false
    });

    assert.equal(classification.signal, 'ProbableAIBulkWorkspaceEdit');
});

test('large bulk expansion with chat evidence is treated as probable AI bulk edit', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isInitialFilePopulation: false,
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: true,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: false
    });

    assert.equal(classification.signal, 'ProbableAIBulkWorkspaceEdit');
});

test('whole-file replacement with recent snapshot remains probable AI apply', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: true,
        isSmallLocalizedEdit: false,
        isInitialFilePopulation: false,
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: true,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: true
    });

    assert.equal(classification.signal, 'ProbableAIApplyToWorkspaceFile');
});

test('small localized edit while chat is open remains human', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: true,
        isInitialFilePopulation: false,
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: false,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: false
    });

    assert.equal(classification.signal, 'LikelyHumanEditWhileChatSessionOpen');
});

test('non-whole-file edit with recent snapshot remains possible AI apply', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isInitialFilePopulation: false,
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: true,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: true
    });

    assert.equal(classification.signal, 'PossibleAIApplyToWorkspaceFile');
});

test('small initial file population without chat evidence is treated as unsure', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isInitialFilePopulation: true,
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: false,
        hasRecentChatCorrelation: false,
        hasRecentSnapshotActivity: false
    });

    assert.equal(classification.signal, 'UncorrelatedBulkOrNewFileEdit');
});
