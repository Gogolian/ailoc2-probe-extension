# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [1.0.21] - 2026-07-29

- Attribute unresolved and explicitly Unknown changed lines as AI in newly generated VS Code and IntelliJ summaries.
- Attribute files written by Claude Code through explicit Bash output redirections, including heredoc fallbacks after a file-tool failure.
- Restore the commit subject suffix as `(AI: percentage)`, derived from `AI-Lines` so `(AI-Lines: 10/20)` produces `(AI: 50%)`.
- Write the case-sensitive `(AI-Lines: AI/total)` marker to commit message bodies in both VS Code and IntelliJ flows.
- Keep the compatibility Unknown count in the total-count schema while assigning newly unresolved lines to AI.

## [1.0.18] - 2026-07-23
- Add AI-authored and human-authored non-blank staged-line counts to VS Code and IntelliJ commit subjects.
- Persist Unknown added-line counts in summaries and commit audits without assigning ambiguous work to either author.
- Refresh attribution from the final Git index after delegated pre-commit tools and add cross-platform regression suites to CI.

## [1.0.17] - 2026-07-22
- Add explicit Find Action aliases for installing and uninstalling aggregate workspace Claude hooks in IntelliJ.

## [1.0.16] - 2026-07-20
- Add aggregate workspace Claude Code hook installation and removal to the IntelliJ plugin.
- Route edits from one parent Claude Code session to each nested file's Git repository without recursively changing repository configuration.
- Preserve unrelated Claude settings and refuse to overwrite malformed settings.

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
