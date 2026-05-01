# Extension architecture

This document explains how the AILoc2 extension is structured today and how runtime state flows from editor events to repo-local artifacts and Git hooks.

## Design constraints

The current architecture is built around five practical constraints:

1. **The extension must observe edits where they happen.** Git hooks can see files and diffs, but not editor provenance at creation time.
2. **The repo must remain the unit of storage.** Attribution output needs to travel with the repository, not an external session database.
3. **Commit workflows must stay normal.** The user should still edit, save, stage, and commit with ordinary Git commands.
4. **Ambiguous evidence should stay ambiguous.** The implementation tries to avoid turning weak hints into strong AI claims.
5. **Consumers may already have hook setups.** Managed hooks need to coexist with existing repo-local `core.hooksPath` usage when possible.

## Runtime map

| Module | Responsibility |
| --- | --- |
| `src/extension.ts` | Extension activation, command registration, VS Code event listeners, edit classification, and handoff into persistence. |
| `src/metrics/store.ts` | Debounced per-repo write queue, rolling state updates, manifest caching, save checkpoints, and lifecycle persistence. |
| `src/metrics/summary.ts` | Reads Git diff slices plus rolling state and produces staged / unstaged attribution summaries. |
| `src/metrics/git.ts` | Thin wrappers around Git calls for working-tree and index blob IDs. |
| `src/metrics/repoResolver.ts` | Resolves repo roots, repo-relative paths, and normalized logical paths. |
| `src/metrics/pathing.ts` | Defines the on-disk metrics layout under `.ailoc2-metrics`. |
| `src/metrics/schema.ts` | Shared record types, signal groups, attribution buckets, and rolling-state structures. |
| `src/hooks/management.ts` | Installs and uninstalls managed hooks, copies runtime assets, and handles hook chaining. |
| `src/hooks/commitMessage.ts` | Applies the `(AI xx.xx%)` or `(AI unavailable)` suffix to the commit subject line. |
| `src/cli/gitHookCli.ts` | Bundled CLI entrypoint executed by the managed hooks. |
| `src/trackingExclusions.ts` | Prevents the extension from tracking its own metrics artifacts and other excluded paths. |

## High-level flow

```mermaid
flowchart TD
    A[VS Code starts] --> B[activate() in src/extension.ts]
    B --> C[Register commands and workspace listeners]
    C --> D[User edits a workspace file]
    D --> E[Capture before/after snapshot]
    E --> F[Correlate recent chat-editing context]
    F --> G[Compute change stats and classify signal]
    G --> H[Queue rolling-state update in RepoMetricsStore]
    H --> I[Write .ailoc2-metrics/state/files/*.metrics.json]
    I --> J[pre-commit snapshots index baseline and refreshes summary.json]
    J --> K[commit-msg appends AI suffix]
    K --> L[post-commit promotes baseline and refreshes summary.json]
```

## Activation lifecycle

The extension is activated on `onStartupFinished`.

During activation, `src/extension.ts` does the following:

- creates two output channels: `AILoc2 Probe` and `AILoc2 Summary`
- reads runtime configuration from `ailoc2Probe.logging.verboseOutputChannel`
- instantiates in-memory maps for snapshots, recent chat contexts, and recent will-save events
- seeds snapshots for already-open documents
- creates a `RepoMetricsStore`
- registers commands for diagnostics, summary recomputation, and hook management
- registers listeners for open, change, save, rename, and delete events

On deactivation, the extension flushes pending repo queues and writes a `session-boundary` event with `phase: ended` for each repo that had persisted activity.

## In-memory state vs persisted state

### In memory

The extension keeps several short-lived structures in memory:

- **document snapshots** — text, hash, character length, line count, and version for diff-oriented event analysis
- **recent chat edit contexts** — virtual-document evidence keyed by normalized logical path
- **recent will-save contexts** — save correlation hints used when a later `didSave` arrives
- **tracked repo roots** — repos that have emitted persisted activity in the current extension session

These structures help classify events, but they are not the durable source of truth.

### Persisted to disk

Durable repo-local state lives under `.ailoc2-metrics/` and includes:

- `manifest.json`
- `summary.json`
- `state/repo-summary.json`
- `state/files/**/*.metrics.json`

These files are described in more detail in [`attribution-and-summary.md`](attribution-and-summary.md).

## Document categories and why they matter

