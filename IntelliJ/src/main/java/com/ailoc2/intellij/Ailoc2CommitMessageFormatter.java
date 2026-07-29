package com.ailoc2.intellij;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

final class Ailoc2CommitMessageFormatter {
    static final String UNAVAILABLE_ANNOTATION = "(AI-Lines: unavailable)";

    private static final Pattern ATTRIBUTION_SUFFIX_PATTERN = Pattern.compile(
        "(?:^|\\s+)(?:\\((?:AI:?|AI lines:|H lines:|AI-Lines:) [^)]*\\)(?:\\s+|$))+$"
    );
    private static final Pattern AI_LINES_BODY_PATTERN = Pattern.compile("\\s*\\(AI-Lines: [^)]*\\)\\s*");

    private Ailoc2CommitMessageFormatter() {
    }

    static String apply(String messageText, Ailoc2GitSummary summary) {
        String newline = detectNewline(messageText);
        String[] lines = messageText.split("\\r\\n|\\r|\\n", -1);
        String subject = lines.length > 0 ? lines[0] : "";
        String normalizedSubject = ATTRIBUTION_SUFFIX_PATTERN.matcher(subject).replaceFirst("").stripTrailing();
        String subjectSuffix = createSubjectSuffix(summary);
        String annotatedSubject = normalizedSubject.isEmpty()
            ? subjectSuffix
            : normalizedSubject + " " + subjectSuffix;
        List<String> bodyLines = new ArrayList<>();
        for (int index = 1; index < lines.length; index++) {
            if (AI_LINES_BODY_PATTERN.matcher(lines[index]).matches()) {
                if (
                    !bodyLines.isEmpty()
                    && bodyLines.getLast().isBlank()
                    && index + 1 < lines.length
                    && lines[index + 1].isBlank()
                ) {
                    bodyLines.removeLast();
                }
                continue;
            }
            bodyLines.add(lines[index]);
        }
        while (!bodyLines.isEmpty() && bodyLines.getFirst().isBlank()) {
            bodyLines.removeFirst();
        }

        StringBuilder annotatedMessage = new StringBuilder(annotatedSubject)
            .append(newline)
            .append(newline)
            .append(createAnnotation(summary));
        if (!bodyLines.isEmpty()) {
            annotatedMessage.append(newline).append(newline).append(String.join(newline, bodyLines));
        }
        else if (endsWithNewline(messageText)) {
            annotatedMessage.append(newline);
        }
        return annotatedMessage.toString();
    }

    static String createAnnotation(Ailoc2GitSummary summary) {
        Long totalLineCount = getTotalLineCount(summary);
        if (totalLineCount == null) {
            return UNAVAILABLE_ANNOTATION;
        }

        return "(AI-Lines: " + summary.aiAddedLineCount + "/" + totalLineCount + ")";
    }

    private static String createSubjectSuffix(Ailoc2GitSummary summary) {
        Long totalLineCount = getTotalLineCount(summary);
        if (totalLineCount == null) {
            return "(AI: unavailable)";
        }
        if (totalLineCount == 0L) {
            return "(AI: 0%)";
        }

        String percentage = BigDecimal.valueOf(summary.aiAddedLineCount)
            .multiply(BigDecimal.valueOf(100L))
            .divide(BigDecimal.valueOf(totalLineCount), 2, RoundingMode.HALF_UP)
            .stripTrailingZeros()
            .toPlainString();
        return "(AI: " + percentage + "%)";
    }

    private static Long getTotalLineCount(Ailoc2GitSummary summary) {
        if (
            summary == null
            || !summary.available
            || summary.aiAddedLineCount < 0L
            || summary.humanAddedLineCount < 0L
            || summary.unknownAddedLineCount < 0L
        ) {
            return null;
        }

        try {
            return Math.addExact(
                Math.addExact(summary.aiAddedLineCount, summary.humanAddedLineCount),
                summary.unknownAddedLineCount
            );
        }
        catch (ArithmeticException ignored) {
            return null;
        }
    }

    private static String detectNewline(String text) {
        if (text.contains("\r\n")) {
            return "\r\n";
        }
        if (text.contains("\r")) {
            return "\r";
        }
        return "\n";
    }

    private static boolean endsWithNewline(String text) {
        return text.endsWith("\r") || text.endsWith("\n");
    }
}
