# Technical documentation

This folder is the implementation guide for AILoc2.

The top-level [`README.md`](../README.md) explains what the project is and how to try it. These docs explain how the current prototype works internally, where data is stored, which heuristics are used, and where the extension deliberately stays conservative.

## Reading order

1. [`architecture.md`](architecture.md) — start here for the runtime model, source map, lifecycle, and key moving parts.
2. [`attribution-and-summary.md`](attribution-and-summary.md) — read this next if you want to understand how edit signals become repo-level AI percentages.
3. [`hooks-and-runtime.md`](hooks-and-runtime.md) — read this if you care about hook installation, chaining, CLI behavior, and commit-message annotation.

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
| Tracking exclusions | `src/trackingExclusions.ts` |
| Hook install / uninstall | `src/hooks/management.ts` |
| Commit message suffix logic | `src/hooks/commitMessage.ts` |
| Hook runtime CLI entrypoint | `src/cli/gitHookCli.ts` |

## Quick reference

- **Extension display name:** `AILoc2 Probe`
- **Activation event:** `onStartupFinished`
- **Detailed output channel:** `AILoc2 Probe`
- **Summary output channel:** `AILoc2 Summary`
- **Repo-local metrics root:** `.ailoc2-metrics/`
- **Managed hook directory:** `.githooks/`
- **Managed hook runtime file:** `.githooks/ailoc2-hook-runtime.cjs`

## Design posture

AILoc2 is intentionally biased toward a few constraints:

- **local-first** — state lives in the repo, not a backend
- **commit-native** — the primary result lands in the commit workflow
- **inspectable** — JSON artifacts are meant to be readable by humans and tooling
- **conservative** — ambiguous edits should not silently turn into inflated AI percentages
- **non-invasive** — hooks should fail open and avoid blocking normal development

## Historical note

This repository started by experimenting with external CodeBlend session artifacts. That approach turned out to be too coarse for trustworthy commit scoring: a small AI apply could make large parts of a file look AI-owned. The current architecture pivots away from session scraping and instead records editor-side evidence directly inside the VS Code extension.
