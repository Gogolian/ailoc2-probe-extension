package com.ailoc2.intellij;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Path;

public final class Ailoc2InstallWorkspaceHooksAction extends AnAction {
    private final Ailoc2HookManager hookManager = new Ailoc2HookManager();

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getData(CommonDataKeys.PROJECT);
        if (project == null) {
            return;
        }

        Path workspaceRoot = project.getService(Ailoc2ProjectService.class).projectBasePath();
        if (workspaceRoot == null) {
            Messages.showErrorDialog(project, "AILoc2 could not determine the IntelliJ workspace directory.", "AILoc2 Install Workspace Claude Hooks");
            return;
        }

        try {
            Ailoc2HookManager.WorkspaceClaudeInstallResult installResult = hookManager.installWorkspaceClaudeHooks(workspaceRoot);
            String status = installResult.status() == Ailoc2HookManager.WorkspaceClaudeInstallStatus.ALREADY_INSTALLED
                ? "already active"
                : "installed";
            Messages.showInfoMessage(
                project,
                "AILoc2 Claude Code workspace hooks are " + status + " under " + installResult.workspaceRoot() + ".",
                "AILoc2 Install Workspace Claude Hooks"
            );
        }
        catch (Exception error) {
            Messages.showErrorDialog(
                project,
                "AILoc2 failed to install workspace Claude hooks: " + error.getMessage(),
                "AILoc2 Install Workspace Claude Hooks"
            );
        }
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        event.getPresentation().setEnabledAndVisible(event.getData(CommonDataKeys.PROJECT) != null);
    }
}
