package com.ailoc2.intellij;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

final class Ailoc2FileState {
    private final Map<Integer, Ailoc2AttributionBucket> lineBuckets = new HashMap<>();
    private long aiMagnitude;
    private long humanMagnitude;

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

    void addMagnitude(Ailoc2AttributionBucket bucket, long magnitude) {
        long positiveMagnitude = Math.max(1L, magnitude);
        if (bucket == Ailoc2AttributionBucket.AI) {
            aiMagnitude += positiveMagnitude;
        }
        else if (bucket == Ailoc2AttributionBucket.HUMAN) {
            humanMagnitude += positiveMagnitude;
        }
    }

    long getAiMagnitude() {
        return aiMagnitude;
    }

    long getHumanMagnitude() {
        return humanMagnitude;
    }

    void setAiMagnitude(long aiMagnitude) {
        this.aiMagnitude = Math.max(0L, aiMagnitude);
    }

    void setHumanMagnitude(long humanMagnitude) {
        this.humanMagnitude = Math.max(0L, humanMagnitude);
    }

    Ailoc2AttributionBucket fallbackBucket() {
        if (aiMagnitude == 0L && humanMagnitude == 0L) {
            return Ailoc2AttributionBucket.UNKNOWN;
        }
        return aiMagnitude >= humanMagnitude ? Ailoc2AttributionBucket.AI : Ailoc2AttributionBucket.HUMAN;
    }
}
