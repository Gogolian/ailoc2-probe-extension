package com.ailoc2.intellij;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Reads the two-layer probe configuration: a committed {@code .ailoc2-probe.json} carrying
 * team policy plus an optional gitignored {@code .ailoc2-metrics/config.json} override.
 *
 * <p>Mirrors {@code src/metrics/probeConfig.ts}; the two must stay in agreement or the IDE
 * and the terminal will report different percentages for the same commit.
 */
final class Ailoc2ProbeConfig {
    static final String REPO_CONFIG_FILE_NAME = ".ailoc2-probe.json";
    static final String METRICS_DIRECTORY = ".ailoc2-metrics";
    static final String LOCAL_CONFIG_FILE_NAME = "config.json";

    static final String MODE_SIGNALS = "signals";
    static final String MODE_MARKERS = "markers";

    private static final Map<Path, CachedConfig> cachedConfigByRepoRoot = new ConcurrentHashMap<>();

    private final String mode;
    private final boolean largeFileIsAi;
    private final boolean newFileIsAi;
    private final List<String> excludePaths;
    private final List<Ailoc2MetricsIgnoreRules.CompiledRule> excludeRules;

    private Ailoc2ProbeConfig(String mode, boolean largeFileIsAi, boolean newFileIsAi, List<String> excludePaths) {
        this.mode = mode;
        this.largeFileIsAi = largeFileIsAi;
        this.newFileIsAi = newFileIsAi;
        this.excludePaths = List.copyOf(excludePaths);
        List<Ailoc2MetricsIgnoreRules.CompiledRule> rules = new ArrayList<>();
        for (String pattern : excludePaths) {
            Ailoc2MetricsIgnoreRules.CompiledRule rule = Ailoc2MetricsIgnoreRules.compileRule(pattern);
            if (rule != null) {
                rules.add(rule);
            }
        }
        this.excludeRules = List.copyOf(rules);
    }

    static Ailoc2ProbeConfig defaults() {
        return new Ailoc2ProbeConfig(MODE_SIGNALS, true, true, List.of());
    }

    static Ailoc2ProbeConfig read(Path repoRoot) {
        Path normalizedRepoRoot = repoRoot.toAbsolutePath().normalize();
        Path repoConfigPath = normalizedRepoRoot.resolve(REPO_CONFIG_FILE_NAME);
        Path localConfigPath = normalizedRepoRoot.resolve(METRICS_DIRECTORY).resolve(LOCAL_CONFIG_FILE_NAME);
        String signature = fileSignature(repoConfigPath) + "|" + fileSignature(localConfigPath);

        CachedConfig cached = cachedConfigByRepoRoot.get(normalizedRepoRoot);
        if (cached != null && cached.signature.equals(signature)) {
            return cached.config;
        }

        Ailoc2ProbeConfig config = merge(readLayer(repoConfigPath), readLayer(localConfigPath));
        cachedConfigByRepoRoot.put(normalizedRepoRoot, new CachedConfig(signature, config));
        return config;
    }

    static void invalidate(Path repoRoot) {
        cachedConfigByRepoRoot.remove(repoRoot.toAbsolutePath().normalize());
    }

    String mode() {
        return mode;
    }

    boolean isMarkerMode() {
        return MODE_MARKERS.equals(mode);
    }

    boolean largeFileIsAi() {
        return largeFileIsAi;
    }

    boolean newFileIsAi() {
        return newFileIsAi;
    }

    List<String> excludePaths() {
        return excludePaths;
    }

    boolean isAttributionExcluded(String repoRelativePath) {
        String normalizedPath = Ailoc2MetricsIgnoreRules.normalizeRepoRelativePath(repoRelativePath);
        if (normalizedPath.isEmpty()) {
            return false;
        }

        boolean excluded = false;
        for (Ailoc2MetricsIgnoreRules.CompiledRule rule : excludeRules) {
            if (rule.pattern().matcher(normalizedPath).matches()) {
                excluded = !rule.negate();
            }
        }
        return excluded;
    }

    /**
     * Builds the extended regular expression of excluded paths for the generated shell hook.
     * Returns an empty string when nothing is excluded, since awk treats an empty pattern as
     * matching every line.
     */
    String toExcludeExtendedRegex() {
        return toExtendedRegex(false);
    }

