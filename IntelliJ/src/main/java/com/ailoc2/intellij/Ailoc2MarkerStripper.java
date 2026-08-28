package com.ailoc2.intellij;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

/**
 * Removes marker lines from the index and, when it is safe, the
 * working tree — the legacy behavior where markers never reach a commit.
 *
 * <p>Mirrors {@code src/metrics/markerStripping.ts}. Deliberately diverges from the legacy
 * Python implementation, which hardcoded mode {@code 100644} (dropping the executable bit and
 * rewriting symlinks), normalized line endings, and clobbered unstaged edits.
 */
final class Ailoc2MarkerStripper {
    private static final Set<String> REGULAR_FILE_MODES = Set.of("100644", "100755");

    private Ailoc2MarkerStripper() {
    }

    /**
     * @return the repo-relative paths whose staged content was rewritten
     */
    static List<String> stripStagedMarkers(Path repoRoot, List<String> repoRelativePaths) {
        return stripStagedMarkers(repoRoot, repoRelativePaths, Ailoc2MarkerAttribution.Polarity.AI);
    }

    static List<String> stripStagedMarkers(
        Path repoRoot,
        List<String> repoRelativePaths,
        Ailoc2MarkerAttribution.Polarity polarity
    ) {
        List<String> stripped = new ArrayList<>();
        for (String repoRelativePath : repoRelativePaths) {
            if (stripStagedFile(repoRoot, repoRelativePath, polarity)) {
                stripped.add(repoRelativePath);
            }
        }
        return stripped;
    }

    private static boolean stripStagedFile(
        Path repoRoot,
        String repoRelativePath,
        Ailoc2MarkerAttribution.Polarity polarity
    ) {
        String gitPath = repoRelativePath.replace('\\', '/');
        String mode = readIndexMode(repoRoot, gitPath);
        if (mode == null || !REGULAR_FILE_MODES.contains(mode)) {
            return false;
        }

        byte[] stagedContent = runGitBytes(repoRoot, List.of("show", ":" + gitPath), null);
        if (stagedContent == null || containsNul(stagedContent)) {
            return false;
        }

        byte[] cleaned = stripMarkerLinesPreservingBytes(stagedContent, polarity);
        if (Arrays.equals(cleaned, stagedContent)) {
            return false;
        }

        byte[] hashOutput = runGitBytes(repoRoot, List.of("hash-object", "-w", "--stdin"), cleaned);
        if (hashOutput == null) {
            return false;
        }

        String blobOid = new String(hashOutput, StandardCharsets.UTF_8).strip();
        if (blobOid.isEmpty()) {
            return false;
        }

        if (runGitBytes(repoRoot, List.of("update-index", "--cacheinfo", mode + "," + blobOid + "," + gitPath), null) == null) {
            return false;
        }

        // Only rewrite the working tree when it still matches the pre-strip index content,
        // otherwise unstaged edits would be silently clobbered.
        Path absolutePath = repoRoot.resolve(repoRelativePath);
        try {
            if (Arrays.equals(Files.readAllBytes(absolutePath), stagedContent)) {
                Files.write(absolutePath, cleaned);
            }
        }
        catch (IOException ignored) {
            // A missing or unreadable working-tree file leaves the index change in place.
        }

        return true;
    }

    /**
     * Keeps each line's own terminator so CRLF files and files without a trailing newline
     * round-trip unchanged.
     */
    static byte[] stripMarkerLinesPreservingBytes(byte[] content) {
        return stripMarkerLinesPreservingBytes(content, Ailoc2MarkerAttribution.Polarity.AI);
    }

    static byte[] stripMarkerLinesPreservingBytes(byte[] content, Ailoc2MarkerAttribution.Polarity polarity) {
        ByteArrayOutputStream kept = new ByteArrayOutputStream(content.length);
        int lineStart = 0;
        for (int index = 0; index < content.length; index++) {
            if (content[index] != '\n') {
                continue;
            }

            int lineEnd = index + 1;
            appendUnlessMarker(kept, content, lineStart, lineEnd, polarity);
            lineStart = lineEnd;
        }

        if (lineStart < content.length) {
            appendUnlessMarker(kept, content, lineStart, content.length, polarity);
        }

        return kept.toByteArray();
    }

    private static void appendUnlessMarker(
        ByteArrayOutputStream target,
        byte[] content,
        int start,
        int end,
        Ailoc2MarkerAttribution.Polarity polarity
    ) {
        String line = new String(content, start, end - start, StandardCharsets.UTF_8);
        if (Ailoc2MarkerAttribution.isMarkerLine(line, polarity)) {
            return;
        }
        target.write(content, start, end - start);
    }

    private static boolean containsNul(byte[] content) {
        for (byte value : content) {
            if (value == 0) {
                return true;
            }
        }
        return false;
    }

    private static String readIndexMode(Path repoRoot, String gitPath) {
        byte[] output = runGitBytes(repoRoot, List.of("ls-files", "--stage", "--", gitPath), null);
        if (output == null) {
            return null;
        }

        String text = new String(output, StandardCharsets.UTF_8);
        int newlineIndex = text.indexOf('\n');
        String firstLine = newlineIndex >= 0 ? text.substring(0, newlineIndex) : text;
        String[] fields = firstLine.strip().split("\\s+");
        return fields.length > 0 && !fields[0].isEmpty() ? fields[0] : null;
    }

    private static byte[] runGitBytes(Path repoRoot, List<String> args, byte[] input) {
        List<String> command = new ArrayList<>();
        command.add("git");
        command.addAll(args);

        try {
            ProcessBuilder processBuilder = new ProcessBuilder(command)
                .directory(repoRoot.toFile())
                .redirectErrorStream(false);
            Process process = processBuilder.start();

            if (input != null) {
                try (OutputStream stdin = process.getOutputStream()) {
                    stdin.write(input);
                }
            }
            else {
                process.getOutputStream().close();
            }

            byte[] stdout;
            try (InputStream stream = process.getInputStream()) {
                stdout = stream.readAllBytes();
            }
            process.getErrorStream().close();

            return process.waitFor() == 0 ? stdout : null;
        }
        catch (IOException error) {
            return null;
        }
        catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return null;
        }
    }
}
