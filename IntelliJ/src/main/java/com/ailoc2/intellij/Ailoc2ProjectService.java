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
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.atomic.AtomicBoolean;

@Service(Service.Level.PROJECT)
public final class Ailoc2ProjectService implements Disposable {
    private static final Logger LOG = Logger.getInstance(Ailoc2ProjectService.class);
    private static final Pattern HUNK_PATTERN = Pattern.compile("^@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,(\\d+))? @@.*$");
    private static final long RECENT_COMMAND_CONTEXT_MILLIS = 500L;
    private static final int AI_BULK_REPLACEMENT_MULTIPLIER_THRESHOLD = 4;
    private static final int AI_BULK_REPLACEMENT_MINIMUM_LENGTH = 400;
    private static final int AI_BULK_INSERT_MINIMUM_LENGTH = 400;
    private static final int AI_BULK_INSERT_MINIMUM_LINES = 2;
    private static final String AI_UNDEFINED_COMMAND_SENTINEL = "Undefined";
    private static final Duration CLAUDE_PROVENANCE_MAX_AGE = Duration.ofMinutes(2);
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
    private final AtomicBoolean started = new AtomicBoolean();
    private volatile CommandContext activeCommandContext = CommandContext.empty();
    private volatile CommandContext recentCommandContext = CommandContext.empty();

    public Ailoc2ProjectService(Project project) {
        this.project = project;
    }

    public void start() {
        if (!started.compareAndSet(false, true)) {
            return;
        }

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
        Ailoc2GitSummary summary = computeGitSummary(
            repoRoot,
            List.of("diff", "--cached", "--unified=0", "--find-renames", "--no-color", "--ignore-all-space"),
            "staged"
        );
        storage.writeSummary(repoRoot, summary);
        return summary;
    }

    public void prepareCommitAudit(Path repoRoot) {
        if (!storage.persistPendingCommitAudit(repoRoot)) {
            LOG.warn("AILoc2 could not persist the pending commit audit for repo " + repoRoot);
        }
    }

    public Ailoc2RepoSummary refreshRepoSummary(Path repoRoot) {
        Ailoc2GitSummary stagedSummary = computeGitSummary(
            repoRoot,
            List.of("diff", "--cached", "--unified=0", "--find-renames", "--no-color", "--ignore-all-space"),
            "staged"
        );
        Ailoc2GitSummary unstagedSummary = computeGitSummary(
            repoRoot,
            List.of("diff", "--unified=0", "--find-renames", "--no-color", "--ignore-all-space"),
            "unstaged"
        );
        Ailoc2RepoSummary repoSummary = new Ailoc2RepoSummary(repoRoot, stagedSummary, unstagedSummary);
        storage.writeSummary(repoRoot, stagedSummary, unstagedSummary);
        return repoSummary;
    }

    public void finalizeCommittedState(Path repoRoot) {
        storage.archivePendingCommitAudit(repoRoot, readGitSingleLine(repoRoot, List.of("rev-parse", "HEAD")));
        Set<String> committedPaths = readGitPathSet(repoRoot, List.of("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"));
        if (committedPaths.isEmpty()) {
            refreshRepoSummary(repoRoot);
            return;
        }

        Set<String> preservedPaths = readGitPathSet(repoRoot, List.of("diff", "--name-only", "--no-color"));
        preservedPaths.addAll(readGitPathSet(repoRoot, List.of("ls-files", "--others", "--exclude-standard")));
        storage.clearCommittedState(repoRoot, committedPaths, preservedPaths);
        refreshRepoSummary(repoRoot);
    }

