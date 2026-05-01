# Git hooks and runtime

This document explains how AILoc2 installs Git hooks, what the generated scripts do, how the bundled runtime CLI behaves, and how fallback cases are handled.

## Why the runtime is a single bundled CommonJS file

The managed hook runtime is installed into consumer repos as:

`.githooks/ailoc2-hook-runtime.cjs`

That file is intentionally bundled as CommonJS. The reason is operational, not aesthetic: consumer repositories may declare `"type": "module"`, and a copied multi-file runtime under the repo’s package scope can easily break if Node interprets it under the wrong module system.

Bundling the hook runtime as one `.cjs` file keeps the hook side predictable.

## Managed hook assets

A fresh managed install provisions exactly four repo-local files:

| File | Purpose |
| --- | --- |
| `.githooks/pre-commit` | Prepares the next-HEAD baseline snapshot and refreshes the summary file before commit finalization. |
| `.githooks/commit-msg` | Appends the AI suffix to the commit subject. |
| `.githooks/post-commit` | Promotes the committed baseline and refreshes the summary after a successful commit. |
| `.githooks/ailoc2-hook-runtime.cjs` | Bundled runtime CLI invoked by the managed hooks. |

## Install flow

`installRepoHooks()` in `src/hooks/management.ts` performs the following steps:

1. resolve and validate the target repo root
2. assert that `<repoRoot>/.git` exists
3. read Git config values for:
   - `core.hooksPath` (local)
   - `core.hooksPath` (effective)
   - `ailoc2Probe.delegateLocalHooksPath` (local)
4. decide whether the repo is already installed, in conflict, or ready for installation
5. write managed hook files and copy the bundled runtime asset
6. optionally record the previous local hooks path for restoration on uninstall
7. optionally record a delegated repo-local hooks path to chain after AILoc2 runs
8. set local `core.hooksPath` to `.githooks`

## Installation statuses

| Status | Meaning |
| --- | --- |
| `installed` | AILoc2 successfully installed its managed assets and set local `core.hooksPath`. |
| `already-installed` | The repo is already using the managed AILoc2 hooks path. |
| `conflict` | The repo already has a different **local** `core.hooksPath`, and replacement was not yet authorized. |

## Git config keys used by AILoc2

| Key | Purpose |
| --- | --- |
| `core.hooksPath` | Standard Git config entry switched to `.githooks` during install. |
| `ailoc2Probe.previousLocalHooksPath` | Stores the replaced repo-local hooks path so uninstall can restore it later. |
| `ailoc2Probe.delegateLocalHooksPath` | Stores an existing repo-local hooks path that AILoc2 should chain after its own hook logic. |

Only repo-local hook configuration is chained or restored automatically. The implementation does not try to rewrite arbitrary global hook setups.

## What the managed hooks do

### `pre-commit`

The managed `pre-commit` hook:

1. checks whether `node` is available and `./.githooks/ailoc2-hook-runtime.cjs` exists
2. if so, runs:

   `node ./.githooks/ailoc2-hook-runtime.cjs prepare-commit-baseline`

3. then runs:

   `node ./.githooks/ailoc2-hook-runtime.cjs refresh-summary`

4. if either command fails, prints a warning to stderr and continues
5. if a delegated repo-local hook path exists, runs the delegated `pre-commit` hook afterward

The key point is that summary refresh is **best effort**. AILoc2 does not try to block every commit because auxiliary metadata could not be refreshed.

### `commit-msg`

The managed `commit-msg` hook:

1. receives the commit message file path as `$1`
2. checks for `node` and the managed runtime file
3. if available, runs:

   `node ./.githooks/ailoc2-hook-runtime.cjs annotate-commit-message "$1"`

4. if that fails, appends a placeholder suffix instead
5. if a delegated repo-local hook exists, runs that delegated hook afterward

The placeholder suffix is currently:

`(AI unavailable)`

That string means annotation could not produce a summary-backed percentage at commit time. It does **not** necessarily mean no AI was used.

### `post-commit`

The managed `post-commit` hook:

