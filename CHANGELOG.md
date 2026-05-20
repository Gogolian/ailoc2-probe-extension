# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-05-08
- Add repo-local `.ailoc2-metrics/.ignore` support for both VS Code and IntelliJ metrics tracking.
- Skip creating per-file metrics state for ignored files and directories.

## [0.1.1] - 2026-05-04
- Add compatibility to vscode 1.104.3

## [0.1.0] - 2026-05-02

### Added

- Initial public preview of `AILoc2 Probe`.
- Repo-local attribution state persisted under `.ailoc2-metrics`.
- Summary generation for staged and unstaged Git changes.
- Managed Git hook installation and bundled hook runtime.
- Commit message annotation with staged AI percentage or `(AI unavailable)` fallback.
- Technical documentation covering architecture, attribution, and hooks.
