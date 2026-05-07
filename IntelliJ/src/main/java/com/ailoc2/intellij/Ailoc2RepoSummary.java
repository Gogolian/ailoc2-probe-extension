package com.ailoc2.intellij;

import java.nio.file.Path;

final class Ailoc2RepoSummary {
    private final Path repoRoot;
    private final String repoName;
    private final Ailoc2GitSummary staged;
    private final Ailoc2GitSummary unstaged;

    Ailoc2RepoSummary(Path repoRoot, Ailoc2GitSummary staged, Ailoc2GitSummary unstaged) {
        this.repoRoot = repoRoot;
        this.repoName = repoRoot.getFileName() == null ? repoRoot.toString() : repoRoot.getFileName().toString();
        this.staged = staged;
        this.unstaged = unstaged;
    }

    Path repoRoot() {
        return repoRoot;
    }

    String repoName() {
        return repoName;
    }

    Ailoc2GitSummary staged() {
        return staged;
    }

    Ailoc2GitSummary unstaged() {
        return unstaged;
    }

    boolean available() {
        return staged.available && unstaged.available;
    }
}
