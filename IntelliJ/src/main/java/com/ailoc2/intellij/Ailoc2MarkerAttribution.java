package com.ailoc2.intellij;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Comment-marker attribution.
 *
 * <p>Mirrors {@code src/metrics/markerAttribution.ts}; the two must stay in agreement or the
 * IDE and the terminal will report different percentages for the same commit. Markers are
 * matched anywhere in a line and the comment syntax is deliberately irrelevant, which is how a
 * single pattern covered {@code //}, {@code #}, {@code /* *}{@code /}, {@code <!-- -->} and {@code --}.
 *
 * <p>Two polarities are supported. {@link Polarity#AI} tags AI code and treats everything else
 * as human. {@link Polarity#HUMAN} inverts that: unmarked lines are AI and only tagged blocks
 * are human, which suits workflows where AI writes most of the code.
 */
final class Ailoc2MarkerAttribution {
    static final Pattern AI_MARKER_START = Pattern.compile("ai[\\s_\\-]*start\\b", Pattern.CASE_INSENSITIVE);
    static final Pattern AI_MARKER_STOP = Pattern.compile("ai[\\s_\\-]*stop\\b", Pattern.CASE_INSENSITIVE);
    static final Pattern HUMAN_MARKER_START = Pattern.compile("human[\\s_\\-]*start\\b", Pattern.CASE_INSENSITIVE);
    static final Pattern HUMAN_MARKER_STOP = Pattern.compile("human[\\s_\\-]*stop\\b", Pattern.CASE_INSENSITIVE);

    /**
     * Which author a marker block attributes its contents to. Lines outside any block get the
     * opposite bucket, so {@link Polarity#HUMAN} treats untagged code as AI.
     */
    enum Polarity { AI, HUMAN }

    private Ailoc2MarkerAttribution() {
    }

    static boolean isMarkerLine(String text) {
        return isMarkerLine(text, Polarity.AI);
    }

    static boolean isMarkerLine(String text, Polarity polarity) {
        Pattern start = polarity == Polarity.HUMAN ? HUMAN_MARKER_START : AI_MARKER_START;
        Pattern stop = polarity == Polarity.HUMAN ? HUMAN_MARKER_STOP : AI_MARKER_STOP;
        return start.matcher(text).find() || stop.matcher(text).find();
    }

    /**
     * Counts added lines per file, attributing lines inside a marker block to AI and everything
     * else to Human.
     *
     * <p>Deliberately diverges from the legacy Python implementation, which never reset block
     * state between files (so an unclosed block bled into every later file), did not support
     * nesting, and counted blank lines. Marker lines are excluded from both the numerator and
     * the denominator.
     */
    static Ailoc2GitSummary summarize(String diffText, Predicate<String> ignoredPathPredicate) {
        return summarize(diffText, ignoredPathPredicate, Polarity.AI);
    }

    static Ailoc2GitSummary summarize(
        String diffText,
        Predicate<String> ignoredPathPredicate,
        Polarity polarity
    ) {
        Pattern startPattern = polarity == Polarity.HUMAN ? HUMAN_MARKER_START : AI_MARKER_START;
        Pattern stopPattern = polarity == Polarity.HUMAN ? HUMAN_MARKER_STOP : AI_MARKER_STOP;
        Map<String, long[]> weightsByPath = new LinkedHashMap<>();
        long aiWeight = 0;
        long humanWeight = 0;
        int aiLineCount = 0;
        int humanLineCount = 0;

        String currentPath = null;
        int blockDepth = 0;

        for (String line : diffText.split("\r?\n", -1)) {
            if (line.startsWith("diff --git ")) {
                currentPath = null;
                blockDepth = 0;
                continue;
            }

            if (line.startsWith("+++ ")) {
                currentPath = normalizeTargetPath(line.substring(4));
                if (currentPath != null && ignoredPathPredicate.test(currentPath)) {
                    currentPath = null;
                }
                blockDepth = 0;
                continue;
            }

            if (currentPath == null || line.startsWith("---") || line.startsWith("@@")) {
                continue;
            }

            if (!line.startsWith("+") || line.startsWith("+++")) {
                continue;
            }

            String content = line.substring(1);
            if (startPattern.matcher(content).find()) {
                blockDepth++;
                continue;
            }
            if (stopPattern.matcher(content).find()) {
                blockDepth = Math.max(0, blockDepth - 1);
                continue;
            }

            long weight = nonWhitespaceWeight(content);
            if (weight == 0) {
                continue;
            }

            long[] pathWeights = weightsByPath.computeIfAbsent(currentPath, key -> new long[2]);
            boolean isInsideBlock = blockDepth > 0;
            if (polarity == Polarity.AI ? isInsideBlock : !isInsideBlock) {
                aiWeight += weight;
                aiLineCount++;
                pathWeights[0] += weight;
            }
            else {
                humanWeight += weight;
                humanLineCount++;
                pathWeights[1] += weight;
            }
        }

        Map<String, Ailoc2GitSummary.FileWeights> files = new LinkedHashMap<>();
        for (Map.Entry<String, long[]> entry : weightsByPath.entrySet()) {
            files.put(entry.getKey(), new Ailoc2GitSummary.FileWeights(entry.getValue()[0], entry.getValue()[1]));
        }

        return new Ailoc2GitSummary(
            weightsByPath.size(),
            weightsByPath.size(),
            aiWeight,
            humanWeight,
            aiLineCount,
            humanLineCount,
            0L,
            true,
            files
        );
    }

    /**
     * Repo-relative paths whose staged additions still contain markers.
     */
    static List<String> collectMarkerPaths(String diffText) {
        return collectMarkerPaths(diffText, Polarity.AI);
    }

    static List<String> collectMarkerPaths(String diffText, Polarity polarity) {
        List<String> paths = new ArrayList<>();
        String currentPath = null;

        for (String line : diffText.split("\r?\n", -1)) {
            if (line.startsWith("+++ ")) {
                currentPath = normalizeTargetPath(line.substring(4));
                continue;
            }

            if (currentPath == null || !line.startsWith("+") || line.startsWith("+++")) {
                continue;
            }

            if (isMarkerLine(line.substring(1), polarity) && !paths.contains(currentPath)) {
                paths.add(currentPath);
            }
        }

        return paths;
    }

    private static String normalizeTargetPath(String rawPath) {
        String candidate = rawPath.strip();
        if (candidate.isEmpty() || "/dev/null".equals(candidate)) {
            return null;
        }

        if (candidate.length() > 1 && candidate.startsWith("\"") && candidate.endsWith("\"")) {
            candidate = candidate.substring(1, candidate.length() - 1);
        }
        if (candidate.startsWith("b/")) {
            candidate = candidate.substring(2);
        }

        return candidate.isEmpty() ? null : candidate;
    }

    private static long nonWhitespaceWeight(String text) {
        long weight = 0;
        for (int index = 0; index < text.length(); index++) {
            if (!Character.isWhitespace(text.charAt(index))) {
                weight++;
            }
        }
        return weight;
    }
}
