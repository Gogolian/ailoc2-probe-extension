package com.ailoc2.intellij;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.command.CommandEvent;
import com.intellij.openapi.command.CommandListener;
import com.intellij.openapi.command.CommandProcessor;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.event.DocumentEvent;
import com.intellij.openapi.editor.event.DocumentListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service(Service.Level.PROJECT)
public final class Ailoc2ProjectService implements Disposable {
    private static final Pattern HUNK_PATTERN = Pattern.compile("^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@.*$");
    private static final int AI_BULK_REPLACEMENT_MULTIPLIER_THRESHOLD = 4;
    private static final int AI_BULK_REPLACEMENT_MINIMUM_LENGTH = 400;
    private static final List<String> AI_COMMAND_HINTS = List.of(
        "copilot",
        "codeium",
        "tabnine",
        "assistant",
        "junie",
        "llm",
        "ai assistant",
        "ai completion",
        "generate code"
    );

    private final Project project;
    private final Ailoc2Storage storage = new Ailoc2Storage();
    private volatile String activeCommandName = "";

    public Ailoc2ProjectService(Project project) {
        this.project = project;
    }

    public void start() {
        CommandProcessor.getInstance().addCommandListener(new CommandListener() {
            @Override
            public void commandStarted(@NotNull CommandEvent event) {
                activeCommandName = event.getCommandName() == null ? "" : event.getCommandName();
            }

            @Override
            public void commandFinished(@NotNull CommandEvent event) {
                activeCommandName = "";
            }
        }, this);

        EditorFactory.getInstance().getEventMulticaster().addDocumentListener(new DocumentListener() {
            @Override
            public void documentChanged(@NotNull DocumentEvent event) {
                recordDocumentChange(event);
            }
        }, this);
    }

    public Ailoc2GitSummary refreshStagedSummary(Path repoRoot) {
        Ailoc2GitSummary summary = computeStagedSummary(repoRoot);
        storage.writeSummary(repoRoot, summary);
        return summary;
    }

    public Path projectRepoRoot() {
        Path basePath = project.getBasePath() == null ? null : Path.of(project.getBasePath());
        if (basePath != null) {
            Path root = findRepoRoot(basePath);
            if (root != null) {
                return root;
            }
        }
        return null;
    }

    @Override
    public void dispose() {
    }

    private void recordDocumentChange(DocumentEvent event) {
        Document document = event.getDocument();
        VirtualFile file = FileDocumentManager.getInstance().getFile(document);
        if (file == null || file.isDirectory() || !file.isInLocalFileSystem()) {
            return;
        }

        Path filePath = Path.of(file.getPath()).toAbsolutePath().normalize();
        Path repoRoot = findRepoRoot(filePath);
        if (repoRoot == null || shouldIgnore(repoRoot, filePath)) {
            return;
        }

        String repoRelativePath = repoRoot.relativize(filePath).toString().replace('\\', '/');
        Ailoc2AttributionBucket bucket = classifyChange(activeCommandName, event);
        Ailoc2FileState state = storage.stateFor(repoRoot, repoRelativePath);
        int safeOffset = Math.max(0, Math.min(event.getOffset(), document.getTextLength()));
        int startLine = Math.max(1, document.getLineNumber(safeOffset) + 1);
        int changedLineCount = Math.max(1, countTouchedLines(event.getNewFragment()));
        for (int line = startLine; line < startLine + changedLineCount; line++) {
            state.setLineBucket(line, bucket);
        }
        state.addMagnitude(bucket, Math.max(event.getOldLength(), event.getNewLength()));
        storage.persistState(repoRoot, repoRelativePath, state);
    }

