package com.ailoc2.intellij;

import java.util.Collections;
import java.util.Map;
import java.util.TreeMap;

final class Ailoc2FileState {
    private final Map<Integer, Ailoc2AttributionBucket> lineBuckets = new TreeMap<>();
    private long aiMagnitude;
    private long humanMagnitude;
    private long unknownMagnitude;
    private String source = "INTELLIJ";
    private String recordedAt = "";

    Map<Integer, Ailoc2AttributionBucket> getLineBuckets() {
        return Collections.unmodifiableMap(lineBuckets);
    }

    void setLineBucket(int oneBasedLineNumber, Ailoc2AttributionBucket bucket) {
        if (oneBasedLineNumber <= 0) {
            return;
        }
        lineBuckets.put(oneBasedLineNumber, bucket);
    }

    Ailoc2AttributionBucket getLineBucket(int oneBasedLineNumber) {
        return lineBuckets.getOrDefault(oneBasedLineNumber, Ailoc2AttributionBucket.UNKNOWN);
    }

    boolean hasLineBucket(int oneBasedLineNumber) {
        return lineBuckets.containsKey(oneBasedLineNumber);
    }

    void applyLineChange(
        int oneBasedStartLine,
        CharSequence oldFragment,
        CharSequence newFragment,
        Ailoc2AttributionBucket bucket
    ) {
        int safeStartLine = Math.max(1, oneBasedStartLine);
        int removedLineBreakCount = countLineBreaks(oldFragment);
        int addedLineBreakCount = countLineBreaks(newFragment);
        boolean oldEndsAtLineBoundary = endsWithLineBreak(oldFragment);
        boolean newEndsAtLineBoundary = endsWithLineBreak(newFragment);
        int oldEndLine = oldFragment.isEmpty()
            ? safeStartLine - 1
            : safeStartLine + removedLineBreakCount - (oldEndsAtLineBoundary ? 1 : 0);
        int lineDelta = addedLineBreakCount - removedLineBreakCount;
        Map<Integer, Ailoc2AttributionBucket> shiftedBuckets = new TreeMap<>();

        for (Map.Entry<Integer, Ailoc2AttributionBucket> entry : lineBuckets.entrySet()) {
            int lineNumber = entry.getKey();
            if (lineNumber < safeStartLine) {
                shiftedBuckets.put(lineNumber, entry.getValue());
            }
            else if (lineNumber > oldEndLine) {
                shiftedBuckets.put(lineNumber + lineDelta, entry.getValue());
            }
        }
        if (!newFragment.isEmpty()) {
            int newEndLine = safeStartLine + addedLineBreakCount - (newEndsAtLineBoundary ? 1 : 0);
            for (int lineNumber = safeStartLine; lineNumber <= Math.max(safeStartLine, newEndLine); lineNumber++) {
                shiftedBuckets.put(lineNumber, bucket);
            }
        }
        else if (!oldFragment.isEmpty() && !oldEndsAtLineBoundary) {
            shiftedBuckets.put(safeStartLine, Ailoc2AttributionBucket.UNKNOWN);
        }

        lineBuckets.clear();
        lineBuckets.putAll(shiftedBuckets);
    }

    private int countLineBreaks(CharSequence fragment) {
        int lineBreaks = 0;
        for (int index = 0; index < fragment.length(); index++) {
            if (fragment.charAt(index) == '\n') {
                lineBreaks++;
            }
        }
        return lineBreaks;
    }

    private boolean endsWithLineBreak(CharSequence fragment) {
        return !fragment.isEmpty() && fragment.charAt(fragment.length() - 1) == '\n';
    }

    void addMagnitude(Ailoc2AttributionBucket bucket, long magnitude) {
        long positiveMagnitude = Math.max(1L, magnitude);
        if (bucket == Ailoc2AttributionBucket.AI) {
            aiMagnitude += positiveMagnitude;
        }
        else if (bucket == Ailoc2AttributionBucket.HUMAN) {
            humanMagnitude += positiveMagnitude;
        }
        else {
            unknownMagnitude += positiveMagnitude;
        }
    }

    long getAiMagnitude() {
        return aiMagnitude;
    }

    long getHumanMagnitude() {
        return humanMagnitude;
    }

    long getUnknownMagnitude() {
        return unknownMagnitude;
    }

    void setAiMagnitude(long aiMagnitude) {
        this.aiMagnitude = Math.max(0L, aiMagnitude);
    }

    void setHumanMagnitude(long humanMagnitude) {
        this.humanMagnitude = Math.max(0L, humanMagnitude);
    }

    void setUnknownMagnitude(long unknownMagnitude) {
        this.unknownMagnitude = Math.max(0L, unknownMagnitude);
    }

    String getSource() {
        return source;
    }

    void setSource(String source) {
        this.source = source == null || source.isBlank() ? "INTELLIJ" : source;
    }

    String getRecordedAt() {
        return recordedAt;
    }

    void setRecordedAt(String recordedAt) {
        this.recordedAt = recordedAt == null ? "" : recordedAt;
    }

    Ailoc2AttributionBucket fallbackBucket() {
        long strongestMagnitude = Math.max(aiMagnitude, Math.max(humanMagnitude, unknownMagnitude));
        if (strongestMagnitude == 0L) {
            return Ailoc2AttributionBucket.UNKNOWN;
        }
        int strongestBucketCount = (aiMagnitude == strongestMagnitude ? 1 : 0)
            + (humanMagnitude == strongestMagnitude ? 1 : 0)
            + (unknownMagnitude == strongestMagnitude ? 1 : 0);
        if (strongestBucketCount > 1 || unknownMagnitude == strongestMagnitude) {
            return Ailoc2AttributionBucket.UNKNOWN;
        }
        return aiMagnitude == strongestMagnitude ? Ailoc2AttributionBucket.AI : Ailoc2AttributionBucket.HUMAN;
    }
}
