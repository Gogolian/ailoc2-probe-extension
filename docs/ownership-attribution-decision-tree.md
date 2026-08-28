# Ownership Attribution — Decision Tree

This document explains **how AILoc2 Probe decides whether code is AI-authored, human-authored, or unsure**. It is meant to be the quick-reference "why did this line get counted as AI?" companion to [`attribution-and-summary.md`](./attribution-and-summary.md) (the full algorithm) and [`architecture.md`](./architecture.md) (the module map).

## The core principle

The extension does **not** label whole files, and it does **not** treat "big" as "AI". It records incremental editor evidence as you type, keeps a rolling per-line attribution model per file, and computes a final percentage only at commit time by scoring that model against the actual Git diff.

The question it answers is:

> *How much of **this commit's changed lines** looks AI-assisted?*

Not: *did AI ever touch this file?*

Three buckets exist end to end:

| Bucket | Meaning | Fate at commit time |
| --- | --- | --- |
| **AI** | Evidence links the edit to an AI-assist flow | Counted as AI |
| **Human** | Ordinary editor edit, or a small human edit during a chat session | Counted as Human |
| **Unknown** | Bulk/new-file content with no AI correlation — genuinely ambiguous | Surfaced as **"Unsure"**, and folded into **AI** for the percentage |

> Key consequence: **anything unresolved defaults to AI.** Unknown lines, missing state, and tie-breaks all round toward AI so the metric never *under*-reports AI involvement.

---

## Signals that feed the decision

Before any classification runs, each edit is described by a set of derived flags (`src/extension.ts` → `computeChangeStats`, and the chat-correlation helpers):

- **`hasRecentSnapshotActivity`** — a VS Code *chat-editing snapshot* virtual document for this file changed recently. This is the strongest "an AI apply just happened here" signal.
- **`hasRecentChatCorrelation`** — a VS Code *chat-editing* virtual document for this logical path was active within the recency window.
- **`isWholeDocumentReplace`** — one change, starting at offset 0, whose replaced range equals the entire previous document length (the shape of an "apply to file" operation).
- **`isSmallLocalizedEdit`** — one change inserting **≤8** and removing **≤8** characters (the shape of a person typing).
- **`isInitialFilePopulation`** — file was previously empty; content was added with nothing removed.
- **`isLargeBulkInsertion`** — 0 removed, **≥400** inserted chars **and ≥8** inserted lines.
- **`isLargeBulkExpansion`** — some removal, **≥400** inserted chars, **≥8** inserted lines, and inserted **≥4×** removed.

Governing constants (`src/extension.ts`):

| Constant | Value | Role |
| --- | --- | --- |
| `CHAT_CONTEXT_WINDOW_MS` | `120_000` (120 s) | How long recent chat activity stays "relevant" |
| `RECENT_WILL_SAVE_WINDOW_MS` | `5_000` | Save-proximity window |
| `BULK_AI_INSERT_MINIMUM_TEXT_LENGTH` | `400` | Bulk threshold (chars) |
| `BULK_AI_INSERT_MINIMUM_LINE_COUNT` | `8` | Bulk threshold (lines) |
| `BULK_AI_EXPANSION_MULTIPLIER_THRESHOLD` | `4` | Expansion ratio for bulk-expansion |

---

## The decision tree (per edit)

Classification happens in `src/changeClassification.ts` → `classifyWorkspaceFileChange()`. Rules are evaluated **in order; the first match wins.** The emitted `signal` is then mapped to a bucket by `src/metrics/schema.ts` → `getAttributionBucketForSignal()`.

```
edit arrives
│
├─ 1. Is this a no-op / dirty-state flip?
│      └─ YES → LifecycleNoiseOrDirtyStateFlip        ── DISCARDED (never persisted)
│
├─ 2. Recent AI snapshot activity  AND  whole-document replace?
│      └─ YES → ProbableAIApplyToWorkspaceFile         ── AI   (strongest)
│
├─ 3. Recent chat correlation  AND  small localized edit (≤8/≤8)?
│      └─ YES → LikelyHumanEditWhileChatSessionOpen     ── HUMAN
│               (you hand-tweaking while a chat is open ≠ AI)
│
├─ 4. Recent AI snapshot activity (any shape)?
│      └─ YES → PossibleAIApplyToWorkspaceFile          ── AI
│
├─ 5. Recent chat correlation  AND  (large bulk insertion OR expansion)?
│      └─ YES → ProbableAIBulkWorkspaceEdit             ── AI
│
├─ 6. Initial file population  OR  large bulk insertion  OR  large bulk expansion?
│      └─ YES → UncorrelatedBulkOrNewFileEdit           ── UNKNOWN ("Unsure")
│               (big, but no AI context → do NOT claim it as AI)
│
└─ 7. anything else
       └────→ LikelyHumanOrRegularEditorEdit            ── HUMAN
```

### Reading the tree

- **AI requires *correlation*, not size.** A large paste with no recent chat/snapshot activity falls to rule 6 (Unknown) or rule 7 (Human) — never to an AI bucket. This is deliberate: "you pasted a lot of code" is not evidence of AI authorship.
- **Small edits during a chat session are human** (rule 3 beats rule 4/5). Fixing a typo while Copilot Chat is open should not count against you.
- **Snapshot activity outranks chat correlation** (rules 2 & 4 are about the snapshot document — the actual apply — while 3 & 5 are about chat being merely *open*).
- **"Unsure" is a real outcome** (rule 6). Genuinely ambiguous bulk/new-file content is tracked as Unknown rather than being force-labeled either way — though it later rounds to AI in the percentage.

