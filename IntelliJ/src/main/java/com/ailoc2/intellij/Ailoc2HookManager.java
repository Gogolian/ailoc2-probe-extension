package com.ailoc2.intellij;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;

final class Ailoc2HookManager {
    private static final String REPO_HOOKS_DIRECTORY_NAME = ".githooks";
    private static final String REPO_HOOKS_PATH_VALUE = ".githooks";
    private static final String RUNTIME_FILE_NAME = "ailoc2-intellij-hook-runtime.sh";
    private static final String CORE_HOOKS_PATH_CONFIG_KEY = "core.hooksPath";
    private static final String PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY = "ailoc2Probe.previousLocalHooksPath";
    private static final String DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY = "ailoc2Probe.delegateLocalHooksPath";
    private static final String MANAGED_HOOK_MARKER_PREFIX = "# AILoc2 managed IntelliJ hook: ";
    private static final List<String> REQUIRED_REPO_HOOK_FILES = List.of("pre-commit", "commit-msg", "post-commit");

    HookInstallResult installRepoHooks(Path repoRoot, boolean allowReplacingExistingLocalHooksPath, boolean chainExistingLocalHooksPath)
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
                null
            );
        }

        ensureManagedRepoHookAssetsInstalled(normalizedRepoRoot, delegatedHooksPath);

        if (isAlreadyInstalled) {
            return new HookInstallResult(
                HookInstallStatus.ALREADY_INSTALLED,
                normalizedRepoRoot,
                hooksDirectoryPath,
                currentLocalHooksPath,
                currentEffectiveHooksPath,
                null,
                delegatedHooksPath
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
            delegatedHooksPath
        );
    }

    HookUninstallResult uninstallRepoHooks(Path repoRoot) throws IOException, InterruptedException {
        Path normalizedRepoRoot = repoRoot.toAbsolutePath().normalize();
        Path hooksDirectoryPath = getRepoHooksDirectoryPath(normalizedRepoRoot);
        String currentLocalHooksPath = getGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, GitConfigScope.LOCAL);
        String currentEffectiveHooksPath = getGitConfigValue(normalizedRepoRoot, CORE_HOOKS_PATH_CONFIG_KEY, GitConfigScope.EFFECTIVE);
        boolean removedManagedHookAssets = removeManagedHookAssets(normalizedRepoRoot);

        if (!isRepoManagedHooksPath(normalizedRepoRoot, currentLocalHooksPath)) {
            if (removedManagedHookAssets) {
                unsetLocalGitConfigValue(normalizedRepoRoot, PREVIOUS_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
                unsetLocalGitConfigValue(normalizedRepoRoot, DELEGATE_LOCAL_HOOKS_PATH_CONFIG_KEY, true);
            }

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

    private void assertGitRepositoryRoot(Path repoRoot) throws IOException {
        if (!Files.exists(repoRoot.resolve(".git"))) {
            throw new IOException("The selected path is not a Git repository root: " + repoRoot);
        }
    }

    private void ensureManagedRepoHookAssetsInstalled(Path repoRoot, String delegatedHooksPath) throws IOException {
        Files.createDirectories(getRepoHooksDirectoryPath(repoRoot));
        ensureManagedHookFile(repoRoot, "pre-commit", delegatedHooksPath);
        ensureManagedHookFile(repoRoot, "commit-msg", delegatedHooksPath);
        ensureManagedHookFile(repoRoot, "post-commit", delegatedHooksPath);
        installManagedRuntimeAsset(repoRoot);

        for (String hookFileName : REQUIRED_REPO_HOOK_FILES) {
            markExecutableBestEffort(getRepoHooksDirectoryPath(repoRoot).resolve(hookFileName));
        }
        markExecutableBestEffort(getRuntimeFilePath(repoRoot));
    }

    private void ensureManagedHookFile(Path repoRoot, String hookFileName, String delegatedHooksPath) throws IOException {
        String expectedContents = createManagedHookFileContents(hookFileName, delegatedHooksPath);
        Path hookFilePath = getRepoHooksDirectoryPath(repoRoot).resolve(hookFileName);
        if (Files.exists(hookFilePath)) {
            String existingContents = Files.readString(hookFilePath, StandardCharsets.UTF_8);
            if (!isManagedHookFileText(hookFileName, existingContents)) {
                throw new IOException(
                    "The repo-local " + REPO_HOOKS_DIRECTORY_NAME + "/" + hookFileName
                        + " file already exists and is not managed by AILoc2."
                );
            }

            if (normalizeHookFileText(existingContents).equals(normalizeHookFileText(expectedContents))) {
                return;
            }
        }

        Files.writeString(hookFilePath, expectedContents, StandardCharsets.UTF_8);
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
        removeEmptyHookDirectoryIfPossible(repoRoot);
        return removedManagedHookFiles || removedRuntimeAsset;
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

    private String createManagedHookFileContents(String hookFileName, String delegatedHooksPath) {
        return switch (hookFileName) {
            case "pre-commit" -> createManagedPreCommitHookScript(delegatedHooksPath);
            case "commit-msg" -> createManagedCommitMsgHookScript(delegatedHooksPath);
            case "post-commit" -> createManagedPostCommitHookScript(delegatedHooksPath);
            default -> throw new IllegalArgumentException("Unsupported managed hook file: " + hookFileName);
        };
    }

    private String createManagedPreCommitHookScript(String delegatedHooksPath) {
        String delegatedHookPath = createDelegatedHookScriptPath(delegatedHooksPath, "pre-commit");
        return """
            #!/bin/sh
            # AILoc2 managed IntelliJ hook: pre-commit

            RUNTIME_PATH="./.githooks/%s"
            DELEGATE_HOOK_PATH="%s"

            run_delegate_hook() {
                if [ -z "$DELEGATE_HOOK_PATH" ] || [ ! -f "$DELEGATE_HOOK_PATH" ]; then
                    return 0
                fi

                "$DELEGATE_HOOK_PATH" "$@"
            }

            if [ -f "$RUNTIME_PATH" ]; then
                sh "$RUNTIME_PATH" refresh-summary >/dev/null 2>&1 || printf '%%s\\n' 'AILoc2 pre-commit warning: IntelliJ summary refresh failed; continuing without blocking the commit.' >&2
            else
                printf '%%s\\n' 'AILoc2 pre-commit warning: IntelliJ hook runtime is unavailable; skipping summary refresh.' >&2
            fi

            run_delegate_hook "$@"
            exit $?
            """.formatted(RUNTIME_FILE_NAME, escapeForDoubleQuotedShell(delegatedHookPath));
    }

    private String createManagedCommitMsgHookScript(String delegatedHooksPath) {
        String delegatedHookPath = createDelegatedHookScriptPath(delegatedHooksPath, "commit-msg");
        return """
            #!/bin/sh
            # AILoc2 managed IntelliJ hook: commit-msg

            MESSAGE_FILE="$1"
            RUNTIME_PATH="./.githooks/%s"
            DELEGATE_HOOK_PATH="%s"

            run_delegate_hook() {
                if [ -z "$DELEGATE_HOOK_PATH" ] || [ ! -f "$DELEGATE_HOOK_PATH" ]; then
                    return 0
                fi

                "$DELEGATE_HOOK_PATH" "$@"
            }

            if [ -n "$MESSAGE_FILE" ] && [ -f "$RUNTIME_PATH" ]; then
                sh "$RUNTIME_PATH" annotate-commit-message "$MESSAGE_FILE" >/dev/null 2>&1 || sh "$RUNTIME_PATH" append-placeholder "$MESSAGE_FILE" >/dev/null 2>&1
            elif [ -n "$MESSAGE_FILE" ]; then
                printf '%%s\\n' 'AILoc2 commit-msg warning: IntelliJ hook runtime is unavailable; skipping AI suffix.' >&2
            fi

            run_delegate_hook "$@"
            exit $?
            """.formatted(RUNTIME_FILE_NAME, escapeForDoubleQuotedShell(delegatedHookPath));
    }

    private String createManagedPostCommitHookScript(String delegatedHooksPath) {
        String delegatedHookPath = createDelegatedHookScriptPath(delegatedHooksPath, "post-commit");
        return """
            #!/bin/sh
            # AILoc2 managed IntelliJ hook: post-commit

            RUNTIME_PATH="./.githooks/%s"
            DELEGATE_HOOK_PATH="%s"

            run_delegate_hook() {
                if [ -z "$DELEGATE_HOOK_PATH" ] || [ ! -f "$DELEGATE_HOOK_PATH" ]; then
                    return 0
                fi

                "$DELEGATE_HOOK_PATH" "$@"
            }

            if [ -f "$RUNTIME_PATH" ]; then
                sh "$RUNTIME_PATH" finalize-commit >/dev/null 2>&1 || printf '%%s\\n' 'AILoc2 post-commit warning: IntelliJ committed metrics cleanup failed.' >&2
            fi

            run_delegate_hook "$@"
            exit $?
            """.formatted(RUNTIME_FILE_NAME, escapeForDoubleQuotedShell(delegatedHookPath));
    }

    private String createManagedRuntimeScript() {
        return """
            #!/bin/sh
            # AILoc2 managed IntelliJ hook runtime

            SUMMARY_FILE=".ailoc2-metrics/summary.json"
            STATE_DIR=".ailoc2-metrics/intellij-state"
            PLACEHOLDER_SUFFIX=' (AI unavailable)'

            refresh_summary() {
                REPO_ROOT=$(pwd)
                REPO_NAME=${REPO_ROOT##*/}
                SUMMARY_DATA=$(git diff --cached --unified=0 --find-renames --no-color | awk -v state_dir="$STATE_DIR" '
                    function safe_state_file(path, safe) {
                        safe = path
                        gsub(/\\\\/, "/", safe)
                        gsub(/[^A-Za-z0-9._-]/, "_", safe)
                        return safe ".tsv"
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
                    current_path != "" && current_line > 0 && /^\\+/ && !/^\\+\\+\\+/ {
                        bucket = bucket_for(current_path, current_line)
                        weight = length($0) - 1
                        if (weight < 1) {
                            weight = 1
                        }
                        if (bucket == "AI") {
                            ai_weight += weight
                            attributed[current_path] = 1
                        }
                        else if (bucket == "HUMAN") {
                            human_weight += weight
                            attributed[current_path] = 1
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
                        }
                        printf "%d %d %d %d\\n", changed_count, attributed_count, ai_weight, human_weight
                    }
                ')

                set -- $SUMMARY_DATA
                CHANGED_FILE_COUNT=${1:-0}
                ATTRIBUTED_CHANGED_FILE_COUNT=${2:-0}
                AI_WEIGHT=${3:-0}
                HUMAN_WEIGHT=${4:-0}
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
                SUMMARY_LINE="$REPO_NAME: STAGED -> AI $AI_DISPLAY% | Human $HUMAN_DISPLAY%"
                ESCAPED_REPO_ROOT=$(printf '%s' "$REPO_ROOT" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
                ESCAPED_REPO_NAME=$(printf '%s' "$REPO_NAME" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
                ESCAPED_SUMMARY_LINE=$(printf '%s' "$SUMMARY_LINE" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')

                mkdir -p "$(dirname "$SUMMARY_FILE")"
                {
                    printf '{\\n'
                    printf '  "schemaVersion": 1,\\n'
                    printf '  "recordType": "intellij-hook-summary",\\n'
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
                    printf '    "aiPercentage": %s,\\n' "$AI_PERCENTAGE"
                    printf '    "humanPercentage": %s\\n' "$HUMAN_PERCENTAGE"
                    printf '  }\\n'
                    printf '}\\n'
                } > "$SUMMARY_FILE"
            }

            append_suffix() {
                MESSAGE_FILE="$1"
                SUFFIX="$2"
                if [ -z "$MESSAGE_FILE" ] || [ ! -f "$MESSAGE_FILE" ]; then
                    return 0
                fi

                TEMP_FILE="${MESSAGE_FILE}.ailoc2.$$"
                SUBJECT_LINE=$(sed -n '1p' "$MESSAGE_FILE" | sed -E 's/[[:space:]]+\\(AI [^)]*\\)$//')

                {
                    if [ -n "$SUBJECT_LINE" ]; then
                        printf '%s%s\\n' "$SUBJECT_LINE" "$SUFFIX"
                    else
                        printf '%s\\n' "${SUFFIX# }"
                    fi
                    sed '1d' "$MESSAGE_FILE"
                } > "$TEMP_FILE" && mv "$TEMP_FILE" "$MESSAGE_FILE"
            }

            annotate_commit_message() {
                MESSAGE_FILE="$1"
                refresh_summary
                if grep -q '"isGitSummaryAvailable"[[:space:]]*:[[:space:]]*true' "$SUMMARY_FILE"; then
                    AI_PERCENTAGE=$(sed -n 's/.*"aiPercentage"[[:space:]]*:[[:space:]]*\\([0-9.][0-9.]*\\).*/\\1/p' "$SUMMARY_FILE" | head -n 1)
                    if [ -n "$AI_PERCENTAGE" ]; then
                        AI_DISPLAY=$(awk -v value="$AI_PERCENTAGE" 'BEGIN { printf "%.2f", value }')
                        append_suffix "$MESSAGE_FILE" " (AI $AI_DISPLAY%)"
                        return 0
                    fi
                fi
                append_suffix "$MESSAGE_FILE" "$PLACEHOLDER_SUFFIX"
            }

            safe_state_file() {
                printf '%s' "$1" | sed 's#\\\\#/#g; s#[^A-Za-z0-9._-]#_#g'
            }

            has_unstaged_work() {
                REPO_RELATIVE_PATH="$1"
                if ! git diff --quiet -- "$REPO_RELATIVE_PATH"; then
                    return 0
                fi
                git ls-files --others --exclude-standard -- "$REPO_RELATIVE_PATH" | grep -q .
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
                clear_committed_state
                refresh_summary
            }

            case "$1" in
                refresh-summary)
                    refresh_summary
                    ;;
                finalize-commit)
                    finalize_commit
                    ;;
                annotate-commit-message)
                    annotate_commit_message "$2"
                    ;;
                append-placeholder)
                    append_suffix "$2" "$PLACEHOLDER_SUFFIX"
                    ;;
                *)
                    printf '%s\\n' 'Usage: ailoc2-intellij-hook-runtime.sh <refresh-summary|finalize-commit|annotate-commit-message <messageFile>|append-placeholder <messageFile>>' >&2
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
        CONFLICT
    }

    enum HookUninstallStatus {
        UNINSTALLED,
        RESTORED_PREVIOUS,
        NOT_INSTALLED
    }

    record HookInstallResult(
        HookInstallStatus status,
        Path repoRoot,
        Path hooksDirectoryPath,
        String currentLocalHooksPath,
        String currentEffectiveHooksPath,
        String replacedPreviousLocalHooksPath,
        String delegatedHooksPath
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

    private enum GitConfigScope {
        LOCAL,
        EFFECTIVE
    }

    private record GitCommandResult(int exitCode, String stdout, String stderr) {}
}
