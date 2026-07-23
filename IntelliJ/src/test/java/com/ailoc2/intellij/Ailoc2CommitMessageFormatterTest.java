package com.ailoc2.intellij;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class Ailoc2CommitMessageFormatterTest {
    @Test
    void appendsPercentageAndLineCounts() {
        String result = Ailoc2CommitMessageFormatter.apply("Ship it", availableSummary());

        assertEquals("Ship it (AI: 40.00%) (AI lines: 4) (H lines: 6)", result);
    }

    @Test
    void replacesLegacyAndCompoundSuffixes() {
        assertEquals(
            "Ship it (AI: 40.00%) (AI lines: 4) (H lines: 6)",
            Ailoc2CommitMessageFormatter.apply("Ship it (AI 10.00%)", availableSummary())
        );
        assertEquals(
            "Ship it (AI: 40.00%) (AI lines: 4) (H lines: 6)",
            Ailoc2CommitMessageFormatter.apply(
                "Ship it (AI: 10.00%) (AI lines: 1) (H lines: 9)",
                availableSummary()
            )
        );
    }

    @Test
    void preservesCommitBodyAndOriginalNewlines() {
        String message = "Ship it\r\n\r\nBody line\r\n";

        String result = Ailoc2CommitMessageFormatter.apply(message, availableSummary());

        assertEquals("Ship it (AI: 40.00%) (AI lines: 4) (H lines: 6)\r\n\r\nBody line\r\n", result);
    }

    @Test
    void emptySubjectAndUnavailableSummaryAreIdempotent() {
        String first = Ailoc2CommitMessageFormatter.apply("", Ailoc2GitSummary.unavailable());
        String second = Ailoc2CommitMessageFormatter.apply(first, Ailoc2GitSummary.unavailable());

        assertEquals("(AI: unavailable) (AI lines: unavailable) (H lines: unavailable)", first);
        assertEquals(first, second);
    }

    @Test
    void invalidCountsFailClosed() {
        Ailoc2GitSummary invalidSummary = new Ailoc2GitSummary(
            1,
            1,
            4L,
            6L,
            -1L,
            6L,
            0L,
            true,
            Map.of()
        );

        assertEquals(Ailoc2CommitMessageFormatter.UNAVAILABLE_SUFFIX, Ailoc2CommitMessageFormatter.createSuffix(invalidSummary));
    }

    private Ailoc2GitSummary availableSummary() {
        return new Ailoc2GitSummary(
            1,
            1,
            4L,
            6L,
            4L,
            6L,
            0L,
            true,
            Map.of()
        );
    }
}
