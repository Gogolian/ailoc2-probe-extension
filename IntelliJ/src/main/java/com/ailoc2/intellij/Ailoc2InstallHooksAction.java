package com.ailoc2.intellij;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Path;

public final class Ailoc2InstallHooksAction extends AnAction {
    private static final String CHAIN_HOOKS = "Chain hooks";
    private static final String REPLACE_HOOKS_PATH = "Replace hooksPath";
    private static final String WRAP_EXISTING_HOOKS = "Wrap Existing Hooks";
    private static final String CANCEL = "Cancel";

    private final Ailoc2HookManager hookManager = new Ailoc2HookManager();

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getData(CommonDataKeys.PROJECT);
        if (project == null) {
            return;
        }

        Path repoRoot = project.getService(Ailoc2ProjectService.class).projectRepoRoot();
        if (repoRoot == null) {
            Messages.showErrorDialog(project, "AILoc2 could not find a Git repository for this project.", "AILoc2 Install Hooks");
            return;
        }

        try {
            boolean allowReplacingExistingLocalHooksPath = false;
            boolean chainExistingLocalHooksPath = false;
            boolean wrapExistingHookFiles = false;
            Ailoc2HookManager.HookInstallResult installResult = hookManager.installRepoHooks(
                repoRoot,
                allowReplacingExistingLocalHooksPath,
                chainExistingLocalHooksPath,
                wrapExistingHookFiles
            );
            if (installResult.status() == Ailoc2HookManager.HookInstallStatus.CONFLICT) {
                int choice = Messages.showDialog(
                    project,
                    repoRoot.getFileName() + " already uses a different local hooksPath ("
                        + installResult.currentLocalHooksPath()
                        + "). Do you want AILoc2 to chain to that hooksPath or replace it?",
                    "AILoc2 Install Hooks",
                    new String[]{CHAIN_HOOKS, REPLACE_HOOKS_PATH, CANCEL},
                    0,
                    Messages.getWarningIcon()
                );
                if (choice != 0 && choice != 1) {
                    return;
                }

                allowReplacingExistingLocalHooksPath = true;
                chainExistingLocalHooksPath = choice == 0;
                installResult = hookManager.installRepoHooks(
                    repoRoot,
                    allowReplacingExistingLocalHooksPath,
                    chainExistingLocalHooksPath,
                    wrapExistingHookFiles
                );
            }

            if (installResult.status() == Ailoc2HookManager.HookInstallStatus.HOOK_FILE_CONFLICT) {
                int choice = Messages.showDialog(
                    project,
                    repoRoot.getFileName() + " already has existing hook files that are not managed by AILoc2: "
                        + formatHookFileList(installResult.conflictingHookFiles())
                        + ". Do you want AILoc2 to preserve those hooks and run them after AILoc2?",
                    "AILoc2 Install Hooks",
                    new String[]{WRAP_EXISTING_HOOKS, CANCEL},
                    0,
                    Messages.getWarningIcon()
                );
                if (choice != 0) {
                    return;
                }

                wrapExistingHookFiles = true;
                installResult = hookManager.installRepoHooks(
                    repoRoot,
                    allowReplacingExistingLocalHooksPath,
                    chainExistingLocalHooksPath,
                    wrapExistingHookFiles
                );
            }

            if (installResult.status() == Ailoc2HookManager.HookInstallStatus.MANUAL_MERGE_REQUIRED) {
                Messages.showWarningDialog(
                    project,
                    "AILoc2 could not safely wrap existing hooks for " + repoRoot.getFileName()
                        + ". Proposed AILoc2 hook files were written to "
                        + String.join(", ", installResult.manualMergeHookFiles())
                        + ". Merge them with "
                        + formatHookFileList(installResult.conflictingHookFiles())
                        + ", then rerun install.",
                    "AILoc2 Install Hooks"
                );
                return;
            }

            project.getService(Ailoc2ProjectService.class).refreshStagedSummary(repoRoot);
            Messages.showInfoMessage(project, successMessage(repoRoot, installResult), "AILoc2 Install Hooks");
        }
        catch (Exception error) {
            Messages.showErrorDialog(
                project,
                "AILoc2 failed to install hooks for " + repoRoot.getFileName() + ": " + error.getMessage(),
                "AILoc2 Install Hooks"
            );
        }
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        event.getPresentation().setEnabledAndVisible(event.getData(CommonDataKeys.PROJECT) != null);
    }

    private String successMessage(Path repoRoot, Ailoc2HookManager.HookInstallResult installResult) {
        String repoName = repoRoot.getFileName().toString();
        String suffix = installResult.wrappedHookFiles().isEmpty()
            ? ""
            : " Existing hooks were preserved and will run after AILoc2: " + formatHookFileList(installResult.wrappedHookFiles()) + ".";
        if (installResult.status() == Ailoc2HookManager.HookInstallStatus.ALREADY_INSTALLED) {
            return installResult.delegatedHooksPath() == null
                ? "AILoc2 Git and Claude Code hooks are already active for " + repoName + "." + suffix
                : "AILoc2 Git and Claude Code hooks are already active for " + repoName + " and chained to " + installResult.delegatedHooksPath() + "." + suffix;
        }
        if (installResult.delegatedHooksPath() != null) {
            return "AILoc2 Git and Claude Code hooks installed for " + repoName + " and chained to " + installResult.delegatedHooksPath() + "." + suffix;
        }
        if (installResult.replacedPreviousLocalHooksPath() != null) {
            return "AILoc2 Git and Claude Code hooks installed for " + repoName + ". Previous local hooksPath saved for restore on uninstall." + suffix;
        }
        return "AILoc2 Git and Claude Code hooks installed for " + repoName + "." + suffix;
    }

    private String formatHookFileList(java.util.List<String> hookFileNames) {
        return hookFileNames.stream()
            .map(hookFileName -> ".githooks/" + hookFileName)
            .collect(java.util.stream.Collectors.joining(", "));
    }
}
