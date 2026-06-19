import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyWorkspaceFileChange } from '../changeClassification';

test('large bulk insertion without chat evidence is treated as human paste', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isLargeBulkInsertion: true,
        isLargeBulkExpansion: false,
        hasRecentChatCorrelation: false,
        hasRecentSnapshotActivity: false
    });

    assert.equal(classification.signal, 'LikelyHumanOrRegularEditorEdit');
});

test('large bulk expansion without chat evidence is treated as human paste', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: false,
        isSmallLocalizedEdit: false,
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: true,
        hasRecentChatCorrelation: false,
        hasRecentSnapshotActivity: false
    });

    assert.equal(classification.signal, 'LikelyHumanOrRegularEditorEdit');
});

test('whole-file replacement with recent snapshot remains probable AI apply', () => {
    const classification = classifyWorkspaceFileChange({
        isNoOp: false,
        isWholeDocumentReplace: true,
        isSmallLocalizedEdit: false,
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
        isLargeBulkInsertion: false,
        isLargeBulkExpansion: true,
        hasRecentChatCorrelation: true,
        hasRecentSnapshotActivity: true
    });

    assert.equal(classification.signal, 'PossibleAIApplyToWorkspaceFile');
});