1. checks for `node` and the managed runtime file
2. if available, runs:

   `node ./.githooks/ailoc2-hook-runtime.cjs finalize-commit`

3. if that command fails, prints a warning to stderr and continues
4. if a delegated repo-local hook exists, runs that delegated `post-commit` hook afterward

This step is what advances the repo baseline from “last fully clean state” to “the state that was just committed,” which is how later commits stop inheriting already-committed attribution from earlier ones.

## Commit message mutation rules

`src/hooks/commitMessage.ts` applies a few careful rules:

- only the **subject line** is rewritten
- any existing trailing ` (AI ...)` suffix is stripped before a new suffix is applied
- the original newline convention (`\n`, `\r\n`, or `\r`) is preserved
- if the subject line is empty, the suffix text becomes the first line

### Suffix generation

Two suffix shapes exist today:

- percentage available: ` (AI 23.47%)`
- summary unavailable: ` (AI unavailable)`

The percentage is taken from `summary.staged.aiPercentage` when `summary.isGitSummaryAvailable` is true.

## Runtime CLI

The managed hooks call the bundled CLI defined in `src/cli/gitHookCli.ts`.

### Supported commands

| Command | Behavior |
| --- | --- |
| `prepare-commit-baseline [repoRoot]` | Snapshots the current Git index into a pending baseline file for promotion after a successful commit. |
| `refresh-summary [repoRoot]` | Recomputes `.ailoc2-metrics/summary.json` and prints the formatted summary line. |
| `annotate-commit-message <messageFilePath> [repoRoot]` | Rewrites the commit subject with the AI suffix and prints the suffix used. |
| `finalize-commit [repoRoot]` | Promotes the pending baseline (or derives one from the current index) and refreshes `.ailoc2-metrics/summary.json`. |

If `repoRoot` is omitted, the CLI resolves it relative to the current working directory.

## Uninstall flow

`uninstallRepoHooks()` does the reverse side of installation:

1. inspect the current local and effective hooks path
2. remove managed assets if they still look like AILoc2-managed files
3. if the current local hooks path is AILoc2-managed and a previous local hooks path was saved, restore it
4. otherwise unset the local `core.hooksPath`
5. remove AILoc2 bookkeeping config keys

## Uninstall statuses

| Status | Meaning |
| --- | --- |
| `uninstalled` | Managed hooks were removed and no previous local hooks path needed restoration. |
| `restored-previous` | Managed hooks were removed and the previous repo-local hooks path was restored. |
| `not-installed` | The repo was not currently using the managed hooks path, though leftover managed assets may still have been cleaned up. |

## Safety rules around overwrite and removal

The hook manager is intentionally cautious.

- managed hook files are only overwritten when they already look like AILoc2-managed files or when the target path does not exist
- uninstall only removes hook files that still match the managed AILoc2 patterns or legacy managed variants
- if a hook file has been replaced with unrelated custom content, uninstall leaves it alone

This avoids the cheerful disaster mode where a tool deletes a team’s custom hook logic because the filenames happened to match.

## Legacy runtime cleanup

Older installs could use a copied runtime tree under:

`.githooks/ailoc2-runtime/`

Current installs remove that legacy directory and standardize on the single-file `.cjs` runtime.

## Operational troubleshooting

### The commit got `(AI unavailable)`

That usually means one of these happened:

- Node was unavailable in the hook environment
- the managed runtime file was missing
- the summary file could not be refreshed or read
- the hook runtime hit an unexpected error and fell back to the placeholder suffix

First things to check:

- `.githooks/ailoc2-hook-runtime.cjs` exists in the repo
- `.ailoc2-metrics/summary.json` exists and is valid JSON
- `git config --local --get core.hooksPath` resolves to `.githooks`
- the extension has actually observed edits for the repo and written rolling state

### Hook install reports a conflict

This means the repo already has a different **local** `core.hooksPath`. The extension can either:

- chain to that existing repo-local hook path
- replace it and remember the old value for later restoration

### The repo uses `"type": "module"`

That is exactly why the installed runtime is bundled as `.cjs`. It avoids the consumer repo’s package module type from accidentally changing how the hook runtime is interpreted.
