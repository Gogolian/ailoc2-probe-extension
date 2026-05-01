# Attribution and summary pipeline

This document describes how AILoc2 turns editor events into rolling attribution state and then into staged / unstaged AI percentages.

## The short version

AILoc2 does **not** try to label an entire file as AI or human. Instead, it stores incremental evidence about edits, keeps a rolling attribution model per file, and only computes the final percentage when it compares that model against the current Git diff.

That distinction matters. The project is trying to answer:

> “How much of the change in this commit looks AI-assisted?”

not:

> “Did AI ever touch this file?”

## Runtime constants worth knowing

The current prototype uses a few hard-coded timing and buffering thresholds:

| Constant | Current value | Meaning |
| --- | --- | --- |
| chat context window | `120000 ms` | How long recent chat-editing context stays relevant. |
| recent snapshot threshold | `1500 ms` | How fresh snapshot activity must be to count as “recent AI apply evidence.” |
| recent will-save window | `5000 ms` | How long a `willSave` record can be matched to a later `didSave`. |
| small localized edit threshold | single change, `<= 8` inserted chars, `<= 8` removed chars | Used to bias tiny edits toward human when chat context exists. |
| write debounce | `350 ms` | How long rolling-state writes are coalesced per repo queue. |
| max save checkpoints | `64` | How many saved attribution checkpoints are retained per tracked file. |

These numbers are implementation details, not a promise that the final product will use the same values forever.

## From editor event to stored metric

### Step 1: snapshot before and after the change

Each tracked document can have an in-memory snapshot containing:

- text
- short SHA-256 hash
- character length
- line count
- document version
- capture time

This gives the extension enough context to derive change sizes and line-diff segments without re-reading old file contents from disk.

### Step 2: remember recent chat-editing context

When VS Code surfaces `chat-editing-text-model` or `chat-editing-snapshot-text-model` documents, the extension stores lightweight correlation context keyed by the document’s normalized logical path.

The remembered context includes things like:

- last seen scheme
- seen kinds
- request IDs
- snapshot request IDs
- document IDs
- last virtual document URI
- last event name
- last snapshot timestamp
- chat-session resource details when available

This context is not persisted directly as a repo artifact. It exists to help classify later changes on the real workspace file.

### Step 3: compute normalized change stats

`computeChangeStats()` in `src/extension.ts` derives the fields that feed both classification and persistence.

| Field | Meaning |
| --- | --- |
| `totalInsertedTextLength` | Sum of inserted text lengths across content changes. |
| `totalRemovedTextLength` | Sum of removed lengths across content changes. |
| `isNoOp` | `true` when the event has zero content changes. |
| `isWholeDocumentReplace` | `true` when one change replaces the entire previous document text. |
| `isSmallLocalizedEdit` | `true` for a single tiny change that looks more like manual editing than an AI apply. |
| `replacementRatio` | Ratio of the larger insert/remove size to the event baseline size. |

These stats are compact enough to persist later but informative enough to drive heuristics now.

### Step 4: classify the change

The classification rules are intentionally simple and ordered.

1. if the changed document is itself a chat-editing document, classify it as `ChatEditingVirtualDocument`
2. else if the event has zero content changes, classify it as `LifecycleNoiseOrDirtyStateFlip`
3. else if the document is a real workspace file, there is very recent snapshot activity, and the file was replaced wholesale, classify it as `ProbableAIApplyToWorkspaceFile`
4. else if the document is a real workspace file, there is recent chat context, and the edit is tiny and localized, classify it as `LikelyHumanEditWhileChatSessionOpen`
5. else if the document is a real workspace file and there is recent snapshot activity, classify it as `PossibleAIApplyToWorkspaceFile`
6. else if the document is a real workspace file, classify it as `LikelyHumanOrRegularEditorEdit`
7. otherwise classify it as `OtherVirtualOrNonWorkspaceDocument`

The main idea is to keep the strongest AI bucket reserved for a specific sequence: snapshot evidence followed quickly by a workspace-file change, especially a whole-document replacement.

### Step 5: decide whether persistence is allowed

Not every classified event becomes durable repo state.

An event is filtered out if any of the following is true:

- the path matches a tracking exclusion such as `.ailoc2-metrics`
- the document is not a real `file:` document
- the document is untitled
- the event was classified as lifecycle noise
- no repo root can be resolved for the document

Only eligible workspace-file events become `workspace-file-metric` records.

## Rolling state model

The durable state for one tracked file is stored as a `file-rolling-state` record under:

`.ailoc2-metrics/state/files/<repoRelativePath>.metrics.json`

The record stores:

- latest signal
- counters per signal
- cumulative AI change magnitude
- cumulative human change magnitude
- save attribution checkpoints
- current line-attribution spans
- deleted marker timestamp

### Example rolling state

```json
{
  "schemaVersion": "1",
  "recordType": "file-rolling-state",
  "repoRoot": "C:\\repo",
  "repoRelativePath": "src\\example.ts",
  "lastRecordedAt": "2026-05-02T10:15:30.000Z",
  "latestSignal": "LikelyHumanOrRegularEditorEdit",
  "signalCounters": {
    "ProbableAIApplyToWorkspaceFile": 1,
    "PossibleAIApplyToWorkspaceFile": 0,
    "LikelyHumanEditWhileChatSessionOpen": 2,
    "LikelyHumanOrRegularEditorEdit": 5
  },
  "cumulativeAiChangeMagnitude": 184,
  "cumulativeHumanChangeMagnitude": 421,
  "saveAttributionCheckpoints": [],
  "lineAttributionSpans": [
    { "attribution": "Human", "lineCount": 24 },
    { "attribution": "AI", "lineCount": 6 },
    { "attribution": "Unknown", "lineCount": 1 }
  ],
  "deletedAt": null
}
```

