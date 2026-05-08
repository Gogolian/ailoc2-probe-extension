package com.ailoc2.intellij;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

final class Ailoc2MetricsIgnoreRules {
    private static final String METRICS_DIRECTORY = ".ailoc2-metrics";
    private static final String IGNORE_FILE_NAME = ".ignore";
    private final Map<Path, CachedRules> cachedRulesByRepoRoot = new ConcurrentHashMap<>();

    boolean isIgnored(Path repoRoot, String repoRelativePath) {
        String normalizedPath = normalizeRepoRelativePath(repoRelativePath);
        if (normalizedPath.isEmpty()) {
            return false;
        }

        boolean ignored = false;
        for (CompiledRule rule : readRules(repoRoot)) {
            if (rule.pattern.matcher(normalizedPath).matches()) {
                ignored = !rule.negate;
            }
        }
        return ignored;
    }

    private List<CompiledRule> readRules(Path repoRoot) {
        Path normalizedRepoRoot = repoRoot.toAbsolutePath().normalize();
        Path ignorePath = normalizedRepoRoot.resolve(METRICS_DIRECTORY).resolve(IGNORE_FILE_NAME);
        try {
            String signature = Files.getLastModifiedTime(ignorePath).toMillis() + ":" + Files.size(ignorePath);
            CachedRules cachedRules = cachedRulesByRepoRoot.get(normalizedRepoRoot);
            if (cachedRules != null && cachedRules.signature.equals(signature)) {
                return cachedRules.rules;
            }

            List<CompiledRule> rules = new ArrayList<>();
            for (String line : Files.readAllLines(ignorePath, StandardCharsets.UTF_8)) {
                CompiledRule compiledRule = compileRule(line);
                if (compiledRule != null) {
                    rules.add(compiledRule);
                }
            }

            cachedRulesByRepoRoot.put(normalizedRepoRoot, new CachedRules(signature, List.copyOf(rules)));
            return rules;
        }
        catch (IOException ignored) {
            CachedRules cachedRules = cachedRulesByRepoRoot.get(normalizedRepoRoot);
            if (cachedRules != null && "missing".equals(cachedRules.signature)) {
                return cachedRules.rules;
            }

            List<CompiledRule> emptyRules = List.of();
            cachedRulesByRepoRoot.put(normalizedRepoRoot, new CachedRules("missing", emptyRules));
            return emptyRules;
        }
    }

    private CompiledRule compileRule(String line) {
        if (line.trim().isEmpty()) {
            return null;
        }

        String pattern = line;
        if (pattern.startsWith("#")) {
            return null;
        }

        boolean negate = false;
        if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
            pattern = pattern.substring(1);
        }
        else if (pattern.startsWith("!")) {
            negate = true;
            pattern = pattern.substring(1);
        }

        pattern = pattern.trim();
        if (pattern.isEmpty()) {
            return null;
        }

        boolean anchored = pattern.startsWith("/");
        if (anchored) {
            pattern = pattern.substring(1);
        }

        String normalizedPattern = pattern
            .replace('\\', '/')
            .replaceFirst("^\\./+", "")
            .replaceFirst("/+$", "");
        if (normalizedPattern.isEmpty()) {
            return null;
        }

        String regex = (anchored ? "^" : "^(?:.*/)?")
            + globToRegexSource(normalizedPattern)
            + "(?:/.*)?$";
        try {
            return new CompiledRule(negate, Pattern.compile(regex));
        }
        catch (PatternSyntaxException ignored) {
            return null;
        }
    }

    private String globToRegexSource(String pattern) {
        StringBuilder source = new StringBuilder(pattern.length() * 2);
        for (int index = 0; index < pattern.length(); index++) {
            char character = pattern.charAt(index);
            char nextCharacter = index + 1 < pattern.length() ? pattern.charAt(index + 1) : '\0';
            if (character == '\\') {
                if (nextCharacter != '\0') {
                    source.append(escapeRegexCharacter(nextCharacter));
                    index++;
                }
                else {
                    source.append("\\\\");
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

            source.append(escapeRegexCharacter(character));
        }
        return source.toString();
    }

    private String normalizeRepoRelativePath(String repoRelativePath) {
        return repoRelativePath
            .replace('\\', '/')
            .replaceFirst("^/+", "")
            .replaceFirst("^\\./", "")
            .replaceFirst("/+$", "");
    }

    private String escapeRegexCharacter(char value) {
        return switch (value) {
            case '|', '\\', '{', '}', '(', ')', '[', ']', '^', '$', '+', '?', '.' -> "\\" + value;
            default -> Character.toString(value);
        };
    }

    private record CachedRules(String signature, List<CompiledRule> rules) {}

    private record CompiledRule(boolean negate, Pattern pattern) {}
}
