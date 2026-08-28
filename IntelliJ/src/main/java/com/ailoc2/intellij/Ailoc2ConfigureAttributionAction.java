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
import java.util.ArrayList;
import java.util.List;

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
        List<String> switchableModes = new ArrayList<>();
        for (String mode : Ailoc2ProbeConfig.MODES) {
            if (!mode.equals(config.mode())) {
                switchableModes.add(mode);
            }
        }

        List<String> options = new ArrayList<>();
        for (String mode : switchableModes) {
            options.add("Switch to " + describeMode(mode));
        }
        options.add((config.largeFileIsAi() ? "Disable" : "Enable") + " large-insertion attribution (currently: "
            + (config.largeFileIsAi() ? "on" : "off") + ")");
        options.add((config.newFileIsAi() ? "Disable" : "Enable") + " new-file attribution (currently: "
            + (config.newFileIsAi() ? "on" : "off") + ")");
        options.add("Cancel");

        int choice = Messages.showDialog(
            project,
            describeCurrentConfig(config),
            DIALOG_TITLE,
            options.toArray(new String[0]),
            options.size() - 1,
            Messages.getQuestionIcon()
        );

        Ailoc2ProbeConfig updated;
        if (choice >= 0 && choice < switchableModes.size()) {
            updated = config.withMode(switchableModes.get(choice));
        }
        else if (choice == switchableModes.size()) {
            updated = config.withLargeFileIsAi(!config.largeFileIsAi());
        }
        else if (choice == switchableModes.size() + 1) {
            updated = config.withNewFileIsAi(!config.newFileIsAi());
        }
        else {
            updated = null;
        }

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

    private String describeMode(String mode) {
        return switch (mode) {
            case Ailoc2ProbeConfig.MODE_MARKERS -> "AI marker attribution (only AI start/stop blocks count as AI)";
            case Ailoc2ProbeConfig.MODE_HUMAN_MARKERS -> "human marker attribution (everything is AI except Human start/stop blocks)";
            default -> "signal attribution (observed editor and chat activity, no tags)";
        };
    }

    private String describeCurrentConfig(Ailoc2ProbeConfig config) {
        return "Mode: " + describeMode(config.mode())
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
