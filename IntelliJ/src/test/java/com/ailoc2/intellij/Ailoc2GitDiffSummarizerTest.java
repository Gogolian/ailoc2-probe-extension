package com.ailoc2.intellij;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class Ailoc2GitDiffSummarizerTest {
    @Test
    void countsNonBlankAddedLinesByAttributionBucket() {
        Ailoc2FileState state = new Ailoc2FileState();
        state.setLineBucket(1, Ailoc2AttributionBucket.AI);
        state.setLineBucket(2, Ailoc2AttributionBucket.HUMAN);
        state.setLineBucket(3, Ailoc2AttributionBucket.UNKNOWN);
        state.setLineBucket(4, Ailoc2AttributionBucket.AI);
        Map<String, Ailoc2FileState> states = Map.of("src/example.ts", state);
        String diff = String.join("\n",
            "diff --git a/src/example.ts b/src/example.ts",
            "--- /dev/null",
            "+++ b/src/example.ts",
            "@@ -0,0 +1,5 @@",
            "+ai token",
            "+human token",
            "+unknown token",
            "++++counter;",
            "+   "
        );

        Ailoc2GitSummary summary = summarize(diff, states, path -> false);

        assertEquals(
            new SummarySnapshot(
                1,
                1,
                weight("ai token") + weight("unknown token") + weight("+++counter;"),
                weight("human token"),
                3,
                1,
                1
            ),
            snapshot(summary)
        );
    }

    @Test
    void usesFileFallbackOnlyWhenNoExplicitLineBucketExists() {
        Ailoc2FileState state = new Ailoc2FileState();
        state.setAiMagnitude(1L);
        state.setHumanMagnitude(10L);
        Map<String, Ailoc2FileState> states = Map.of("src/fallback.ts", state);
        String diff = String.join("\n",
            "diff --git a/src/fallback.ts b/src/fallback.ts",
            "--- a/src/fallback.ts",
            "+++ b/src/fallback.ts",
            "@@ -1 +1 @@",
            "-old value",
            "+new value"
        );

        Ailoc2GitSummary summary = summarize(diff, states, path -> false);

        assertEquals(new SummarySnapshot(1, 1, 0L, weight("new value"), 0, 1, 0), snapshot(summary));
    }

    @Test
    void attributesUnknownLinesAsAiAndExcludesBlankAndDeletedLines() {
        Map<String, Ailoc2FileState> states = new HashMap<>();
        states.put("src/unknown.ts", new Ailoc2FileState());
        states.put("src/deleted.ts", new Ailoc2FileState());
        String diff = String.join("\n",
            "diff --git a/src/unknown.ts b/src/unknown.ts",
            "--- a/src/unknown.ts",
            "+++ b/src/unknown.ts",
            "@@ -1 +1,2 @@",
            "-old value",
            "+unknown value",
            "+   ",
            "diff --git a/src/deleted.ts b/src/deleted.ts",
            "--- a/src/deleted.ts",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-deleted value"
        );

        Ailoc2GitSummary summary = summarize(diff, states, path -> false);

        assertEquals(new SummarySnapshot(1, 1, weight("unknown value"), 0L, 1, 0, 1), snapshot(summary));
    }

    @Test
    void excludesIgnoredPathsFromAllCounts() {
        Ailoc2FileState state = new Ailoc2FileState();
        state.setLineBucket(1, Ailoc2AttributionBucket.AI);
        String diff = String.join("\n",
            "diff --git a/generated.ts b/generated.ts",
            "--- /dev/null",
            "+++ b/generated.ts",
            "@@ -0,0 +1 @@",
            "+generated"
        );

        Ailoc2GitSummary summary = summarize(diff, Map.of("generated.ts", state), path -> true);

        assertEquals(new SummarySnapshot(0, 0, 0L, 0L, 0, 0, 0), snapshot(summary));
    }

    private Ailoc2GitSummary summarize(
        String diff,
        Map<String, Ailoc2FileState> states,
        java.util.function.Predicate<String> ignoredPathPredicate
    ) {
        return new Ailoc2GitDiffSummarizer(
            path -> states.getOrDefault(path, new Ailoc2FileState()),
            ignoredPathPredicate
        ).summarize(diff);
    }

    private SummarySnapshot snapshot(Ailoc2GitSummary summary) {
        return new SummarySnapshot(
            summary.changedFileCount,
            summary.attributedChangedFileCount,
            summary.aiWeightedChangedLines,
            summary.humanWeightedChangedLines,
            summary.aiAddedLineCount,
            summary.humanAddedLineCount,
            summary.unknownAddedLineCount
        );
    }

    private long weight(String text) {
        return text.codePoints().filter(codePoint -> !Character.isWhitespace(codePoint)).count();
    }

    private record SummarySnapshot(
        int changedFileCount,
        int attributedChangedFileCount,
        long aiWeight,
        long humanWeight,
        long aiLineCount,
        long humanLineCount,
        long unknownLineCount
    ) {
    }
}
