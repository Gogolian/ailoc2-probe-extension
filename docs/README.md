# Technical documentation

This folder is the implementation guide for AILoc2.

The top-level [`README.md`](../README.md) explains what the project is and how to try it. These docs explain how the current prototype works internally, where data is stored, which heuristics are used, and where implementation behavior does or does not meet its conservative-attribution goal.

## Configuration

If you want to change how attribution behaves rather than understand how it is implemented, read the configuration guide instead:

- [`configuration.md`](configuration.md) — attribution modes, `largeFileIsAI`, per-path exclusions, and the two config layers
- [`konfiguracja.md`](konfiguracja.md) — the same guide in Polish / ten sam przewodnik po polsku

## Reading order

1. [`architecture.md`](architecture.md) — start here for the runtime model, source map, lifecycle, and key moving parts.
2. [`vscode-data-collection-and-commit-statistics.md`](vscode-data-collection-and-commit-statistics.md) — follow the complete VS Code path from monitored signals to the commit marker, including data-quality risks and missing signals.
3. [`intellij-data-collection-and-commit-statistics.md`](intellij-data-collection-and-commit-statistics.md) — follow the corresponding IntelliJ path and understand where its evidence and staging model differ.
4. [`attribution-and-summary.md`](attribution-and-summary.md) — use this as a compact reference for the canonical VS Code rolling-state and summary algorithm.
5. [`hooks-and-runtime.md`](hooks-and-runtime.md) — read this if you care about VS Code hook installation, chaining, CLI behavior, and commit-message annotation.
6. [`claude-code.md`](claude-code.md) — read this for the Claude Code companion runtime and shared `.ailoc2-metrics` flow.

## Source map

| Area | Primary source files |
| --- | --- |
| Extension activation and event wiring | `src/extension.ts` |
| Repo-local rolling state persistence | `src/metrics/store.ts` |
| Summary generation from Git diff slices | `src/metrics/summary.ts` |
| Git helper calls | `src/metrics/git.ts` |
| Repo discovery and path normalization | `src/metrics/repoResolver.ts` |
| Metrics file layout | `src/metrics/pathing.ts` |
| Shared schema types | `src/metrics/schema.ts` |
| Probe configuration and layer merge | `src/metrics/probeConfig.ts` |
| Gitignore-style pattern matching | `src/metrics/globRules.ts` |
| Marker (`AI start`/`AI stop`) attribution | `src/metrics/markerAttribution.ts` |
| Marker stripping at commit time | `src/metrics/markerStripping.ts` |
| Tracking exclusions | `src/trackingExclusions.ts` |
| Hook install / uninstall | `src/hooks/management.ts` |
| Commit message suffix logic | `src/hooks/commitMessage.ts` |
| Hook runtime CLI entrypoint | `src/cli/gitHookCli.ts` |
| Claude Code runtime CLI entrypoint | `src/cli/claudeCodeCli.ts` |
| Claude Code metrics bridge | `src/integrations/claudeCode/` |
| IntelliJ event capture and classification | `IntelliJ/src/main/java/com/ailoc2/intellij/Ailoc2ProjectService.java` |
| IntelliJ positional line state | `IntelliJ/src/main/java/com/ailoc2/intellij/Ailoc2FileState.java` |
| IntelliJ Git summary and commit annotation | `IntelliJ/src/main/java/com/ailoc2/intellij/Ailoc2GitDiffSummarizer.java`, `Ailoc2CommitMessageFormatter.java` |
| IntelliJ Git hook runtime generation | `IntelliJ/src/main/java/com/ailoc2/intellij/Ailoc2HookManager.java` |
| IntelliJ probe configuration | `IntelliJ/src/main/java/com/ailoc2/intellij/Ailoc2ProbeConfig.java` |
| IntelliJ marker attribution and stripping | `IntelliJ/src/main/java/com/ailoc2/intellij/Ailoc2MarkerAttribution.java`, `Ailoc2MarkerStripper.java` |

## Quick reference

- **Extension display name:** `AILoc2 Probe`
- **Activation event:** `onStartupFinished`
- **Detailed output channel:** `AILoc2 Probe`
- **Summary output channel:** `AILoc2 Summary`
- **Repo-local metrics root:** `.ailoc2-metrics/`
- **Team config file:** `.ailoc2-probe.json` (committed)
- **Local config override:** `.ailoc2-metrics/config.json`
- **Managed hook directory:** `.githooks/`
- **Managed hook runtime file:** `.githooks/ailoc2-hook-runtime.cjs`
- **Claude Code runtime file:** `.claude/ailoc2-claude-code.cjs`

## Design posture

AILoc2 is intentionally biased toward a few constraints:

- **local-first** — state lives in the repo, not a backend
- **commit-native** — the primary result lands in the commit workflow
- **inspectable** — JSON artifacts are meant to be readable by humans and tooling
- **conservative by intent** — ambiguous edits should not silently inflate AI percentages; the platform guides document current heuristics that do not yet fully meet this goal
- **non-invasive** — hooks should fail open and avoid blocking normal development

## Historical note

This repository started by experimenting with external CodeBlend session artifacts. That approach turned out to be too coarse for trustworthy commit scoring: a small AI apply could make large parts of a file look AI-owned. The current architecture pivots away from session scraping and instead records editor-side evidence directly inside the VS Code extension.
