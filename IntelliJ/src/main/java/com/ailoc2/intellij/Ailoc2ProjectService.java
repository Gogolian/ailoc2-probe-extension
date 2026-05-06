package com.ailoc2.intellij;

import com.intellij.openapi.Disposable;
import com.intellij.openapi.command.CommandEvent;
import com.intellij.openapi.command.CommandListener;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
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
    private static final Logger LOG = Logger.getInstance(Ailoc2ProjectService.class);
    private static final Pattern HUNK_PATTERN = Pattern.compile("^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@.*$");
    private static final long RECENT_COMMAND_CONTEXT_MILLIS = 500L;
    private static final int AI_BULK_REPLACEMENT_MULTIPLIER_THRESHOLD = 4;
    private static final int AI_BULK_REPLACEMENT_MINIMUM_LENGTH = 400;
    private static final int AI_BULK_INSERT_MINIMUM_LENGTH = 400;
    private static final int AI_BULK_INSERT_MINIMUM_LINES = 2;
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
    private volatile CommandContext activeCommandContext = CommandContext.empty();
    private volatile CommandContext recentCommandContext = CommandContext.empty();

    public Ailoc2ProjectService(Project project) {
        this.project = project;
    }

    public void start() {
        project.getMessageBus().connect(this).subscribe(CommandListener.TOPIC, new CommandListener() {
            @Override
            public void commandStarted(@NotNull CommandEvent event) {
                activeCommandContext = CommandContext.from(event);
                recentCommandContext = activeCommandContext;
                LOG.info("AILoc2 command started: " + activeCommandContext.describe());
            }

            @Override
            public void commandFinished(@NotNull CommandEvent event) {
                recentCommandContext = CommandContext.from(event);
                LOG.info("AILoc2 command finished: " + recentCommandContext.describe());
                activeCommandContext = CommandContext.empty();
            }
        });

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
        CommandContext commandContext = currentCommandContext();
        ClassificationResult classification = classifyChange(commandContext, event);
        Ailoc2AttributionBucket bucket = classification.bucket();
        Ailoc2FileState state = storage.stateFor(repoRoot, repoRelativePath);
        int safeOffset = Math.max(0, Math.min(event.getOffset(), document.getTextLength()));
        int startLine = Math.max(1, document.getLineNumber(safeOffset) + 1);
        int changedLineCount = Math.max(1, countTouchedLines(event.getNewFragment()));
        for (int line = startLine; line < startLine + changedLineCount; line++) {
            state.setLineBucket(line, bucket);
        }
        state.addMagnitude(bucket, Math.max(event.getOldLength(), event.getNewLength()));
        storage.persistState(repoRoot, repoRelativePath, state);
        LOG.info(
            "AILoc2 parsed document event: repo=" + repoRoot
                + ", file=" + repoRelativePath
                + ", bucket=" + bucket
                + ", reason=" + classification.reason()
                + ", command=" + commandContext.describe()
                + ", offset=" + event.getOffset()
                + ", oldLength=" + event.getOldLength()
                + ", newLength=" + event.getNewLength()
                + ", oldLines=" + countFragmentLines(event.getOldFragment())
                + ", newLines=" + countFragmentLines(event.getNewFragment())
                + ", touchedLines=" + changedLineCount
        );
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
                LOG.warn("AILoc2 staged summary failed: git diff exited with code " + exitCode + " for repo " + repoRoot);
                return Ailoc2GitSummary.unavailable();
            }
            Ailoc2GitSummary summary = summarizeDiff(repoRoot, diff.toString());
            LOG.info(
                "AILoc2 staged summary refreshed: repo=" + repoRoot
                    + ", changedFiles=" + summary.changedFileCount
                    + ", attributedFiles=" + summary.attributedChangedFileCount
                    + ", aiWeight=" + summary.aiWeightedChangedLines
                    + ", humanWeight=" + summary.humanWeightedChangedLines
                    + ", aiPercentage=" + String.format(Locale.ROOT, "%.2f", summary.aiPercentage)
            );
            return summary;
        }
        catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            LOG.warn("AILoc2 staged summary failed for repo " + repoRoot, error);
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

    private ClassificationResult classifyChange(CommandContext commandContext, DocumentEvent event) {
        String normalized = commandContext.normalizedSearchText();
        for (String hint : AI_COMMAND_HINTS) {
            if (normalized.contains(hint)) {
                return new ClassificationResult(Ailoc2AttributionBucket.AI, "command-context:" + hint);
            }
        }
        if (commandContext.hasUndefinedCommandName()
            && commandContext.hasEmptyCommandGroup()) {
            return new ClassificationResult(Ailoc2AttributionBucket.AI, "undefined-command");
        }
        if (event.getOldLength() == 0
            && isBulkMultilineInsertion(event, AI_BULK_INSERT_MINIMUM_LENGTH, AI_BULK_INSERT_MINIMUM_LINES)) {
            return new ClassificationResult(Ailoc2AttributionBucket.AI, "bulk-insert");
        }
        if (event.getOldLength() > 0
            && event.getNewLength() > event.getOldLength() * (long) AI_BULK_REPLACEMENT_MULTIPLIER_THRESHOLD
            && event.getNewLength() > AI_BULK_REPLACEMENT_MINIMUM_LENGTH) {
            return new ClassificationResult(Ailoc2AttributionBucket.AI, "bulk-replacement");
        }
        return new ClassificationResult(Ailoc2AttributionBucket.HUMAN, "default-human");
    }

    private boolean isBulkMultilineInsertion(DocumentEvent event, int minimumLength, int minimumLines) {
        return event.getNewLength() > minimumLength
            && countFragmentLines(event.getNewFragment()) >= minimumLines;
    }

    private CommandContext currentCommandContext() {
        CommandContext commandContext = activeCommandContext;
        if (!commandContext.isEmpty()) {
            return commandContext;
        }

        CommandContext recentContext = recentCommandContext;
        if (recentContext.isRecent()) {
            return recentContext;
        }

        return CommandContext.empty();
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

    private int countFragmentLines(CharSequence fragment) {
        return fragment.isEmpty() ? 0 : countTouchedLines(fragment);
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

    private record CommandContext(
        String commandName,
        String commandGroupId,
        String commandGroupClassName,
        String normalizedSearchText,
        long observedAtMillis
    ) {
        static CommandContext empty() {
            return new CommandContext("", "", "", "", 0L);
        }

        static CommandContext from(CommandEvent event) {
            String commandName = sanitize(event.getCommandName());
            Object commandGroupId = event.getCommandGroupId();
            String commandGroupIdText = sanitize(commandGroupId == null ? null : commandGroupId.toString());
            String commandGroupClassName = sanitize(commandGroupId == null ? null : commandGroupId.getClass().getName());
            String normalizedSearchText = String.join(" ", commandName, commandGroupIdText, commandGroupClassName)
                .trim()
                .toLowerCase(Locale.ROOT);
            return new CommandContext(commandName, commandGroupIdText, commandGroupClassName, normalizedSearchText, System.currentTimeMillis());
        }

        String describe() {
            return "name=" + display(commandName)
                + ", groupId=" + display(commandGroupId)
                + ", groupClass=" + display(commandGroupClassName);
        }

        boolean isEmpty() {
            return normalizedSearchText.isEmpty();
        }

        boolean hasUndefinedCommandName() {
            return "undefined".equalsIgnoreCase(commandName);
        }

        boolean hasEmptyCommandGroup() {
            return commandGroupId.isEmpty() && commandGroupClassName.isEmpty();
        }

        boolean isRecent() {
            long elapsedMillis = System.currentTimeMillis() - observedAtMillis;
            return observedAtMillis > 0L && elapsedMillis >= 0L && elapsedMillis <= RECENT_COMMAND_CONTEXT_MILLIS;
        }

        private static String sanitize(String value) {
            if (value == null) {
                return "";
            }
            return value.replaceAll("\\s+", " ").trim();
        }

        private static String display(String value) {
            return value.isEmpty() ? "<none>" : value;
        }
    }

    private record ClassificationResult(Ailoc2AttributionBucket bucket, String reason) {}
}
