# Final goal

Build a small, reusable repository that teams can copy into their own repos to install a `.githooks` folder.

## Desired end state

- Git hooks run automatically in consumer repositories.
- The hooks inspect local CodeBlend session artifacts under `~/.codeblend/vscode/sessions`.
- We estimate how many changed lines in a commit were generated with AI assistance.
- The commit message is annotated with a suffix like `(AI 23.47%)`.
- The solution is practical for real developer workflows and easy to drop into existing repos.

## Working assumptions discovered so far

- CodeBlend sessions live under `C:\Users\<user>\.codeblend\vscode\sessions`.
- Real session folders are timestamped like `yyyyMMddHHmmss-<id>`.
- Non-session folders may also exist there (for example `mycli`), so we must ignore anything that does not match the timestamped pattern.
- `document-state.json` appears to contain file paths as JSON keys, which can be used to infer the repository/workspace that a session belongs to.
- `codeblend-*.log` includes a `workspaceFolder` field near session start, which is a useful fallback when `document-state.json` is missing.
- A repository may legitimately have no matching CodeBlend session yet; for a brand-new, never-opened, or inactive repo, `No CodeBlend session matched repo root` is an expected outcome rather than a script failure.
- The `workspaceFolder` fallback has been validated on active repositories and can successfully identify the latest matching session even when `document-state.json` is sparse or secondary.

## This session's milestone

Create a PowerShell prototype that:

- lists the raw CodeBlend session inventory,
- detects the current repository root,
- finds the latest timestamped CodeBlend session that belongs to the current repository,
- and logs the relevant session file contents to the console for inspection.

## Attribution experiment conclusions

- `document-state.json` values appear to use run-length encoding in the form `state:lineCount,state:lineCount,...`.
- `2` behaves like **AI-last-touched** lines.
- `1` behaves like **human-last-touched** lines.
- `0` does **not** behave like plain manual authorship; it appears as an unattributed or neutral state for cases such as an empty file (`0:1`), a trailing blank line, and some structural operations.
- Manual typing and manual edits create localized `1` spans, and additional nearby manual edits can extend those spans.
- AI edits can flip previously human-touched lines back to `2`, and some AI operations appear to rewrite attribution for the whole file rather than only the visually changed lines.
- Deletions remove spans cleanly, but manual line moves fragment attribution and do not preserve a simple per-line identity.
- File move / rename plus staging may perturb attribution state, so path-based or structural operations need special caution in the final algorithm.
- The eventual commit metric should be based on **staged changed lines**, not whole-file percentages.
- For commit scoring, the current best interpretation is: count `2` as AI, count `1` as human, and treat `0` as unattributed / unknown that should likely be excluded from the main AI percentage and optionally reported separately.

## Strategic pivot

- The CodeBlend-based approach is not reliable enough for this project.
- A single small AI edit can cause large regions or an entire file to be attributed as AI, which makes commit-level percentages untrustworthy.
- We should replace the CodeBlend dependency with our own attribution system that records edits at the moment they happen.

## Direction under consideration

- **Best first option:** a VS Code extension plus a small local CLI / hook reader.
- **Why the extension is the leading option:** it can observe document changes and save lifecycle events directly inside the editor.
- **Why a plain script is insufficient:** a git hook or filesystem watcher can see file contents and timestamps, but not who or what produced the edit.
- **Why a standalone app is weaker as a first step:** without tight editor integration, it still cannot reliably distinguish manual edits from AI-generated edits.

## Current POC implemented in this repo

- A minimal VS Code extension scaffold now exists in this repository.
- The extension opens an output channel named `AILoc2 Probe`.
- It currently logs rich telemetry for:
	- extension activation,
	- document open / close,
	- document edit events,
	- will-save events,
	- did-save events,
	- an explicit command to log the active document snapshot.
- The logged payload includes document identity, workspace context, visible editor selection state, save reason, file stats, text change ranges, inserted text preview, removed text preview, and before/after text hashes.
- This POC is intentionally focused on observation only; it does not yet compute attribution or interact with git hooks.

## Key findings from the first VS Code probe logs

- Manual edits on the real workspace file appear as small, localized `file:` document changes such as inserting `\r\n` or a single character like `H`.
- The VS Code LLM editing flow opens virtual documents with schemes such as `chat-editing-text-model` and `chat-editing-snapshot-text-model`.
- Those virtual chat-editing documents carry useful correlation data in their URI/query payloads, including the logical target file path, request identifiers, and chat-session metadata.
- When the LLM applies a result back to the real file, the observed workspace-file change can appear as a **whole-document replacement** rather than a narrow line edit.
- `changeReason` remained `RegularEditOrUnknown` for both manual edits and LLM-driven edits, so it is not sufficient for attribution by itself.
- Some `onDidChangeTextDocument` events have `changeCount: 0` and unchanged hashes; these appear to be lifecycle / dirty-state noise and should be filtered out of attribution logic.
- Save lifecycle behavior may differ between normal edits and LLM-driven flows, so we now track whether a `didSave` had a recent matching `willSave` event.
- The most promising near-term attribution heuristic is: correlate recent `chat-editing-*` virtual-document activity with subsequent real `file:` document replacements for the same logical path.

## Key findings from the second VS Code probe logs

- Open `chat-editing-text-model` documents can **mirror manual typing** while a chat editing session is active.
- That means “recent chat-edit context exists” is **not enough** to label a real-file change as AI.
- A small localized real-file edit during an active chat session should remain human-leaning unless stronger evidence appears.
- The stronger near-term AI signal is now: **recent `chat-editing-snapshot-text-model` activity with a request ID, followed almost immediately by a real-file change, especially a whole-document replacement.**
- Save behavior remains an auxiliary signal only; some AI-applied saves still appear without a recent `willSave`, while ordinary manual saves usually have one.

## Refactor state at the end of this step

- The extension heuristics were refactored so the change-analysis path is now split into reusable helpers instead of one large inline classifier.
- The most important new helper boundaries are:
	- computing normalized change stats,
	- classifying a change event into a provenance-oriented signal,
	- producing a compact persistence-oriented metric candidate object.
- The probe now logs a `metricCandidate` object alongside the richer raw event payload.
- That `metricCandidate` is not persisted yet, but it is intentionally shaped to become the handoff point for a future repo-local store such as `.ailoc2-metrics`.
- A `replacementRatio` field is now computed for each change so future sessions can distinguish near-whole-document rewrites from smaller structured edits without re-deriving that information from logs.
- This keeps the current extension focused on observation while preparing the codebase for the next milestone: tracking AI-apply evidence and file-level change history in a repo-local metrics folder.

## What VS Code can and cannot tell us

- VS Code extensions can observe document changes via editor APIs and can observe save events.
- VS Code exposes save timing / reason information such as manual save vs auto-save behavior.
- VS Code does **not** provide a generic public signal that says “this save was performed by AI” or “this edit came from another extension's AI feature.”
- Therefore, reliable AI attribution requires that **we own the AI edit path** (for example through our own extension commands, inline completions, chat actions, or explicit apply buttons) and record attribution ourselves.
- Any edits not created through our tracked AI path should be treated as human or unknown, depending on how strict we want the model to be.

## Likely next milestones

- Decide the product shape: VS Code extension only, extension + hook CLI, or extension + background service.
- Design our own attribution data model and persistence format.
- Track editor changes and save events with precise provenance for edits created by our own AI commands.
- Compare staged git changes against our attribution store.
- Compute a commit-level AI percentage.
- Update the commit message safely in a hook.
- Add guardrails, tests, and documentation for consumers.
