package com.ailoc2.intellij;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * Regression coverage for the lazy per-path TSV loader in the generated runtime.
 *
 * <p>The old {@code bucket_for()} rescanned the whole state file for every added line, giving
 * {@code O(D + Sum(A_p * S_p))} for a refresh. The current version loads each path's state at
 * most once, guarded by {@code loaded[path]}, giving {@code O(D + Sum(S_p))}. These tests pin
 * the observable behavior across that change and add a deterministic single-open assertion,
 * because a wall-clock threshold alone is machine-dependent and would not reliably catch a
 * reintroduced quadratic scan on small inputs.
 */
class Ailoc2HookRuntimePerformanceTest {
    @Test
    void explicitLineBucketWinsOverMagnitudeFallback(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\nadded2\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "f.ts", """
            aiMagnitude\t100
            humanMagnitude\t100
            unknownMagnitude\t0
            line\t2\tHUMAN
            """);
        run(repoRoot, "git", "add", "f.ts");

        Staged staged = refreshAndReadStaged(repoRoot, shell);

        // added1 (line 2) has an explicit HUMAN record; added2 (line 3) falls back to a tied
        // magnitude, which resolves to UNKNOWN and is folded into the AI counters.
        assertEquals(1, staged.aiAddedLineCount);
        assertEquals(1, staged.humanAddedLineCount);
        assertEquals(1, staged.unknownAddedLineCount);
    }

    @Test
    void allZeroMagnitudeIsUnknown(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "f.ts", "aiMagnitude\t0\nhumanMagnitude\t0\nunknownMagnitude\t0\n");
        run(repoRoot, "git", "add", "f.ts");

        Staged staged = refreshAndReadStaged(repoRoot, shell);

        assertEquals(1, staged.aiAddedLineCount);
        assertEquals(0, staged.humanAddedLineCount);
        assertEquals(1, staged.unknownAddedLineCount);
    }

    @Test
    void missingTsvIsUnknown(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");

        Staged staged = refreshAndReadStaged(repoRoot, shell);

        assertEquals(1, staged.aiAddedLineCount);
        assertEquals(1, staged.unknownAddedLineCount);
    }

    @Test
    void duplicateLineRecordKeepsLastOneWins(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "f.ts", """
            aiMagnitude\t0
            humanMagnitude\t0
            unknownMagnitude\t0
            line\t2\tAI
            line\t2\tHUMAN
            """);
        run(repoRoot, "git", "add", "f.ts");

        Staged staged = refreshAndReadStaged(repoRoot, shell);

        assertEquals(0, staged.aiAddedLineCount);
        assertEquals(1, staged.humanAddedLineCount);
    }

    @Test
    void whitespaceOnlyAdditionDoesNotAffectCounters(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\n   \nadded1\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "f.ts", "aiMagnitude\t50\nhumanMagnitude\t10\nunknownMagnitude\t0\n");
        run(repoRoot, "git", "add", "f.ts");

        Staged staged = refreshAndReadStaged(repoRoot, shell);

        assertEquals(1, staged.aiAddedLineCount);
        assertEquals(0, staged.humanAddedLineCount);
        assertEquals(0, staged.unknownAddedLineCount);
    }

    @Test
    void multipleHunksResolveCorrectNewLineNumbers(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        StringBuilder original = new StringBuilder();
        for (int i = 0; i < 10; i++) {
            original.append("line").append(i).append('\n');
        }
        writeAndCommit(repoRoot, "f.ts", original.toString());

        List<String> lines = new java.util.ArrayList<>(List.of(original.toString().split("\n")));
        lines.set(1, "CHANGED_TOP");
        lines.add(8, "INSERTED_BOTTOM");
        Files.writeString(repoRoot.resolve("f.ts"), String.join("\n", lines) + "\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "f.ts", "aiMagnitude\t0\nhumanMagnitude\t0\nunknownMagnitude\t0\nline\t2\tAI\nline\t9\tHUMAN\n");
        run(repoRoot, "git", "add", "f.ts");

        Staged staged = refreshAndReadStaged(repoRoot, shell);

        assertEquals(1, staged.aiAddedLineCount);
        assertEquals(1, staged.humanAddedLineCount);
    }

    @Test
    void multipleFilesEachUseTheirOwnState(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "a.ts", "a\n");
        Files.writeString(repoRoot.resolve("b.ts"), "b\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "b.ts");
        run(repoRoot, "git", "commit", "-m", "add b");

        Files.writeString(repoRoot.resolve("a.ts"), "a\nadded_a\n", StandardCharsets.UTF_8);
        Files.writeString(repoRoot.resolve("b.ts"), "b\nadded_b\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "a.ts", "aiMagnitude\t0\nhumanMagnitude\t0\nunknownMagnitude\t0\nline\t2\tAI\n");
        writeTsv(repoRoot, "b.ts", "aiMagnitude\t0\nhumanMagnitude\t0\nunknownMagnitude\t0\nline\t2\tHUMAN\n");
        run(repoRoot, "git", "add", "a.ts", "b.ts");

        Staged staged = refreshAndReadStaged(repoRoot, shell);

        assertEquals(1, staged.aiAddedLineCount);
        assertEquals(1, staged.humanAddedLineCount);
    }

    /**
     * Instruments a copy of the generated runtime to print a marker every time {@code
     * load_state()} completes for a path, then asserts each referenced path is loaded exactly
     * once even though the diff touches it on many lines. This is the deterministic guard the
     * plan requires in place of a machine-dependent wall-clock threshold.
     */
    @Test
    void eachStateFileIsLoadedAtMostOncePerRefresh(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);

        StringBuilder base = new StringBuilder();
        for (int i = 0; i < 60; i++) {
            base.append("line").append(i).append('\n');
        }
        writeAndCommit(repoRoot, "big.ts", base.toString());

        StringBuilder updated = new StringBuilder(base);
        for (int i = 0; i < 60; i++) {
            updated.append("generated").append(i).append('\n');
        }
        Files.writeString(repoRoot.resolve("big.ts"), updated.toString(), StandardCharsets.UTF_8);

        StringBuilder tsv = new StringBuilder("aiMagnitude\t0\nhumanMagnitude\t0\nunknownMagnitude\t0\n");
        for (int lineNumber = 61; lineNumber <= 120; lineNumber++) {
            tsv.append("line\t").append(lineNumber).append("\tAI\n");
        }
        writeTsv(repoRoot, "big.ts", tsv.toString());
        run(repoRoot, "git", "add", "big.ts");

        String instrumented = new Ailoc2HookManager().createManagedRuntimeScript()
            .replace("loaded[path] = 1", "loaded[path] = 1; print \"LOADED:\" path > \"/dev/stderr\"");
        Path runtimePath = repoRoot.resolve("instrumented-runtime.sh");
        Files.writeString(runtimePath, instrumented, StandardCharsets.UTF_8);

        Process process = new ProcessBuilder(shell, runtimePath.toString(), "refresh-summary")
            .directory(repoRoot.toFile())
            .start();
        String stderr = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
        process.getInputStream().readAllBytes();
        process.waitFor();

        List<String> loadMarkers = stderr.lines()
            .filter(line -> line.startsWith("LOADED:"))
            .collect(Collectors.toList());
        assertEquals(List.of("LOADED:big.ts"), loadMarkers, "big.ts must be loaded exactly once despite 60 added lines referencing it");
    }

    /**
     * A file whose only addition has zero non-whitespace weight must never trigger a state
     * load at all, not just avoid repeating it.
     */
    @Test
    void whitespaceOnlyFileNeverLoadsState(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\n   \n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");

        String instrumented = new Ailoc2HookManager().createManagedRuntimeScript()
            .replace("loaded[path] = 1", "loaded[path] = 1; print \"LOADED:\" path > \"/dev/stderr\"");
        Path runtimePath = repoRoot.resolve("instrumented-runtime.sh");
        Files.writeString(runtimePath, instrumented, StandardCharsets.UTF_8);

        Process process = new ProcessBuilder(shell, runtimePath.toString(), "refresh-summary")
            .directory(repoRoot.toFile())
            .start();
        String stderr = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
        process.getInputStream().readAllBytes();
        process.waitFor();

        assertFalse(stderr.contains("LOADED:"), "a whitespace-only addition must not trigger any state load");
    }

    private void initRepo(Path repoRoot) throws Exception {
        Ailoc2ProcessTestSupport.initRepo(repoRoot);
    }

    private void writeAndCommit(Path repoRoot, String fileName, String contents) throws Exception {
        Ailoc2ProcessTestSupport.writeAndCommit(repoRoot, fileName, contents);
    }

    private void writeTsv(Path repoRoot, String repoRelativePath, String contents) throws IOException {
        String stateFileName = repoRelativePath.replace('\\', '/').replaceAll("[^A-Za-z0-9._-]", "_") + ".tsv";
        Path statePath = repoRoot.resolve(".ailoc2-metrics/intellij-state").resolve(stateFileName);
        Files.createDirectories(statePath.getParent());
        Files.writeString(statePath, contents, StandardCharsets.UTF_8);
    }

    private Staged refreshAndReadStaged(Path repoRoot, String shell) throws Exception {
        Path runtimePath = repoRoot.resolve("ailoc2-intellij-hook-runtime.sh");
        Files.writeString(runtimePath, new Ailoc2HookManager().createManagedRuntimeScript(), StandardCharsets.UTF_8);
        run(repoRoot, shell, runtimePath.toString(), "refresh-summary");
        String summary = Files.readString(repoRoot.resolve(".ailoc2-metrics/summary.json"), StandardCharsets.UTF_8);
        return Staged.parse(summary);
    }

    private String run(Path directory, String... command) throws Exception {
        return Ailoc2ProcessTestSupport.run(directory, command);
    }

    private String findShell() {
        return Ailoc2ProcessTestSupport.findShell();
    }

    /**
     * Minimal hand-rolled JSON field extraction, matching the style already used by
     * {@code Ailoc2HookManagerTest} rather than adding a JSON parser dependency.
     */
    private record Staged(int aiAddedLineCount, int humanAddedLineCount, int unknownAddedLineCount) {
        static Staged parse(String summaryJson) {
            return new Staged(
                extractInt(summaryJson, "aiAddedLineCount"),
                extractInt(summaryJson, "humanAddedLineCount"),
                extractInt(summaryJson, "unknownAddedLineCount")
            );
        }

        private static int extractInt(String json, String key) {
            java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("\"" + key + "\"\\s*:\\s*(\\d+)")
                .matcher(json);
            if (!matcher.find()) {
                throw new AssertionError("Missing key " + key + " in summary JSON:\n" + json);
            }
            return Integer.parseInt(matcher.group(1));
        }
    }
}