    private String readGitSingleLine(Path repoRoot, List<String> gitArgs) {
        ProcessBuilder processBuilder = new ProcessBuilder(withGitCommand(gitArgs));
        processBuilder.directory(repoRoot.toFile());
        try {
            Process process = processBuilder.start();
            String value;
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                value = reader.readLine();
            }
            return process.waitFor() == 0 && value != null ? value.strip() : null;
        }
        catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return null;
        }
    }

    public Path projectRepoRoot() {
        Path basePath = projectBasePath();
        if (basePath != null) {
            Path root = findRepoRoot(basePath);
            if (root != null) {
                return root;
            }
        }
        return null;
    }

    public Path projectBasePath() {
        return project.getBasePath() == null ? null : Path.of(project.getBasePath()).toAbsolutePath().normalize();
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
        Path serviceRepoRoot = projectRepoRoot();
        if (repoRoot == null || serviceRepoRoot == null || !repoRoot.equals(serviceRepoRoot) || shouldIgnore(repoRoot, filePath)) {
            return;
        }

        String repoRelativePath = repoRoot.relativize(filePath).toString().replace('\\', '/');
        if (storage.isTrackingIgnored(repoRoot, repoRelativePath)) {
            storage.removeState(repoRoot, repoRelativePath);
            return;
        }

        CommandContext commandContext = currentCommandContext();
        if (commandContext.isReloadFromDisk()) {
            Ailoc2FileState state = storage.reloadState(repoRoot, repoRelativePath);
            int startLine = Math.max(1, document.getLineNumber(Math.max(0, Math.min(event.getOffset(), document.getTextLength()))) + 1);
            if (hasRecentClaudeProvenance(state)) {
                LOG.info("AILoc2 reloaded Claude Code attribution: repo=" + repoRoot + ", file=" + repoRelativePath);
                return;
            }

            state.applyLineChange(
                startLine,
                event.getOldFragment(),
                event.getNewFragment(),
                Ailoc2AttributionBucket.UNKNOWN
            );
            state.setSource("EXTERNAL");
            state.setRecordedAt(Instant.now().toString());
            storage.persistState(repoRoot, repoRelativePath, state);
            LOG.info("AILoc2 external reload left attribution unknown: repo=" + repoRoot + ", file=" + repoRelativePath);
            return;
        }

        ClassificationResult classification = classifyChange(commandContext, event);
        Ailoc2AttributionBucket bucket = classification.bucket();
        Ailoc2FileState state = storage.stateFor(repoRoot, repoRelativePath);
        int safeOffset = Math.max(0, Math.min(event.getOffset(), document.getTextLength()));
        int startLine = Math.max(1, document.getLineNumber(safeOffset) + 1);
        int changedLineCount = Math.max(1, countTouchedLines(event.getNewFragment()));
        state.applyLineChange(
            startLine,
            event.getOldFragment(),
            event.getNewFragment(),
            bucket
        );
        state.addMagnitude(bucket, Math.max(event.getOldLength(), event.getNewLength()));
        state.setSource("INTELLIJ");
        state.setRecordedAt(Instant.now().toString());
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

    private Ailoc2GitSummary computeGitSummary(Path repoRoot, List<String> gitArgs, String summaryKind) {
        ProcessBuilder processBuilder = new ProcessBuilder(withGitCommand(gitArgs));
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
                LOG.warn("AILoc2 " + summaryKind + " summary failed: git exited with code " + exitCode + " for repo " + repoRoot);
                return Ailoc2GitSummary.unavailable();
            }
            Ailoc2GitSummary summary = summarizeDiff(repoRoot, diff.toString());
            LOG.info(
                "AILoc2 " + summaryKind + " summary refreshed: repo=" + repoRoot
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
            LOG.warn("AILoc2 " + summaryKind + " summary failed for repo " + repoRoot, error);
            return Ailoc2GitSummary.unavailable();
        }
    }

    private List<String> withGitCommand(List<String> gitArgs) {
        return java.util.stream.Stream.concat(java.util.stream.Stream.of("git"), gitArgs.stream()).toList();
    }

    private Set<String> readGitPathSet(Path repoRoot, List<String> gitArgs) {
        ProcessBuilder processBuilder = new ProcessBuilder(withGitCommand(gitArgs));
        processBuilder.directory(repoRoot.toFile());
        Set<String> repoRelativePaths = new HashSet<>();
        try {
            Process process = processBuilder.start();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String repoRelativePath = line.strip();
                    if (!repoRelativePath.isEmpty()
                        && !shouldIgnore(repoRoot, repoRoot.resolve(repoRelativePath))
                        && !storage.isTrackingIgnored(repoRoot, repoRelativePath)) {
                        repoRelativePaths.add(repoRelativePath.replace('\\', '/'));
                    }
                }
            }
            int exitCode = process.waitFor();
            if (exitCode != 0) {
                return Set.of();
            }
        }
        catch (IOException | InterruptedException error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return Set.of();
        }
        return repoRelativePaths;
    }

    private Ailoc2GitSummary summarizeDiff(Path repoRoot, String diffText) {
        Set<String> changedFiles = new HashSet<>();
        Set<String> attributedFiles = new HashSet<>();
        String currentPath = null;
        int currentLine = 0;
        long aiWeight = 0L;
        long humanWeight = 0L;
        Map<String, Ailoc2GitSummary.FileWeights> fileWeights = new HashMap<>();

        for (String line : diffText.split("\\R")) {
            if (line.startsWith("+++ ")) {
                currentPath = parseNewPath(line);
                currentLine = 0;
                if (currentPath != null && !storage.isTrackingIgnored(repoRoot, currentPath)) {
                    changedFiles.add(currentPath);
                }
                else {
                    currentPath = null;
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
                if (bucket == Ailoc2AttributionBucket.UNKNOWN && !state.hasLineBucket(currentLine)) {
                    bucket = state.fallbackBucket();
                }
                long weight = nonWhitespaceWeight(line.substring(1));
                if (weight > 0L && bucket == Ailoc2AttributionBucket.AI) {
                    aiWeight += weight;
                    attributedFiles.add(currentPath);
                    fileWeights.compute(
                        currentPath,
                        (path, weights) -> (weights == null ? new Ailoc2GitSummary.FileWeights(0L, 0L) : weights).addAi(weight)
                    );
                }
                else if (weight > 0L && bucket == Ailoc2AttributionBucket.HUMAN) {
                    humanWeight += weight;
                    attributedFiles.add(currentPath);
                    fileWeights.compute(
                        currentPath,
                        (path, weights) -> (weights == null ? new Ailoc2GitSummary.FileWeights(0L, 0L) : weights).addHuman(weight)
                    );
                }
                currentLine++;
            }
            else if (line.startsWith(" ")) {
                currentLine++;
            }
        }

        return new Ailoc2GitSummary(changedFiles.size(), attributedFiles.size(), aiWeight, humanWeight, true, fileWeights);
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

    private long nonWhitespaceWeight(String text) {
        return text.codePoints().filter(codePoint -> !Character.isWhitespace(codePoint)).count();
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
            && isBulkMultilineInsertion(event)) {
            return new ClassificationResult(Ailoc2AttributionBucket.AI, "bulk-insert");
        }
        if (event.getOldLength() > 0
            && event.getNewLength() > event.getOldLength() * (long) AI_BULK_REPLACEMENT_MULTIPLIER_THRESHOLD
            && event.getNewLength() > AI_BULK_REPLACEMENT_MINIMUM_LENGTH) {
            return new ClassificationResult(Ailoc2AttributionBucket.AI, "bulk-replacement");
        }
        return new ClassificationResult(Ailoc2AttributionBucket.HUMAN, "default-human");
    }

    private boolean isBulkMultilineInsertion(DocumentEvent event) {
        return event.getNewLength() > AI_BULK_INSERT_MINIMUM_LENGTH
            && countFragmentLines(event.getNewFragment()) >= AI_BULK_INSERT_MINIMUM_LINES;
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

    private boolean hasRecentClaudeProvenance(Ailoc2FileState state) {
        if (!"CLAUDE_CODE".equals(state.getSource()) || state.getRecordedAt().isBlank()) {
            return false;
        }
        try {
            Duration age = Duration.between(Instant.parse(state.getRecordedAt()), Instant.now());
            return !age.isNegative() && age.compareTo(CLAUDE_PROVENANCE_MAX_AGE) <= 0;
        }
        catch (RuntimeException ignored) {
            return false;
        }
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
            return AI_UNDEFINED_COMMAND_SENTINEL.equals(commandName);
        }

        boolean hasEmptyCommandGroup() {
            return commandGroupId.isEmpty() && commandGroupClassName.isEmpty();
        }

        boolean isReloadFromDisk() {
            return commandName.toLowerCase(Locale.ROOT).contains("reload from disk");
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