### Signal → bucket reference (`src/metrics/schema.ts`)

| Signal | Bucket |
| --- | --- |
| `ProbableAIApplyToWorkspaceFile` | **AI** |
| `PossibleAIApplyToWorkspaceFile` | **AI** |
| `ProbableAIBulkWorkspaceEdit` | **AI** |
| `LikelyHumanEditWhileChatSessionOpen` | **Human** |
| `LikelyHumanOrRegularEditorEdit` | **Human** |
| `UncorrelatedBulkOrNewFileEdit` | **Unknown** |

### Claude Code edits — always AI

Edits made through the Claude Code file tools bypass the editor heuristics entirely. `src/integrations/claudeCode/metrics.ts` → `getClaudeCodeSignal()` maps them straight to AI signals (`ProbableAIApplyToWorkspaceFile` for whole-file writes, `ProbableAIBulkWorkspaceEdit` otherwise) and mirrors the state so the IntelliJ plugin agrees.

---

## What happens after classification

The per-edit signal is not the final answer — it feeds a rolling model that is scored against the diff at commit time.

### 1. Weighting: non-whitespace characters only

Every change is weighted by **non-whitespace changed characters** (`src/metrics/store.ts` → `getAttributionRelevantChangeMagnitude()`). Reindenting, blank lines, and pure whitespace churn earn **zero** attribution weight in either direction.

### 2. Formatter-neutral line diffing

`src/metrics/lineDiff.ts` compares lines with a formatter-stable comparator: lines that differ only in whitespace are treated as **equal**, and for JS/TS/JSX/TSX it also normalizes **quote style, trailing semicolons, and trailing commas**. This stops a human-run formatter/linter from silently rewriting previously-AI lines into "Human" and deflating the AI percentage. Crucially, `equal` segments **keep their prior attribution**, so AI lines survive a reformat.

### 3. Rolling per-line model

`applyLineDiffSegmentsToRollingState()` maintains a run-length-encoded per-line attribution map (buckets AI/Human/Unknown):

- `equal` lines → keep previous attribution
- `added` lines → get the current edit's bucket
- `removed` lines → drop out

### 4. Diff-time scoring (`src/metrics/summary.ts`)

At commit time the extension scores staged, unstaged, and untracked changes against this model. Simplified ladder:

1. No rolling state for the file → all added lines default to **AI** (unresolved → AI).
2. Prefer an exact **Git index blob-OID match** to a saved checkpoint (reuse its precise per-line spans).
3. Otherwise score the diff's changed line ranges against the per-line spans, weighted by non-whitespace char count.
4. Fall back through signal counters → latest signal → aggregate magnitude ratio as needed.

Integer line counts are distributed by magnitude ratio using largest-remainder; **any leftover or tie goes to AI**.

### 5. Percentage and commit markers (`src/hooks/commitMessage.ts`)

```
AI %  =  100 × aiAddedLines / (aiAddedLines + humanAddedLines)
```

(Unknown/"Unsure" lines are folded into the AI count for this ratio.) Three annotations are written to the commit message:

- Subject suffix: **`(AI: NN.NN%)`**  — e.g. `bump version (AI: 84.30%)`
- Body: **`(AI-Lines: <ai>/<ai+human>)`**
- Body: **`(Unsure: <unknown>/<ai>)`**  — emitted only when unknown ≤ ai

When the data is unavailable, each is written as `unavailable` instead.

---

## Worked examples

| Scenario | Recent snapshot? | Recent chat? | Edit shape | Signal | Bucket |
| --- | --- | --- | --- | --- | --- |
| Copilot "apply" rewrites the file | yes | — | whole-doc replace | `ProbableAIApplyToWorkspaceFile` | **AI** |
| You fix a typo while chat is open | — | yes | ≤8 chars | `LikelyHumanEditWhileChatSessionOpen` | **Human** |
| Chat is open, you accept a big block | — | yes | ≥400 chars / ≥8 lines | `ProbableAIBulkWorkspaceEdit` | **AI** |
| Snapshot changed, but not a full replace | yes | — | partial | `PossibleAIApplyToWorkspaceFile` | **AI** |
| You paste a big blob, no AI open | no | no | ≥400 chars / ≥8 lines | `UncorrelatedBulkOrNewFileEdit` | **Unknown** → AI in % |
| New empty file you start filling in | no | no | initial population | `UncorrelatedBulkOrNewFileEdit` | **Unknown** → AI in % |
| Ordinary hand editing | no | no | small/medium | `LikelyHumanOrRegularEditorEdit` | **Human** |

---

## Known blind spots

- **Timing-based, not provenance-based.** Attribution rests on editor/chat signals within a 120 s window. Copy-pasting AI output from an *external* chat (browser, terminal) with no editor correlation lands in Unknown → counted as AI, which is intentional but coarse.
- **Unresolved rounds to AI.** Missing rolling state (e.g. edits made outside the tracked editor) inflates AI rather than under-reporting it.
- **Refactors, line moves, and import re-sorting** are areas of ongoing improvement (see `IMPROVEMENT_PLANS.md`).

For the exhaustive algorithm, constants, and edge-case handling, see [`attribution-and-summary.md`](./attribution-and-summary.md).