    /**
     * Companion to {@link #toExcludeExtendedRegex()} carrying the {@code !negated} patterns.
     * A single positive regex cannot express last-match-wins re-inclusion, so the hook checks
     * this second pattern to decide whether an excluded path is pulled back in.
     */
    String toReincludeExtendedRegex() {
        return toExtendedRegex(true);
    }

    private String toExtendedRegex(boolean negated) {
        List<String> patterns = new ArrayList<>();
        for (String pattern : excludePaths) {
            if (pattern.isBlank() || pattern.startsWith("#")) {
                continue;
            }

            String normalized = pattern.trim();
            boolean isNegated = normalized.startsWith("!");
            if (isNegated) {
                normalized = normalized.substring(1);
            }
            if (isNegated != negated) {
                continue;
            }

            boolean anchored = normalized.startsWith("/");
            if (anchored) {
                normalized = normalized.substring(1);
            }
            normalized = normalized.replace('\\', '/').replaceFirst("^\\./+", "").replaceFirst("/+$", "");
            if (normalized.isEmpty()) {
                continue;
            }

            patterns.add((anchored ? "" : "(.*/)?")
                + globToExtendedRegexSource(normalized)
                + "(/.*)?");
        }

        if (patterns.isEmpty()) {
            return "";
        }

        return "^(" + String.join("|", patterns) + ")$";
    }

    /**
     * Glob to POSIX ERE. Literal characters are wrapped in bracket expressions rather than
     * backslash-escaped, because awk rejects escapes like {@code \.} in a dynamic regex with a
     * warning and then treats them as "any character", which would over-match.
     */
    private static String globToExtendedRegexSource(String pattern) {
        StringBuilder source = new StringBuilder(pattern.length() * 3);
        for (int index = 0; index < pattern.length(); index++) {
            char character = pattern.charAt(index);
            char nextCharacter = index + 1 < pattern.length() ? pattern.charAt(index + 1) : '\0';

            if (character == '\\') {
                if (nextCharacter != '\0') {
                    source.append(bracketEscape(nextCharacter));
                    index++;
                }
                continue;
            }

            if (character == '*') {
                if (nextCharacter == '*') {
                    source.append(".*");
                    index++;
                }
                else {
                    source.append("[^/]*");
                }
                continue;
            }

            if (character == '?') {
                source.append("[^/]");
                continue;
            }

            if (character == '[') {
                int closingBracketIndex = pattern.indexOf(']', index + 1);
                if (closingBracketIndex > index + 1) {
                    String characterClass = pattern.substring(index + 1, closingBracketIndex);
                    if (characterClass.startsWith("!")) {
                        characterClass = "^" + characterClass.substring(1);
                    }
                    source.append('[').append(characterClass).append(']');
                    index = closingBracketIndex;
                    continue;
                }
            }

            source.append(bracketEscape(character));
        }
        return source.toString();
    }

    private static String bracketEscape(char value) {
        return switch (value) {
            case '.', '[', '$', '(', ')', '|', '*', '+', '?', '{', '}', '^' -> "[" + value + "]";
            case ']' -> "[]]";
            case '\\' -> "[\\]";
            default -> Character.toString(value);
        };
    }

    /**
     * Team-then-local concatenation rather than replacement, so a local layer can re-include
     * a team-excluded path with {@code !pattern} under last-match-wins.
     */
    private static Ailoc2ProbeConfig merge(JsonObject repoLayer, JsonObject localLayer) {
        Ailoc2ProbeConfig defaults = defaults();
        JsonObject repoAttribution = readObject(repoLayer, "attribution");
        JsonObject localAttribution = readObject(localLayer, "attribution");

        List<String> excludePaths = new ArrayList<>();
        excludePaths.addAll(readStringArray(repoAttribution, "excludePaths"));
        excludePaths.addAll(readStringArray(localAttribution, "excludePaths"));

        String mode = firstNonNull(
            readMode(localAttribution),
            readMode(repoAttribution),
            defaults.mode);
        boolean largeFileIsAi = firstNonNull(
            readBoolean(localAttribution, "largeFileIsAI"),
            readBoolean(repoAttribution, "largeFileIsAI"),
            defaults.largeFileIsAi);
        boolean newFileIsAi = firstNonNull(
            readBoolean(localAttribution, "newFileIsAI"),
            readBoolean(repoAttribution, "newFileIsAI"),
            defaults.newFileIsAi);

        return new Ailoc2ProbeConfig(mode, largeFileIsAi, newFileIsAi, excludePaths);
    }

