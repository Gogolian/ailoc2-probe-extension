package com.ailoc2.intellij;

import java.util.Map;

final class Ailoc2GitSummary {
    final int changedFileCount;
    final int attributedChangedFileCount;
    final long aiWeightedChangedLines;
    final long humanWeightedChangedLines;
    final double aiPercentage;
    final double humanPercentage;
    final boolean available;
    final Map<String, FileWeights> fileWeights;

    Ailoc2GitSummary(
        int changedFileCount,
        int attributedChangedFileCount,
        long aiWeightedChangedLines,
        long humanWeightedChangedLines,
        boolean available,
        Map<String, FileWeights> fileWeights
    ) {
        this.changedFileCount = changedFileCount;
        this.attributedChangedFileCount = attributedChangedFileCount;
        this.aiWeightedChangedLines = aiWeightedChangedLines;
        this.humanWeightedChangedLines = humanWeightedChangedLines;
        this.available = available;
        this.fileWeights = Map.copyOf(fileWeights);
        long denominator = aiWeightedChangedLines + humanWeightedChangedLines;
        if (denominator > 0L) {
            this.aiPercentage = (aiWeightedChangedLines * 100.0d) / denominator;
            this.humanPercentage = (humanWeightedChangedLines * 100.0d) / denominator;
        }
        else {
            this.aiPercentage = 0.0d;
            this.humanPercentage = 0.0d;
        }
    }

    static Ailoc2GitSummary unavailable() {
        return new Ailoc2GitSummary(0, 0, 0L, 0L, false, Map.of());
    }

    record FileWeights(long aiWeightedChangedLines, long humanWeightedChangedLines) {
        FileWeights addAi(long weight) {
            return new FileWeights(aiWeightedChangedLines + weight, humanWeightedChangedLines);
        }

        FileWeights addHuman(long weight) {
            return new FileWeights(aiWeightedChangedLines, humanWeightedChangedLines + weight);
        }
    }
}
