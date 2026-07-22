# Claude Code integration

AILoc2 includes a Claude Code companion runtime that records Claude-authored file edits into the same repo-local `.ailoc2-metrics` state used by the VS Code and IntelliJ integrations.

The goal is synergy across tools:

1. a human edits a file in VS Code or IntelliJ
2. Claude Code edits another file in the same repository
3. the user stages and commits through normal Git or VS Code
4. the existing AILoc2 summary reads one shared `.ailoc2-metrics` state and reports the combined AI/Human attribution

## Runtime file

The Claude Code runtime is bundled as:

`out/claude-code/ailoc2-claude-code.cjs`

It is bundled as CommonJS for the same reason as the Git hook runtime: the target repository might use any Node module type, so copied hook runtimes should not depend on the consumer package scope.

## Commands

The runtime supports these commands:

| Command | Behavior |
| --- | --- |
| `capture-before [payloadJsonPath|-]` | Reads a Claude Code hook payload and snapshots target file contents before `Write`, `Edit`, or `MultiEdit` runs. |
| `record-edit [payloadJsonPath|-]` | Reads the post-tool payload, loads the before snapshot, reads the file after Claude Code changed it, and writes AI attribution into `.ailoc2-metrics/state/files/**`. |
| `install-claude-hooks [repoRoot] [runtimeSourcePath]` | Copies the runtime to `.claude/ailoc2-claude-code.cjs` and merges AILoc2 hook entries into `.claude/settings.json`. |
| `uninstall-claude-hooks [repoRoot]` | Removes AILoc2-managed Claude Code hook entries and deletes the copied runtime. |

When `payloadJsonPath` is omitted or `-`, the runtime reads JSON from stdin. This matches Claude Code hook behavior where payloads are provided to hook commands via stdin.

## Hook install behavior

The normal AILoc2 **Install Repo Hooks** flow installs Claude Code hooks automatically. The standalone `install-claude-hooks` command writes repo-local Claude settings under:

`.claude/settings.json`

It adds managed hooks for `Write|Edit|MultiEdit`:

- `PreToolUse` → `capture-before`
- `PostToolUse` → `record-edit`

Existing Claude settings and unrelated hooks are preserved. Re-running install first removes older AILoc2-managed hook entries, then adds the current ones. Uninstall removes only hook commands that reference `ailoc2-claude-code.cjs`.

## Attribution behavior

Claude Code is the provenance signal. Successful `Write`, `Edit`, and `MultiEdit` file mutations are recorded as AI-authored edits without relying on size heuristics.

Current mapping:

| Claude tool | AILoc2 signal |
| --- | --- |
| `Write` | `ProbableAIApplyToWorkspaceFile` |
| `Edit` | `ProbableAIBulkWorkspaceEdit` |
| `MultiEdit` | `ProbableAIBulkWorkspaceEdit` |

The runtime computes formatter-neutral line diff segments using `src/metrics/lineDiff.ts`, queues records through `RepoMetricsStore`, and writes save checkpoints so staged Git blobs can be matched to Claude attribution later.

## Missing before snapshots

For `Edit` and `MultiEdit`, AILoc2 requires a before snapshot. If `record-edit` runs without a matching `capture-before` snapshot, it skips the edit instead of attributing the whole file to AI. This avoids over-counting when hook ordering or payloads are incomplete.

For `Write`, a missing before snapshot is treated as an empty file, which matches the common new-file case.

## Shared storage

Claude Code writes into the existing VS Code-compatible layout:

```text
.ailoc2-metrics/
└─ state/
   └─ files/
      └─ path/
         └─ to-file.js.metrics.json
```

It also writes a synchronized TSV view under `.ailoc2-metrics/intellij-state` so the IntelliJ shell hook can consume the same line attribution without mistaking the resulting disk reload for a human edit. It does not create a separate Claude summary file. The existing Git hook runtime remains the single commit-time summary path.

## Manual smoke test

1. Build the project:

```bash
npm run build
```

2. Install Claude Code hooks into a target repo:

```bash
node out/claude-code/ailoc2-claude-code.cjs install-claude-hooks C:\path\to\repo out\claude-code\ailoc2-claude-code.cjs
```

3. Ask Claude Code to create or edit a file in that repo.
4. Recompute or commit with AILoc2 Git hooks installed.
5. Inspect `.ailoc2-metrics/state/files/**` and `.ailoc2-metrics/summary.json`.

## Failure posture

The hook commands are fail-soft during normal Claude Code edit flows. A metrics failure logs a warning but should not block Claude Code from editing files.