    private static JsonObject readLayer(Path filePath) {
        try {
            String contents = Files.readString(filePath, StandardCharsets.UTF_8);
            JsonElement parsed = JsonParser.parseString(contents);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        }
        catch (IOException | RuntimeException ignored) {
            // Malformed or absent config must never break a commit; fall back to defaults.
            return null;
        }
    }

    private static String fileSignature(Path filePath) {
        try {
            return Files.getLastModifiedTime(filePath).toMillis() + ":" + Files.size(filePath);
        }
        catch (IOException ignored) {
            return "missing";
        }
    }

    private static JsonObject readObject(JsonObject parent, String key) {
        if (parent == null || !parent.has(key)) {
            return null;
        }

        JsonElement value = parent.get(key);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }

    private static String readMode(JsonObject attribution) {
        if (attribution == null || !attribution.has("mode")) {
            return null;
        }

        JsonElement value = attribution.get("mode");
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            return null;
        }

        String mode = value.getAsString();
        return MODE_SIGNALS.equals(mode) || MODE_MARKERS.equals(mode) ? mode : null;
    }

    private static Boolean readBoolean(JsonObject attribution, String key) {
        if (attribution == null || !attribution.has(key)) {
            return null;
        }

        JsonElement value = attribution.get(key);
        if (value == null || !value.isJsonPrimitive()) {
            return null;
        }

        JsonPrimitive primitive = value.getAsJsonPrimitive();
        return primitive.isBoolean() ? primitive.getAsBoolean() : null;
    }

    private static List<String> readStringArray(JsonObject attribution, String key) {
        if (attribution == null || !attribution.has(key)) {
            return List.of();
        }

        JsonElement value = attribution.get(key);
        if (value == null || !value.isJsonArray()) {
            return List.of();
        }

        List<String> entries = new ArrayList<>();
        for (JsonElement entry : value.getAsJsonArray()) {
            if (entry != null && entry.isJsonPrimitive() && entry.getAsJsonPrimitive().isString()) {
                entries.add(entry.getAsString());
            }
        }
        return entries;
    }

    private static <T> T firstNonNull(T first, T second, T fallback) {
        if (first != null) {
            return first;
        }
        return second != null ? second : fallback;
    }

    static String toJson(Ailoc2ProbeConfig config) {
        StringBuilder excludeJson = new StringBuilder();
        for (int index = 0; index < config.excludePaths.size(); index++) {
            if (index > 0) {
                excludeJson.append(",\n      ");
            }
            excludeJson.append('"').append(config.excludePaths.get(index).replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
        }

        return "{\n"
            + "  \"version\": 1,\n"
            + "  \"attribution\": {\n"
            + "    \"mode\": \"" + config.mode + "\",\n"
            + "    \"largeFileIsAI\": " + config.largeFileIsAi + ",\n"
            + "    \"newFileIsAI\": " + config.newFileIsAi + ",\n"
            + "    \"excludePaths\": ["
            + (config.excludePaths.isEmpty() ? "]" : "\n      " + excludeJson + "\n    ]")
            + "\n  }\n"
            + "}\n";
    }

    Ailoc2ProbeConfig withMode(String nextMode) {
        return new Ailoc2ProbeConfig(nextMode, largeFileIsAi, newFileIsAi, excludePaths);
    }

    Ailoc2ProbeConfig withLargeFileIsAi(boolean nextLargeFileIsAi) {
        return new Ailoc2ProbeConfig(mode, nextLargeFileIsAi, newFileIsAi, excludePaths);
    }

    Ailoc2ProbeConfig withNewFileIsAi(boolean nextNewFileIsAi) {
        return new Ailoc2ProbeConfig(mode, largeFileIsAi, nextNewFileIsAi, excludePaths);
    }

    private record CachedConfig(String signature, Ailoc2ProbeConfig config) {}
}
