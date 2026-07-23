package com.ailoc2.intellij;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Path;

public final class Ailoc2UninstallWorkspaceHooksAction extends AnAction {
    private final Ailoc2HookManager hookManager = new Ailoc2HookManager();

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getData(CommonDataKeys.PROJECT);
        if (project == null) {
            return;
        }

        Path workspaceRoot = project.getService(Ailoc2ProjectService.class).projectBasePath();
        if (workspaceRoot == null) {
            Messages.showErrorDialog(project, "AILoc2 could not determine the IntelliJ workspace directory.", "AILoc2 Uninstall Workspace Claude Hooks");
            return;
        }

        try {
            Ailoc2HookManager.WorkspaceClaudeUninstallResult uninstallResult = hookManager.uninstallWorkspaceClaudeHooks(workspaceRoot);
            String message = uninstallResult.status() == Ailoc2HookManager.WorkspaceClaudeUninstallStatus.UNINSTALLED
                ? "AILoc2 Claude Code workspace hooks were removed from " + uninstallResult.workspaceRoot() + "."
                : "No AILoc2 Claude Code workspace hooks are installed under " + uninstallResult.workspaceRoot() + ".";
            Messages.showInfoMessage(project, message, "AILoc2 Uninstall Workspace Claude Hooks");
        }
        catch (Exception error) {
            Messages.showErrorDialog(
                project,
                "AILoc2 failed to uninstall workspace Claude hooks: " + error.getMessage(),
                "AILoc2 Uninstall Workspace Claude Hooks"
            );
        }
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        event.getPresentation().setEnabledAndVisible(event.getData(CommonDataKeys.PROJECT) != null);
    }
}
