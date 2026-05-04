package com.ailoc2.intellij;

final class Ailoc2GitSummary {
    final int changedFileCount;
    final int attributedChangedFileCount;
    final long aiWeightedChangedLines;
    final long humanWeightedChangedLines;
    final double aiPercentage;
    final double humanPercentage;
    final boolean available;

    Ailoc2GitSummary(
        int changedFileCount,
        int attributedChangedFileCount,
        long aiWeightedChangedLines,
        long humanWeightedChangedLines,
        boolean available
    ) {
        this.changedFileCount = changedFileCount;
        this.attributedChangedFileCount = attributedChangedFileCount;
        this.aiWeightedChangedLines = aiWeightedChangedLines;
        this.humanWeightedChangedLines = humanWeightedChangedLines;
        this.available = available;
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
        return new Ailoc2GitSummary(0, 0, 0L, 0L, false);
    }
}
