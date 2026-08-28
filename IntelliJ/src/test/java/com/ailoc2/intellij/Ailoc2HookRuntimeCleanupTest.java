package com.ailoc2.intellij;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Coverage for post-commit cleanup: {@code clear_committed_state()} batching its Git calls to a
 * constant count independent of the number of committed files, and {@code refresh_summary()}'s
 * fast path for an empty staged diff.
 */
class Ailoc2HookRuntimeCleanupTest {
    @Test
    void gitCallCountDuringCleanupIsConstantRegardlessOfFileCount(@TempDir Path smallRepo, @TempDir Path largeRepo) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");

        long smallRepoCalls = commitFilesAndCountCleanupGitCalls(smallRepo, shell, 1);
        long largeRepoCalls = commitFilesAndCountCleanupGitCalls(largeRepo, shell, 10);

        assertEquals(smallRepoCalls, largeRepoCalls,
            "the number of Git invocations during cleanup must not scale with the number of committed files");
    }

    @Test
    void fullyCommittedFileWithNoFurtherWorkHasItsStateRemoved(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "f.ts", "aiMagnitude\t1\nhumanMagnitude\t0\nunknownMagnitude\t0\n");
        run(repoRoot, "git", "add", "f.ts");
        run(repoRoot, "git", "commit", "-m", "change f");

        runRuntime(repoRoot, shell, writeRuntime(repoRoot), "finalize-commit");

        assertFalse(Files.exists(statePath(repoRoot, "f.ts")), "a fully committed file with no remaining work must lose its state");
    }

    @Test
    void partiallyCommittedFileKeepsItsStateWhenUnstagedWorkRemains(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "a\nb\nc\n");

        Files.writeString(repoRoot.resolve("f.ts"), "a_changed\nb\nc\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        // Further, still-unstaged edit to the same file after staging.
        Files.writeString(repoRoot.resolve("f.ts"), "a_changed\nb_unstaged\nc\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "f.ts", "aiMagnitude\t1\nhumanMagnitude\t0\nunknownMagnitude\t0\n");
        run(repoRoot, "git", "commit", "-m", "commit a_changed only");

        runRuntime(repoRoot, shell, writeRuntime(repoRoot), "finalize-commit");

        assertTrue(Files.exists(statePath(repoRoot, "f.ts")), "a file with remaining unstaged work must keep its state");
    }

    @Test
    void unrelatedUntrackedFileDoesNotPreventCleanupOfACommittedFile(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "a.ts", "a\n");

        Files.writeString(repoRoot.resolve("a.ts"), "a\nadded\n", StandardCharsets.UTF_8);
        writeTsv(repoRoot, "a.ts", "aiMagnitude\t1\nhumanMagnitude\t0\nunknownMagnitude\t0\n");
        run(repoRoot, "git", "add", "a.ts");
        Files.writeString(repoRoot.resolve("untracked.ts"), "untracked stuff\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "commit", "-m", "commit a fully");

        runRuntime(repoRoot, shell, writeRuntime(repoRoot), "finalize-commit");

        assertFalse(Files.exists(statePath(repoRoot, "a.ts")), "an unrelated untracked file must not preserve a's state");
    }

    @Test
    void emptyStagedDiffUsesTheFastPathAndProducesTheSameSchema(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Path runtimePath = writeRuntime(repoRoot);

        long diffCalls = countGitCallsMatching(repoRoot, shell, runtimePath, "diff --cached --unified=0", "refresh-summary");

        assertEquals(0, diffCalls, "an empty staged diff must skip the full diff-and-parse path entirely");
        String summary = Files.readString(repoRoot.resolve(".ailoc2-metrics/summary.json"), StandardCharsets.UTF_8);
        assertTrue(summary.contains("\"changedFileCount\": 0"));
        assertTrue(summary.contains("\"isGitSummaryAvailable\": true"));
        assertTrue(summary.contains("\"files\": {}"));
    }

    @Test
    void whitespaceOnlyStagedDiffAlsoUsesTheFastPath(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "line1\n");
        Files.writeString(repoRoot.resolve("f.ts"), "line1  \n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        Path runtimePath = writeRuntime(repoRoot);

        runRuntime(repoRoot, shell, runtimePath, "refresh-summary");

        String summary = Files.readString(repoRoot.resolve(".ailoc2-metrics/summary.json"), StandardCharsets.UTF_8);
        assertTrue(summary.contains("\"changedFileCount\": 0"),
            "a whitespace-only diff must be treated as empty, matching --ignore-all-space used elsewhere");
    }

    @Test
    void nonEmptyDiffIsUnaffectedByTheFastPathCheck(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        Path runtimePath = writeRuntime(repoRoot);

        runRuntime(repoRoot, shell, runtimePath, "refresh-summary");

        String summary = Files.readString(repoRoot.resolve(".ailoc2-metrics/summary.json"), StandardCharsets.UTF_8);
        assertTrue(summary.contains("\"changedFileCount\": 1"));
        assertTrue(summary.contains("\"aiAddedLineCount\": 1"));
    }

    private long commitFilesAndCountCleanupGitCalls(Path repoRoot, String shell, int fileCount) throws Exception {
        initRepo(repoRoot);
        for (int i = 1; i <= fileCount; i++) {
            Files.writeString(repoRoot.resolve("f" + i + ".ts"), "base" + i + "\n", StandardCharsets.UTF_8);
        }
        run(repoRoot, addArgsFor(fileCount, "f%d.ts"));
        run(repoRoot, "git", "commit", "-m", "init");

        for (int i = 1; i <= fileCount; i++) {
            Files.writeString(repoRoot.resolve("f" + i + ".ts"), "base" + i + "\nadded" + i + "\n", StandardCharsets.UTF_8);
            writeTsv(repoRoot, "f" + i + ".ts", "aiMagnitude\t1\nhumanMagnitude\t0\nunknownMagnitude\t0\n");
        }
        run(repoRoot, addArgsFor(fileCount, "f%d.ts"));
        run(repoRoot, "git", "commit", "-m", "change " + fileCount + " files");

        Path tracePath = Files.createTempFile(repoRoot, "git-trace-", ".log");
        Map<String, String> environment = new LinkedHashMap<>();
        environment.put("GIT_TRACE", tracePath.toString());
        runWithEnvironment(repoRoot, environment, shell, writeRuntime(repoRoot).toString(), "finalize-commit");

        return Files.readAllLines(tracePath, StandardCharsets.UTF_8).stream()
            .filter(line -> line.contains("trace: built-in: git "))
            .count();
    }

    private String[] addArgsFor(int fileCount, String pattern) {
        String[] args = new String[fileCount + 2];
        args[0] = "git";
        args[1] = "add";
        for (int i = 1; i <= fileCount; i++) {
            args[i + 1] = String.format(pattern, i);
        }
        return args;
    }

    private long countGitCallsMatching(Path repoRoot, String shell, Path runtimePath, String needle, String... args) throws Exception {
        Path tracePath = Files.createTempFile(repoRoot, "git-trace-", ".log");
        Map<String, String> environment = new LinkedHashMap<>();
        environment.put("GIT_TRACE", tracePath.toString());
        String[] command = new String[args.length + 2];
        command[0] = shell;
        command[1] = runtimePath.toString();
        System.arraycopy(args, 0, command, 2, args.length);
        runWithEnvironment(repoRoot, environment, command);

        return Files.readAllLines(tracePath, StandardCharsets.UTF_8).stream()
            .filter(line -> line.contains(needle))
            .count();
    }

    private Path statePath(Path repoRoot, String repoRelativePath) {
        String stateFileName = repoRelativePath.replace('\\', '/').replaceAll("[^A-Za-z0-9._-]", "_") + ".tsv";
        return repoRoot.resolve(".ailoc2-metrics/intellij-state").resolve(stateFileName);
    }

    private void writeTsv(Path repoRoot, String repoRelativePath, String contents) throws IOException {
        Path statePath = statePath(repoRoot, repoRelativePath);
        Files.createDirectories(statePath.getParent());
        Files.writeString(statePath, contents, StandardCharsets.UTF_8);
    }

    private Path writeRuntime(Path repoRoot) throws IOException {
        Path runtimePath = repoRoot.resolve("ailoc2-intellij-hook-runtime.sh");
        Files.writeString(runtimePath, new Ailoc2HookManager().createManagedRuntimeScript(), StandardCharsets.UTF_8);
        return runtimePath;
    }

    private void runRuntime(Path repoRoot, String shell, Path runtimePath, String... args) throws Exception {
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

    private String runWithEnvironment(Path directory, Map<String, String> environment, String... command) throws Exception {
        return Ailoc2ProcessTestSupport.runWithEnvironment(directory, environment, command);
    }

    private String findShell() {
        return Ailoc2ProcessTestSupport.findShell();
    }
}
