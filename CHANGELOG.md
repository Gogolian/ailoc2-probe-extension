# Changelog

All notable changes to this project will be documented in this file.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [1.0.25] - 2026-08-28

- Add `attribution.mode: "human-markers"`, which treats every added line as AI unless it sits inside a `Human start` / `Human stop` block. It needs no cooperation from the AI tool, only that the human tags their own edits, and it errs toward over-reporting AI rather than under-reporting it.
- Recognize the `Human start` / `Human stop` family with the same case-insensitive, comment-syntax-agnostic matching as the AI family, and strip only the active mode's markers at commit time.
- Exclude the committed `.ailoc2-probe.json` and all `.ailoc2-metrics/` artifacts from attribution in every mode, including the generated IntelliJ shell hook, so the commit that adds the config no longer scores itself.
- Offer all three modes in the VS Code and IntelliJ attribution settings actions.

## [1.0.24] - 2026-08-28

- Add a repo-local attribution config: committed `.ailoc2-probe.json` for team policy plus an optional machine-local `.ailoc2-metrics/config.json` override, created when repo hooks are installed and never overwritten on reinstall.
- Add `attribution.largeFileIsAI` and `attribution.newFileIsAI` so large insertions and new-file population can be attributed to Human instead of raising the AI percentage. Stronger evidence such as a chat apply or a recorded Claude Code edit still counts as AI.
- Add `attribution.excludePaths` with gitignore-style patterns and `!` re-inclusion. Excluded files are counted in neither the AI numerator nor the total and get no per-file attribution state.
- Add `attribution.mode: "markers"` restoring the legacy `AI start` / `AI stop` comment model as an exclusive replacement for passive signals, and strip the markers from the index and working tree at commit time so they never reach the commit.
- Preserve line endings, trailing-newline state, and the executable bit while stripping markers; skip symlinks, submodules, and binary content; leave the working tree untouched when it no longer matches the staged content.
- Add `AILoc2 Probe: Attribution Settings` to VS Code and the IntelliJ Tools menu for switching mode and toggling the heuristics; both write the local layer so a toggle never modifies committed team policy.
- Honor config exclusions in the generated IntelliJ shell hook through a flattened `.ailoc2-metrics/resolved-config.env` sidecar, which also closes the gap where that hook ignored `.ailoc2-metrics/.ignore` entirely.
- Align the IntelliJ bulk-insert line threshold with the VS Code extension (`2` to `8`).
- Add configuration guides in English and Polish under `docs/`.

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
