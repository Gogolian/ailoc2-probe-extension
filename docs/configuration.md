# Configuration guide

*Polish version: [`konfiguracja.md`](konfiguracja.md)*

AILoc2 reads its attribution settings from a config file in your repository. This guide covers every option, how the two config layers combine, and what each setting actually changes in the reported percentage.

Defaults match the historical behavior, so an existing repository behaves exactly as before until you change something.

## The two layers

| File | Committed? | Purpose |
| --- | --- | --- |
| `.ailoc2-probe.json` (repo root) | **Yes** | Team policy. Travels with the repo, so everyone scores commits the same way. |
| `.ailoc2-metrics/config.json` | No — `.ailoc2-metrics/` is gitignored | Personal override for one machine. |

`.ailoc2-probe.json` is created with defaults when you run **Install Repo Hooks**. It is never overwritten on reinstall, so your edits are safe, and it is deliberately kept out of `.gitignore` so you can commit it.

The local file is optional and may be partial — list only the keys you want to override.

### How the layers merge

Every setting except `excludePaths` merges **per key**: if the local file specifies it, local wins; otherwise the team value applies; otherwise the default.

```jsonc
// .ailoc2-probe.json  (team)
{ "attribution": { "mode": "signals", "largeFileIsAI": false } }

// .ailoc2-metrics/config.json  (you)
{ "attribution": { "mode": "markers" } }

// effective: mode = "markers"  (local wins)
//            largeFileIsAI = false  (team value, not overridden)
```

