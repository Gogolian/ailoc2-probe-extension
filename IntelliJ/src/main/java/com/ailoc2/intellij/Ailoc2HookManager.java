package com.ailoc2.intellij;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class Ailoc2HookManager {
    private static final String REPO_HOOKS_DIRECTORY_NAME = ".githooks";
    private static final String REPO_HOOKS_PATH_VALUE = ".githooks";
    private static final String RUNTIME_FILE_NAME = "ailoc2-intellij-hook-runtime.sh";
    private static final String CLAUDE_DIRECTORY_NAME = ".claude";
    private static final String CLAUDE_RUNTIME_FILE_NAME = "ailoc2-claude-code.cjs";
    private static final String CLAUDE_RUNTIME_RESOURCE_PATH = "/claude-code/" + CLAUDE_RUNTIME_FILE_NAME;
    private static final String CORE_HOOKS_PATH_CONFIG_KEY = "core.hooksPath";
    private static final String PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY = "ailoc2Probe.previousLocalHooksPath";
    private static final String DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY = "ailoc2Probe.delegateLocalHooksPath";
    private static final String MANAGED_HOOK_MARKER_PREFIX = "# AILoc2 managed IntelliJ hook: ";
    private static final String WRAPPED_HOOK_DELEGATE_MARKER_PREFIX = "# AILoc2 wrapped hook delegate: ";
    private static final String WRAPPED_HOOK_DELEGATE_FILE_SUFFIX = ".ailoc2-delegate";
    private static final String MANUAL_MERGE_HOOK_FILE_SUFFIX = ".ailoc2-proposed";
    private static final List<String> REQUIRED_REPO_HOOK_FILES = List.of("pre-commit", "commit-msg", "post-commit");
    private static final List<String> MANAGED_GITIGNORE_PATTERNS = List.of(".ailoc2-metrics/", ".githooks/", ".claude/");
    private static final String CLAUDE_MANAGED_TOOL_MATCHER = "Write|Edit|MultiEdit";
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    HookInstallResult installRepoHooks(
        Path repoRoot,
        boolean allowReplacingExistingLocalHooksPath,
        boolean chainExistingLocalHooksPath,
        boolean wrapExistingHookFiles
    )
        throws IOException, InterruptedException {
        Path normalizedRepoRoot = repoRoot.toAbsolutePath().normalize();
        assertGitRepositoryRoot(normalizedRepoRoot);

        String currentLocalHooksPath = getGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, GitConfigScope.LOCAL);
        String currentEffectiveHooksPath = getGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, GitConfigScope.EFFECTIVE);
        String existingDelegatedHooksPath = getGitConfigValue(normalizedRepoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, GitConfigScope.LOCAL);
        Path hooksDirectoryPath = getRepoHooksDirectoryPath(normalizedRepoRoot);
        boolean isAlreadyInstalled = isRepoManagedHooksPath(normalizedRepoRoot, currentLocalHooksPath)
            || (currentLocalHooksPath == null && isRepoManagedHooksPath(normalizedRepoRoot, currentEffectiveHooksPath));
        String delegatedHooksPath = isAlreadyInstalled
            ? existingDelegatedHooksPath
            : chainExistingLocalHooksPath && currentLocalHooksPath != null
            ? currentLocalHooksPath
            : null;

        if (currentLocalHooksPath != null
            && !isRepoManagedHooksPath(normalizedRepoRoot, currentLocalHooksPath)
            && !allowReplacingExistingLocalHooksPath) {
            return new HookInstallResult(
                HookInstallStatus.CONFLICT,
                normalizedRepoRoot,
                hooksDirectoryPath,
                currentLocalHooksPath,
                currentEffectiveHooksPath,
                null,
                null,
                List.of(),
                List.of(),
                List.of()
            );
        }

        List<String> conflictingHookFiles = findUnmanagedHookFileConflicts(normalizedRepoRoot);
        if (!conflictingHookFiles.isEmpty() && !wrapExistingHookFiles) {
            return new HookInstallResult(
                HookInstallStatus.HOOK_FILE_CONFLICT,
                normalizedRepoRoot,
                hooksDirectoryPath,
                currentLocalHooksPath,
                currentEffectiveHooksPath,
                null,
                delegatedHooksPath,
                conflictingHookFiles,
                List.of(),
                List.of()
            );
        }

        assertClaudeRuntimeResourceAvailable();

        List<String> wrappedHookFiles = List.of();
        if (!conflictingHookFiles.isEmpty()) {
            HookFileWrapResult wrapResult = wrapUnmanagedHookFiles(normalizedRepoRoot, conflictingHookFiles, delegatedHooksPath);
            if (!wrapResult.manualMergeHookFiles().isEmpty()) {
                return new HookInstallResult(
                    HookInstallStatus.MANUAL_MERGE_REQUIRED,
                    normalizedRepoRoot,
                    hooksDirectoryPath,
                    currentLocalHooksPath,
                    currentEffectiveHooksPath,
                    null,
                    delegatedHooksPath,
                    conflictingHookFiles,
                    List.of(),
                    wrapResult.manualMergeHookFiles()
                );
            }
            wrappedHookFiles = wrapResult.wrappedHookFiles();
        }

        ensureManagedRepoHookAssetsInstalled(normalizedRepoRoot, delegatedHooksPath, wrappedHookFiles);

        if (isAlreadyInstalled) {
            return new HookInstallResult(
                HookInstallStatus.ALREADY_INSTALLED,
                normalizedRepoRoot,
                hooksDirectoryPath,
                currentLocalHooksPath,
                currentEffectiveHooksPath,
                null,
                delegatedHooksPath,
                conflictingHookFiles,
                wrappedHookFiles,
                List.of()
            );
        }

        String replacedPreviousLocalHooksPath = null;
        if (currentLocalHooksPath != null) {
            replacedPreviousLocalHooksPath = currentLocalHooksPath;
            setLocalGitConfigValue(normalizedRepoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, currentLocalHooksPath);
        }
        else {
            unsetLocalGitConfigValue(normalizedRepoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
        }

        if (delegatedHooksPath != null) {
            setLocalGitConfigValue(normalizedRepoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, delegatedHooksPath);
        }
        else {
            unsetLocalGitConfigValue(normalizedRepoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
        }

        setLocalGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, REPO_HOOKS_PATH_VALUE);

        return new HookInstallResult(
            HookInstallStatus.INSTALLED,
            normalizedRepoRoot,
            hooksDirectoryPath,
            REPO_HOOKS_PATH_VALUE,
            REPO_HOOKS_PATH_VALUE,
            replacedPreviousLocalHooksPath,
            delegatedHooksPath,
            conflictingHookFiles,
            wrappedHookFiles,
            List.of()
        );
    }

    HookUninstallResult uninstallRepoHooks(Path repoRoot) throws IOException, InterruptedException {
        Path normalizedRepoRoot = repoRoot.toAbsolutePath().normalize();
        Path hooksDirectoryPath = getRepoHooksDirectoryPath(normalizedRepoRoot);
        String currentLocalHooksPath = getGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, GitConfigScope.LOCAL);
        String currentEffectiveHooksPath = getGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, GitConfigScope.EFFECTIVE);
        boolean removedManagedHookAssets;
        IOException managedAssetsError = null;
        try {
            removedManagedHookAssets = removeManagedHookAssets(normalizedRepoRoot);
        }
        catch (IOException error) {
            removedManagedHookAssets = true;
            managedAssetsError = error;
        }

        if (!isRepoManagedHooksPath(normalizedRepoRoot, currentLocalHooksPath)) {
            if (removedManagedHookAssets) {
                unsetLocalGitConfigValue(normalizedRepoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
                unsetLocalGitConfigValue(normalizedRepoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
            }
            throwManagedAssetsError(managedAssetsError);

            return new HookUninstallResult(
                HookUninstallStatus.NOT_INSTALLED,
                normalizedRepoRoot,
                hooksDirectoryPath,
                currentLocalHooksPath,
                currentEffectiveHooksPath,
                null,
                removedManagedHookAssets
            );
        }

        String previousLocalHooksPath = getGitConfigValue(normalizedRepoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, GitConfigScope.LOCAL);
        if (previousLocalHooksPath != null) {
            setLocalGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, previousLocalHooksPath);
            unsetLocalGitConfigValue(normalizedRepoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
            unsetLocalGitConfigValue(normalizedRepoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
            throwManagedAssetsError(managedAssetsError);
            return new HookUninstallResult(
                HookUninstallStatus.RESTORED_PREVIOUS,
                normalizedRepoRoot,
                hooksDirectoryPath,
                currentLocalHooksPath,
                previousLocalHooksPath,
                previousLocalHooksPath,
                removedManagedHookAssets
            );
        }

        unsetLocalGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, true);
        unsetLocalGitConfigValue(normalizedRepoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
        unsetLocalGitConfigValue(normalizedRepoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
        throwManagedAssetsError(managedAssetsError);

        return new HookUninstallResult(
            HookUninstallStatus.UNINSTALLED,
            normalizedRepoRoot,
            hooksDirectoryPath,
            null,
            getGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, GitConfigScope.EFFECTIVE),
            null,
            removedManagedHookAssets
        );
    }

    private void throwManagedAssetsError(IOException error) throws IOException {
        if (error != null) {
            throw new IOException("Git hook configuration was cleaned up, but some managed AILoc2 assets could not be removed.", error);
        }
    }

    WorkspaceClaudeInstallResult installWorkspaceClaudeHooks(Path workspaceRoot) throws IOException {
        Path normalizedWorkspaceRoot = workspaceRoot.toAbsolutePath().normalize();
        if (!Files.isDirectory(normalizedWorkspaceRoot)) {
            throw new IOException("The workspace root is not an existing directory: " + normalizedWorkspaceRoot);
        }

        assertClaudeRuntimeResourceAvailable();
        boolean alreadyInstalled = isManagedClaudeCodeInstalled(normalizedWorkspaceRoot);
        installManagedClaudeCodeAssets(normalizedWorkspaceRoot);
        markExecutableBestEffort(getClaudeRuntimePath(normalizedWorkspaceRoot));
        return new WorkspaceClaudeInstallResult(
            alreadyInstalled ? WorkspaceClaudeInstallStatus.ALREADY_INSTALLED : WorkspaceClaudeInstallStatus.INSTALLED,
            normalizedWorkspaceRoot,
            getClaudeSettingsPath(normalizedWorkspaceRoot),
            getClaudeRuntimePath(normalizedWorkspaceRoot)
        );
    }

    WorkspaceClaudeUninstallResult uninstallWorkspaceClaudeHooks(Path workspaceRoot) throws IOException {
        Path normalizedWorkspaceRoot = workspaceRoot.toAbsolutePath().normalize();
        boolean removed = removeClaudeCodeAssets(normalizedWorkspaceRoot);
        return new WorkspaceClaudeUninstallResult(
            removed ? WorkspaceClaudeUninstallStatus.UNINSTALLED : WorkspaceClaudeUninstallStatus.NOT_INSTALLED,
            normalizedWorkspaceRoot,
            removed
        );
    }

    private void assertGitRepositoryRoot(Path repoRoot) throws IOException {
        if (!Files.exists(repoRoot.resolve(".git"))) {
            throw new IOException("The selected path is not a Git repository root: " + repoRoot);
        }
    }

    private void ensureManagedRepoHookAssetsInstalled(Path repoRoot, String delegatedHooksPath, List<String> wrappedHookFiles) throws IOException {
        ensureManagedPathsIgnored(repoRoot);
        Files.createDirectories(getRepoHooksDirectoryPath(repoRoot));
        for (String hookFileName : REQUIRED_REPO_HOOK_FILES) {
            ensureManagedHookFile(repoRoot, hookFileName, createHookDelegateSpecs(hookFileName, delegatedHooksPath, wrappedHookFiles));
        }
        installManagedRuntimeAsset(repoRoot);
        installManagedClaudeCodeAssets(repoRoot);

        for (String hookFileName : REQUIRED_REPO_HOOK_FILES) {
            markExecutableBestEffort(getRepoHooksDirectoryPath(repoRoot).resolve(hookFileName));
        }
        markExecutableBestEffort(getRuntimeFilePath(repoRoot));
        markExecutableBestEffort(getClaudeRuntimePath(repoRoot));
    }

    private void ensureManagedHookFile(Path repoRoot, String hookFileName, List<HookDelegateSpec> delegateSpecs) throws IOException {
        Path hookFilePath = getRepoHooksDirectoryPath(repoRoot).resolve(hookFileName);
        List<HookDelegateSpec> expectedDelegateSpecs = new ArrayList<>(delegateSpecs);
        if (Files.exists(hookFilePath)) {
            String existingContents = Files.readString(hookFilePath, StandardCharsets.UTF_8);
            if (!isManagedHookFileText(hookFileName, existingContents)) {
                throw new IOException(
                    "The repo-local " + REPO_HOOKS_DIRECTORY_NAME + "/" + hookFileName
                        + " file already exists and is not managed by AILoc2."
                );
            }

            expectedDelegateSpecs = mergeHookDelegateSpecs(extractWrappedHookDelegateSpecs(existingContents), expectedDelegateSpecs);
            String expectedContents = createManagedHookFileContents(hookFileName, expectedDelegateSpecs);
            if (normalizeHookFileText(existingContents).equals(normalizeHookFileText(expectedContents))) {
                return;
            }

            Files.writeString(hookFilePath, expectedContents, StandardCharsets.UTF_8);
            return;
        }

        String expectedContents = createManagedHookFileContents(hookFileName, expectedDelegateSpecs);
        Files.writeString(hookFilePath, expectedContents, StandardCharsets.UTF_8);
    }

    private List<String> findUnmanagedHookFileConflicts(Path repoRoot) {
        List<String> conflictingHookFiles = new ArrayList<>();
        for (String hookFileName : REQUIRED_REPO_HOOK_FILES) {
            Path hookFilePath = getRepoHooksDirectoryPath(repoRoot).resolve(hookFileName);
            if (!Files.exists(hookFilePath)) {
                continue;
            }

            try {
                if (!Files.isRegularFile(hookFilePath)) {
                    conflictingHookFiles.add(hookFileName);
                    continue;
                }

                String existingContents = Files.readString(hookFilePath, StandardCharsets.UTF_8);
                if (!isManagedHookFileText(hookFileName, existingContents)) {
                    conflictingHookFiles.add(hookFileName);
                }
            }
            catch (IOException ignored) {
                conflictingHookFiles.add(hookFileName);
            }
        }

        return conflictingHookFiles;
    }

    private HookFileWrapResult wrapUnmanagedHookFiles(Path repoRoot, List<String> hookFileNames, String delegatedHooksPath) throws IOException {
        List<String> unsafeHookFiles = new ArrayList<>();
        for (String hookFileName : hookFileNames) {
            Path hookFilePath = getRepoHooksDirectoryPath(repoRoot).resolve(hookFileName);
            Path delegateFilePath = getWrappedHookDelegateFilePath(repoRoot, hookFileName);
            if (Files.exists(delegateFilePath) || !Files.isRegularFile(hookFilePath)) {
                unsafeHookFiles.add(hookFileName);
            }
        }

        if (!unsafeHookFiles.isEmpty()) {
            return new HookFileWrapResult(List.of(), writeManualMergeHookFiles(repoRoot, hookFileNames, delegatedHooksPath));
        }

        for (String hookFileName : hookFileNames) {
            Files.move(getRepoHooksDirectoryPath(repoRoot).resolve(hookFileName), getWrappedHookDelegateFilePath(repoRoot, hookFileName));
        }

        return new HookFileWrapResult(List.copyOf(hookFileNames), List.of());
    }

    private List<String> writeManualMergeHookFiles(Path repoRoot, List<String> hookFileNames, String delegatedHooksPath) throws IOException {
        Files.createDirectories(getRepoHooksDirectoryPath(repoRoot));
        List<String> manualMergeHookFiles = new ArrayList<>();
        for (String hookFileName : hookFileNames) {
            String proposedFileName = hookFileName + MANUAL_MERGE_HOOK_FILE_SUFFIX;
            Path proposedFilePath = getRepoHooksDirectoryPath(repoRoot).resolve(proposedFileName);
            Files.writeString(
                proposedFilePath,
                createManagedHookFileContents(hookFileName, createHookDelegateSpecs(hookFileName, delegatedHooksPath, List.of())),
                StandardCharsets.UTF_8
            );
            manualMergeHookFiles.add(REPO_HOOKS_PATH_VALUE + "/" + proposedFileName);
        }

        return manualMergeHookFiles;
    }

    private void assertClaudeRuntimeResourceAvailable() throws IOException {
        try (InputStream runtimeStream = Ailoc2HookManager.class.getResourceAsStream(CLAUDE_RUNTIME_RESOURCE_PATH)) {
            if (runtimeStream == null) {
                throw new IOException("AILoc2 Claude Code runtime resource is missing: " + CLAUDE_RUNTIME_RESOURCE_PATH);
            }
        }
    }

    private void installManagedRuntimeAsset(Path repoRoot) throws IOException {
        Files.writeString(getRuntimeFilePath(repoRoot), createManagedRuntimeScript(), StandardCharsets.UTF_8);
    }

    private boolean removeManagedHookAssets(Path repoRoot) throws IOException {
        boolean removedManagedHookFiles = false;
        for (String hookFileName : REQUIRED_REPO_HOOK_FILES) {
            removedManagedHookFiles = removeManagedHookFile(repoRoot, hookFileName) || removedManagedHookFiles;
        }
        boolean removedRuntimeAsset = removeRuntimeAsset(repoRoot);
        boolean removedClaudeCodeAssets = removeClaudeCodeAssets(repoRoot);
        removeEmptyHookDirectoryIfPossible(repoRoot);
        return removedManagedHookFiles || removedRuntimeAsset || removedClaudeCodeAssets;
    }

    private void ensureManagedPathsIgnored(Path repoRoot) throws IOException {
        Path gitignorePath = repoRoot.resolve(".gitignore");
        String existingContents = Files.exists(gitignorePath)
            ? Files.readString(gitignorePath, StandardCharsets.UTF_8)
            : "";
        Set<String> existingPatterns = existingContents.lines()
            .map(this::normalizeGitignorePattern)
            .filter(pattern -> !pattern.isBlank())
            .collect(java.util.stream.Collectors.toSet());
        List<String> missingPatterns = MANAGED_GITIGNORE_PATTERNS.stream()
            .filter(pattern -> !existingPatterns.contains(normalizeGitignorePattern(pattern)))
            .toList();
        if (missingPatterns.isEmpty()) {
            return;
        }

        String separator = existingContents.isEmpty() || existingContents.endsWith("\n") || existingContents.endsWith("\r") ? "" : "\n";
        Files.writeString(gitignorePath, existingContents + separator + String.join("\n", missingPatterns) + "\n", StandardCharsets.UTF_8);
    }

    private String normalizeGitignorePattern(String pattern) {
        String normalizedPattern = pattern.trim().replace('\\', '/');
        if (normalizedPattern.startsWith("./")) {
            normalizedPattern = normalizedPattern.substring(2);
        }
        while (normalizedPattern.endsWith("/")) {
            normalizedPattern = normalizedPattern.substring(0, normalizedPattern.length() - 1);
        }
        return normalizedPattern;
    }

    private void installManagedClaudeCodeAssets(Path repoRoot) throws IOException {
        Path settingsPath = getClaudeSettingsPath(repoRoot);
        JsonObject settings = readClaudeSettings(settingsPath);
        Path claudeDirectory = getClaudeDirectoryPath(repoRoot);
        Files.createDirectories(claudeDirectory);
        try (InputStream runtimeStream = Ailoc2HookManager.class.getResourceAsStream(CLAUDE_RUNTIME_RESOURCE_PATH)) {
            if (runtimeStream == null) {
                throw new IOException("AILoc2 Claude Code runtime resource is missing: " + CLAUDE_RUNTIME_RESOURCE_PATH);
            }
            Files.copy(runtimeStream, getClaudeRuntimePath(repoRoot), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }

        JsonObject hooks = settings.has("hooks") && settings.get("hooks").isJsonObject()
            ? settings.getAsJsonObject("hooks")
            : new JsonObject();
        removeManagedClaudeHookCommands(hooks);
        addManagedClaudeHook(hooks, "PreToolUse", createManagedClaudeCommand(repoRoot, "capture-before"));
        addManagedClaudeHook(hooks, "PostToolUse", createManagedClaudeCommand(repoRoot, "record-edit"));
        settings.add("hooks", hooks);
        Files.writeString(settingsPath, GSON.toJson(settings) + "\n", StandardCharsets.UTF_8);
    }

    private boolean removeClaudeCodeAssets(Path repoRoot) throws IOException {
        boolean removed = false;
        Path settingsPath = getClaudeSettingsPath(repoRoot);
        IOException settingsError = null;
        try {
            if (Files.exists(settingsPath)) {
                JsonObject settings = readClaudeSettings(settingsPath);
                if (settings.has("hooks") && settings.get("hooks").isJsonObject()) {
                    removeManagedClaudeHookCommands(settings.getAsJsonObject("hooks"));
                    Files.writeString(settingsPath, GSON.toJson(settings) + "\n", StandardCharsets.UTF_8);
                    removed = true;
                }
            }
        }
        catch (IOException error) {
            settingsError = error;
        }

        try {
            removed = Files.deleteIfExists(getClaudeRuntimePath(repoRoot)) || removed;
        }
        catch (IOException runtimeError) {
            if (settingsError != null) {
                runtimeError.addSuppressed(settingsError);
            }
            throw runtimeError;
        }
        if (settingsError != null) {
            throw settingsError;
        }
        return removed;
    }

    private boolean isManagedClaudeCodeInstalled(Path root) throws IOException {
        if (!Files.isRegularFile(getClaudeRuntimePath(root))) {
            return false;
        }
        JsonObject settings = readClaudeSettings(getClaudeSettingsPath(root));
        if (!settings.has("hooks") || !settings.get("hooks").isJsonObject()) {
            return false;
        }
        for (JsonElement eventHooks : settings.getAsJsonObject("hooks").entrySet().stream().map(Map.Entry::getValue).toList()) {
            if (!eventHooks.isJsonArray()) {
                continue;
            }
            for (JsonElement groupElement : eventHooks.getAsJsonArray()) {
                if (!groupElement.isJsonObject()) {
                    continue;
                }
                JsonObject group = groupElement.getAsJsonObject();
                if (!group.has("hooks") || !group.get("hooks").isJsonArray()) {
                    continue;
                }
                for (JsonElement commandElement : group.getAsJsonArray("hooks")) {
                    if (isManagedClaudeCommand(commandElement)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private JsonObject readClaudeSettings(Path settingsPath) throws IOException {
        if (!Files.exists(settingsPath)) {
            return new JsonObject();
        }

        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(settingsPath, StandardCharsets.UTF_8));
            if (!parsed.isJsonObject()) {
                throw new IOException("Existing Claude settings must contain a JSON object: " + settingsPath);
            }
            return parsed.getAsJsonObject();
        }
        catch (RuntimeException error) {
            throw new IOException("AILoc2 could not parse existing Claude settings: " + settingsPath, error);
        }
    }

    private void addManagedClaudeHook(JsonObject hooks, String eventName, String command) {
        JsonArray eventHooks = hooks.has(eventName) && hooks.get(eventName).isJsonArray()
            ? hooks.getAsJsonArray(eventName)
            : new JsonArray();
        JsonObject hookGroup = new JsonObject();
        hookGroup.addProperty("matcher", CLAUDE_MANAGED_TOOL_MATCHER);
        JsonArray commands = new JsonArray();
        JsonObject commandHook = new JsonObject();
        commandHook.addProperty("type", "command");
        commandHook.addProperty("command", command);
        commands.add(commandHook);
        hookGroup.add("hooks", commands);
        eventHooks.add(hookGroup);
        hooks.add(eventName, eventHooks);
    }

    private void removeManagedClaudeHookCommands(JsonObject hooks) {
        for (String eventName : new ArrayList<>(hooks.keySet())) {
            JsonElement value = hooks.get(eventName);
            if (!value.isJsonArray()) {
                continue;
            }

            JsonArray filteredGroups = new JsonArray();
            for (JsonElement groupElement : value.getAsJsonArray()) {
                if (!groupElement.isJsonObject()) {
                    continue;
                }
                JsonObject group = groupElement.getAsJsonObject();
                JsonArray commands = group.has("hooks") && group.get("hooks").isJsonArray()
                    ? group.getAsJsonArray("hooks")
                    : new JsonArray();
                JsonArray unmanagedCommands = new JsonArray();
                for (JsonElement commandElement : commands) {
                    if (!isManagedClaudeCommand(commandElement)) {
                        unmanagedCommands.add(commandElement);
                    }
                }
                if (!unmanagedCommands.isEmpty()) {
                    group.add("hooks", unmanagedCommands);
                    filteredGroups.add(group);
                }
            }
            hooks.add(eventName, filteredGroups);
        }
    }

    private boolean isManagedClaudeCommand(JsonElement commandElement) {
        if (!commandElement.isJsonObject()) {
            return false;
        }
        JsonElement command = commandElement.getAsJsonObject().get("command");
        return command != null && command.isJsonPrimitive() && command.getAsString().contains(CLAUDE_RUNTIME_FILE_NAME);
    }

    private String createManagedClaudeCommand(Path repoRoot, String command) {
        return "node \"" + getClaudeRuntimePath(repoRoot).toString().replace("\"", "\\\"") + "\" " + command;
    }

    private boolean removeManagedHookFile(Path repoRoot, String hookFileName) throws IOException {
        Path hookFilePath = getRepoHooksDirectoryPath(repoRoot).resolve(hookFileName);
        if (!Files.exists(hookFilePath)) {
            return false;
        }

        String existingContents = Files.readString(hookFilePath, StandardCharsets.UTF_8);
        if (!isManagedHookFileText(hookFileName, existingContents)) {
            return false;
        }

        HookDelegateSpec restorableDelegate = extractWrappedHookDelegateSpecs(existingContents).stream()
            .filter(delegateSpec -> delegateSpec.path().equals(getWrappedHookDelegateScriptPath(hookFileName)))
            .findFirst()
            .orElse(null);
        if (restorableDelegate != null) {
            Path restorableDelegatePath = repoRoot.resolve(restorableDelegate.path()).normalize();
            if (Files.exists(restorableDelegatePath)) {
                Files.deleteIfExists(hookFilePath);
                Files.move(restorableDelegatePath, hookFilePath);
                return true;
            }
        }

        Files.deleteIfExists(hookFilePath);
        return true;
    }

    private boolean removeRuntimeAsset(Path repoRoot) throws IOException {
        Path runtimeFilePath = getRuntimeFilePath(repoRoot);
        if (!Files.exists(runtimeFilePath)) {
            return false;
        }

        String existingContents = Files.readString(runtimeFilePath, StandardCharsets.UTF_8);
        if (!existingContents.contains("# AILoc2 managed IntelliJ hook runtime")) {
            return false;
        }

        Files.deleteIfExists(runtimeFilePath);
        return true;
    }

    private void removeEmptyHookDirectoryIfPossible(Path repoRoot) {
        Path hookDirectoryPath = getRepoHooksDirectoryPath(repoRoot);
        try (var remainingEntries = Files.exists(hookDirectoryPath) ? Files.list(hookDirectoryPath) : null) {
            if (remainingEntries != null && remainingEntries.findAny().isEmpty()) {
                Files.deleteIfExists(hookDirectoryPath);
            }
        }
        catch (IOException ignored) {
            // Nothing to do if the hook directory cannot be removed.
        }
    }

    private Path getRepoHooksDirectoryPath(Path repoRoot) {
        return repoRoot.resolve(REPO_HOOKS_DIRECTORY_NAME);
    }

    private Path getRuntimeFilePath(Path repoRoot) {
        return getRepoHooksDirectoryPath(repoRoot).resolve(RUNTIME_FILE_NAME);
    }

    private Path getClaudeDirectoryPath(Path repoRoot) {
        return repoRoot.resolve(CLAUDE_DIRECTORY_NAME);
    }

    private Path getClaudeSettingsPath(Path repoRoot) {
        return getClaudeDirectoryPath(repoRoot).resolve("settings.json");
    }

    private Path getClaudeRuntimePath(Path repoRoot) {
        return getClaudeDirectoryPath(repoRoot).resolve(CLAUDE_RUNTIME_FILE_NAME);
    }

    private boolean isRepoManagedHooksPath(Path repoRoot, String candidateHooksPath) {
        if (candidateHooksPath == null || candidateHooksPath.isBlank()) {
            return false;
        }

        Path resolvedCandidatePath = Path.of(candidateHooksPath).isAbsolute()
            ? Path.of(candidateHooksPath)
            : repoRoot.resolve(candidateHooksPath);
        return normalizePath(resolvedCandidatePath).equals(normalizePath(getRepoHooksDirectoryPath(repoRoot)));
    }

    private String normalizePath(Path path) {
        return path.toAbsolutePath().normalize().toString().replace('\\', '/');
    }

    private String createManagedHookFileContents(String hookFileName, List<HookDelegateSpec> delegateSpecs) {
        return switch (hookFileName) {
            case "pre-commit" -> createManagedPreCommitHookScript(delegateSpecs);
            case "commit-msg" -> createManagedCommitMsgHookScript(delegateSpecs);
            case "post-commit" -> createManagedPostCommitHookScript(delegateSpecs);
            default -> throw new IllegalArgumentException("Unsupported managed hook file: " + hookFileName);
        };
    }

    private String createManagedPreCommitHookScript(List<HookDelegateSpec> delegateSpecs) {
        return """
            #!/bin/sh
            # AILoc2 managed IntelliJ hook: pre-commit
            %s

            RUNTIME_PATH="./.githooks/%s"

            %s

            if [ -f "$RUNTIME_PATH" ]; then
                sh "$RUNTIME_PATH" refresh-summary >/dev/null 2>&1 && sh "$RUNTIME_PATH" prepare-commit-audit >/dev/null 2>&1 || printf '%%s\\n' 'AILoc2 pre-commit warning: IntelliJ summary or audit refresh failed; continuing without blocking the commit.' >&2
            else
                printf '%%s\\n' 'AILoc2 pre-commit warning: IntelliJ hook runtime is unavailable; skipping summary refresh.' >&2
            fi

            run_delegate_hooks "$@"
            exit $?
            """.formatted(createWrappedDelegateMarkerBlock(delegateSpecs), RUNTIME_FILE_NAME, createDelegateHookFunction(delegateSpecs));
    }

    private String createManagedCommitMsgHookScript(List<HookDelegateSpec> delegateSpecs) {
        return """
            #!/bin/sh
            # AILoc2 managed IntelliJ hook: commit-msg
            %s

            MESSAGE_FILE="$1"
            RUNTIME_PATH="./.githooks/%s"
            PLACEHOLDER_ANNOTATION='(AI-Lines: unavailable)'

            %s

            append_placeholder_annotation() {
                if [ -z "$MESSAGE_FILE" ] || [ ! -f "$MESSAGE_FILE" ]; then
                    return 0
                fi

                TEMP_FILE="${MESSAGE_FILE}.ailoc2.$$"
                SUBJECT_LINE=$(sed -n '1p' "$MESSAGE_FILE" | sed -E 's/(^|[[:space:]]+)([(]AI:? [^)]*[)]|[(]AI lines: [^)]*[)]|[(]H lines: [^)]*[)]|[(]AI-Lines: [^)]*[)])([[:space:]]+([(]AI:? [^)]*[)]|[(]AI lines: [^)]*[)]|[(]H lines: [^)]*[)]|[(]AI-Lines: [^)]*[)]))*$//')
                {
                    printf '%%s\n\n%%s\n' "$SUBJECT_LINE" "$PLACEHOLDER_ANNOTATION"
                    sed '1d' "$MESSAGE_FILE" | awk '
                        /^[[:space:]]*[(]AI-Lines: [^)]*[)][[:space:]]*$/ { next }
                        !started && /^[[:space:]]*$/ { next }
                        { if (!started) { print ""; started = 1 } print }
                    '
                } > "$TEMP_FILE" && mv "$TEMP_FILE" "$MESSAGE_FILE"
            }

            if [ -n "$MESSAGE_FILE" ] && [ -f "$RUNTIME_PATH" ]; then
                sh "$RUNTIME_PATH" annotate-commit-message "$MESSAGE_FILE" >/dev/null 2>&1 || append_placeholder_annotation
            elif [ -n "$MESSAGE_FILE" ]; then
                append_placeholder_annotation
                printf '%%s\\n' 'AILoc2 commit-msg warning: IntelliJ hook runtime is unavailable; using unavailable attribution.' >&2
            fi

            run_delegate_hooks "$@"
            exit $?
            """.formatted(createWrappedDelegateMarkerBlock(delegateSpecs), RUNTIME_FILE_NAME, createDelegateHookFunction(delegateSpecs));
    }

    String createManagedCommitMsgHookScript() {
        return createManagedCommitMsgHookScript(List.of());
    }

    private String createManagedPostCommitHookScript(List<HookDelegateSpec> delegateSpecs) {
        return """
            #!/bin/sh
            # AILoc2 managed IntelliJ hook: post-commit
            %s

            RUNTIME_PATH="./.githooks/%s"

            %s

            if [ -f "$RUNTIME_PATH" ]; then
                sh "$RUNTIME_PATH" finalize-commit >/dev/null 2>&1 || printf '%%s\\n' 'AILoc2 post-commit warning: IntelliJ committed metrics cleanup failed.' >&2
            fi

            run_delegate_hooks "$@"
            exit $?
            """.formatted(createWrappedDelegateMarkerBlock(delegateSpecs), RUNTIME_FILE_NAME, createDelegateHookFunction(delegateSpecs));
    }

    String createManagedRuntimeScript() {
        return """
            #!/bin/sh
            # AILoc2 managed IntelliJ hook runtime

            SUMMARY_FILE=".ailoc2-metrics/summary.json"
            STATE_DIR=".ailoc2-metrics/intellij-state"
            AUDIT_DIR=".ailoc2-metrics/commit-audits"
            PLACEHOLDER_ANNOTATION='(AI-Lines: unavailable)'

            refresh_summary() {
                REPO_ROOT=$(pwd)
                REPO_NAME=${REPO_ROOT##*/}
                DETAILS_FILE="$STATE_DIR/.summary-details.$$"
                mkdir -p "$STATE_DIR"
                : > "$DETAILS_FILE"
                SUMMARY_DATA=$(git diff --cached --unified=0 --find-renames --no-color --ignore-all-space | awk -v state_dir="$STATE_DIR" -v details_file="$DETAILS_FILE" '
                    function safe_state_file(path, safe) {
                        safe = path
                        gsub(/\\\\/, "/", safe)
                        gsub(/[^A-Za-z0-9._-]/, "_", safe)
                        return safe ".tsv"
                    }
                    function non_whitespace_length(text, compact) {
                        compact = text
                        gsub(/[[:space:]]/, "", compact)
                        return length(compact)
                    }
                    function bucket_for(path, line_number, state_file, state_line, parts, found, ai_magnitude, human_magnitude) {
                        state_file = state_dir "/" safe_state_file(path)
                        found = ""
                        ai_magnitude = 0
                        human_magnitude = 0
                        while ((getline state_line < state_file) > 0) {
                            split(state_line, parts, "\\t")
                            if (parts[1] == "aiMagnitude") {
                                ai_magnitude = parts[2] + 0
                            }
                            else if (parts[1] == "humanMagnitude") {
                                human_magnitude = parts[2] + 0
                            }
                            else if (parts[1] == "line" && (parts[2] + 0) == line_number) {
                                found = parts[3]
                            }
                        }
                        close(state_file)
                        if (found != "") {
                            return found
                        }
                        if (ai_magnitude == 0 && human_magnitude == 0) {
                            return "UNKNOWN"
                        }
                        return ai_magnitude >= human_magnitude ? "AI" : "HUMAN"
                    }
                    /^\\+\\+\\+ / {
                        current_path = substr($0, 5)
                        sub(/^[[:space:]]+/, "", current_path)
                        sub(/[[:space:]]+$/, "", current_path)
                        if (current_path == "/dev/null") {
                            current_path = ""
                        }
                        sub(/^b\\//, "", current_path)
                        current_line = 0
                        if (current_path != "") {
                            changed[current_path] = 1
                        }
                        next
                    }
                    /^@@ / {
                        hunk = $0
                        sub(/^@@ -[0-9][0-9]*(,[0-9][0-9]*)? \\+/, "", hunk)
                        sub(/ @@.*$/, "", hunk)
                        split(hunk, range_parts, ",")
                        current_line = range_parts[1] + 0
                        next
                    }
                    current_path != "" && current_line > 0 && /^\\+/ && !/^\\+\\+\\+ / {
                        bucket = bucket_for(current_path, current_line)
                        weight = non_whitespace_length(substr($0, 2))
                        if (weight > 0 && bucket == "AI") {
                            ai_weight += weight
                            ai_line_count++
                            ai_by_path[current_path] += weight
                            attributed[current_path] = 1
                        }
                        else if (weight > 0 && bucket == "HUMAN") {
                            human_weight += weight
                            human_line_count++
                            human_by_path[current_path] += weight
                            attributed[current_path] = 1
                        }
                        else if (weight > 0) {
                            unknown_line_count++
                        }
                        current_line++
                        next
                    }
                    current_path != "" && current_line > 0 && /^ / {
                        current_line++
                    }
                    END {
                        changed_count = 0
                        attributed_count = 0
                        for (path in changed) {
                            changed_count++
                        }
                        for (path in attributed) {
                            attributed_count++
                            printf "%s\\t%d\\t%d\\n", path, ai_by_path[path] + 0, human_by_path[path] + 0 > details_file
                        }
                        printf "%d %d %d %d %d %d %d\\n", changed_count, attributed_count, ai_weight, human_weight, ai_line_count, human_line_count, unknown_line_count
                    }
                ')

                set -- $SUMMARY_DATA
                CHANGED_FILE_COUNT=${1:-0}
                ATTRIBUTED_CHANGED_FILE_COUNT=${2:-0}
                AI_WEIGHT=${3:-0}
                HUMAN_WEIGHT=${4:-0}
                AI_LINE_COUNT=${5:-0}
                HUMAN_LINE_COUNT=${6:-0}
                UNKNOWN_LINE_COUNT=${7:-0}
                TOTAL_WEIGHT=$((AI_WEIGHT + HUMAN_WEIGHT))
                if [ "$TOTAL_WEIGHT" -gt 0 ]; then
                    AI_PERCENTAGE=$(awk -v ai="$AI_WEIGHT" -v total="$TOTAL_WEIGHT" 'BEGIN { printf "%.6f", (ai / total) * 100 }')
                    HUMAN_PERCENTAGE=$(awk -v human="$HUMAN_WEIGHT" -v total="$TOTAL_WEIGHT" 'BEGIN { printf "%.6f", (human / total) * 100 }')
                else
                    AI_PERCENTAGE="0.000000"
                    HUMAN_PERCENTAGE="0.000000"
                fi
                AI_DISPLAY=$(awk -v value="$AI_PERCENTAGE" 'BEGIN { printf "%.2f", value }')
                HUMAN_DISPLAY=$(awk -v value="$HUMAN_PERCENTAGE" 'BEGIN { printf "%.2f", value }')
                GENERATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
                SUMMARY_LINE="$REPO_NAME: STAGED -> AI $AI_DISPLAY% | Human $HUMAN_DISPLAY% | AI lines $AI_LINE_COUNT | Human lines $HUMAN_LINE_COUNT | Unknown lines $UNKNOWN_LINE_COUNT"
                ESCAPED_REPO_ROOT=$(printf '%s' "$REPO_ROOT" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
                ESCAPED_REPO_NAME=$(printf '%s' "$REPO_NAME" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
                ESCAPED_SUMMARY_LINE=$(printf '%s' "$SUMMARY_LINE" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')

                mkdir -p "$(dirname "$SUMMARY_FILE")"
                {
                    printf '{\\n'
                    printf '  "schemaVersion": "1",\\n'
                    printf '  "recordType": "hook-summary",\\n'
                    printf '  "generatedAt": "%s",\\n' "$GENERATED_AT"
                    printf '  "repoRoot": "%s",\\n' "$ESCAPED_REPO_ROOT"
                    printf '  "repoName": "%s",\\n' "$ESCAPED_REPO_NAME"
                    printf '  "isGitSummaryAvailable": true,\\n'
                    printf '  "summaryLine": "%s",\\n' "$ESCAPED_SUMMARY_LINE"
                    printf '  "staged": {\\n'
                    printf '    "changedFileCount": %s,\\n' "$CHANGED_FILE_COUNT"
                    printf '    "attributedChangedFileCount": %s,\\n' "$ATTRIBUTED_CHANGED_FILE_COUNT"
                    printf '    "aiWeightedChangedLines": %s,\\n' "$AI_WEIGHT"
                    printf '    "humanWeightedChangedLines": %s,\\n' "$HUMAN_WEIGHT"
                    printf '    "aiAddedLineCount": %s,\\n' "$AI_LINE_COUNT"
                    printf '    "humanAddedLineCount": %s,\\n' "$HUMAN_LINE_COUNT"
                    printf '    "unknownAddedLineCount": %s,\\n' "$UNKNOWN_LINE_COUNT"
                    printf '    "aiPercentage": %s,\\n' "$AI_PERCENTAGE"
                    printf '    "humanPercentage": %s,\\n' "$HUMAN_PERCENTAGE"
                    printf '    "files": {'
                    FIRST_FILE=true
                    while IFS="$(printf '\\t')" read -r FILE_PATH FILE_AI_WEIGHT FILE_HUMAN_WEIGHT; do
                        [ -n "$FILE_PATH" ] || continue
                        ESCAPED_FILE_PATH=$(printf '%s' "$FILE_PATH" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
                        if [ "$FIRST_FILE" = true ]; then
                            FIRST_FILE=false
                        else
                            printf ','
                        fi
                        printf '\\n      "%s": {"aiWeightedChangedLines": %s, "humanWeightedChangedLines": %s}' "$ESCAPED_FILE_PATH" "$FILE_AI_WEIGHT" "$FILE_HUMAN_WEIGHT"
                    done < "$DETAILS_FILE"
                    if [ "$FIRST_FILE" = false ]; then
                        printf '\\n'
                    fi
                    printf '    }\\n'
                    printf '  }\\n'
                    printf '}\\n'
                } > "$SUMMARY_FILE"
                rm -f "$DETAILS_FILE"
            }

            prepare_commit_audit() {
                [ -f "$SUMMARY_FILE" ] || return 1
                mkdir -p "$AUDIT_DIR"
                cp "$SUMMARY_FILE" "$AUDIT_DIR/pending.json"
            }

            append_annotation() {
                MESSAGE_FILE="$1"
                ANNOTATION="$2"
                if [ -z "$MESSAGE_FILE" ] || [ ! -f "$MESSAGE_FILE" ]; then
                    return 0
                fi

                TEMP_FILE="${MESSAGE_FILE}.ailoc2.$$"
                SUBJECT_LINE=$(sed -n '1p' "$MESSAGE_FILE" | sed -E 's/(^|[[:space:]]+)([(]AI:? [^)]*[)]|[(]AI lines: [^)]*[)]|[(]H lines: [^)]*[)]|[(]AI-Lines: [^)]*[)])([[:space:]]+([(]AI:? [^)]*[)]|[(]AI lines: [^)]*[)]|[(]H lines: [^)]*[)]|[(]AI-Lines: [^)]*[)]))*$//')

                {
                    printf '%s\n\n%s\n' "$SUBJECT_LINE" "$ANNOTATION"
                    sed '1d' "$MESSAGE_FILE" | awk '
                        /^[[:space:]]*[(]AI-Lines: [^)]*[)][[:space:]]*$/ { next }
                        !started && /^[[:space:]]*$/ { next }
                        { if (!started) { print ""; started = 1 } print }
                    '
                } > "$TEMP_FILE" && mv "$TEMP_FILE" "$MESSAGE_FILE"
            }

            annotate_commit_message() {
                MESSAGE_FILE="$1"
                refresh_summary
                prepare_commit_audit
                if grep -q '"isGitSummaryAvailable"[[:space:]]*:[[:space:]]*true' "$SUMMARY_FILE"; then
                    AI_PERCENTAGE=$(sed -n 's/.*"aiPercentage"[[:space:]]*:[[:space:]]*\\([0-9.][0-9.]*\\).*/\\1/p' "$SUMMARY_FILE" | head -n 1)
                    AI_LINE_COUNT=$(sed -n 's/.*"aiAddedLineCount"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$SUMMARY_FILE" | head -n 1)
                    HUMAN_LINE_COUNT=$(sed -n 's/.*"humanAddedLineCount"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$SUMMARY_FILE" | head -n 1)
                    UNKNOWN_LINE_COUNT=$(sed -n 's/.*"unknownAddedLineCount"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$SUMMARY_FILE" | head -n 1)
                    if [ -n "$AI_PERCENTAGE" ] && [ -n "$AI_LINE_COUNT" ] && [ -n "$HUMAN_LINE_COUNT" ] && [ -n "$UNKNOWN_LINE_COUNT" ]; then
                        TOTAL_LINE_COUNT=$((AI_LINE_COUNT + HUMAN_LINE_COUNT + UNKNOWN_LINE_COUNT))
                        append_annotation "$MESSAGE_FILE" "(AI-Lines: $AI_LINE_COUNT/$TOTAL_LINE_COUNT)"
                        return 0
                    fi
                fi
                append_annotation "$MESSAGE_FILE" "$PLACEHOLDER_ANNOTATION"
            }

            # Convert a repo-relative path into the sanitized filename used under intellij-state.
            safe_state_file() {
                printf '%s' "$1" | sed 's#\\\\#/#g; s#[^A-Za-z0-9._-]#_#g'
            }

            # Return success when the path still has unstaged modifications or untracked content.
            has_unstaged_work() {
                REPO_RELATIVE_PATH="$1"
                if ! git diff --quiet -- "$REPO_RELATIVE_PATH"; then
                    return 0
                fi
                if git ls-files --others --exclude-standard -- "$REPO_RELATIVE_PATH" | grep -q .; then
                    return 0
                fi
                return 1
            }

            clear_committed_state() {
                git diff-tree --no-commit-id --name-only -r HEAD | while IFS= read -r COMMITTED_PATH; do
                    if [ -z "$COMMITTED_PATH" ] || has_unstaged_work "$COMMITTED_PATH"; then
                        continue
                    fi

                    STATE_FILE="$STATE_DIR/$(safe_state_file "$COMMITTED_PATH").tsv"
                    rm -f "$STATE_FILE"
                done
            }

            finalize_commit() {
                COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null || true)
                if [ -n "$COMMIT_HASH" ] && [ -f "$AUDIT_DIR/pending.json" ]; then
                    mv "$AUDIT_DIR/pending.json" "$AUDIT_DIR/$COMMIT_HASH.json"
                fi
                clear_committed_state
                refresh_summary
            }

            case "$1" in
                refresh-summary)
                    refresh_summary
                    ;;
                prepare-commit-audit)
                    prepare_commit_audit
                    ;;
                finalize-commit)
                    finalize_commit
                    ;;
                annotate-commit-message)
                    annotate_commit_message "$2"
                    ;;
                append-placeholder)
                    append_annotation "$2" "$PLACEHOLDER_ANNOTATION"
                    ;;
                *)
                    printf '%s\\n' 'Usage: ailoc2-intellij-hook-runtime.sh <refresh-summary|prepare-commit-audit|finalize-commit|annotate-commit-message <messageFile>|append-placeholder <messageFile>>' >&2
                    exit 1
                    ;;
            esac
            """;
    }

    private String createDelegatedHookScriptPath(String delegatedHooksPath, String hookFileName) {
        if (delegatedHooksPath == null || delegatedHooksPath.isBlank()) {
            return "";
        }

        return delegatedHooksPath.replace('\\', '/') + "/" + hookFileName;
    }

    private List<HookDelegateSpec> createHookDelegateSpecs(String hookFileName, String delegatedHooksPath, List<String> wrappedHookFiles) {
        List<HookDelegateSpec> delegateSpecs = new ArrayList<>();
        if (wrappedHookFiles.contains(hookFileName)) {
            delegateSpecs.add(new HookDelegateSpec(getWrappedHookDelegateScriptPath(hookFileName), true));
        }

        String delegatedHookPath = createDelegatedHookScriptPath(delegatedHooksPath, hookFileName);
        if (!delegatedHookPath.isBlank()) {
            delegateSpecs.add(new HookDelegateSpec(delegatedHookPath, false));
        }

        return delegateSpecs;
    }

    private String createDelegateHookFunction(List<HookDelegateSpec> delegateSpecs) {
        StringBuilder builder = new StringBuilder("run_delegate_hooks() {\n");
        for (HookDelegateSpec delegateSpec : delegateSpecs) {
            builder
                .append("    DELEGATE_HOOK_PATH=\"")
                .append(escapeForDoubleQuotedShell(delegateSpec.path()))
                .append("\"\n")
                .append("    if [ -n \"$DELEGATE_HOOK_PATH\" ] && [ -f \"$DELEGATE_HOOK_PATH\" ]; then\n")
                .append("        \"$DELEGATE_HOOK_PATH\" \"$@\" || return $?\n")
                .append("    fi\n\n");
        }
        builder.append("    return 0\n}");
        return builder.toString();
    }

    private String createWrappedDelegateMarkerBlock(List<HookDelegateSpec> delegateSpecs) {
        List<String> wrappedDelegateMarkers = delegateSpecs.stream()
            .filter(HookDelegateSpec::wrapped)
            .map(delegateSpec -> WRAPPED_HOOK_DELEGATE_MARKER_PREFIX + delegateSpec.path())
            .toList();
        return wrappedDelegateMarkers.isEmpty()
            ? ""
            : String.join("\n", wrappedDelegateMarkers) + "\n";
    }

    private List<HookDelegateSpec> mergeHookDelegateSpecs(List<HookDelegateSpec> first, List<HookDelegateSpec> second) {
        List<HookDelegateSpec> mergedDelegateSpecs = new ArrayList<>();
        for (HookDelegateSpec delegateSpec : first) {
            mergeHookDelegateSpec(mergedDelegateSpecs, delegateSpec);
        }
        for (HookDelegateSpec delegateSpec : second) {
            mergeHookDelegateSpec(mergedDelegateSpecs, delegateSpec);
        }
        return mergedDelegateSpecs;
    }

    private void mergeHookDelegateSpec(List<HookDelegateSpec> delegateSpecs, HookDelegateSpec delegateSpec) {
        for (int i = 0; i < delegateSpecs.size(); i++) {
            HookDelegateSpec existingDelegateSpec = delegateSpecs.get(i);
            if (existingDelegateSpec.path().equals(delegateSpec.path())) {
                delegateSpecs.set(i, new HookDelegateSpec(existingDelegateSpec.path(), existingDelegateSpec.wrapped() || delegateSpec.wrapped()));
                return;
            }
        }

        delegateSpecs.add(delegateSpec);
    }

    private List<HookDelegateSpec> extractWrappedHookDelegateSpecs(String text) {
        return normalizeHookFileText(text)
            .lines()
            .map(String::trim)
            .filter(line -> line.startsWith(WRAPPED_HOOK_DELEGATE_MARKER_PREFIX))
            .map(line -> line.substring(WRAPPED_HOOK_DELEGATE_MARKER_PREFIX.length()).trim())
            .filter(path -> !path.isBlank())
            .map(path -> new HookDelegateSpec(path, true))
            .toList();
    }

    private Path getWrappedHookDelegateFilePath(Path repoRoot, String hookFileName) {
        return getRepoHooksDirectoryPath(repoRoot).resolve(getWrappedHookDelegateFileName(hookFileName));
    }

    private String getWrappedHookDelegateScriptPath(String hookFileName) {
        return REPO_HOOKS_PATH_VALUE + "/" + getWrappedHookDelegateFileName(hookFileName);
    }

    private String getWrappedHookDelegateFileName(String hookFileName) {
        return hookFileName + WRAPPED_HOOK_DELEGATE_FILE_SUFFIX;
    }

    private String escapeForDoubleQuotedShell(String value) {
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("$", "\\$")
            .replace("`", "\\`");
    }

    private boolean isManagedHookFileText(String hookFileName, String text) {
        return normalizeHookFileText(text)
            .lines()
            .anyMatch(line -> line.trim().equals(MANAGED_HOOK_MARKER_PREFIX + hookFileName));
    }

    private String normalizeHookFileText(String text) {
        return text.replace("\r\n", "\n").trim();
    }

    private String getGitConfigValue(Path repoRoot, String key, GitConfigScope scope) throws IOException, InterruptedException {
        List<String> args = scope == GitConfigScope.LOCAL
            ? List.of("config", "--local", "--get", key)
            : List.of("config", "--get", key);
        GitCommandResult result = runGit(repoRoot, args);
        if (result.exitCode() != 0) {
            return null;
        }

        String value = result.stdout().trim();
        return value.isEmpty() ? null : value;
    }

    private void setLocalGitConfigValue(Path repoRoot, String key, String value) throws IOException, InterruptedException {
        runGitOrThrow(repoRoot, List.of("config", "--local", key, value));
    }

    private void unsetLocalGitConfigValue(Path repoRoot, String key, boolean ignoreMissing) throws IOException, InterruptedException {
        GitCommandResult result = runGit(repoRoot, List.of("config", "--local", "--unset", key));
        if (result.exitCode() != 0 && !ignoreMissing) {
            throw new IOException("git config --unset failed for " + key + ": " + result.stderr().trim());
        }
    }

    private void runGitOrThrow(Path repoRoot, List<String> args) throws IOException, InterruptedException {
        GitCommandResult result = runGit(repoRoot, args);
        if (result.exitCode() != 0) {
            throw new IOException("git " + String.join(" ", args) + " failed: " + result.stderr().trim());
        }
    }

    private GitCommandResult runGit(Path repoRoot, List<String> args) throws IOException, InterruptedException {
        List<String> command = new ArrayList<>();
        command.add("git");
        command.addAll(args);
        ProcessBuilder processBuilder = new ProcessBuilder(command);
        processBuilder.directory(repoRoot.toFile());
        Process process = processBuilder.start();
        String stdout = readProcessText(process.getInputStream());
        String stderr = readProcessText(process.getErrorStream());
        int exitCode = process.waitFor();
        return new GitCommandResult(exitCode, stdout, stderr);
    }

    private String readProcessText(java.io.InputStream inputStream) throws IOException {
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line).append('\n');
            }
        }
        return builder.toString();
    }

    private void markExecutableBestEffort(Path path) {
        try {
            Set<PosixFilePermission> permissions = EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE,
                PosixFilePermission.GROUP_READ,
                PosixFilePermission.GROUP_EXECUTE,
                PosixFilePermission.OTHERS_READ,
                PosixFilePermission.OTHERS_EXECUTE
            );
            Files.setPosixFilePermissions(path, permissions);
        }
        catch (IOException | UnsupportedOperationException ignored) {
            // Git for Windows does not depend on POSIX executable bits.
        }
    }

    enum HookInstallStatus {
        INSTALLED,
        ALREADY_INSTALLED,
        CONFLICT,
        HOOK_FILE_CONFLICT,
        MANUAL_MERGE_REQUIRED
    }

    enum HookUninstallStatus {
        UNINSTALLED,
        RESTORED_PREVIOUS,
        NOT_INSTALLED
    }

    enum WorkspaceClaudeInstallStatus {
        INSTALLED,
        ALREADY_INSTALLED
    }

    enum WorkspaceClaudeUninstallStatus {
        UNINSTALLED,
        NOT_INSTALLED
    }

    record HookInstallResult(
        HookInstallStatus status,
        Path repoRoot,
        Path hooksDirectoryPath,
        String currentLocalHooksPath,
        String currentEffectiveHooksPath,
        String replacedPreviousLocalHooksPath,
        String delegatedHooksPath,
        List<String> conflictingHookFiles,
        List<String> wrappedHookFiles,
        List<String> manualMergeHookFiles
    ) {}

    record HookUninstallResult(
        HookUninstallStatus status,
        Path repoRoot,
        Path hooksDirectoryPath,
        String currentLocalHooksPath,
        String currentEffectiveHooksPath,
        String restoredHooksPath,
        boolean removedManagedHookAssets
    ) {}

    record WorkspaceClaudeInstallResult(
        WorkspaceClaudeInstallStatus status,
        Path workspaceRoot,
        Path settingsPath,
        Path runtimePath
    ) {}

    record WorkspaceClaudeUninstallResult(
        WorkspaceClaudeUninstallStatus status,
        Path workspaceRoot,
        boolean removedManagedClaudeAssets
    ) {}

    private enum GitConfigScope {
        LOCAL,
        EFFECTIVE
    }

    private record HookDelegateSpec(String path, boolean wrapped) {}

    private record HookFileWrapResult(List<String> wrappedHookFiles, List<String> manualMergeHookFiles) {}

    private record GitCommandResult(int exitCode, String stdout, String stderr) {}
}