### What “change magnitude” means here

For AI and human buckets, the cumulative magnitude is currently:

`totalInsertedTextLength + totalRemovedTextLength`

for any persisted event whose signal maps to that attribution bucket.

This is a pragmatic scoring magnitude, not a statement that every inserted and removed character maps neatly to final authored ownership.

## Line attribution spans

AILoc2 also maintains a run-length encoded attribution model over logical file lines:

```json
[
  { "attribution": "Human", "lineCount": 10 },
  { "attribution": "AI", "lineCount": 3 },
  { "attribution": "Unknown", "lineCount": 1 }
]
```

This model is updated from `lineDiffSegments`, which are generated by diffing the previous and next logical lines for a change event.

The update rules are straightforward:

- `equal` segments keep the previous attribution
- `added` segments receive the attribution bucket implied by the event signal
- `removed` segments disappear from the resulting line model

This preserves useful locality without pretending that line identity survives every structural transformation.

## Save checkpoints

On each real-file save, `RepoMetricsStore.noteDocumentSaved()` queues a save update. During flush, the store records a checkpoint containing:

- working-tree Git blob OID
- cumulative AI magnitude
- cumulative human magnitude
- a clone of current line-attribution spans

Checkpoint writes are deduplicated when the Git blob OID and attribution state are unchanged.

These checkpoints are the bridge between editor-time attribution and later Git-stage analysis.

## How staged attribution works

When the summary code wants to score staged content for a file, it first tries to find the current **index** blob OID via `git ls-files --stage`. If that blob matches a saved checkpoint, AILoc2 can reuse the exact line-attribution spans that correspond to the staged blob.

That gives the summary logic something much better than a whole-file guess: it can score the changed line ranges in the staged diff against the saved attribution model that matched the staged content.

## Summary inputs

`src/metrics/summary.ts` builds the repo summary from five main inputs:

1. staged tracked-file diff slices via `git diff --cached --unified=0 --find-renames --no-color`
2. unstaged tracked-file diff slices via `git diff --unified=0 --find-renames --no-color`
3. unstaged untracked files via `git ls-files --others --exclude-standard`
4. rolling state from `.ailoc2-metrics/state/files/**/*.metrics.json`
5. clean-baseline state from `.ailoc2-metrics/state/repo-summary.json`

## Summary algorithm

At a high level, the summary logic does this for each relevant repo-relative path:

1. read the rolling state for the file
2. derive the current aggregate attribution by subtracting the clean baseline from cumulative magnitudes
3. try to derive a staged checkpoint attribution by matching the index blob OID to a save checkpoint
4. if changed-line attribution is possible, score only the changed line ranges using line-attribution spans
5. otherwise fall back to aggregate AI vs human magnitudes for that file
6. accumulate weighted changed-line totals into staged and unstaged slice summaries
7. convert accumulated weighted totals into percentages

## Line weighting

Changed lines are weighted by current line length with a minimum weight of `1`.

That means a blank line still contributes weight `1`, while longer lines count more than extremely short lines. This is still a heuristic, but it is generally more representative than a flat “one line equals one line” policy for the current implementation.

## Clean baseline refresh

If both staged and unstaged diff sets are empty, AILoc2 treats the repo as clean and refreshes `state/repo-summary.json`.

That file stores the current cumulative AI and human magnitudes per tracked file as a baseline. Future summaries subtract that baseline so the commit-level score reflects **new uncommitted work**, not the entire historical accumulation of the file.

## Summary output

The generated summary lives at `.ailoc2-metrics/summary.json` and contains:

- staged slice summary
- unstaged slice summary
- repo name and repo root
- whether Git summary data was available
- whether the clean baseline was refreshed
- a preformatted `summaryLine`

### Example summary shape

```json
{
  "schemaVersion": "1",
  "recordType": "hook-summary",
  "repoName": "my-repo",
  "isGitSummaryAvailable": true,
  "staged": {
    "changedFileCount": 3,
    "attributedChangedFileCount": 2,
    "aiWeightedChangedLines": 73,
    "humanWeightedChangedLines": 238,
    "aiPercentage": 23.47,
    "humanPercentage": 76.53,
    "usedFallbackAttribution": false
  },
  "unstaged": {
    "changedFileCount": 1,
    "attributedChangedFileCount": 1,
    "aiWeightedChangedLines": 0,
    "humanWeightedChangedLines": 18,
    "aiPercentage": 0,
    "humanPercentage": 100,
    "usedFallbackAttribution": false
  }
}
```

## Fallback behavior

The happy path is changed-line attribution based on saved checkpoints or current line-attribution spans.

When that is unavailable, AILoc2 falls back in stages:

1. aggregate AI vs human cumulative magnitudes
2. signal counters if magnitudes are zero
3. latest signal if counters are also empty

When fallback is used, the summary marks `usedFallbackAttribution: true` for that diff slice.

## Unknown attribution

Unknown lines are tracked explicitly in the line-attribution model, but the final headline percentage is based on AI and human weighted totals only.

This is intentional. Unknown should remain unknown instead of quietly inflating one side of the result.

## Known blind spots

The current implementation has several important blind spots:

- AI tools that do not expose distinguishable chat-editing signals may look human or unknown
- edits made outside VS Code are not observed at edit time
- structural operations such as line moves and large refactors do not preserve perfect per-line identity
- rename handling preserves file continuity structurally, but not a perfect semantic ownership model
- `.gitignore` and metrics artifacts are intentionally excluded from tracking

The prototype is useful precisely because it is honest about these boundaries.
