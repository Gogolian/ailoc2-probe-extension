package com.ailoc2.intellij;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The IntelliJ checkin handler calls {@code writeSummary(repoRoot, stagedSummary)} — the
 * single-argument overload — at commit time, which must not clobber whatever {@code unstaged}
 * section a prior {@code refreshRepoSummary()} call wrote to the same {@code summary.json}.
 */
class Ailoc2StorageTest {
    @Test
    void stagedOnlyWritePreservesAPreviouslyWrittenUnstagedSection(@TempDir Path repoRoot) throws Exception {
        Ailoc2Storage storage = new Ailoc2Storage();
        Ailoc2GitSummary staged = new Ailoc2GitSummary(1, 1, 10L, 0L, 1, 0, 0, true, Map.of());
        Ailoc2GitSummary unstaged = new Ailoc2GitSummary(2, 2, 5L, 5L, 1, 1, 0, true, Map.of());

        storage.writeSummary(repoRoot, staged, unstaged);
        String afterFullWrite = readSummary(repoRoot);
        assertTrue(afterFullWrite.contains("\"unstaged\""));

        Ailoc2GitSummary newStaged = new Ailoc2GitSummary(9, 9, 99L, 0L, 9, 0, 0, true, Map.of());
        storage.writeSummary(repoRoot, newStaged);

        String afterStagedOnlyWrite = readSummary(repoRoot);
        assertTrue(afterStagedOnlyWrite.contains("\"unstaged\""), "the unstaged section must survive a staged-only write");
        assertTrue(afterStagedOnlyWrite.contains("\"changedFileCount\": 2"), "the preserved unstaged content must be unchanged");
        assertTrue(afterStagedOnlyWrite.contains("\"aiAddedLineCount\": 9"), "the staged section must reflect the new write");
    }

    @Test
    void stagedOnlyWriteWithNoPriorSummaryProducesNoUnstagedSection(@TempDir Path repoRoot) {
        Ailoc2Storage storage = new Ailoc2Storage();
        Ailoc2GitSummary staged = new Ailoc2GitSummary(1, 1, 10L, 0L, 1, 0, 0, true, Map.of());

        storage.writeSummary(repoRoot, staged);

        String summary = readSummary(repoRoot);
        assertFalse(summary.contains("\"unstaged\""), "there is nothing to preserve when no summary.json exists yet");
    }

    @Test
    void fullWriteReplacesAnyPreviouslyPreservedUnstagedSection(@TempDir Path repoRoot) {
        Ailoc2Storage storage = new Ailoc2Storage();
        storage.writeSummary(repoRoot,
            new Ailoc2GitSummary(1, 1, 10L, 0L, 1, 0, 0, true, Map.of()),
            new Ailoc2GitSummary(2, 2, 5L, 5L, 1, 1, 0, true, Map.of()));

        // An explicit two-argument call always supersedes whatever unstaged data existed.
        storage.writeSummary(repoRoot,
            new Ailoc2GitSummary(3, 3, 1L, 0L, 1, 0, 0, true, Map.of()),
            new Ailoc2GitSummary(4, 4, 1L, 0L, 1, 0, 0, true, Map.of()));

        String summary = readSummary(repoRoot);
        assertTrue(summary.contains("\"changedFileCount\": 3"));
    }

    @Test
    void writesAreAtomicAndLeaveNoTemporaryFile(@TempDir Path repoRoot) throws Exception {
        Ailoc2Storage storage = new Ailoc2Storage();
        for (int i = 0; i < 5; i++) {
            storage.writeSummary(repoRoot, new Ailoc2GitSummary(i, i, i, 0L, i, 0, 0, true, Map.of()));
        }

        try (Stream<Path> metricsFiles = Files.walk(repoRoot.resolve(".ailoc2-metrics"))) {
            long leftoverTempFiles = metricsFiles.filter(path -> path.toString().endsWith(".tmp")).count();
            assertEquals(0, leftoverTempFiles);
        }
    }

    @Test
    void malformedExistingSummaryDoesNotBreakTheNextWrite(@TempDir Path repoRoot) throws Exception {
        Files.createDirectories(repoRoot.resolve(".ailoc2-metrics"));
        Files.writeString(repoRoot.resolve(".ailoc2-metrics/summary.json"), "{ this is not valid json", StandardCharsets.UTF_8);

        Ailoc2Storage storage = new Ailoc2Storage();
        storage.writeSummary(repoRoot, new Ailoc2GitSummary(1, 1, 1L, 0L, 1, 0, 0, true, Map.of()));

        String summary = readSummary(repoRoot);
        assertFalse(summary.contains("\"unstaged\""));
        assertTrue(summary.contains("\"changedFileCount\": 1"));
    }

    private String readSummary(Path repoRoot) {
        try {
            return Files.readString(repoRoot.resolve(".ailoc2-metrics/summary.json"), StandardCharsets.UTF_8);
        }
        catch (Exception error) {
            throw new AssertionError(error);
        }
    }
}
