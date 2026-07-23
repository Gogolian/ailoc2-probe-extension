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
| `.githooks/commit-msg` | Appends the AI percentage and line-count suffix to the commit subject. |
| `.githooks/post-commit` | Promotes the committed baseline, clears fully committed file metrics, and refreshes the summary after a successful commit. |
| `.githooks/ailoc2-hook-runtime.cjs` | Bundled runtime CLI invoked by the managed hooks. |

If the repo already has unmanaged hook files at the same `.githooks/<hook>` paths, AILoc2 asks before changing them. When wrapping is approved, the original hook is moved beside the managed wrapper as `.githooks/<hook>.ailoc2-delegate` and the generated AILoc2 hook runs that preserved hook after AILoc2 finishes.

When automatic wrapping is unsafe, AILoc2 prepares `.githooks/migration-package/` instead. The package contains generated AILoc2 `pre-commit`, `commit-msg`, and `post-commit` hook files, `ailoc2-hook-runtime.cjs`, and `COPILOT-INSTRUCTIONS.md` with guidance for a follow-up Copilot session to chain the generated logic into the existing hooks.

## Install flow

`installRepoHooks()` in `src/hooks/management.ts` performs the following steps:

1. resolve and validate the target repo root
2. assert that `<repoRoot>/.git` exists
3. read Git config values for:
   - `core.hooksPath` (local)
   - `core.hooksPath` (effective)
   - `ailoc2Probe.delegateLocalHooksPath` (local)
4. decide whether the repo is already installed, in conflict, or ready for installation
5. detect existing unmanaged `.githooks/pre-commit`, `.githooks/commit-msg`, or `.githooks/post-commit` files before mutating the repo
6. if approved, preserve existing unmanaged hook files as `.githooks/<hook>.ailoc2-delegate`, or prepare `.githooks/migration-package/` if automatic wrapping is unsafe
7. update `.gitignore` for `.ailoc2-metrics/`, `.githooks/`, and `.claude/`
8. write managed hook files and copy the bundled Git hook runtime asset
9. install Claude Code hooks into `.claude/settings.json` and copy `.claude/ailoc2-claude-code.cjs`
10. optionally record the previous local hooks path for restoration on uninstall
11. optionally record a delegated repo-local hooks path to chain after AILoc2 runs
12. set local `core.hooksPath` to `.githooks`

## Aggregate workspace install

The IntelliJ **Install Workspace Claude Hooks** action supports Claude Code sessions started above multiple nested repositories. It writes only:

- `<workspace>/.claude/settings.json`
- `<workspace>/.claude/ailoc2-claude-code.cjs`

Existing unrelated Claude settings and hook commands are preserved, and reinstalling is idempotent. Malformed existing settings are reported instead of being overwritten. Uninstall removes only AILoc2-managed Claude commands and the managed runtime.

Workspace installation never recursively modifies nested repositories. In particular, it does not write nested `.githooks`, change `core.hooksPath`, or alter nested `.gitignore` files. Git hooks remain a separate, explicit per-repository installation.

## Installation statuses

| Status | Meaning |
| --- | --- |
| `installed` | AILoc2 successfully installed managed Git and Claude Code hook assets and set local `core.hooksPath`. |
| `already-installed` | The repo is already using the managed AILoc2 hooks path; managed assets are refreshed. |
| `conflict` | The repo already has a different **local** `core.hooksPath`, and replacement was not yet authorized. |
| `hook-file-conflict` | The repo has existing `.githooks/<hook>` files that are not managed by AILoc2, and wrapping was not yet authorized. |
| `manual-merge-required` | AILoc2 could not safely preserve an existing hook automatically, so it prepared `.githooks/migration-package/` for manual or Copilot-assisted chaining. |

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
2. if so, runs baseline preparation and summary refresh in one Node process:

   `node ./.githooks/ailoc2-hook-runtime.cjs prepare-commit`

3. if the command fails, prints a warning to stderr and continues
4. if a delegated repo-local hook path exists, runs the delegated `pre-commit` hook afterward

The key point is that summary refresh is **best effort**. AILoc2 does not try to block every commit because auxiliary metadata could not be refreshed.

If an unmanaged `pre-commit` hook was wrapped during install, the preserved `.githooks/pre-commit.ailoc2-delegate` hook runs after the AILoc2 logic. If AILoc2 also chained to a previous `core.hooksPath`, that previous-path hook runs after the preserved same-directory hook.

### `commit-msg`

The managed `commit-msg` hook:

1. receives the commit message file path as `$1`
2. checks for `node` and the managed runtime file
3. if available, runs:

   `node ./.githooks/ailoc2-hook-runtime.cjs annotate-commit-message "$1"`

4. during annotation, recomputes the pending baseline and summary from the final Git index
5. if annotation fails, appends a placeholder suffix instead
6. if a delegated repo-local hook exists, runs that delegated hook afterward

The placeholder suffix is currently:

`(AI: unavailable) (AI lines: unavailable) (H lines: unavailable)`

That string means annotation could not produce a valid summary-backed percentage and both line counts at commit time. It does **not** mean no AI was used.

