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
            Ailoc2HookManager.HookInstallResult installResult = hookManager.installRepoHooks(repoRoot, false, false);
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

                installResult = hookManager.installRepoHooks(repoRoot, true, choice == 0);
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
        if (installResult.status() == Ailoc2HookManager.HookInstallStatus.ALREADY_INSTALLED) {
            return installResult.delegatedHooksPath() == null
                ? "AILoc2 hooks are already active for " + repoName + "."
                : "AILoc2 hooks are already active for " + repoName + " and chained to " + installResult.delegatedHooksPath() + ".";
        }
        if (installResult.delegatedHooksPath() != null) {
            return "AILoc2 hooks installed for " + repoName + " and chained to " + installResult.delegatedHooksPath() + ".";
        }
        if (installResult.replacedPreviousLocalHooksPath() != null) {
            return "AILoc2 hooks installed for " + repoName + ". Previous local hooksPath saved for restore on uninstall.";
        }
        return "AILoc2 hooks installed for " + repoName + ".";
    }
}
