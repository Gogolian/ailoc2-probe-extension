package com.ailoc2.intellij;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Quick toggle for the attribution settings that otherwise require hand-editing JSON.
 *
 * <p>Writes the machine-local override rather than the committed team policy, so flipping a
 * switch never dirties a shared file.
 */
public final class Ailoc2ConfigureAttributionAction extends AnAction {
    private static final String DIALOG_TITLE = "AILoc2 Attribution Settings";

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        Project project = event.getData(CommonDataKeys.PROJECT);
        if (project == null) {
            return;
        }

        Ailoc2ProjectService service = project.getService(Ailoc2ProjectService.class);
        Path repoRoot = service.projectRepoRoot();
        if (repoRoot == null) {
            Messages.showErrorDialog(project, "AILoc2 could not find a Git repository for this project.", DIALOG_TITLE);
            return;
        }

        Ailoc2ProbeConfig config = Ailoc2ProbeConfig.read(repoRoot);
        String[] options = {
            config.isMarkerMode()
                ? "Switch to signal attribution (currently: AI start/stop markers)"
                : "Switch to AI start/stop marker attribution (currently: signals)",
            (config.largeFileIsAi() ? "Disable" : "Enable") + " large-insertion attribution (currently: "
                + (config.largeFileIsAi() ? "on" : "off") + ")",
            (config.newFileIsAi() ? "Disable" : "Enable") + " new-file attribution (currently: "
                + (config.newFileIsAi() ? "on" : "off") + ")",
            "Cancel"
        };

        int choice = Messages.showDialog(
            project,
            describeCurrentConfig(config),
            DIALOG_TITLE,
            options,
            options.length - 1,
            Messages.getQuestionIcon()
        );

        Ailoc2ProbeConfig updated = switch (choice) {
            case 0 -> config.withMode(config.isMarkerMode()
                ? Ailoc2ProbeConfig.MODE_SIGNALS
                : Ailoc2ProbeConfig.MODE_MARKERS);
            case 1 -> config.withLargeFileIsAi(!config.largeFileIsAi());
            case 2 -> config.withNewFileIsAi(!config.newFileIsAi());
            default -> null;
        };

        if (updated == null) {
            return;
        }

        try {
            writeLocalOverride(repoRoot, updated);
        }
        catch (IOException error) {
            Messages.showErrorDialog(
                project,
                "AILoc2 could not write the local attribution config: " + error.getMessage(),
                DIALOG_TITLE
            );
            return;
        }

        Ailoc2ProbeConfig.invalidate(repoRoot);
        service.refreshResolvedConfigSidecar(repoRoot);
        service.refreshStagedSummary(repoRoot);

        Messages.showInfoMessage(
            project,
            "Updated local attribution settings.\n\n" + describeCurrentConfig(Ailoc2ProbeConfig.read(repoRoot)),
            DIALOG_TITLE
        );
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        event.getPresentation().setEnabledAndVisible(event.getData(CommonDataKeys.PROJECT) != null);
    }

    private String describeCurrentConfig(Ailoc2ProbeConfig config) {
        return "Mode: " + (config.isMarkerMode() ? "AI start/stop markers" : "signals")
            + "\nLarge insertions count as AI: " + (config.largeFileIsAi() ? "yes" : "no")
            + "\nNew files count as AI: " + (config.newFileIsAi() ? "yes" : "no")
            + "\nExcluded paths: " + (config.excludePaths().isEmpty() ? "none" : String.join(", ", config.excludePaths()))
            + "\n\nTeam defaults live in " + Ailoc2ProbeConfig.REPO_CONFIG_FILE_NAME
            + "; changes here are saved to " + Ailoc2ProbeConfig.METRICS_DIRECTORY
            + "/" + Ailoc2ProbeConfig.LOCAL_CONFIG_FILE_NAME + " for this machine only.";
    }

    private void writeLocalOverride(Path repoRoot, Ailoc2ProbeConfig config) throws IOException {
        Path metricsDirectory = repoRoot.resolve(Ailoc2ProbeConfig.METRICS_DIRECTORY);
        Files.createDirectories(metricsDirectory);
        Files.writeString(
            metricsDirectory.resolve(Ailoc2ProbeConfig.LOCAL_CONFIG_FILE_NAME),
            Ailoc2ProbeConfig.toJson(config),
            StandardCharsets.UTF_8
        );
    }
}
