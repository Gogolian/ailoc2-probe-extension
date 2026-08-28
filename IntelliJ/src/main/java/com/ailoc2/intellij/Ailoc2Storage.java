package com.ailoc2.intellij;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.Collection;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

final class Ailoc2Storage {
    private static final String METRICS_DIRECTORY = ".ailoc2-metrics";
    private final Ailoc2MetricsIgnoreRules metricsIgnoreRules = new Ailoc2MetricsIgnoreRules();
    private final Map<StateKey, Ailoc2FileState> cachedStates = new ConcurrentHashMap<>();

    Ailoc2FileState stateFor(Path repoRoot, String repoRelativePath) {
        if (isTrackingIgnored(repoRoot, repoRelativePath)) {
            return new Ailoc2FileState();
        }

        StateKey cacheKey = new StateKey(repoRoot.toAbsolutePath().normalize(), repoRelativePath);
        return cachedStates.computeIfAbsent(cacheKey, ignored -> readState(repoRoot, repoRelativePath));
    }

    Ailoc2FileState reloadState(Path repoRoot, String repoRelativePath) {
        if (isTrackingIgnored(repoRoot, repoRelativePath)) {
            return new Ailoc2FileState();
        }

        StateKey cacheKey = new StateKey(repoRoot.toAbsolutePath().normalize(), repoRelativePath);
        Ailoc2FileState state = readState(repoRoot, repoRelativePath);
        cachedStates.put(cacheKey, state);
        return state;
    }

    void persistState(Path repoRoot, String repoRelativePath, Ailoc2FileState state) {
        if (isTrackingIgnored(repoRoot, repoRelativePath)) {
            removeState(repoRoot, repoRelativePath);
            return;
        }

        Path statePath = statePath(repoRoot, repoRelativePath);
        StringBuilder builder = new StringBuilder();
        builder.append("# AILoc2 IntelliJ rolling state v2\n");
        builder.append("source\t").append(state.getSource()).append('\n');
        builder.append("recordedAt\t").append(state.getRecordedAt()).append('\n');
        builder.append("aiMagnitude\t").append(state.getAiMagnitude()).append('\n');
        builder.append("humanMagnitude\t").append(state.getHumanMagnitude()).append('\n');
        builder.append("unknownMagnitude\t").append(state.getUnknownMagnitude()).append('\n');
        for (Map.Entry<Integer, Ailoc2AttributionBucket> entry : state.getLineBuckets().entrySet()) {
            builder.append("line\t").append(entry.getKey()).append('\t').append(entry.getValue().name()).append('\n');
        }

        try {
            Files.createDirectories(statePath.getParent());
            Files.writeString(statePath, builder.toString(), StandardCharsets.UTF_8);
        }
        catch (IOException ignored) {
            // Metrics must never block normal editing.
        }
    }

    /**
     * Writes only the {@code staged} section, preserving whatever {@code unstaged} section is
     * already on disk instead of dropping it. Used by the commit-time refresh, which only
     * recomputes staged attribution; a full {@link #writeSummary(Path, Ailoc2GitSummary,
     * Ailoc2GitSummary)} call from an on-demand summary replaces both sections outright.
     */
    void writeSummary(Path repoRoot, Ailoc2GitSummary stagedSummary) {
        Path summaryPath = repoRoot.resolve(METRICS_DIRECTORY).resolve("summary.json");
        String preservedUnstagedFragment = readRawJsonFragment(summaryPath, "unstaged");
        writeSummaryDocument(repoRoot, summaryPath, stagedSummary, null, preservedUnstagedFragment);
    }

    void writeSummary(Path repoRoot, Ailoc2GitSummary stagedSummary, Ailoc2GitSummary unstagedSummary) {
        Path summaryPath = repoRoot.resolve(METRICS_DIRECTORY).resolve("summary.json");
        writeSummaryDocument(repoRoot, summaryPath, stagedSummary, unstagedSummary, null);
    }

