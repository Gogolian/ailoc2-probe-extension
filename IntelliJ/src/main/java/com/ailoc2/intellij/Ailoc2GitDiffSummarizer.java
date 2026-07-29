package com.ailoc2.intellij;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class Ailoc2GitDiffSummarizer {
    private static final Pattern HUNK_PATTERN = Pattern.compile("^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@.*$");

    private final Function<String, Ailoc2FileState> stateProvider;
    private final Predicate<String> ignoredPathPredicate;

    Ailoc2GitDiffSummarizer(
        Function<String, Ailoc2FileState> stateProvider,
        Predicate<String> ignoredPathPredicate
    ) {
        this.stateProvider = stateProvider;
        this.ignoredPathPredicate = ignoredPathPredicate;
    }

    Ailoc2GitSummary summarize(String diffText) {
        Set<String> changedFiles = new HashSet<>();
        Set<String> attributedFiles = new HashSet<>();
        String currentPath = null;
        int currentLine = 0;
        long aiWeight = 0L;
        long humanWeight = 0L;
        long aiAddedLineCount = 0L;
        long humanAddedLineCount = 0L;
        long unknownAddedLineCount = 0L;
        Map<String, Ailoc2GitSummary.FileWeights> fileWeights = new HashMap<>();

        for (String line : diffText.split("\\R")) {
            if (line.startsWith("+++ ")) {
                currentPath = parseNewPath(line);
                currentLine = 0;
                if (currentPath != null && !ignoredPathPredicate.test(currentPath)) {
                    changedFiles.add(currentPath);
                }
                else {
                    currentPath = null;
                }
                continue;
            }

            Matcher matcher = HUNK_PATTERN.matcher(line);
            if (matcher.matches()) {
                currentLine = Integer.parseInt(matcher.group(1));
                continue;
            }

            if (currentPath == null || currentLine <= 0) {
                continue;
            }

            if (line.startsWith("+") && !line.startsWith("+++ ")) {
                Ailoc2FileState state = stateProvider.apply(currentPath);
                Ailoc2AttributionBucket bucket = state.getLineBucket(currentLine);
                if (bucket == Ailoc2AttributionBucket.UNKNOWN && !state.hasLineBucket(currentLine)) {
                    bucket = state.fallbackBucket();
                }
                long weight = nonWhitespaceWeight(line.substring(1));
                if (weight > 0L && bucket == Ailoc2AttributionBucket.AI) {
                    aiWeight += weight;
                    aiAddedLineCount++;
                    attributedFiles.add(currentPath);
                    fileWeights.compute(
                        currentPath,
                        (path, weights) -> (weights == null ? new Ailoc2GitSummary.FileWeights(0L, 0L) : weights).addAi(weight)
                    );
                }
                else if (weight > 0L && bucket == Ailoc2AttributionBucket.HUMAN) {
                    humanWeight += weight;
                    humanAddedLineCount++;
                    attributedFiles.add(currentPath);
                    fileWeights.compute(
                        currentPath,
                        (path, weights) -> (weights == null ? new Ailoc2GitSummary.FileWeights(0L, 0L) : weights).addHuman(weight)
                    );
                }
                else if (weight > 0L) {
                    aiWeight += weight;
                    aiAddedLineCount++;
                    attributedFiles.add(currentPath);
                    fileWeights.compute(
                        currentPath,
                        (path, weights) -> (weights == null ? new Ailoc2GitSummary.FileWeights(0L, 0L) : weights).addAi(weight)
                    );
                }
                currentLine++;
            }
            else if (line.startsWith(" ")) {
                currentLine++;
            }
        }

        return new Ailoc2GitSummary(
            changedFiles.size(),
            attributedFiles.size(),
            aiWeight,
            humanWeight,
            aiAddedLineCount,
            humanAddedLineCount,
            unknownAddedLineCount,
            true,
            fileWeights
        );
    }

    private String parseNewPath(String line) {
        String pathText = line.substring(4).trim();
        if ("/dev/null".equals(pathText)) {
            return null;
        }
        if (pathText.startsWith("b/")) {
            return pathText.substring(2);
        }
        return pathText;
    }

    private long nonWhitespaceWeight(String text) {
        return text.codePoints().filter(codePoint -> !Character.isWhitespace(codePoint)).count();
    }
}
