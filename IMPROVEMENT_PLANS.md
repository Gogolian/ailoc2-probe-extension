# IMPROVEMENT_PLANS.md

How AILoc2 should evolve so that **linters and formatters never steal attribution**.

> Guiding invariant: if AI wrote 50% of a change and a human wrote the other 50%,
> then running a linter/formatter over the code must still report **AI 50%** at
> commit time. A formatter is not an author.

This document captures the analysis behind that goal, what was fixed now, and
what is intentionally deferred. It also records what we learned from studying
[`kaustubh03/brela`](https://github.com/kaustubh03/brela).

---

## 1. The problem, precisely

Attribution lives in two layers:

1. **Rolling per-line state** (`.ailoc2-metrics/state/files/**/*.metrics.json`) —
   a run-length attribution model built up live from editor events
   (`src/metrics/store.ts` → `applyLineDiffSegmentsToRollingState`).
2. **Commit-time summary** (`src/metrics/summary.ts`) — scores the staged/unstaged
  Git diff against that rolling model and writes the weighted percentage plus
  non-blank AI/Human added-line counts.

A linter/formatter run damages attribution in several distinct ways:

| # | Linter behavior | Where it hurts | Status |
|---|---|---|---|
| A | Whitespace / indentation reflow (Prettier reindent, `gofmt`, spaces around operators) | Rolling state: reflowed lines were rewritten to `Human` | **Fixed** (formatter-neutral line diff) |
| B | Whitespace-only churn in the committed diff | Summary percentages | Already handled (`--ignore-all-space` + non-whitespace weighting) |
| C | Non-whitespace token rewrites (single→double quotes, semicolon insertion, trailing commas) | Rolling state **and** new-file summary: lines/magnitudes looked like real human edits | **Partially fixed** for TypeScript/JavaScript quote style, trailing semicolons, and trailing commas |
| D | Line moves / reordering (import sorting, member sorting) | Rolling state: positional line model misaligns; moved AI lines look removed+added | **Open** |
| E | Formatter runs *outside* the editor (`eslint --fix` / `prettier -w` on CLI, pre-commit hooks) | Never observed at edit time; only seen as a Git diff at commit | **Open** |
| F | Formatter output scores as "more AI-like" by style-consistency heuristics | Any future fingerprint-based scoring | Watch-out (see brela note) |

### Reproduction

`src/test/linterAttribution.test.ts` drives the real store end to end:

- **Fixed case (A):** AI writes 2 lines, human writes 2 lines, formatter reindents
  the whole file → attribution stays `AI 2 / Human 2`.
- **Fixed slice (C):** AI writes 2 lines, a quote/semicolon rewrite is applied →
  attribution stays `AI 2` and the formatter event contributes zero Human magnitude.

---

## 2. What was fixed in this pass

**Formatter-neutral rolling-state line diffing and magnitude accounting** (cases A and part of C).

- New pure module `src/metrics/lineDiff.ts` computes `lineDiffSegments` by
  comparing logical lines with formatter-neutral trivia stripped (a `diffArrays`
  `comparator`). Pure reflow, plus conservative TypeScript/JavaScript quote,
  trailing-semicolon, and trailing-comma rewrites, become `equal` segments, so the
  rolling per-line model preserves prior attribution instead of reassigning
  reflowed lines to the editing event's bucket.
- `LineDiffSegment` records added/removed non-whitespace weights. Rolling state
  now increments cumulative AI/Human magnitude only for attribution-relevant
  added/removed segments. Formatter-only `equal` segments add zero magnitude and
  do not advance the latest author signal.
- This aligns the rolling-state layer with the summary layer, which already uses
  `git diff --ignore-all-space`.
- Tests: `src/test/lineDiff.test.ts` (unit) and `src/test/linterAttribution.test.ts`
  (end-to-end through the store), plus `src/test/commitBaseline.test.ts` for the
  staged-new-file summary regression.
- The IntelliJ plugin needs the **same** change; see §4.

This is deliberately the conservative, low-risk slice. Real token differences are
still compared, and formatter-style token normalization is gated to TypeScript and
JavaScript.

---

## 3. Deferred work (the harder, higher-value parts)

### 3.1 Broader token-normalized line matching (remaining case C)

Compare lines after a language-aware normalization pass, not just whitespace
stripping, when deciding whether an `added` line is really a reformat of a
`removed` line. Quote-style, trailing semicolons, and trailing commas are already
handled conservatively for TypeScript/JavaScript. Remaining candidates include
formatter-produced equivalent-token rewrites such as `as const` insertion or other
language-specific trivia that should not imply authorship.

- **Risk:** over-normalization can mask a genuine human edit. Keep it conservative
  and ideally per-language (gate by `languageId`).
- **Where:** the `comparator` in `lineDiff.ts` is the single injection point.
- **Stronger version:** tokenizer/AST-based equivalence (e.g. compare token
  streams ignoring trivia). Best accuracy, highest cost; likely per-language and
  opt-in.

### 3.2 Move-tolerant (content-keyed) attribution (case D)

Today attribution is positional, so import sorting makes AI lines look
removed-then-added. Adopt a **content-multiset** mapping: key the previous
attribution by normalized line content, and when a line reappears at a new
position, carry its prior attribution with it.

- brela's `extractAddedRanges()` already uses a consume-once multiset that is
  naturally tolerant of moves — a transferable shape, not a copyable solution
  (brela does no normalization, so it still breaks on reformatting).
- Combine with §3.1 normalization so a *moved and reformatted* import still keeps
  its author.

### 3.3 Detect formatter/linter edits explicitly

Rather than (or in addition to) normalizing diffs, recognize formatter activity
and treat it as **attribution-neutral** (carry-forward), never crediting it to AI
or Human:

- **Format-on-save:** edits applied during the save flow (around
  `onWillSaveTextDocument` / `vscode.commands` format) are a strong signal.
- **Whole-file low-semantic-delta rewrite:** a whole-document replace whose
  normalized content is unchanged is almost certainly a formatter.
- **Known tool fingerprints:** an edit immediately following a detected
  `eslint --fix` / `prettier` task.

A new neutral bucket (`Formatter`/`Tool`) that is excluded from the headline
percentage — like `Unknown` is today — keeps the invariant intact.

### 3.4 Out-of-editor formatter runs (case E)

When the linter runs on the CLI or in a pre-commit hook, no editor event exists.
At commit time the staged diff shows changed lines the extension never saw.
Options:

- During `pre-commit`, compare the staged blob against the last save checkpoint
  using normalized (§3.1) and move-tolerant (§3.2) matching, and carry attribution
  across the reformat instead of treating the lines as unattributed.
- Optionally provide an AILoc2 wrapper / config so a known formatter step marks
  its own output as attribution-neutral.

### 3.5 Anti-pattern to avoid (case F)

brela's `diff-fingerprint.ts` scores *style consistency* (consistent quotes,
indentation, semicolons) as evidence of AI authorship. Formatter output is
maximally consistent, so that heuristic would label formatted human code as AI.
If we ever add stylistic fingerprinting, it must be formatter-aware or it will
invert the very result we care about.