    private Ailoc2GitSummary computeStagedSummary(Path repoRoot) {
        ProcessBuilder processBuilder = new ProcessBuilder("git", "diff", "--cached", "--unified=0", "--find-renames", "--no-color");
        processBuilder.directory(repoRoot.toFile());
        try {
            Process process = processBuilder.start();
            StringBuilder diff = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    diff.append(line).append('\n');
                }
            }
            int exitCode = process.waitFor();
            if (exitCode != 0) {
                return Ailoc2GitSummary.unavailable();
            }
            return summarizeDiff(repoRoot, diff.toString());
        }
        catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return Ailoc2GitSummary.unavailable();
        }
    }

    private Ailoc2GitSummary summarizeDiff(Path repoRoot, String diffText) {
        Set<String> changedFiles = new HashSet<>();
        Set<String> attributedFiles = new HashSet<>();
        String currentPath = null;
        int currentLine = 0;
        long aiWeight = 0L;
        long humanWeight = 0L;

        for (String line : diffText.split("\\R")) {
            if (line.startsWith("+++ ")) {
                currentPath = parseNewPath(line);
                currentLine = 0;
                if (currentPath != null) {
                    changedFiles.add(currentPath);
                }
                continue;
            }

            Matcher matcher = HUNK_PATTERN.matcher(line);
            if (matcher.matches()) {
                currentLine = Integer.parseInt(matcher.group(1));
                continue;
            }

            if (currentPath == null || currentLine <= 0) {
                continue;
            }

            if (line.startsWith("+") && !line.startsWith("+++")) {
                Ailoc2FileState state = storage.stateFor(repoRoot, currentPath);
                Ailoc2AttributionBucket bucket = state.getLineBucket(currentLine);
                if (bucket == Ailoc2AttributionBucket.UNKNOWN) {
                    bucket = state.fallbackBucket();
                }
                long weight = Math.max(1, line.length() - 1L);
                if (bucket == Ailoc2AttributionBucket.AI) {
                    aiWeight += weight;
                    attributedFiles.add(currentPath);
                }
                else if (bucket == Ailoc2AttributionBucket.HUMAN) {
                    humanWeight += weight;
                    attributedFiles.add(currentPath);
                }
                currentLine++;
            }
            else if (line.startsWith(" ")) {
                currentLine++;
            }
        }

        return new Ailoc2GitSummary(changedFiles.size(), attributedFiles.size(), aiWeight, humanWeight, true);
    }

    private String parseNewPath(String line) {
        String pathText = line.substring(4).trim();
        if ("/dev/null".equals(pathText)) {
            return null;
        }
        if (pathText.startsWith("b/")) {
            return pathText.substring(2);
        }
        return pathText;
    }

    private Ailoc2AttributionBucket classifyChange(String commandName, DocumentEvent event) {
        String normalized = commandName == null ? "" : commandName.toLowerCase(Locale.ROOT);
        for (String hint : AI_COMMAND_HINTS) {
            if (normalized.contains(hint)) {
                return Ailoc2AttributionBucket.AI;
            }
        }
        if (event.getOldLength() > 0
            && event.getNewLength() > event.getOldLength() * (long) AI_BULK_REPLACEMENT_MULTIPLIER_THRESHOLD
            && event.getNewLength() > AI_BULK_REPLACEMENT_MINIMUM_LENGTH) {
            return Ailoc2AttributionBucket.AI;
        }
        return Ailoc2AttributionBucket.HUMAN;
    }

    private int countTouchedLines(CharSequence fragment) {
        int lines = 1;
        for (int i = 0; i < fragment.length(); i++) {
            if (fragment.charAt(i) == '\n') {
                lines++;
            }
        }
        return lines;
    }

    private Path findRepoRoot(Path startPath) {
        Path current = Files.isDirectory(startPath) ? startPath : startPath.getParent();
        while (current != null) {
            if (Files.exists(current.resolve(".git"))) {
                return current.toAbsolutePath().normalize();
            }
            current = current.getParent();
        }
        return null;
    }

    private boolean shouldIgnore(Path repoRoot, Path filePath) {
        if (!filePath.startsWith(repoRoot)) {
            return true;
        }
        String repoRelativePath = repoRoot.relativize(filePath).toString().replace('\\', '/');
        return repoRelativePath.startsWith(".git/")
            || repoRelativePath.startsWith(".ailoc2-metrics/")
            || repoRelativePath.startsWith(".idea/")
            || repoRelativePath.equals(".git")
            || repoRelativePath.equals(".ailoc2-metrics")
            || repoRelativePath.equals(".idea");
    }
}
