package com.ailoc2.intellij;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Collection;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

final class Ailoc2Storage {
    private static final String METRICS_DIRECTORY = ".ailoc2-metrics";
    private final Map<StateKey, Ailoc2FileState> cachedStates = new ConcurrentHashMap<>();

    Ailoc2FileState stateFor(Path repoRoot, String repoRelativePath) {
        StateKey cacheKey = new StateKey(repoRoot.toAbsolutePath().normalize(), repoRelativePath);
        return cachedStates.computeIfAbsent(cacheKey, ignored -> readState(repoRoot, repoRelativePath));
    }

    void persistState(Path repoRoot, String repoRelativePath, Ailoc2FileState state) {
        Path statePath = statePath(repoRoot, repoRelativePath);
        StringBuilder builder = new StringBuilder();
        builder.append("# AILoc2 IntelliJ rolling state v1\n");
        builder.append("aiMagnitude\t").append(state.getAiMagnitude()).append('\n');
        builder.append("humanMagnitude\t").append(state.getHumanMagnitude()).append('\n');
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

    void writeSummary(Path repoRoot, Ailoc2GitSummary stagedSummary) {
        writeSummary(repoRoot, stagedSummary, null);
    }

    void writeSummary(Path repoRoot, Ailoc2GitSummary stagedSummary, Ailoc2GitSummary unstagedSummary) {
        Path summaryPath = repoRoot.resolve(METRICS_DIRECTORY).resolve("summary.json");
        String repoName = repoRoot.getFileName() == null ? repoRoot.toString() : repoRoot.getFileName().toString();
        boolean available = stagedSummary.available && (unstagedSummary == null || unstagedSummary.available);
        String summaryLine = available && unstagedSummary != null
            ? String.format(
                java.util.Locale.ROOT,
                "%s: STAGED -> AI %.2f%% | Human %.2f%% ; UNSTAGED -> AI %.2f%% | Human %.2f%%",
                repoName,
                stagedSummary.aiPercentage,
                stagedSummary.humanPercentage,
                unstagedSummary.aiPercentage,
                unstagedSummary.humanPercentage
            )
            : stagedSummary.available
            ? String.format("%s: STAGED -> AI %.2f%% | Human %.2f%%", repoName, stagedSummary.aiPercentage, stagedSummary.humanPercentage)
            : repoName + ": summary unavailable";
        String json = "{\n"
            + "  \"schemaVersion\": 1,\n"
            + "  \"recordType\": \"intellij-hook-summary\",\n"
            + "  \"generatedAt\": \"" + escapeJson(Instant.now().toString()) + "\",\n"
            + "  \"repoRoot\": \"" + escapeJson(repoRoot.toString()) + "\",\n"
            + "  \"repoName\": \"" + escapeJson(repoName) + "\",\n"
            + "  \"isGitSummaryAvailable\": " + available + ",\n"
            + "  \"summaryLine\": \"" + escapeJson(summaryLine) + "\",\n"
            + "  \"staged\": " + summaryJson(stagedSummary)
            + (unstagedSummary == null ? "\n" : ",\n  \"unstaged\": " + summaryJson(unstagedSummary) + "\n")
            + "}\n";

        try {
            Files.createDirectories(summaryPath.getParent());
            Files.writeString(summaryPath, json, StandardCharsets.UTF_8);
        }
        catch (IOException ignored) {
            // Summary writing is best effort.
        }
    }

    void clearCommittedState(Path repoRoot, Collection<String> committedRepoRelativePaths, Set<String> preservedRepoRelativePaths) {
        for (String repoRelativePath : committedRepoRelativePaths) {
            if (preservedRepoRelativePaths.contains(repoRelativePath)) {
                continue;
            }

            StateKey cacheKey = new StateKey(repoRoot.toAbsolutePath().normalize(), repoRelativePath);
            cachedStates.remove(cacheKey);
            try {
                Files.deleteIfExists(statePath(repoRoot, repoRelativePath));
            }
            catch (IOException ignored) {
                // Metrics cleanup must never block normal commits.
            }
        }
    }

    private String summaryJson(Ailoc2GitSummary summary) {
        return "{\n"
            + "    \"changedFileCount\": " + summary.changedFileCount + ",\n"
            + "    \"attributedChangedFileCount\": " + summary.attributedChangedFileCount + ",\n"
            + "    \"aiWeightedChangedLines\": " + summary.aiWeightedChangedLines + ",\n"
            + "    \"humanWeightedChangedLines\": " + summary.humanWeightedChangedLines + ",\n"
            + "    \"aiPercentage\": " + String.format(java.util.Locale.ROOT, "%.6f", summary.aiPercentage) + ",\n"
            + "    \"humanPercentage\": " + String.format(java.util.Locale.ROOT, "%.6f", summary.humanPercentage) + "\n"
            + "  }";
    }

    private Ailoc2FileState readState(Path repoRoot, String repoRelativePath) {
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
