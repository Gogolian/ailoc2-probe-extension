package com.ailoc2.intellij;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.CheckinProjectPanel;
import com.intellij.openapi.vcs.changes.CommitContext;
import com.intellij.openapi.vcs.checkin.CheckinHandler;
import com.intellij.openapi.vcs.checkin.CheckinHandlerFactory;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Path;
import java.util.regex.Pattern;

public final class Ailoc2CheckinHandlerFactory extends CheckinHandlerFactory {
    private static final Pattern AI_SUFFIX_PATTERN = Pattern.compile("\\s+\\(AI [^)]*\\)$");

    @Override
    public @NotNull CheckinHandler createHandler(@NotNull CheckinProjectPanel panel, @NotNull CommitContext commitContext) {
        Project project = panel.getProject();
        return new CheckinHandler() {
            @Override
            public @NotNull ReturnResult beforeCheckin() {
                Ailoc2ProjectService service = project.getService(Ailoc2ProjectService.class);
                Path repoRoot = service.projectRepoRoot();
                if (repoRoot == null) {
                    annotate(panel, null);
                    return ReturnResult.COMMIT;
                }

                Ailoc2GitSummary stagedSummary = service.refreshStagedSummary(repoRoot);
                annotate(panel, stagedSummary.available ? stagedSummary.aiPercentage : null);
                return ReturnResult.COMMIT;
            }

            @Override
            public void checkinSuccessful() {
                Ailoc2ProjectService service = project.getService(Ailoc2ProjectService.class);
                Path repoRoot = service.projectRepoRoot();
                if (repoRoot != null) {
                    service.finalizeCommittedState(repoRoot);
                }
            }
        };
    }

    private void annotate(CheckinProjectPanel panel, Double aiPercentage) {
        String message = panel.getCommitMessage();
        String[] lines = message.split("\\R", -1);
        if (lines.length == 0) {
            lines = new String[]{""};
        }
        String suffix = aiPercentage == null
            ? " (AI unavailable)"
            : String.format(java.util.Locale.ROOT, " (AI %.2f%%)", aiPercentage);
        lines[0] = AI_SUFFIX_PATTERN.matcher(lines[0]).replaceFirst("").stripTrailing() + suffix;
        panel.setCommitMessage(String.join("\n", lines));
    }
}
