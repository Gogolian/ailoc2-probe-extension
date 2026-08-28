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
 * Integration coverage for the {@code pre-commit} to {@code commit-msg} summary cache.
 *
 * <p>{@code prepare_commit()} (invoked by the generated {@code pre-commit} hook) records the
 * exact index tree it summarized in {@code .ailoc2-metrics/commit-audits/pending.tree}.
 * {@code annotate_commit_message()} (invoked by {@code commit-msg}) reuses that summary only
 * when {@code git write-tree} still matches, and otherwise performs exactly one fresh refresh.
 * Call counting uses {@code GIT_TRACE} to a file rather than a {@code PATH} shim, so it works
 * unmodified on Git for Windows.
 */
class Ailoc2HookRuntimeCacheTest {
    @Test
    void unchangedIndexReusesThePreparedSummaryWithoutARediff(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        Path runtimePath = writeRuntime(repoRoot);

        runRuntime(repoRoot, shell, runtimePath, "prepare-commit");
        assertTrue(Files.exists(pendingTreePath(repoRoot)), "prepare-commit must record the staged tree id");

        long diffCallsDuringPrepare = countGitDiffCachedCalls(repoRoot, shell, runtimePath, "prepare-commit");
        assertTrue(diffCallsDuringPrepare >= 1, "prepare-commit itself must diff at least once");

        Path messagePath = repoRoot.resolve("MSG");
        Files.writeString(messagePath, "Ship it\n", StandardCharsets.UTF_8);
        long diffCallsDuringAnnotate = countGitDiffCachedCalls(
            repoRoot, shell, runtimePath, "annotate-commit-message", messagePath.toString());

        assertEquals(0, diffCallsDuringAnnotate, "an unchanged index must be a cache hit with no re-diff");
        assertEquals(
            "Ship it (AI: 100%)\n\n(AI-Lines: 1/1)\n(Unsure: 1/1)\n",
            Files.readString(messagePath, StandardCharsets.UTF_8)
        );
    }

