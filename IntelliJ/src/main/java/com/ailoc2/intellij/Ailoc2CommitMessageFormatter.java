package com.ailoc2.intellij;

import java.util.Locale;
import java.util.regex.Pattern;

final class Ailoc2CommitMessageFormatter {
    static final String UNAVAILABLE_SUFFIX = " (AI: unavailable) (AI lines: unavailable) (H lines: unavailable)";

    private static final Pattern ATTRIBUTION_SUFFIX_PATTERN = Pattern.compile(
        "(?:^|\\s+)(?:\\((?:AI:?|AI lines:|H lines:) [^)]*\\)(?:\\s+|$))+$"
    );

    private Ailoc2CommitMessageFormatter() {
    }

    static String apply(String messageText, Ailoc2GitSummary summary) {
        int subjectEnd = firstLineBreakIndex(messageText);
        String subject = subjectEnd >= 0 ? messageText.substring(0, subjectEnd) : messageText;
        String remainder = subjectEnd >= 0 ? messageText.substring(subjectEnd) : "";
        String normalizedSubject = ATTRIBUTION_SUFFIX_PATTERN.matcher(subject).replaceFirst("").stripTrailing();
        String suffix = createSuffix(summary);
        String annotatedSubject = normalizedSubject.isEmpty() ? suffix.stripLeading() : normalizedSubject + suffix;
        return annotatedSubject + remainder;
    }

    static String createSuffix(Ailoc2GitSummary summary) {
        if (!hasValidAttribution(summary)) {
            return UNAVAILABLE_SUFFIX;
        }

        return String.format(
            Locale.ROOT,
            " (AI: %.2f%%) (AI lines: %d) (H lines: %d)",
            summary.aiPercentage,
            summary.aiAddedLineCount,
            summary.humanAddedLineCount
        );
    }

    private static boolean hasValidAttribution(Ailoc2GitSummary summary) {
        return summary != null
            && summary.available
            && Double.isFinite(summary.aiPercentage)
            && summary.aiPercentage >= 0.0d
            && summary.aiPercentage <= 100.0d
            && summary.aiAddedLineCount >= 0L
            && summary.humanAddedLineCount >= 0L;
    }

    private static int firstLineBreakIndex(String text) {
        for (int index = 0; index < text.length(); index++) {
            char character = text.charAt(index);
            if (character == '\r' || character == '\n') {
                return index;
            }
        }
        return -1;
    }
}
