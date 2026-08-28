package com.ailoc2.intellij;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class Ailoc2MarkerAttributionTest {
    private static String diff(String filePath, String... addedLines) {
        StringBuilder builder = new StringBuilder()
            .append("diff --git a/").append(filePath).append(" b/").append(filePath).append('\n')
            .append("--- a/").append(filePath).append('\n')
            .append("+++ b/").append(filePath).append('\n')
            .append("@@ -0,0 +1,").append(addedLines.length).append(" @@\n");
        for (String line : addedLines) {
            builder.append('+').append(line).append('\n');
        }
        return builder.toString();
    }

    @Test
    void attributesOnlyLinesInsideMarkerBlocks() {
        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(diff("src/app.ts",
            "const humanBefore = 1;",
            "// AI start",
            "const generatedOne = 2;",
            "const generatedTwo = 3;",
            "// AI stop",
            "const humanAfter = 4;"
        ), path -> false);

        assertEquals(2L, summary.aiAddedLineCount);
        assertEquals(2L, summary.humanAddedLineCount);
        assertEquals(0L, summary.unknownAddedLineCount, "marker mode never produces Unknown");
        // Ailoc2GitSummary derives the percentage from non-whitespace weight, not line counts.
        assertEquals(
            (summary.aiWeightedChangedLines * 100.0d) / (summary.aiWeightedChangedLines + summary.humanWeightedChangedLines),
            summary.aiPercentage,
            0.000001d);
        assertTrue(summary.aiWeightedChangedLines > 0L);
        assertTrue(summary.humanWeightedChangedLines > 0L);
    }

    @Test
    void markerLinesLeaveBothNumeratorAndDenominator() {
        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(
            diff("src/only.ts", "// AI start", "// AI stop"), path -> false);

        assertEquals(0L, summary.aiAddedLineCount);
        assertEquals(0L, summary.humanAddedLineCount);
        assertEquals(0, summary.changedFileCount);
    }

    @Test
    void unclosedBlockDoesNotBleedIntoTheNextFile() {
        String diffText = diff("src/leaky.ts", "// AI start", "const generated = 1;")
            + diff("src/clean.ts", "const handWritten = 2;");

        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(diffText, path -> false);

        assertEquals(1L, summary.aiAddedLineCount);
        assertEquals(1L, summary.humanAddedLineCount, "the later file stays human");
    }

    @Test
    void nestedBlocksRequireMatchingStops() {
        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(diff("src/nested.ts",
            "// AI start",
            "const outer = 1;",
            "// AI start",
            "const inner = 2;",
            "// AI stop",
            "const stillInside = 3;",
            "// AI stop",
            "const outsideAgain = 4;"
        ), path -> false);

        assertEquals(3L, summary.aiAddedLineCount);
        assertEquals(1L, summary.humanAddedLineCount);
    }

    @Test
    void blankAndWhitespaceOnlyLinesAreNotCounted() {
        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(diff("src/blank.ts",
            "// AI start", "const generated = 1;", "", "   ", "// AI stop"
        ), path -> false);

        assertEquals(1L, summary.aiAddedLineCount);
        assertEquals(0L, summary.humanAddedLineCount);
    }

    @Test
    void removedAndContextLinesAreIgnored() {
        String diffText = """
            diff --git a/src/app.ts b/src/app.ts
            --- a/src/app.ts
            +++ b/src/app.ts
            @@ -1,3 +1,3 @@
             const untouched = 0;
            -const removed = 1;
            +// AI start
            +const generated = 2;
            +// AI stop
            """;

        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(diffText, path -> false);

        assertEquals(1L, summary.aiAddedLineCount);
        assertEquals(0L, summary.humanAddedLineCount);
    }

    @Test
    void markersAreRecognizedAcrossCommentSyntaxesAndCasing() {
        String[] markers = {
            "// AI start", "# AI start", "/* AI start */", "<!-- AI start -->", "-- AI start",
            "// ai_start", "// AI-START", "<!-- AI STOP -->", "# ai stop"
        };

        for (String marker : markers) {
            assertTrue(Ailoc2MarkerAttribution.isMarkerLine(marker), "expected to recognize " + marker);
        }

        assertFalse(Ailoc2MarkerAttribution.isMarkerLine("const aiStartupCost = 1;"), "requires a word boundary");
        assertFalse(Ailoc2MarkerAttribution.isMarkerLine("const normal = 1;"));
    }

    @Test
    void excludedPathsAreDropped() {
        String diffText = diff("vendor/lib.js", "// AI start", "const generated = 1;", "// AI stop")
            + diff("src/app.ts", "const handWritten = 2;");

        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(
            diffText, path -> path.startsWith("vendor/"));

        assertEquals(1, summary.changedFileCount);
        assertEquals(0L, summary.aiAddedLineCount);
        assertEquals(1L, summary.humanAddedLineCount);
    }

    @Test
    void collectMarkerPathsReportsOnlyFilesWithMarkers() {
        String diffText = diff("src/marked.ts", "// AI start", "const one = 1;", "// AI stop")
            + diff("src/plain.ts", "const two = 2;");

        assertEquals(java.util.List.of("src/marked.ts"), Ailoc2MarkerAttribution.collectMarkerPaths(diffText));
    }

    @Test
    void humanPolarityAttributesUnmarkedLinesToAi() {
        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(diff("src/app.ts",
            "const generatedOne = 1;",
            "// Human start",
            "const handWrittenOne = 2;",
            "const handWrittenTwo = 3;",
            "// Human stop",
            "const generatedTwo = 4;"
        ), path -> false, Ailoc2MarkerAttribution.Polarity.HUMAN);

        assertEquals(2L, summary.aiAddedLineCount, "lines outside a human block are AI");
        assertEquals(2L, summary.humanAddedLineCount);
        assertEquals(0L, summary.unknownAddedLineCount);
    }

    @Test
    void humanPolarityTreatsUntaggedFileAsEntirelyAi() {
        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(
            diff("src/untagged.ts", "const one = 1;", "const two = 2;", "const three = 3;"),
            path -> false,
            Ailoc2MarkerAttribution.Polarity.HUMAN);

        assertEquals(3L, summary.aiAddedLineCount);
        assertEquals(0L, summary.humanAddedLineCount);
        assertEquals(100.0d, summary.aiPercentage, 0.000001d);
    }

    @Test
    void markerFamiliesAreIndependent() {
        String diffText = diff("src/mixed.ts", "// AI start", "const line = 1;", "// AI stop");

        Ailoc2GitSummary human = Ailoc2MarkerAttribution.summarize(
            diffText, path -> false, Ailoc2MarkerAttribution.Polarity.HUMAN);
        Ailoc2GitSummary ai = Ailoc2MarkerAttribution.summarize(
            diffText, path -> false, Ailoc2MarkerAttribution.Polarity.AI);

        assertEquals(3L, human.aiAddedLineCount, "AI markers are ordinary lines under human polarity");
        assertEquals(1L, ai.aiAddedLineCount, "and are consumed as markers under AI polarity");
    }

    @Test
    void humanPolarityResetsBlockStatePerFile() {
        String diffText = diff("src/leaky.ts", "// Human start", "const handWritten = 1;")
            + diff("src/next.ts", "const generated = 2;");

        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(
            diffText, path -> false, Ailoc2MarkerAttribution.Polarity.HUMAN);

        assertEquals(1L, summary.humanAddedLineCount);
        assertEquals(1L, summary.aiAddedLineCount, "an unclosed human block must not bleed forward");
    }

    @Test
    void humanMarkerSyntaxMatchesTheAiFamilyConventions() {
        String[] markers = {
            "// Human start", "# human start", "/* HUMAN START */", "<!-- human_start -->",
            "-- Human-Start", "// human stop", "# HUMAN_STOP"
        };

        for (String marker : markers) {
            assertTrue(
                Ailoc2MarkerAttribution.isMarkerLine(marker, Ailoc2MarkerAttribution.Polarity.HUMAN),
                "expected to recognize " + marker);
        }

        assertFalse(Ailoc2MarkerAttribution.isMarkerLine(
            "const humanStartupTime = 1;", Ailoc2MarkerAttribution.Polarity.HUMAN), "requires a word boundary");
        assertFalse(Ailoc2MarkerAttribution.isMarkerLine(
            "// AI start", Ailoc2MarkerAttribution.Polarity.HUMAN), "AI markers are a separate family");
    }

    @Test
    void collectMarkerPathsHonorsPolarity() {
        String diffText = diff("src/human.ts", "// Human start", "const one = 1;", "// Human stop")
            + diff("src/ai.ts", "// AI start", "const two = 2;", "// AI stop");

        assertEquals(
            java.util.List.of("src/human.ts"),
            Ailoc2MarkerAttribution.collectMarkerPaths(diffText, Ailoc2MarkerAttribution.Polarity.HUMAN));
        assertEquals(
            java.util.List.of("src/ai.ts"),
            Ailoc2MarkerAttribution.collectMarkerPaths(diffText, Ailoc2MarkerAttribution.Polarity.AI));
    }

    @Test
    void deletedFilesAreSkipped() {
        String diffText = """
            diff --git a/src/gone.ts b/src/gone.ts
            --- a/src/gone.ts
            +++ /dev/null
            @@ -1,1 +0,0 @@
            -const removed = 1;
            """;

        Ailoc2GitSummary summary = Ailoc2MarkerAttribution.summarize(diffText, path -> false);

        assertEquals(0, summary.changedFileCount);
    }
}