    @Test
    void indexChangedBetweenHooksCausesExactlyOneFreshRefresh(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("g.ts"), "base2\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "g.ts");
        run(repoRoot, "git", "commit", "-m", "add g");

        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        Path runtimePath = writeRuntime(repoRoot);
        runRuntime(repoRoot, shell, runtimePath, "prepare-commit");

        // Simulates a delegate hook (or another tool) touching the index between pre-commit
        // and commit-msg, which is exactly the scenario the tree-id check must catch.
        Files.writeString(repoRoot.resolve("g.ts"), "base2\nadded2\nadded3\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "g.ts");

        Path messagePath = repoRoot.resolve("MSG");
        Files.writeString(messagePath, "Ship it\n", StandardCharsets.UTF_8);
        long diffCalls = countGitDiffCachedCalls(
            repoRoot, shell, runtimePath, "annotate-commit-message", messagePath.toString());

        assertEquals(1, diffCalls, "a changed index must trigger exactly one fresh refresh, not zero and not more than one");
        String summary = Files.readString(repoRoot.resolve(".ailoc2-metrics/summary.json"), StandardCharsets.UTF_8);
        assertTrue(summary.contains("\"changedFileCount\": 2"), "the refreshed summary must reflect both staged files:\n" + summary);
    }

    @Test
    void staleCacheFromAnAbortedCommitIsNotReusedForDifferentContent(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Path runtimePath = writeRuntime(repoRoot);

        // Attempt 1: stage change A, run pre-commit, then abandon it without committing.
        Files.writeString(repoRoot.resolve("f.ts"), "base\nchangeA\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        runRuntime(repoRoot, shell, runtimePath, "prepare-commit");

        // Attempt 2: unstage, stage a different change B, and go straight to commit-msg
        // without ever re-running pre-commit for it.
        run(repoRoot, "git", "reset", "f.ts");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nchangeB1\nchangeB2\nchangeB3\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");

        Path messagePath = repoRoot.resolve("MSG");
        Files.writeString(messagePath, "Ship it\n", StandardCharsets.UTF_8);
        long diffCalls = countGitDiffCachedCalls(
            repoRoot, shell, runtimePath, "annotate-commit-message", messagePath.toString());

        assertEquals(1, diffCalls, "the stale tree id must not be trusted for unrelated content");
        String summary = Files.readString(repoRoot.resolve(".ailoc2-metrics/summary.json"), StandardCharsets.UTF_8);
        assertTrue(summary.contains("\"aiAddedLineCount\": 3"), "summary must reflect change B (3 lines), not the stale change A:\n" + summary);
    }

    @Test
    void missingPendingTreeFallsBackToASingleFreshRefresh(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        Path runtimePath = writeRuntime(repoRoot);
        // pre-commit is intentionally never run: there is no pending.tree and no summary.json.

        Path messagePath = repoRoot.resolve("MSG");
        Files.writeString(messagePath, "Ship it\n", StandardCharsets.UTF_8);
        long diffCalls = countGitDiffCachedCalls(
            repoRoot, shell, runtimePath, "annotate-commit-message", messagePath.toString());

        assertEquals(1, diffCalls, "a missing cache must fail open to exactly one refresh, not crash and not loop");
        assertEquals(
            "Ship it (AI: 100%)\n\n(AI-Lines: 1/1)\n(Unsure: 1/1)\n",
            Files.readString(messagePath, StandardCharsets.UTF_8)
        );
    }

    @Test
    void corruptPendingCacheFallsBackToASingleFreshRefresh(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        Path runtimePath = writeRuntime(repoRoot);

        Files.createDirectories(pendingTreePath(repoRoot).getParent());
        Files.writeString(pendingTreePath(repoRoot), "not-a-real-tree-id", StandardCharsets.UTF_8);
        Files.writeString(repoRoot.resolve(".ailoc2-metrics/summary.json"), "{ garbage", StandardCharsets.UTF_8);

        Path messagePath = repoRoot.resolve("MSG");
        Files.writeString(messagePath, "Ship it\n", StandardCharsets.UTF_8);
        long diffCalls = countGitDiffCachedCalls(
            repoRoot, shell, runtimePath, "annotate-commit-message", messagePath.toString());

        assertEquals(1, diffCalls, "a corrupt cache must fail open to exactly one refresh, not crash");
        assertEquals(
            "Ship it (AI: 100%)\n\n(AI-Lines: 1/1)\n(Unsure: 1/1)\n",
            Files.readString(messagePath, StandardCharsets.UTF_8)
        );
    }

    @Test
    void finalizeCommitClearsThePendingTreeSoItCannotLeakIntoTheNextCommit(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        initRepo(repoRoot);
        writeAndCommit(repoRoot, "f.ts", "base\n");
        Files.writeString(repoRoot.resolve("f.ts"), "base\nadded1\n", StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", "f.ts");
        Path runtimePath = writeRuntime(repoRoot);
        runRuntime(repoRoot, shell, runtimePath, "prepare-commit");
        assertTrue(Files.exists(pendingTreePath(repoRoot)));

        run(repoRoot, "git", "commit", "-m", "real commit");
        runRuntime(repoRoot, shell, runtimePath, "finalize-commit");

        assertFalse(Files.exists(pendingTreePath(repoRoot)), "the pending tree marker must not survive finalize-commit");
        String commitHash = run(repoRoot, "git", "rev-parse", "HEAD").trim();
        assertTrue(
            Files.exists(repoRoot.resolve(".ailoc2-metrics/commit-audits/" + commitHash + ".json")),
            "the audit must be archived under the actual committed hash"
        );
    }

    private Path pendingTreePath(Path repoRoot) {
        return repoRoot.resolve(".ailoc2-metrics/commit-audits/pending.tree");
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

    /**
     * Runs the runtime with {@code GIT_TRACE} pointed at a temp file and counts the built-in
     * {@code git diff --cached --unified=0 ...} invocation that actually parses the diff for
     * per-line attribution. This is deliberately narrower than matching any {@code diff
     * --cached}, because {@code refresh_summary()} also issues a cheap {@code git diff --cached
     * --quiet} emptiness probe on every call; that probe is not the redundant work Stage 3's
     * cache targets, so counting it would make a correct cache hit look like a miss. Works
     * unmodified on Git for Windows, unlike a {@code PATH}-based wrapper script.
     */
    private long countGitDiffCachedCalls(Path repoRoot, String shell, Path runtimePath, String... args) throws Exception {
        Path tracePath = Files.createTempFile(repoRoot, "git-trace-", ".log");
        Map<String, String> environment = new LinkedHashMap<>();
        environment.put("GIT_TRACE", tracePath.toString());

        String[] command = new String[args.length + 2];
        command[0] = shell;
        command[1] = runtimePath.toString();
        System.arraycopy(args, 0, command, 2, args.length);
        runWithEnvironment(repoRoot, environment, command);

        return Files.readAllLines(tracePath, StandardCharsets.UTF_8).stream()
            .filter(line -> line.contains("git diff --cached --unified=0"))
            .count();
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
