package com.ailoc2.intellij;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class Ailoc2MarkerStripperTest {
    @Test
    void preservesCrlfTerminatorsOnSurvivingLines() {
        byte[] content = "const a = 1;\r\n// AI start\r\nconst b = 2;\r\n// AI stop\r\n".getBytes(StandardCharsets.UTF_8);

        byte[] stripped = Ailoc2MarkerStripper.stripMarkerLinesPreservingBytes(content);

        assertEquals("const a = 1;\r\nconst b = 2;\r\n", new String(stripped, StandardCharsets.UTF_8));
    }

    @Test
    void doesNotInventATrailingNewline() {
        byte[] content = "// AI start\nconst a = 1;".getBytes(StandardCharsets.UTF_8);

        byte[] stripped = Ailoc2MarkerStripper.stripMarkerLinesPreservingBytes(content);

        assertEquals("const a = 1;", new String(stripped, StandardCharsets.UTF_8));
    }

    @Test
    void leavesMarkerFreeContentByteIdentical() {
        byte[] content = "const a = 1;\nconst b = 2;\n".getBytes(StandardCharsets.UTF_8);

        assertArrayEquals(content, Ailoc2MarkerStripper.stripMarkerLinesPreservingBytes(content));
    }

    @Test
    void stripsIndexAndMatchingWorkingTree(@TempDir Path repoRoot) throws Exception {
        initRepo(repoRoot);
        stage(repoRoot, "src/app.ts", "const a = 1;\n// AI start\nconst b = 2;\n// AI stop\n");

        List<String> stripped = Ailoc2MarkerStripper.stripStagedMarkers(repoRoot, List.of("src/app.ts"));

        assertEquals(List.of("src/app.ts"), stripped);
        assertEquals("const a = 1;\nconst b = 2;\n", readIndex(repoRoot, "src/app.ts"));
        assertEquals(
            "const a = 1;\nconst b = 2;\n",
            Files.readString(repoRoot.resolve("src/app.ts"), StandardCharsets.UTF_8));
    }

    @Test
    void preservesTheExecutableBit(@TempDir Path repoRoot) throws Exception {
        initRepo(repoRoot);
        stage(repoRoot, "scripts/run.sh", "#!/bin/sh\n# AI start\necho hi\n# AI stop\n");
        git(repoRoot, "update-index", "--chmod=+x", "--", "scripts/run.sh");
        assertEquals("100755", indexMode(repoRoot, "scripts/run.sh"));

        Ailoc2MarkerStripper.stripStagedMarkers(repoRoot, List.of("scripts/run.sh"));

        assertEquals("100755", indexMode(repoRoot, "scripts/run.sh"), "executable bit survives");
        assertEquals("#!/bin/sh\necho hi\n", readIndex(repoRoot, "scripts/run.sh"));
    }

    @Test
    void doesNotClobberUnstagedWork(@TempDir Path repoRoot) throws Exception {
        initRepo(repoRoot);
        stage(repoRoot, "src/app.ts", "const a = 1;\n// AI start\nconst b = 2;\n// AI stop\n");
        String unstaged = "const a = 1;\n// AI start\nconst b = 2;\n// AI stop\nconst inProgress = 3;\n";
        Files.writeString(repoRoot.resolve("src/app.ts"), unstaged, StandardCharsets.UTF_8);

        Ailoc2MarkerStripper.stripStagedMarkers(repoRoot, List.of("src/app.ts"));

        assertEquals(unstaged, Files.readString(repoRoot.resolve("src/app.ts"), StandardCharsets.UTF_8));
        assertEquals("const a = 1;\nconst b = 2;\n", readIndex(repoRoot, "src/app.ts"));
    }

    @Test
    void skipsBinaryContent(@TempDir Path repoRoot) throws Exception {
        initRepo(repoRoot);
        Path absolutePath = repoRoot.resolve("assets/blob.bin");
        Files.createDirectories(absolutePath.getParent());
        Files.write(absolutePath, new byte[]{0x41, 0x00, 0x42, 0x0a});
        git(repoRoot, "add", "--", "assets/blob.bin");

        assertTrue(Ailoc2MarkerStripper.stripStagedMarkers(repoRoot, List.of("assets/blob.bin")).isEmpty());
    }

    @Test
    void leavesMarkerFreeFilesAlone(@TempDir Path repoRoot) throws Exception {
        initRepo(repoRoot);
        stage(repoRoot, "src/plain.ts", "const a = 1;\n");

        assertTrue(Ailoc2MarkerStripper.stripStagedMarkers(repoRoot, List.of("src/plain.ts")).isEmpty());
        assertEquals("const a = 1;\n", readIndex(repoRoot, "src/plain.ts"));
    }

    private void initRepo(Path repoRoot) throws Exception {
        git(repoRoot, "init");
        git(repoRoot, "config", "user.name", "AILoc2 Test");
        git(repoRoot, "config", "user.email", "test@example.invalid");
        git(repoRoot, "config", "core.autocrlf", "false");
    }

    private void stage(Path repoRoot, String gitPath, String contents) throws Exception {
        Path absolutePath = repoRoot.resolve(gitPath);
        Files.createDirectories(absolutePath.getParent());
        Files.writeString(absolutePath, contents, StandardCharsets.UTF_8);
        git(repoRoot, "add", "--", gitPath);
    }

    private String readIndex(Path repoRoot, String gitPath) throws Exception {
        return git(repoRoot, "show", ":" + gitPath);
    }

    private String indexMode(Path repoRoot, String gitPath) throws Exception {
        return git(repoRoot, "ls-files", "--stage", "--", gitPath).strip().split("\\s+")[0];
    }

    private String git(Path repoRoot, String... args) throws IOException, InterruptedException {
        List<String> command = new java.util.ArrayList<>();
        command.add("git");
        command.addAll(List.of(args));
        Process process = new ProcessBuilder(command).directory(repoRoot.toFile()).start();
        String stdout = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        process.waitFor();
        return stdout;
    }
}
