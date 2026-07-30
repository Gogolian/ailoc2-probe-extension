export type ChangeClassification = {
    signal: string;
    explanation: string;
};

export type WorkspaceFileChangeClassificationInput = {
    isNoOp: boolean;
    isWholeDocumentReplace: boolean;
    isSmallLocalizedEdit: boolean;
    isInitialFilePopulation: boolean;
    isLargeBulkInsertion: boolean;
    isLargeBulkExpansion: boolean;
    hasRecentChatCorrelation: boolean;
    hasRecentSnapshotActivity: boolean;
};

export function classifyWorkspaceFileChange(input: WorkspaceFileChangeClassificationInput): ChangeClassification {
    if (input.isNoOp) {
        return {
            signal: 'LifecycleNoiseOrDirtyStateFlip',
            explanation: 'The event has zero content changes and likely reflects a dirty/save lifecycle transition instead of new text.'
        };
    }

    if (input.hasRecentSnapshotActivity && input.isWholeDocumentReplace) {
        return {
            signal: 'ProbableAIApplyToWorkspaceFile',
            explanation: 'A real workspace file was replaced wholesale shortly after chat-editing snapshot activity for the same logical path.'
        };
    }

    if (input.hasRecentChatCorrelation && input.isSmallLocalizedEdit) {
        return {
            signal: 'LikelyHumanEditWhileChatSessionOpen',
            explanation: 'A small localized workspace-file edit occurred while chat-editing virtual documents were open, which likely means the human edited the file during an active chat session.'
        };
    }

    if (input.hasRecentSnapshotActivity) {
        return {
            signal: 'PossibleAIApplyToWorkspaceFile',
            explanation: 'A real workspace file changed soon after chat-editing snapshot activity for the same logical path, but the change was not a whole-document replacement.'
        };
    }

    if (input.hasRecentChatCorrelation && (input.isLargeBulkInsertion || input.isLargeBulkExpansion)) {
        return {
            signal: 'ProbableAIBulkWorkspaceEdit',
            explanation: 'A large workspace-file edit occurred with recent chat-editing context but without stronger snapshot metadata.'
        };
    }

    if (input.isInitialFilePopulation || input.isLargeBulkInsertion || input.isLargeBulkExpansion) {
        return {
            signal: 'UncorrelatedBulkOrNewFileEdit',
            explanation: 'A new file population or bulk workspace edit occurred without enough evidence to distinguish an AI tool from a human bulk operation.'
        };
    }

    return {
        signal: 'LikelyHumanOrRegularEditorEdit',
        explanation: 'A regular workspace file changed without matching chat-editing context.'
    };
}