`src/extension.ts` groups documents by URI scheme because not every text document should be treated the same.

| Category | Typical scheme | Why it matters |
| --- | --- | --- |
| Workspace file | `file` | This is the only category that can become durable repo attribution. |
| Chat editing virtual document | `chat-editing-text-model` | Useful for context, but not persisted as a tracked repo file. |
| Chat editing snapshot virtual document | `chat-editing-snapshot-text-model` | Strongest near-term signal that an AI apply may be about to hit a real file. |
| Source control input | `vscode-scm` | Useful for diagnostics only. |
| Other virtual documents | `git`, `output`, etc. | Useful context or ignored noise, depending on the scheme. |

The current implementation uses virtual chat-editing documents as evidence, but only real `file:` documents can produce repo-local rolling-state updates.

## Logical paths and repo resolution

Two concepts show up repeatedly in the codebase:

- **logical path** — a normalized lowercase filesystem-like path used to correlate different document forms that refer to the same target file
- **repo location** — `{ repoRoot, repoRelativePath, logicalPath }`

`src/metrics/repoResolver.ts` resolves the nearest `.git` directory while staying within the containing VS Code workspace folder boundary when one exists. That prevents the extension from wandering arbitrarily far up the filesystem.

If a document cannot be resolved to a repo root, it can still be logged for diagnostics, but it will not be persisted as repo-local attribution.

## Tracking exclusions

`src/trackingExclusions.ts` currently excludes:

- `.ailoc2-metrics`
- `.ailoc-metrics`
- `.gitignore`

The main reason is self-protection: the extension should not recursively attribute its own generated artifacts or chase noisy repository housekeeping files.

## Event pipeline in detail

### 1. Document open and close

Open and close events are mostly diagnostic, but they also keep snapshots in sync and flush repo queues opportunistically when a tracked document closes.

### 2. Text change

`onDidChangeTextDocument` is the heart of the runtime pipeline.

For each eligible document change, the extension:

1. reads the previous snapshot
2. captures the new snapshot
3. records or refreshes recent chat-edit context for matching virtual documents
4. computes normalized change statistics
5. classifies the change into a signal bucket
6. decides whether the event should be persisted
7. queues a `workspace-file-metric` record if it belongs to a tracked repo file
8. logs the full diagnostic payload

The actual heuristics live in [`attribution-and-summary.md`](attribution-and-summary.md).

### 3. Save lifecycle

`onWillSaveTextDocument` stores a short-lived correlation record. `onDidSaveTextDocument` turns that into a durable save checkpoint by asking the metrics store to snapshot the current rolling-state attribution against the saved working-tree blob.

That saved checkpoint becomes important later when the summary logic tries to map staged Git blobs back to an attribution state.

### 4. Rename and delete

Rename and delete handling is deliberately explicit.

- same-repo rename: move rolling state and emit a `file-lifecycle` event with `action: renamed`
- cross-repo rename: treat it as a delete in the old repo plus `created-from-rename` in the new repo
- delete: mark the rolling state deleted and emit `action: deleted`

This is intentionally structural bookkeeping, not a claim that line identity survives refactors perfectly.

## Observability

AILoc2 intentionally keeps a lot of the runtime visible.

- `AILoc2 Probe` receives rich diagnostic payloads
- `AILoc2 Summary` receives human-readable summary lines
- command handlers and failures are always logged, even when verbose logging is off

This is useful for debugging two kinds of problems:

- incorrect attribution heuristics
- operational issues such as missing runtime assets or hook configuration drift

## Failure posture

The design is intentionally fail-soft.

- the extension keeps logging even when some repo-specific operations fail
- hook scripts try not to block commits purely because AILoc2 could not compute or annotate a summary
- commit annotation falls back to `(AI unavailable)` instead of aborting the commit

In other words: the project prefers imperfect visibility over workflow-breaking drama.

## Why the repo stopped leaning on CodeBlend session scraping

Earlier experiments attempted to infer attribution from external CodeBlend session artifacts. That approach revealed useful signals, but it was not stable enough for commit-level scoring:

- AI applies could rewrite attribution across large file regions
- small manual edits during active AI sessions could be misread without stronger correlation
- whole-file percentages looked precise while hiding weak provenance

The current extension architecture exists because of that lesson. Instead of reverse-engineering attribution after the fact, AILoc2 now records evidence directly inside the editor process where the edits are observed.