---

## 4. IntelliJ parity

The IntelliJ plugin under `IntelliJ/` computes its own staged AI percentage and
added-line counts while maintaining its own metrics; it must receive the same
formatter-neutral line matching and magnitude accounting. Track this so the two
plugins do not diverge in how they treat formatter churn.

---

## 5. Validation strategy

The "does our approach survive linting?" question should be answered by tests, not
by hand. Current coverage:

- `src/test/lineDiff.test.ts` — comparator behavior (reflow, quote/semicolon/trailing-comma normalization, and real token changes).
- `src/test/linterAttribution.test.ts` — end-to-end store invariants proving formatter-neutral rewrites preserve AI and Human attribution.
- `src/test/commitBaseline.test.ts` — real Git staged-summary regression for a formatted AI-authored new file staged alongside a human-authored file.

Planned additions as the deferred work lands:

- A scenario matrix: for each transformation (reindent, quote swap, semicolon
  insertion, import sort, CLI `eslint --fix`), assert the AI/Human split is stable
  across a realistic "AI 50% / human 50%" file.
- Commit-level scenarios for moved/reordered lines and out-of-editor formatter runs once those deferred items land.

When a deferred item is implemented, tighten the corresponding characterization
test from "documents the loss" to "asserts attribution survived."

---

## 6. Is the whole approach wrong?

No — but it is incomplete. The core idea (observe edits live, keep a repo-local
per-line attribution model, score it against the real Git diff) is sound and is
already ahead of brela, which does exact string matching everywhere and has *no*
formatter handling. The realistic failure mode is not the model itself but its
**positional, exact-match line identity**. The path forward is to make line
identity **content-based and normalization-aware** (§3.1–§3.2) and to treat
formatter activity as a first-class neutral signal (§3.3), rather than to discard
the architecture.