    private void writeSummaryDocument(
        Path repoRoot,
        Path summaryPath,
        Ailoc2GitSummary stagedSummary,
        Ailoc2GitSummary unstagedSummary,
        String preservedUnstagedFragment
    ) {
        String repoName = repoRoot.getFileName() == null ? repoRoot.toString() : repoRoot.getFileName().toString();
        boolean hasUnstagedSection = unstagedSummary != null || preservedUnstagedFragment != null;
        boolean available = stagedSummary.available && (unstagedSummary == null || unstagedSummary.available);
        String summaryLine = available && unstagedSummary != null
            ? String.format(
                java.util.Locale.ROOT,
                "%s: STAGED -> AI %.2f%% | Human %.2f%% | AI lines %d | Human lines %d | Unknown lines %d ; UNSTAGED -> AI %.2f%% | Human %.2f%% | AI lines %d | Human lines %d | Unknown lines %d",
                repoName,
                stagedSummary.aiPercentage,
                stagedSummary.humanPercentage,
                stagedSummary.aiAddedLineCount,
                stagedSummary.humanAddedLineCount,
                stagedSummary.unknownAddedLineCount,
                unstagedSummary.aiPercentage,
                unstagedSummary.humanPercentage,
                unstagedSummary.aiAddedLineCount,
                unstagedSummary.humanAddedLineCount,
                unstagedSummary.unknownAddedLineCount
            )
            : stagedSummary.available
            ? String.format(
                java.util.Locale.ROOT,
                "%s: STAGED -> AI %.2f%% | Human %.2f%% | AI lines %d | Human lines %d | Unknown lines %d",
                repoName,
                stagedSummary.aiPercentage,
                stagedSummary.humanPercentage,
                stagedSummary.aiAddedLineCount,
                stagedSummary.humanAddedLineCount,
                stagedSummary.unknownAddedLineCount
            )
            : repoName + ": summary unavailable";
        String unstagedFieldJson = unstagedSummary != null
            ? summaryJson(unstagedSummary)
            : preservedUnstagedFragment;
        String json = "{\n"
            + "  \"schemaVersion\": \"1\",\n"
            + "  \"recordType\": \"hook-summary\",\n"
            + "  \"generatedAt\": \"" + escapeJson(Instant.now().toString()) + "\",\n"
            + "  \"repoRoot\": \"" + escapeJson(repoRoot.toString()) + "\",\n"
            + "  \"repoName\": \"" + escapeJson(repoName) + "\",\n"
            + "  \"isGitSummaryAvailable\": " + available + ",\n"
            + "  \"summaryLine\": \"" + escapeJson(summaryLine) + "\",\n"
            + "  \"staged\": " + summaryJson(stagedSummary)
            + (hasUnstagedSection ? ",\n  \"unstaged\": " + unstagedFieldJson + "\n" : "\n")
            + "}\n";

        writeFileAtomically(summaryPath, json);
    }

    /**
     * Extracts the raw {@code "key": { ... }} value text for a top-level object field from an
     * existing JSON document, by brace-matching rather than parsing, so the preserved section is
     * carried through byte-for-byte. Returns {@code null} if the file or the field is absent or
     * malformed, so a missing/corrupt summary never blocks a write.
     */
    private String readRawJsonFragment(Path jsonPath, String key) {
        String contents;
        try {
            contents = Files.readString(jsonPath, StandardCharsets.UTF_8);
        }
        catch (IOException error) {
            return null;
        }

        String needle = "\"" + key + "\"";
        int keyIndex = contents.indexOf(needle);
        if (keyIndex < 0) {
            return null;
        }

        int braceStart = contents.indexOf('{', keyIndex + needle.length());
        if (braceStart < 0) {
            return null;
        }

        // Tracks whether we are inside a JSON string literal so a brace or backslash that is
        // part of a file path (e.g. an unusual path containing "{") is not mistaken for
        // structure; an unbalanced match here would corrupt the whole document, not just drop
        // the preserved section.
        int depth = 0;
        boolean insideString = false;
        boolean escapeNext = false;
        for (int i = braceStart; i < contents.length(); i++) {
            char character = contents.charAt(i);
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            if (character == '\\' && insideString) {
                escapeNext = true;
                continue;
            }
            if (character == '"') {
                insideString = !insideString;
                continue;
            }
            if (insideString) {
                continue;
            }
            if (character == '{') {
                depth++;
            }
            else if (character == '}') {
                depth--;
                if (depth == 0) {
                    return contents.substring(braceStart, i + 1);
                }
            }
        }
        return null;
    }

