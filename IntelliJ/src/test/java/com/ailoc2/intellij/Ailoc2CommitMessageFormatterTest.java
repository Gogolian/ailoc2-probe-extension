package com.ailoc2.intellij;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class Ailoc2CommitMessageFormatterTest {
    @Test
    void appendsLineDerivedPercentageToSubjectAndCountsToBody() {
        String result = Ailoc2CommitMessageFormatter.apply("Ship it", availableSummary());

        assertEquals("Ship it (AI: 33.33%)\n\n(AI-Lines: 4/12)", result);
    }

    @Test
    void derivesFiftyPercentFromTenOfTwentyLines() {
        Ailoc2GitSummary summary = new Ailoc2GitSummary(
            1,
            1,
            1L,
            9L,
            10L,
            8L,
            2L,
            true,
            Map.of()
        );

        assertEquals(
            "Ship it (AI: 50%)\n\n(AI-Lines: 10/20)",
            Ailoc2CommitMessageFormatter.apply("Ship it (AI: 10.00%)", summary)
        );
    }

    @Test
    void migratesLegacySubjectSuffixes() {
        assertEquals(
            "Ship it (AI: 33.33%)\n\n(AI-Lines: 4/12)",
            Ailoc2CommitMessageFormatter.apply("Ship it (AI 10.00%)", availableSummary())
        );
        assertEquals(
            "Ship it (AI: 33.33%)\n\n(AI-Lines: 4/12)",
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

        assertEquals("Ship it (AI: 33.33%)\r\n\r\n(AI-Lines: 4/12)\r\n\r\nBody line\r\n", result);
    }

    @Test
    void replacesExistingBodyAnnotationIdempotently() {
        String message = "Ship it\n\nContext\n\n(AI-Lines: 1/10)\n\nFooter";
        String first = Ailoc2CommitMessageFormatter.apply(message, availableSummary());
        String second = Ailoc2CommitMessageFormatter.apply(first, availableSummary());

        assertEquals("Ship it (AI: 33.33%)\n\n(AI-Lines: 4/12)\n\nContext\n\nFooter", first);
        assertEquals(first, second);
    }

    @Test
    void unavailableSummaryUsesNonNumericBodyAnnotation() {
        String first = Ailoc2CommitMessageFormatter.apply("", Ailoc2GitSummary.unavailable());
        String second = Ailoc2CommitMessageFormatter.apply(first, Ailoc2GitSummary.unavailable());

        assertEquals("(AI: unavailable)\n\n(AI-Lines: unavailable)", first);
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

        assertEquals(Ailoc2CommitMessageFormatter.UNAVAILABLE_ANNOTATION, Ailoc2CommitMessageFormatter.createAnnotation(invalidSummary));
    }

    private Ailoc2GitSummary availableSummary() {
        return new Ailoc2GitSummary(
            1,
            1,
            4L,
            6L,
            4L,
            6L,
            2L,
            true,
            Map.of()
        );
    }
}
