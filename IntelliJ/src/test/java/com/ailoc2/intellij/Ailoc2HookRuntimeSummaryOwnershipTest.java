package com.ailoc2.intellij;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The generated shell runtime only ever computes {@code staged}; the IntelliJ plugin process is
 * the one that adds {@code unstaged} to the same {@code summary.json}. Before this fix, every
 * write from the shell hook silently dropped whatever {@code unstaged} section was already on
 * disk. These tests pin that the hook now preserves it, on both the fast (empty diff) and full
 * (parsed diff) write paths, and that writes go through a temp-file-plus-rename so no reader
 * ever observes a half-written file.
 */
class Ailoc2HookRuntimeSummaryOwnershipTest {
    private static final String SEEDED_UNSTAGED_SECTION = """
        {
          "schemaVersion": "1",
          "recordType": "hook-summary",
          "generatedAt": "2026-01-01T00:00:00Z",
          "repoRoot": "SEEDED",
          "repoName": "SEEDED",
          "isGitSummaryAvailable": true,
          "summaryLine": "SEEDED",
          "staged": { "changedFileCount": 0, "files": {} },
          "unstaged": {
            "changedFileCount": 1,
            "attributedChangedFileCount": 1,
            "aiWeightedChangedLines": 3,
            "humanWeightedChangedLines": 3,
            "aiAddedLineCount": 1,
            "humanAddedLineCount": 1,
            "unknownAddedLineCount": 0,
            "aiPercentage": 50.000000,
            "humanPercentage": 50.000000,
            "files": { "z.ts": {"aiWeightedChangedLines": 3, "humanWeightedChangedLines": 3} }
          }
        }
        """;

    @Test
    void fullParseRefreshPreservesAnExistingUnstagedSection(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        seedSummary(repoRoot);

        runRuntime(repoRoot, shell, "refresh-summary");

        String summary = Files.readString(summaryPath(repoRoot), StandardCharsets.UTF_8);
        assertTrue(summary.contains("\"unstaged\""), "the unstaged section must survive a staged-only refresh");
        assertTrue(summary.contains("\"z.ts\""), "the preserved unstaged per-file detail must be intact");
        assertTrue(summary.contains("\"aiAddedLineCount\": 1"), "staged must be recomputed from the real diff");
    }

    @Test
    void emptyDiffFastPathAlsoPreservesAnExistingUnstagedSection(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        // Nothing staged, so refresh_summary() takes the empty-diff fast path.
        seedSummary(repoRoot);

        runRuntime(repoRoot, shell, "refresh-summary");

        String summary = Files.readString(summaryPath(repoRoot), StandardCharsets.UTF_8);
        assertTrue(summary.contains("\"unstaged\""), "the fast path must not drop the unstaged section either");
        assertTrue(summary.contains("\"changedFileCount\": 0"));
    }

    @Test
    void missingPriorSummaryProducesNoUnstagedSection(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        // No summary.json exists yet, so there is nothing to preserve.

        runRuntime(repoRoot, shell, "refresh-summary");

        String summary = Files.readString(summaryPath(repoRoot), StandardCharsets.UTF_8);
        assertFalse(summary.contains("\"unstaged\""), "there is nothing to preserve when no prior summary exists");
    }

    @Test
    void annotateCommitMessageReadsStagedCountsUnaffectedByAPresentUnstagedSection(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\nadded2\nadded3\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        // Seed with deliberately different (999) unstaged counts to catch any accidental
        // cross-read between the two sections.
        Files.createDirectories(repoRoot.resolve(".ailoc2-metrics"));
        Files.writeString(summaryPath(repoRoot), """
            { "unstaged": { "aiAddedLineCount": 999, "humanAddedLineCount": 999, "unknownAddedLineCount": 999 } }
            """, StandardCharsets.UTF_8);

        Path messagePath = repoRoot.resolve("MSG");
        Files.writeString(messagePath, "Ship it\n", StandardCharsets.UTF_8);
        runRuntime(repoRoot, shell, "annotate-commit-message", messagePath.toString());

        assertEquals(
            "Ship it (AI: 100%)\n\n(AI-Lines: 3/3)\n(Unsure: 3/3)\n",
            Files.readString(messagePath, StandardCharsets.UTF_8)
        );
    }

    @Test
    void noTemporaryFilesAreLeftBehindAfterRepeatedWrites(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");

        for (int i = 0; i < 3; i++) {
            runRuntime(repoRoot, shell, "refresh-summary");
        }

        try (Stream<Path> metricsFiles = Files.walk(repoRoot.resolve(".ailoc2-metrics"))) {
            long leftoverTempFiles = metricsFiles.filter(path -> path.toString().endsWith(".tmp")).count();
            assertEquals(0, leftoverTempFiles, "an atomic write must never leave a .tmp file behind on success");
        }
    }

    private void seedSummary(Path repoRoot) throws IOException {
        Files.createDirectories(repoRoot.resolve(".ailoc2-metrics"));
        Files.writeString(summaryPath(repoRoot), SEEDED_UNSTAGED_SECTION, StandardCharsets.UTF_8);
    }

    private Path summaryPath(Path repoRoot) {
        return repoRoot.resolve(".ailoc2-metrics/summary.json");
    }

    private void runRuntime(Path repoRoot, String shell, String... args) throws Exception {
        Path runtimePath = repoRoot.resolve("ailoc2-intellij-hook-runtime.sh");
        Files.writeString(runtimePath, new Ailoc2HookManager().createManagedRuntimeScript(), StandardCharsets.UTF_8);
        String[] command = new String[args.length + 2];
        command[0] = shell;
        command[1] = runtimePath.toString();
        System.arraycopy(args, 0, command, 2, args.length);
        run(repoRoot, command);
    }

    private void initRepo(Path repoRoot) throws Exception {
        Ailoc2ProcessTestSupport.initRepo(repoRoot);
    }

    private void writeAndCommit(Path repoRoot, String fileName, String contents) throws Exception {
        Ailoc2ProcessTestSupport.writeAndCommit(repoRoot, fileName, contents);
    }

    private String run(Path directory, String... command) throws Exception {
        return Ailoc2ProcessTestSupport.run(directory, command);
    }

    private String findShell() {
        return Ailoc2ProcessTestSupport.findShell();
    }
}