    /**
     * Writes via a temp file plus rename so a concurrent reader (the shell hook, or another
     * IDE process) never observes partially written JSON.
     */
    private void writeFileAtomically(Path targetPath, String contents) {
        Path tempPath = targetPath.resolveSibling(
            targetPath.getFileName() + "." + ProcessHandle.current().pid() + "." + System.nanoTime() + ".tmp");
        try {
            Files.createDirectories(targetPath.getParent());
            Files.writeString(tempPath, contents, StandardCharsets.UTF_8);
            Files.move(tempPath, targetPath, StandardCopyOption.REPLACE_EXISTING);
        }
        catch (IOException ignored) {
            // Summary writing is best effort; clean up the temp file so it does not linger.
            try {
                Files.deleteIfExists(tempPath);
            }
            catch (IOException ignoredCleanupFailure) {
                // Nothing more we can do.
            }
        }
    }

    boolean persistPendingCommitAudit(Path repoRoot) {
        Path summaryPath = repoRoot.resolve(METRICS_DIRECTORY).resolve("summary.json");
        Path pendingAuditPath = pendingCommitAuditPath(repoRoot);
        try {
            Files.createDirectories(pendingAuditPath.getParent());
            Files.copy(summaryPath, pendingAuditPath, StandardCopyOption.REPLACE_EXISTING);
            return true;
        }
        catch (IOException error) {
            return false;
        }
    }

    boolean archivePendingCommitAudit(Path repoRoot, String commitHash) {
        Path pendingAuditPath = pendingCommitAuditPath(repoRoot);
        if (!Files.isRegularFile(pendingAuditPath) || commitHash == null || commitHash.isBlank()) {
            return false;
        }
        Path archivedAuditPath = pendingAuditPath.getParent().resolve(commitHash + ".json");
        try {
            Files.move(pendingAuditPath, archivedAuditPath, StandardCopyOption.REPLACE_EXISTING);
            return true;
        }
        catch (IOException error) {
            return false;
        }
    }

    void clearCommittedState(Path repoRoot, Collection<String> committedRepoRelativePaths, Set<String> preservedRepoRelativePaths) {
        for (String repoRelativePath : committedRepoRelativePaths) {
            if (preservedRepoRelativePaths.contains(repoRelativePath)) {
                continue;
            }

            removeState(repoRoot, repoRelativePath);
        }
    }

    void removeState(Path repoRoot, String repoRelativePath) {
        StateKey cacheKey = new StateKey(repoRoot.toAbsolutePath().normalize(), repoRelativePath);
        cachedStates.remove(cacheKey);
        try {
            Files.deleteIfExists(statePath(repoRoot, repoRelativePath));
        }
        catch (IOException ignored) {
            // Metrics cleanup must never block normal commits.
        }
    }

    boolean isTrackingIgnored(Path repoRoot, String repoRelativePath) {
        return metricsIgnoreRules.isIgnored(repoRoot, repoRelativePath);
    }

