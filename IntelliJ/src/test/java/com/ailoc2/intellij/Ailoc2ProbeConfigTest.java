package com.ailoc2.intellij;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class Ailoc2ProbeConfigTest {
    @Test
    void defaultsPreserveExistingBehavior(@TempDir Path repoRoot) {
        Ailoc2ProbeConfig.invalidate(repoRoot);

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);

        assertEquals(Ailoc2ProbeConfig.MODE_SIGNALS, config.mode());
        assertTrue(config.largeFileIsAi());
        assertTrue(config.newFileIsAi());
        assertFalse(config.isAttributionExcluded("src/app.ts"));
    }

    @Test
    void localLayerOverridesTeamPolicyPerLeaf(@TempDir Path repoRoot) throws IOException {
        writeRepoLayer(repoRoot, """
            { "attribution": { "mode": "signals", "largeFileIsAI": false, "newFileIsAI": false } }
            """);
        writeLocalLayer(repoRoot, """
            { "attribution": { "mode": "markers" } }
            """);

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);

        assertTrue(config.isMarkerMode());
        assertFalse(config.largeFileIsAi(), "unspecified leaves still come from team policy");
        assertFalse(config.newFileIsAi());
    }

    @Test
    void excludePathsConcatenateSoLocalCanReinclude(@TempDir Path repoRoot) throws IOException {
        writeRepoLayer(repoRoot, """
            { "attribution": { "excludePaths": ["vendor/**", "*.generated.ts"] } }
            """);
        writeLocalLayer(repoRoot, """
            { "attribution": { "excludePaths": ["!vendor/keep.js"] } }
            """);

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);

        assertTrue(config.isAttributionExcluded("vendor/lib/a.js"));
        assertFalse(config.isAttributionExcluded("vendor/keep.js"), "local negation re-includes");
        assertTrue(config.isAttributionExcluded("src/api.generated.ts"));
        assertFalse(config.isAttributionExcluded("src/api.ts"));
    }

    @Test
    void malformedJsonFallsBackToDefaults(@TempDir Path repoRoot) throws IOException {
        writeRepoLayer(repoRoot, "{ this is not json");

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);

        assertEquals(Ailoc2ProbeConfig.MODE_SIGNALS, config.mode());
        assertTrue(config.largeFileIsAi());
    }

    @Test
    void humanMarkersModeMapsToHumanPolarity(@TempDir Path repoRoot) throws IOException {
        writeRepoLayer(repoRoot, """
            { "attribution": { "mode": "human-markers" } }
            """);

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);

        assertEquals(Ailoc2ProbeConfig.MODE_HUMAN_MARKERS, config.mode());
        assertTrue(config.isMarkerMode());
        assertEquals(Ailoc2MarkerAttribution.Polarity.HUMAN, config.markerPolarity());
    }

    @Test
    void aiMarkersModeMapsToAiPolarity(@TempDir Path repoRoot) throws IOException {
        writeRepoLayer(repoRoot, """
            { "attribution": { "mode": "markers" } }
            """);

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);

        assertTrue(config.isMarkerMode());
        assertEquals(Ailoc2MarkerAttribution.Polarity.AI, config.markerPolarity());
    }

    @Test
    void signalsModeIsNotAMarkerMode(@TempDir Path repoRoot) {
        Ailoc2ProbeConfig.invalidate(repoRoot);

        assertFalse(Ailoc2ProbeConfig.read(repoRoot).isMarkerMode());
    }

    @Test
    void unknownModeIsRejected(@TempDir Path repoRoot) throws IOException {
        writeRepoLayer(repoRoot, """
            { "attribution": { "mode": "wat", "largeFileIsAI": "yes" } }
            """);

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);

        assertEquals(Ailoc2ProbeConfig.MODE_SIGNALS, config.mode());
        assertTrue(config.largeFileIsAi(), "a non-boolean value is not trusted");
    }

    /**
     * awk rejects escapes like {@code \\.} in a dynamic regex and then treats them as "any
     * character", so literals must be emitted as bracket expressions instead.
     */
    @Test
    void extendedRegexAvoidsBackslashEscapesForAwk(@TempDir Path repoRoot) throws IOException {
        writeRepoLayer(repoRoot, """
            { "attribution": { "excludePaths": ["vendor/**", "*.generated.ts", "!vendor/keep.js"] } }
            """);

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);
        String excludeRegex = config.toExcludeExtendedRegex();
        String reincludeRegex = config.toReincludeExtendedRegex();

        assertFalse(excludeRegex.contains("\\"), "no backslash escapes: " + excludeRegex);
        assertTrue(excludeRegex.contains("[.]generated[.]ts"));
        assertTrue("vendor/lib/a.js".matches(excludeRegex));
        assertTrue("src/api.generated.ts".matches(excludeRegex));
        assertFalse("src/apiXgeneratedYts".matches(excludeRegex), "the dot must stay literal");
        assertFalse("src/api.ts".matches(excludeRegex));

        assertTrue("vendor/keep.js".matches(reincludeRegex), "negations go in the companion pattern");
        assertFalse("vendor/lib/a.js".matches(reincludeRegex));
    }

    @Test
    void extendedRegexIsEmptyWhenNothingIsExcluded(@TempDir Path repoRoot) {
        Ailoc2ProbeConfig.invalidate(repoRoot);

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);

        assertEquals("", config.toExcludeExtendedRegex(), "awk treats an empty pattern as matching everything");
        assertEquals("", config.toReincludeExtendedRegex());
    }

    @Test
    void installWritesConfigAndSidecarWithoutOverwritingExistingConfig(@TempDir Path repoRoot) throws IOException {
        Ailoc2HookManager manager = new Ailoc2HookManager();

        assertTrue(manager.ensureProbeConfigFile(repoRoot));
        assertFalse(manager.ensureProbeConfigFile(repoRoot), "a second install must not rewrite it");

        String userContents = "{ \"attribution\": { \"excludePaths\": [\"vendor/**\"] } }";
        Files.writeString(repoRoot.resolve(Ailoc2ProbeConfig.REPO_CONFIG_FILE_NAME), userContents, StandardCharsets.UTF_8);
        Ailoc2ProbeConfig.invalidate(repoRoot);
        manager.writeResolvedConfigSidecar(repoRoot);

        String sidecar = Files.readString(
            repoRoot.resolve(Ailoc2ProbeConfig.METRICS_DIRECTORY).resolve("resolved-config.env"),
            StandardCharsets.UTF_8);

        assertEquals(
            userContents,
            Files.readString(repoRoot.resolve(Ailoc2ProbeConfig.REPO_CONFIG_FILE_NAME), StandardCharsets.UTF_8));
        assertTrue(sidecar.contains("AILOC2_MODE='signals'"), sidecar);
        assertTrue(sidecar.contains("AILOC2_LARGE_FILE_IS_AI=1"), sidecar);
        assertTrue(sidecar.contains("vendor"), sidecar);
    }

    @Test
    void generatedRuntimeSourcesTheSidecarAndFiltersExcludedPaths() {
        String runtime = new Ailoc2HookManager().createManagedRuntimeScript();

        assertTrue(runtime.contains("RESOLVED_CONFIG_FILE=\".ailoc2-metrics/resolved-config.env\""));
        assertTrue(runtime.contains(". \"$RESOLVED_CONFIG_FILE\""));
        assertTrue(runtime.contains("-v exclude_re=\"$AILOC2_EXCLUDE_REGEX\""));
        assertTrue(runtime.contains("-v reinclude_re=\"$AILOC2_REINCLUDE_REGEX\""));
        assertTrue(runtime.contains("current_path ~ exclude_re"));
        assertTrue(runtime.contains("current_path !~ reinclude_re"));
    }

    private void writeRepoLayer(Path repoRoot, String contents) throws IOException {
        Files.writeString(repoRoot.resolve(Ailoc2ProbeConfig.REPO_CONFIG_FILE_NAME), contents, StandardCharsets.UTF_8);
        Ailoc2ProbeConfig.invalidate(repoRoot);
    }

    private void writeLocalLayer(Path repoRoot, String contents) throws IOException {
        Path metricsDirectory = repoRoot.resolve(Ailoc2ProbeConfig.METRICS_DIRECTORY);
        Files.createDirectories(metricsDirectory);
        Files.writeString(metricsDirectory.resolve(Ailoc2ProbeConfig.LOCAL_CONFIG_FILE_NAME), contents, StandardCharsets.UTF_8);
        Ailoc2ProbeConfig.invalidate(repoRoot);
    }
}
