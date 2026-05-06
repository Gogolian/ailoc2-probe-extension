package com.ailoc2.intellij;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Path;

public final class Ailoc2UninstallHooksAction extends AnAction {
    private final Ailoc2HookManager hookManager = new Ailoc2HookManager();

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getData(CommonDataKeys.PROJECT);
        if (project == null) {
            return;
        }

        Path repoRoot = project.getService(Ailoc2ProjectService.class).projectRepoRoot();
        if (repoRoot == null) {
            Messages.showErrorDialog(project, "AILoc2 could not find a Git repository for this project.", "AILoc2 Uninstall Hooks");
            return;
        }

        try {
            Ailoc2HookManager.HookUninstallResult uninstallResult = hookManager.uninstallRepoHooks(repoRoot);
            Messages.showInfoMessage(project, successMessage(repoRoot, uninstallResult), "AILoc2 Uninstall Hooks");
        }
        catch (Exception error) {
            Messages.showErrorDialog(
                project,
                "AILoc2 failed to uninstall hooks for " + repoRoot.getFileName() + ": " + error.getMessage(),
                "AILoc2 Uninstall Hooks"
            );
        }
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        event.getPresentation().setEnabledAndVisible(event.getData(CommonDataKeys.PROJECT) != null);
    }

    private String successMessage(Path repoRoot, Ailoc2HookManager.HookUninstallResult uninstallResult) {
        String repoName = repoRoot.getFileName().toString();
        if (uninstallResult.status() == Ailoc2HookManager.HookUninstallStatus.RESTORED_PREVIOUS) {
            return "AILoc2 hooks removed for " + repoName + ". Restored the previous local hooksPath.";
        }
        if (uninstallResult.status() == Ailoc2HookManager.HookUninstallStatus.UNINSTALLED) {
            return "AILoc2 hooks removed for " + repoName + ".";
        }
        if (uninstallResult.removedManagedHookAssets() && uninstallResult.currentLocalHooksPath() != null) {
            return "AILoc2 removed its managed hook files from "
                + repoName
                + ", but left the current repo-local hooksPath ("
                + uninstallResult.currentLocalHooksPath()
                + ") unchanged.";
        }
        if (uninstallResult.removedManagedHookAssets()) {
            return "AILoc2 removed its managed hook files from " + repoName + ".";
        }
        if (uninstallResult.currentLocalHooksPath() != null) {
            return repoName
                + " is using a different repo-local hooksPath ("
                + uninstallResult.currentLocalHooksPath()
                + "). AILoc2 left it unchanged.";
        }
        return "No repo-local AILoc2 hooks are currently installed for " + repoName + ".";
    }
}
