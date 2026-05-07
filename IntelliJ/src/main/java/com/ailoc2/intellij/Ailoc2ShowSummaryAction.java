package com.ailoc2.intellij;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Path;
import java.util.Locale;

public final class Ailoc2ShowSummaryAction extends AnAction {
    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getData(CommonDataKeys.PROJECT);
        if (project == null) {
            return;
        }

        Ailoc2ProjectService service = project.getService(Ailoc2ProjectService.class);
        Path repoRoot = service.projectRepoRoot();
        if (repoRoot == null) {
            Messages.showErrorDialog(project, "AILoc2 could not find a Git repository for this project.", "AILoc2 Repo Summary");
            return;
        }

        ProgressManager.getInstance().run(new Task.Backgroundable(project, "AILoc2: Refreshing summary for " + repoRoot.getFileName(), false) {
            private Ailoc2RepoSummary summary;
            private Exception error;

            @Override
            public void run(@NotNull com.intellij.openapi.progress.ProgressIndicator indicator) {
                try {
                    summary = service.refreshRepoSummary(repoRoot);
                }
                catch (Exception caught) {
                    error = caught;
                }
            }

            @Override
            public void onSuccess() {
                if (error != null) {
                    Messages.showErrorDialog(
                        project,
                        "AILoc2 failed to refresh the repo summary for " + repoRoot.getFileName() + ": " + error.getMessage(),
                        "AILoc2 Repo Summary"
                    );
                    return;
                }

                Messages.showInfoMessage(project, formatSummaryMessage(summary), "AILoc2 Repo Summary");
            }
        });
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        event.getPresentation().setEnabledAndVisible(event.getData(CommonDataKeys.PROJECT) != null);
    }

    private String formatSummaryMessage(Ailoc2RepoSummary summary) {
        if (!summary.available()) {
            return summary.repoName() + ": summary unavailable";
        }

        return summary.repoName()
            + " summary refreshed.\n\n"
            + formatSlice("Staged", summary.staged())
            + "\n"
            + formatSlice("Unstaged", summary.unstaged());
    }

    private String formatSlice(String label, Ailoc2GitSummary summary) {
        return String.format(
            Locale.ROOT,
            "%s: AI %.2f%% | Human %.2f%%\nChanged files: %d | Attributed files: %d\nAI-weighted lines: %d | Human-weighted lines: %d",
            label,
            summary.aiPercentage,
            summary.humanPercentage,
            summary.changedFileCount,
            summary.attributedChangedFileCount,
            summary.aiWeightedChangedLines,
            summary.humanWeightedChangedLines
        );
    }
}
