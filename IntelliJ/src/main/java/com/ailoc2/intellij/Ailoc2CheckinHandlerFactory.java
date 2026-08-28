package com.ailoc2.intellij;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.CheckinProjectPanel;
import com.intellij.openapi.vcs.changes.CommitContext;
import com.intellij.openapi.vcs.checkin.CheckinHandler;
import com.intellij.openapi.vcs.checkin.CheckinHandlerFactory;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Path;

public final class Ailoc2CheckinHandlerFactory extends CheckinHandlerFactory {
    @Override
    public @NotNull CheckinHandler createHandler(@NotNull CheckinProjectPanel panel, @NotNull CommitContext commitContext) {
        Project project = panel.getProject();
        return new CheckinHandler() {
            @Override
            public @NotNull ReturnResult beforeCheckin() {
                Ailoc2ProjectService service = project.getService(Ailoc2ProjectService.class);
                Path repoRoot = service.projectRepoRoot();
                if (repoRoot == null) {
                    annotate(panel, Ailoc2GitSummary.unavailable());
                    return ReturnResult.COMMIT;
                }

                // Keeps the shell hook's sidecar in step with a hand-edited config.
                service.refreshResolvedConfigSidecar(repoRoot);
                Ailoc2GitSummary stagedSummary = service.refreshStagedSummary(repoRoot);
                service.stripStagedMarkersIfEnabled(repoRoot);
                service.prepareCommitAudit(repoRoot);
                annotate(panel, stagedSummary);
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

    private void annotate(CheckinProjectPanel panel, Ailoc2GitSummary summary) {
        panel.setCommitMessage(Ailoc2CommitMessageFormatter.apply(panel.getCommitMessage(), summary));
    }
}
