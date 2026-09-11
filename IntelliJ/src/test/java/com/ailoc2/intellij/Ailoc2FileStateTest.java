package com.ailoc2.intellij;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class Ailoc2FileStateTest {
    @Test
    void deletionMergingLinesKeepsTheClassifiedBucketInsteadOfUnknown() {
        Ailoc2FileState state = new Ailoc2FileState();
        state.setLineBucket(1, Ailoc2AttributionBucket.AI);
        state.setLineBucket(2, Ailoc2AttributionBucket.AI);
        state.setLineBucket(3, Ailoc2AttributionBucket.AI);

        // A human selects from the end of line 1 through the middle of line 3 (not a
        // line-boundary-aligned selection) and deletes it, merging what remains of
        // line 1 and line 3 into a single line. The deletion event itself is
        // classified HUMAN; the merged line must inherit that, not fall back to
        // UNKNOWN, or Ailoc2GitDiffSummarizer later folds it into the AI percentage.
        state.applyLineChange(1, "\n  return oldCode();\n}", "", Ailoc2AttributionBucket.HUMAN);

        assertTrue(state.hasLineBucket(1));
        assertEquals(Ailoc2AttributionBucket.HUMAN, state.getLineBucket(1));
    }

    @Test
    void deletionMergingLinesPreservesAiBucketWhenTheDeletionItselfIsClassifiedAi() {
        Ailoc2FileState state = new Ailoc2FileState();
        state.setLineBucket(1, Ailoc2AttributionBucket.HUMAN);
        state.setLineBucket(2, Ailoc2AttributionBucket.HUMAN);

        state.applyLineChange(1, "\nremainder", "", Ailoc2AttributionBucket.AI);

        assertTrue(state.hasLineBucket(1));
        assertEquals(Ailoc2AttributionBucket.AI, state.getLineBucket(1));
    }
}
