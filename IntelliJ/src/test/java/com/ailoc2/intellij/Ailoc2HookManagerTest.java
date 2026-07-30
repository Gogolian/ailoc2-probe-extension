package com.ailoc2.intellij;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class Ailoc2HookManagerTest {
    @Test
    void generatedHooksContainTheAiLinesBodyContract() {
        Ailoc2HookManager manager = new Ailoc2HookManager();

        String commitMsgHook = manager.createManagedCommitMsgHookScript();
        String runtime = manager.createManagedRuntimeScript();

        assertTrue(commitMsgHook.contains("(AI-Lines: unavailable)"));
        assertTrue(commitMsgHook.contains("(AI: unavailable)"));
        assertTrue(commitMsgHook.contains("(Unsure: unavailable)"));
        assertTrue(commitMsgHook.contains("append_placeholder_annotation"));
        assertTrue(commitMsgHook.contains("AI-Lines: [^)]*"));
        assertTrue(runtime.contains("\"aiAddedLineCount\""));
        assertTrue(runtime.contains("\"humanAddedLineCount\""));
        assertTrue(runtime.contains("\"unknownAddedLineCount\""));
        assertTrue(runtime.contains("(AI-Lines: $AI_LINE_COUNT/$TOTAL_LINE_COUNT)"));
        assertTrue(runtime.contains("(AI: $AI_LINE_PERCENTAGE%)"));
        assertTrue(runtime.contains("(Unsure: $UNKNOWN_LINE_COUNT/$AI_LINE_COUNT)"));
    }

    @Test
    void installedClaudeHooksIncludeBashFallbacks(@TempDir Path workspaceRoot) throws Exception {
        Ailoc2HookManager manager = new Ailoc2HookManager();

        manager.installWorkspaceClaudeHooks(workspaceRoot);

        String settings = Files.readString(workspaceRoot.resolve(".claude/settings.json"), StandardCharsets.UTF_8);
        assertTrue(settings.contains("\"matcher\": \"Write|Edit|MultiEdit|Bash\""));
    }

    @Test
    void commitMsgHookWritesFallbackToBodyWhenRuntimeIsMissing(@TempDir Path directory) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated hook smoke test");
        Path hookPath = directory.resolve("commit-msg");
        Files.writeString(
            hookPath,
            new Ailoc2HookManager().createManagedCommitMsgHookScript(),
            StandardCharsets.UTF_8
        );
        Path messagePath = directory.resolve("COMMIT_EDITMSG");
        Files.writeString(
            messagePath,
            "Ship it (AI: 10.00%) (AI lines: 1) (H lines: 9)\n\nBody\n",
            StandardCharsets.UTF_8
        );

        run(directory, shell, hookPath.toString(), messagePath.toString());

        assertEquals(
            "Ship it (AI: unavailable)\n\n(AI-Lines: unavailable)\n(Unsure: unavailable)\n\nBody\n",
            Files.readString(messagePath, StandardCharsets.UTF_8)
        );
    }

    @Test
    void runtimeAppendPlaceholderWritesFallbackToSubjectAndBody(@TempDir Path directory) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        Path runtimePath = directory.resolve("ailoc2-intellij-hook-runtime.sh");
        Files.writeString(
            runtimePath,
            new Ailoc2HookManager().createManagedRuntimeScript(),
            StandardCharsets.UTF_8
        );
        Path messagePath = directory.resolve("COMMIT_EDITMSG");
        Files.writeString(messagePath, "Ship it (AI: 42%)\n\nBody\n", StandardCharsets.UTF_8);

        run(directory, shell, runtimePath.toString(), "append-placeholder", messagePath.toString());

        assertEquals(
            "Ship it (AI: unavailable)\n\n(AI-Lines: unavailable)\n(Unsure: unavailable)\n\nBody\n",
            Files.readString(messagePath, StandardCharsets.UTF_8)
        );
    }

    @Test
    void runtimeAnnotatesFromTheStagedDiff(@TempDir Path repoRoot) throws Exception {
        String shell = findShell();
        Assumptions.assumeTrue(shell != null, "A POSIX shell is required for the generated runtime smoke test");
        run(repoRoot, "git", "init");
        run(repoRoot, "git", "config", "user.name", "AILoc2 Test");
        run(repoRoot, "git", "config", "user.email", "ailoc2@example.com");

        Path sourceDirectory = repoRoot.resolve("src");
        Files.createDirectories(sourceDirectory);
        for (String fileName : new String[]{"ai.ts", "human.ts", "unknown.ts", "missing.ts"}) {
            Files.writeString(sourceDirectory.resolve(fileName), "const value = \"base\";\n", StandardCharsets.UTF_8);
        }
        run(repoRoot, "git", "add", "src/ai.ts", "src/human.ts", "src/unknown.ts", "src/missing.ts");
        run(repoRoot, "git", "commit", "-m", "initial");

        for (String fileName : new String[]{"ai.ts", "human.ts", "unknown.ts", "missing.ts"}) {
            Files.writeString(sourceDirectory.resolve(fileName), "const value = \"next\";\n", StandardCharsets.UTF_8);
        }
        writeState(repoRoot, "src/ai.ts", "AI", 10L, 0L);
        writeState(repoRoot, "src/human.ts", "HUMAN", 0L, 10L);
        writeState(repoRoot, "src/unknown.ts", "UNKNOWN", 0L, 0L);
        run(repoRoot, "git", "add", "src/ai.ts", "src/human.ts", "src/unknown.ts", "src/missing.ts");

        Path runtimePath = repoRoot.resolve("ailoc2-intellij-hook-runtime.sh");
        Files.writeString(runtimePath, new Ailoc2HookManager().createManagedRuntimeScript(), StandardCharsets.UTF_8);
        Path messagePath = repoRoot.resolve("COMMIT_EDITMSG");
        Files.writeString(messagePath, "Ship it (AI: 1.00%)\n\nBody\n", StandardCharsets.UTF_8);

        run(repoRoot, shell, runtimePath.toString(), "annotate-commit-message", messagePath.toString());

        assertEquals(
            "Ship it (AI: 75%)\n\n(AI-Lines: 3/4)\n(Unsure: 2/3)\n\nBody\n",
            Files.readString(messagePath, StandardCharsets.UTF_8)
        );
        String summary = Files.readString(repoRoot.resolve(".ailoc2-metrics/summary.json"), StandardCharsets.UTF_8);
        assertTrue(summary.contains("\"aiWeightedChangedLines\": 54"));
        assertTrue(summary.contains("\"humanWeightedChangedLines\": 18"));
        assertTrue(summary.contains("\"aiAddedLineCount\": 3"));
        assertTrue(summary.contains("\"humanAddedLineCount\": 1"));
        assertTrue(summary.contains("\"unknownAddedLineCount\": 2"));
        assertTrue(summary.contains("\"aiPercentage\": 75.000000"));
        assertTrue(summary.contains("\"src/missing.ts\": {\"aiWeightedChangedLines\": 18, \"humanWeightedChangedLines\": 0}"));
    }

    private void writeState(Path repoRoot, String repoRelativePath, String bucket, long aiMagnitude, long humanMagnitude) throws IOException {
        String stateFileName = repoRelativePath.replace('\\', '/').replaceAll("[^A-Za-z0-9._-]", "_") + ".tsv";
        Path statePath = repoRoot.resolve(".ailoc2-metrics/intellij-state").resolve(stateFileName);
        Files.createDirectories(statePath.getParent());
        Files.writeString(
            statePath,
            "source\tINTELLIJ\n"
                + "recordedAt\t2026-07-23T00:00:00Z\n"
                + "aiMagnitude\t" + aiMagnitude + "\n"
                + "humanMagnitude\t" + humanMagnitude + "\n"
                + "line\t1\t" + bucket + "\n",
            StandardCharsets.UTF_8
        );
    }

    private String run(Path directory, String... command) throws Exception {
        Process process = new ProcessBuilder(command)
            .directory(directory.toFile())
            .redirectErrorStream(true)
            .start();
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new AssertionError(String.join(" ", command) + " failed with " + exitCode + ":\n" + output);
        }
        return output;
    }

    private String findShell() {
        if (canRun("sh", "-c", "exit 0")) {
            return "sh";
        }

        try {
            Process whereGit = new ProcessBuilder("where.exe", "git").redirectErrorStream(true).start();
            String firstGitPath = new String(whereGit.getInputStream().readAllBytes(), StandardCharsets.UTF_8)
                .lines()
                .findFirst()
                .orElse("")
                .trim();
            if (whereGit.waitFor() != 0 || firstGitPath.isEmpty()) {
                return null;
            }
            Path gitDirectory = Path.of(firstGitPath).getParent().getParent();
            Path gitShell = gitDirectory.resolve("bin/sh.exe");
            return Files.isRegularFile(gitShell) ? gitShell.toString() : null;
        }
        catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return null;
        }
    }

    private boolean canRun(String... command) {
        try {
            return new ProcessBuilder(command).start().waitFor() == 0;
        }
        catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return false;
        }
    }
}