The final-index recomputation matters when an earlier delegated `pre-commit` hook formats, lints, generates, or stages files after AILoc2's first pre-commit pass. Commit annotation and the baseline promoted after the commit both use what Git is actually about to commit.

### `post-commit`

The managed `post-commit` hook:

1. checks for `node` and the managed runtime file
2. if available, runs:

   `node ./.githooks/ailoc2-hook-runtime.cjs finalize-commit`

3. during finalization, clears rolling state for files included in the commit unless that path still has unstaged work
4. if that command fails, prints a warning to stderr and continues
5. if a delegated repo-local hook exists, runs that delegated `post-commit` hook afterward

This step is what advances the repo baseline from “last fully clean state” to “the state that was just committed,” which is how later commits stop inheriting already-committed attribution from earlier ones. Files that were fully committed start fresh; files with leftover unstaged work keep their metrics and baseline entry so that remaining work can still be summarized later.

## Commit message mutation rules

`src/hooks/commitMessage.ts` applies a few careful rules:

- only the **subject line** is rewritten
- any existing legacy percentage suffix or compound percentage/line-count suffix is stripped before a new suffix is applied
- the original newline convention (`\n`, `\r\n`, or `\r`) is preserved
- if the subject line is empty, the suffix text becomes the first line

### Suffix generation

Two suffix shapes exist today:

- attribution available: ` (AI: 23.47%) (AI lines: 12) (H lines: 39)`
- summary unavailable or invalid: ` (AI: unavailable) (AI lines: unavailable) (H lines: unavailable)`

The values are taken from `summary.staged.aiPercentage`, `summary.staged.aiAddedLineCount`, and `summary.staged.humanAddedLineCount`. All three must be valid; old or malformed summaries missing the count fields fail closed to the unavailable suffix.

## Runtime CLI

The managed hooks call the bundled CLI defined in `src/cli/gitHookCli.ts`.

### Supported commands

| Command | Behavior |
| --- | --- |
| `prepare-commit [repoRoot]` | Prepares the pending baseline and refreshes the summary in one process. This is the command used by managed `pre-commit` hooks. |
| `prepare-commit-baseline [repoRoot]` | Snapshots the current Git index into a pending baseline file for promotion after a successful commit. |
| `refresh-summary [repoRoot]` | Recomputes `.ailoc2-metrics/summary.json` and prints the formatted summary line. |
| `annotate-commit-message <messageFilePath> [repoRoot]` | Refreshes the final-index baseline and summary, rewrites the commit subject with the compound attribution suffix, and prints the suffix used. |
| `finalize-commit [repoRoot]` | Promotes the pending baseline (or derives one from the current index) and refreshes `.ailoc2-metrics/summary.json`. |

If `repoRoot` is omitted, the CLI resolves it relative to the current working directory.

### Performance profiling

Set `AILOC2_PROFILE=1` in the hook environment to append timing events to `.ailoc2-metrics/performance.jsonl`. Events include the overall pre-commit duration, baseline and summary phase durations, staged and unstaged file counts, and categorized Git command timings. File paths and source contents are not recorded. Profiling failures are ignored so diagnostics cannot block a commit.

Profiling is disabled by default and the file is not created unless the environment variable is enabled.

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
- unmanaged hook files at AILoc2's target paths are reported before install mutates `.gitignore`, runtime assets, Claude settings, or Git config
- existing hook files are wrapped only after explicit user approval
- wrapped hook files are preserved as `.githooks/<hook>.ailoc2-delegate` and restored to their original active path on uninstall
- uninstall only removes hook files that still match the managed AILoc2 patterns or legacy managed variants
- if a hook file has been replaced with unrelated custom content, uninstall leaves it alone
- if a preserved delegate path already exists or the hook path cannot be moved safely, AILoc2 prepares `.githooks/migration-package/` and asks for manual or Copilot-assisted chaining instead of overwriting anything

This avoids the cheerful disaster mode where a tool deletes a team’s custom hook logic because the filenames happened to match.

## Legacy runtime cleanup

Older installs could use a copied runtime tree under:

`.githooks/ailoc2-runtime/`

Current installs remove that legacy directory and standardize on the single-file `.cjs` runtime.

## Operational troubleshooting

### The commit got unavailable percentage and line markers

That usually means one of these happened:

- Node was unavailable in the hook environment
- the managed runtime file was missing
- the summary file could not be refreshed or read
- an older or malformed summary did not contain valid AI and Human line counts
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

### Hook install reports existing unmanaged hook files

This means `.githooks/pre-commit`, `.githooks/commit-msg`, or `.githooks/post-commit` already exists and does not look AILoc2-managed. The installer can preserve those files and generate AILoc2 wrappers that run the preserved hooks afterward.

If automatic wrapping is unsafe, AILoc2 prepares `.githooks/migration-package/` with generated hook files, the runtime, and Copilot instructions. Merge the packaged AILoc2 logic with the existing hook files manually or with Copilot, then rerun install.

### The repo uses `"type": "module"`

That is exactly why the installed runtime is bundled as `.cjs`. It avoids the consumer repo’s package module type from accidentally changing how the hook runtime is interpreted.