`excludePaths` is different: the two lists are **concatenated**, team first, then local. Because matching is last-match-wins, this lets you re-include something your team excluded (see [Excluding paths](#excluding-paths)).

## Full example

```json
{
  "version": 1,
  "attribution": {
    "mode": "signals",
    "largeFileIsAI": true,
    "newFileIsAI": true,
    "excludePaths": []
  }
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `version` | number | `1` | Config schema version. |
| `attribution.mode` | `"signals"` \| `"markers"` | `"signals"` | How attribution is decided. See [Attribution modes](#attribution-modes). |
| `attribution.largeFileIsAI` | boolean | `true` | Whether a large insertion counts toward AI. |
| `attribution.newFileIsAI` | boolean | `true` | Whether filling a brand-new file counts toward AI. |
| `attribution.excludePaths` | string[] | `[]` | Gitignore-style patterns excluded from attribution. |

Unknown keys are ignored. A malformed or unparseable file falls back to defaults and logs a warning rather than breaking your commit.

## Attribution modes

### `signals` (default)

The passive model: AILoc2 watches editor and chat activity, Claude Code tool calls, and edit shape, then classifies each change. You write no markers. This is the behavior described in [`attribution-and-summary.md`](attribution-and-summary.md).

### `markers`

The legacy model, for teams who still annotate AI code by hand. Attribution comes **only** from `AI start` / `AI stop` comments:

- an added line inside a marker block → **AI**
- every other added line → **Human**

This is an *exclusive replacement*. Chat correlation, large-insertion heuristics, Claude Code provenance, and the stored rolling state are all ignored for counting. Nothing lands in the Unknown bucket.

```ts
const handWritten = 1;
// AI start
const generatedOne = 2;
const generatedTwo = 3;
// AI stop
const alsoHandWritten = 4;
```

The example above reports 2 AI lines and 2 Human lines.

**Marker syntax.** The marker is matched anywhere in the line and the comment character is irrelevant, so every language works with one rule:

```
// AI start        # AI start        -- AI start
/* AI start */     <!-- AI start -->
```

Matching is case-insensitive and tolerates separators, so `AI stop`, `ai_stop`, `AI-STOP` and `Ai   Stop` are all recognized. A word boundary is required, so an identifier like `aiStartupCost` is not mistaken for a marker.

**Counting rules.**

- Marker lines themselves are excluded from both the AI count and the total.
- Blocks nest: an inner `AI stop` closes only the inner block.
- Block state resets at each file, so an unclosed block never bleeds into the next file in the diff.
- Blank and whitespace-only lines are not counted.
- Only added (`+`) lines count; removals and context lines are ignored.

### Markers are removed when you commit

In `markers` mode, AILoc2 counts your staged changes and then **deletes the marker lines from the index and the working tree**, so markers never reach the commit. This reproduces the original tool's behavior, where markers were temporary editing aids.

Everything else is left byte-for-byte identical. The stripper:

- preserves the file's line endings and whether it ended with a newline
- preserves the executable bit
- skips symlinks, submodules, and files containing binary content
- rewrites the working tree **only** if it still matches what you staged, so unstaged work in progress is never clobbered

If you would rather keep your markers in the source, stay in `signals` mode.

## Large insertions and new files

Two separate switches, because they answer different questions.

| Setting | `true` (default) | `false` |
| --- | --- | --- |
| `largeFileIsAI` | A large insertion or a large expansion is treated as AI-leaning. | The change is attributed to **Human** and does not raise the AI percentage. |
| `newFileIsAI` | Filling a brand-new file is treated as AI-leaning. | The change is attributed to **Human**. |

Turn `largeFileIsAI` off when your repo regularly absorbs content you did not write with an AI: vendored libraries, generated API clients, big mechanical refactors, or pasted-in fixtures.

Two things worth knowing:

- **Stronger evidence still wins.** These switches only affect the size-based guess. If AILoc2 has real evidence — a chat-editing apply, or a recorded Claude Code edit — the change is still attributed to AI regardless of these flags.
- **They are genuinely separate.** Turning off `largeFileIsAI` leaves new-file handling untouched, and vice versa.

## Excluding paths

`excludePaths` removes files from attribution entirely. An excluded file is counted in **neither** the AI numerator nor the total, so it cannot move your percentage in either direction, and no per-file attribution state is stored for it.

```json
{
  "attribution": {
    "excludePaths": [
      "vendor/**",
      "*.generated.ts",
      "src/legacy/",
      "!src/legacy/keep-scoring-this.ts"
    ]
  }
}
```

**Pattern syntax** is gitignore-style:

| Pattern | Matches |
| --- | --- |
| `vendor/**` | everything under `vendor/` at any depth |
| `*.generated.ts` | any file with that suffix, in any directory |
| `/build` | `build` at the repo root only (leading `/` anchors) |
| `dist/` | the `dist` directory and its contents |
| `file?.ts` | `file1.ts`, `fileA.ts` — `?` is one character |
| `[abc]*.ts` | character classes, and `[!abc]` to negate |
| `# comment` | ignored |
| `!pattern` | re-includes something an earlier pattern excluded |

The **last matching pattern wins**. Combined with team-then-local concatenation, that is what makes personal re-inclusion work:

```jsonc
// .ailoc2-probe.json  (team) — exclude all of vendor/
{ "attribution": { "excludePaths": ["vendor/**"] } }

// .ailoc2-metrics/config.json  (you) — but score this one file
{ "attribution": { "excludePaths": ["!vendor/my-active-work.js"] } }
```

### `excludePaths` vs `.ailoc2-metrics/.ignore`

Both accept the same pattern syntax, and both keep a file out of scoring. Prefer `excludePaths` for anything the whole team should agree on, since `.ailoc2-metrics/` is gitignored and `.ignore` therefore cannot be shared. `.ignore` remains supported for machine-local opt-outs.

## Changing settings from the IDE

You do not have to hand-edit JSON for the common toggles.

- **VS Code** — run `AILoc2 Probe: Attribution Settings` from the Command Palette. Pick a repository, then flip the mode, `largeFileIsAI`, or `newFileIsAI`. An **Edit excluded paths…** entry opens `.ailoc2-probe.json` directly.
- **IntelliJ IDEA** — **Tools → AILoc2 Probe: Attribution Settings**.

Both write to the **local** layer (`.ailoc2-metrics/config.json`), so a quick toggle never dirties committed team policy. To change team policy, edit `.ailoc2-probe.json` yourself. Both also refresh the repo summary immediately, so the effect is visible right away.

## Files involved

```text
your-repo/
├─ .ailoc2-probe.json                    # team policy — commit this
└─ .ailoc2-metrics/
   ├─ config.json                        # your local override (optional)
   ├─ resolved-config.env                # generated; do not edit
   └─ .ignore                            # legacy machine-local opt-outs
```

`resolved-config.env` is a flattened copy of the merged settings, written for IntelliJ's generated shell hook, which cannot parse JSON. It is regenerated on install, on every toggle, and before every commit from the IDE, so it follows your JSON automatically. Edit the JSON, never the `.env`.

## Troubleshooting

**My change to the config had no effect.**
Both IDEs cache the config and re-read it when the file's timestamp or size changes; toggling from the actions menu invalidates the cache explicitly. After hand-editing, run **Recompute Repo Summary** to see the new numbers.

**I turned off `largeFileIsAI` but the percentage did not move.**
Most likely AILoc2 had stronger evidence than size — a chat apply or a Claude Code edit — which the flag does not suppress. Note too that a file with no recorded attribution state at all is still counted as AI by the unresolved-lines fallback; that fallback is independent of this setting. Use `excludePaths` if you want a file out of scoring entirely.

**In `markers` mode everything is reported as Human.**
Marker mode counts only what is inside `AI start` / `AI stop` blocks, and only markers that are part of your **staged** additions. Check that the block is staged and that the marker line survived a previous commit's stripping pass.

**My markers disappeared.**
That is intended in `markers` mode — see [Markers are removed when you commit](#markers-are-removed-when-you-commit). Switch to `signals` mode to keep them.

**A commit reports `(AI: unavailable)`.**
Summary generation or the hook runtime fell back. This is not a statement about AI usage. Check the `AILoc2 Summary` output channel, or the IDE log, for the underlying warning.

## See also

- [`attribution-and-summary.md`](attribution-and-summary.md) — how signal-mode attribution and summaries are computed
- [`hooks-and-runtime.md`](hooks-and-runtime.md) — hook installation and commit-message annotation
- [`ownership-attribution-decision-tree.md`](ownership-attribution-decision-tree.md) — the signal decision tree
