package com.ailoc2.intellij;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.StartupActivity;
import org.jetbrains.annotations.NotNull;

public final class Ailoc2StartupActivity implements StartupActivity.Background {
    @Override
    public void runActivity(@NotNull Project project) {
        project.getService(Ailoc2ProjectService.class).start();
    }
}
