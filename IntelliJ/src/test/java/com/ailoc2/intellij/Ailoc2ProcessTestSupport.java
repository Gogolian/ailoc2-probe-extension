package com.ailoc2.intellij;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Shared process-invocation helper for the hook runtime integration tests.
 *
 * <p>On this environment, Git for Windows occasionally leaves a grandchild {@code git.exe}
 * running after its parent {@code sh.exe} has already exited. A plain {@code
 * process.getInputStream().readAllBytes()} blocks forever in that case, because the pipe is not
 * closed until every process holding a handle to it exits. Reading the stream on a background
 * thread with a bounded wait, and forcibly destroying the process tree on timeout, keeps one
 * stuck grandchild from hanging the rest of the test run.
 */
final class Ailoc2ProcessTestSupport {
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(30);

    private Ailoc2ProcessTestSupport() {
    }

    static String run(Path directory, String... command) throws Exception {
        return runWithEnvironment(directory, Map.of(), command);
    }

    static String runWithEnvironment(Path directory, Map<String, String> environment, String... command) throws Exception {
        ProcessBuilder processBuilder = new ProcessBuilder(command)
            .directory(directory.toFile())
            .redirectErrorStream(true);
        processBuilder.environment().putAll(environment);
        Process process = processBuilder.start();

        CompletableFuture<String> outputFuture = CompletableFuture.supplyAsync(() -> readAll(process.getInputStream()));

        boolean exitedInTime;
        try {
            exitedInTime = process.waitFor(DEFAULT_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        }
        catch (InterruptedException error) {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw error;
        }

        if (!exitedInTime) {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
            throw new AssertionError(
                String.join(" ", command) + " did not exit within " + DEFAULT_TIMEOUT
                    + "; a lingering child process likely kept its output pipe open"
            );
        }

        String output;
        try {
            output = outputFuture.get(5, TimeUnit.SECONDS);
        }
        catch (TimeoutException error) {
            // The process itself exited, but something still holds the pipe open (the known
            // lingering-grandchild case). The exit code below is still meaningful.
            output = "<output unavailable: pipe still open after process exit>";
        }

        int exitCode = process.exitValue();
        if (exitCode != 0) {
            throw new AssertionError(String.join(" ", command) + " failed with " + exitCode + ":\n" + output);
        }
        return output;
    }

    static Path writeRuntime(Path repoRoot) throws IOException {
        Path runtimePath = repoRoot.resolve("ailoc2-intellij-hook-runtime.sh");
        Files.writeString(runtimePath, new Ailoc2HookManager().createManagedRuntimeScript(), StandardCharsets.UTF_8);
        return runtimePath;
    }

    static void runRuntime(Path repoRoot, String shell, Path runtimePath, String... args) throws Exception {
        String[] command = new String[args.length + 2];
        command[0] = shell;
        command[1] = runtimePath.toString();
        System.arraycopy(args, 0, command, 2, args.length);
        run(repoRoot, command);
    }

    static void initRepo(Path repoRoot) throws Exception {
        run(repoRoot, "git", "init");
        run(repoRoot, "git", "config", "user.name", "AILoc2 Test");
        run(repoRoot, "git", "config", "user.email", "ailoc2@example.invalid");
        run(repoRoot, "git", "config", "core.autocrlf", "false");
    }

    static void writeAndCommit(Path repoRoot, String fileName, String contents) throws Exception {
        Files.writeString(repoRoot.resolve(fileName), contents, StandardCharsets.UTF_8);
        run(repoRoot, "git", "add", fileName);
        run(repoRoot, "git", "commit", "-m", "add " + fileName);
    }

    static String findShell() {
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

    private static boolean canRun(String... command) {
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

    private static String readAll(InputStream stream) {
        try {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
        catch (IOException error) {
            return "<failed to read process output: " + error.getMessage() + ">";
        }
    }
}