    private String summaryJson(Ailoc2GitSummary summary) {
        StringBuilder builder = new StringBuilder();
        builder.append("{\n")
            .append("    \"changedFileCount\": ").append(summary.changedFileCount).append(",\n")
            .append("    \"attributedChangedFileCount\": ").append(summary.attributedChangedFileCount).append(",\n")
            .append("    \"aiWeightedChangedLines\": ").append(summary.aiWeightedChangedLines).append(",\n")
            .append("    \"humanWeightedChangedLines\": ").append(summary.humanWeightedChangedLines).append(",\n")
            .append("    \"aiAddedLineCount\": ").append(summary.aiAddedLineCount).append(",\n")
            .append("    \"humanAddedLineCount\": ").append(summary.humanAddedLineCount).append(",\n")
            .append("    \"unknownAddedLineCount\": ").append(summary.unknownAddedLineCount).append(",\n")
            .append("    \"aiPercentage\": ")
            .append(String.format(java.util.Locale.ROOT, "%.6f", summary.aiPercentage))
            .append(",\n")
            .append("    \"humanPercentage\": ")
            .append(String.format(java.util.Locale.ROOT, "%.6f", summary.humanPercentage))
            .append(",\n")
            .append("    \"files\": {");
        boolean first = true;
        for (Map.Entry<String, Ailoc2GitSummary.FileWeights> entry : new TreeMap<>(summary.fileWeights).entrySet()) {
            if (!first) {
                builder.append(',');
            }
            first = false;
            builder.append("\n      \"").append(escapeJson(entry.getKey())).append("\": {")
                .append("\"aiWeightedChangedLines\": ").append(entry.getValue().aiWeightedChangedLines()).append(", ")
                .append("\"humanWeightedChangedLines\": ").append(entry.getValue().humanWeightedChangedLines())
                .append('}');
        }
        if (!summary.fileWeights.isEmpty()) {
            builder.append('\n');
        }
        return builder.append("    }\n  }").toString();
    }

    private Ailoc2FileState readState(Path repoRoot, String repoRelativePath) {
        if (isTrackingIgnored(repoRoot, repoRelativePath)) {
            return new Ailoc2FileState();
        }

        Ailoc2FileState state = new Ailoc2FileState();
        Path statePath = statePath(repoRoot, repoRelativePath);
        if (!Files.isRegularFile(statePath)) {
            return state;
        }

        try {
            for (String line : Files.readAllLines(statePath, StandardCharsets.UTF_8)) {
                String[] parts = line.split("\\t");
                if (parts.length == 2 && "aiMagnitude".equals(parts[0])) {
                    state.setAiMagnitude(Long.parseLong(parts[1]));
                }
                else if (parts.length == 2 && "humanMagnitude".equals(parts[0])) {
                    state.setHumanMagnitude(Long.parseLong(parts[1]));
                }
                else if (parts.length == 2 && "unknownMagnitude".equals(parts[0])) {
                    state.setUnknownMagnitude(Long.parseLong(parts[1]));
                }
                else if (parts.length == 2 && "source".equals(parts[0])) {
                    state.setSource(parts[1]);
                }
                else if (parts.length == 2 && "recordedAt".equals(parts[0])) {
                    state.setRecordedAt(parts[1]);
                }
                else if (parts.length == 3 && "line".equals(parts[0])) {
                    state.setLineBucket(Integer.parseInt(parts[1]), Ailoc2AttributionBucket.valueOf(parts[2]));
                }
            }
        }
        catch (RuntimeException | IOException ignored) {
            return new Ailoc2FileState();
        }
        return state;
    }

    private Path statePath(Path repoRoot, String repoRelativePath) {
        return repoRoot
            .resolve(METRICS_DIRECTORY)
            .resolve("intellij-state")
            .resolve(safeStateFileName(repoRelativePath) + ".tsv");
    }

    private Path pendingCommitAuditPath(Path repoRoot) {
        return repoRoot.resolve(METRICS_DIRECTORY).resolve("commit-audits").resolve("pending.json");
    }

    private String safeStateFileName(String repoRelativePath) {
        return repoRelativePath.replace('\\', '/').replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private String escapeJson(String value) {
        StringBuilder escaped = new StringBuilder(value.length() + 16);
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            switch (character) {
                case '\\' -> escaped.append("\\\\");
                case '"' -> escaped.append("\\\"");
                case '\b' -> escaped.append("\\b");
                case '\f' -> escaped.append("\\f");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    if (character < 0x20) {
                        escaped.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) character));
                    }
                    else {
                        escaped.append(character);
                    }
                }
            }
        }
        return escaped.toString();
    }

    private record StateKey(Path repoRoot, String repoRelativePath) {}
}
