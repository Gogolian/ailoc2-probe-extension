# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## Unreleased

## [1.0.15] - 2026-07-20
- Preserve Claude Code attribution when IntelliJ reloads externally edited files.
- Keep line attribution aligned after inserted, removed, or replaced lines.
- Include per-file weights in IntelliJ summaries and archive the exact pre-commit summary by commit hash.
- Synchronize Claude Code rolling-state attribution with the IntelliJ Git hook runtime.

## [1.0.14] - 2026-07-17
- Add one IntelliJ plugin package compatible with Community and Ultimate builds `252` through `262.*`.

## [1.0.12] - 2026-07-16
- Run pre-commit baseline preparation and summary refresh in one Node process.
- Limit baseline resolution to staged paths and batch Git blob lookups.
- Run independent staged, unstaged, and untracked summary scans concurrently.
- Add opt-in `AILOC2_PROFILE=1` JSONL timing diagnostics.
- Format commit attribution suffixes as `(AI: xx.xx%)` without accumulating trailing newlines.

## [1.0.11] - 2026-07-03
- Bump the extension and IntelliJ plugin version to 1.0.11.

## [1.0.9] - 2026-07-03
- Fix IntelliJ plugin packaging so the bundled Claude Code runtime is always included before hook installation.
- Update the IntelliJ plugin CI workflow to install Node dependencies before building plugin artifacts.

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
- Commit message annotation with staged AI percentage or `(AI: unavailable)` fallback.
- Technical documentation covering architecture, attribution, and hooks.
