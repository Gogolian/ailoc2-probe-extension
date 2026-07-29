# AILoc2 Probe for IntelliJ IDEA

This folder contains an IntelliJ Platform plugin that mirrors the core AILoc2 behavior from the VS Code extension:

- observes edits in IntelliJ projects without asking LLM tools to add prompts, instructions, or source tags;
- classifies edit signals locally as human-leaning or AI-leaning using editor command context, command group metadata, and bulk-apply heuristics;
- persists repo-local metrics under `.ailoc2-metrics/intellij-state`;
- honors optional gitignore-style opt-out rules from `.ailoc2-metrics/.ignore`;
- calculates staged AI attribution from whitespace-insensitive `git diff --cached` output during IntelliJ commit handling;
- adds the line-derived staged percentage to the commit subject as `(AI: 32%)` and matching counts to the body as `(AI-Lines: 8/25)`, or unavailable forms when Git summary generation fails;
- clears metrics for files that were fully committed while preserving metrics for committed paths that still have unstaged work.

The implementation is intentionally local-first. It does not call a hosted service and does not depend on LLM-generated markers in source files.

## Build and run

From this folder:

```bash
gradle buildPlugin
```

The project produces one universal plugin package:

- compiled against IntelliJ IDEA Community 2025.2.3 and JDK 21;
- compatible with Community and Ultimate builds from `252` through `262.*`;
- verified against Community 2025.2.3 and Ultimate 2026.2.

GitHub Actions builds and verifies the universal plugin ZIP. Run the `Build IntelliJ Plugin` workflow manually, then download the `ailoc2-intellij-plugin-2025.2-2026.2` artifact. The downloaded artifact ZIP is prepared with the plugin root directory at the top level and can be uploaded directly to the IntelliJ Marketplace.

For local development, run:

```bash
gradle runIde
```

Run `gradle verifyPlugin` to check the package against both supported range endpoints.
Run `gradle test` to execute the pure diff, commit-message, and generated-hook regression suites.

## Attribution approach

The plugin registers editor document and command listeners at project startup. Regular IntelliJ edits are counted as human-leaning. Changes made through known AI-assistant command contexts, command group identifiers / classes, or unusually large replacement operations that resemble generated apply flows, are counted as AI-leaning. External disk reloads are not treated as human edits: recent Claude Code state is reloaded as AI provenance, while reloads without provenance remain unknown.

Every command start / finish and every persisted document-change event is also written to the IntelliJ log (`idea.log`) with the command context, changed file, edit sizes, and final attribution bucket so you can inspect real-world event patterns.

At commit time the plugin reads the actual staged diff with whitespace-only hunks ignored and weights added staged lines by non-whitespace characters against the recorded per-line attribution state. The percentage stored in the summary remains character-weighted. The separate AI/Human/Unknown counters count non-blank added lines on the new side of the diff, so a modified line counts once while pure deletions and blank additions count zero. The commit body marker uses AI lines as the numerator and the sum of AI, Human, and Unknown lines as the total; the commit subject percentage is derived from that same ratio. This formatting-neutral simplification currently applies to all tracked file types, including whitespace-significant languages; non-whitespace formatter/linter rewrites such as import sorting or quote changes still count as normal changes.

## Git hooks

The plugin adds two explicit Tools menu actions:

- **AILoc2 Probe: Recompute Repo Summary**
- **AILoc2 Probe: Install Repo Hooks**
- **AILoc2 Probe: Uninstall Repo Hooks**
- **AILoc2 Probe: Install Workspace Claude Hooks**
- **AILoc2 Probe: Uninstall Workspace Claude Hooks**

The recompute action resolves the current project's Git root, refreshes `.ailoc2-metrics/summary.json`, and displays staged and unstaged percentages plus AI/Human/Unknown added-line counts on demand.

If you want to exclude files or directories from IntelliJ metrics entirely, add gitignore-style rules to `.ailoc2-metrics/.ignore`. Ignored paths will not get IntelliJ rolling-state files and are skipped from the summary counts as well.

Hook installation is opt-in because it writes repo-local Git configuration. The install action resolves the current project's Git root, updates `.gitignore` for AILoc2 artifacts, writes managed hook files under `.githooks`, installs Claude Code hooks under `.claude` when the Claude runtime is bundled, and sets local `core.hooksPath` to `.githooks`. If the repo already uses another local hooks path, the action prompts to either chain to that existing path after AILoc2 runs or replace it while saving the previous value for uninstall. If `.githooks/pre-commit`, `.githooks/commit-msg`, or `.githooks/post-commit` already exists and is not AILoc2-managed, the action asks before wrapping it. Approved wrapping preserves the original file as `.githooks/<hook>.ailoc2-delegate`, runs it after AILoc2, and restores it on uninstall. When automatic wrapping is unsafe, AILoc2 writes inactive `.githooks/<hook>.ailoc2-proposed` files for manual or Copilot-assisted merge.

For a Claude Code session started from a directory that contains multiple repositories, open that directory as the IntelliJ project and run **Install Workspace Claude Hooks**. This writes only `<workspace>/.claude/settings.json` and `<workspace>/.claude/ailoc2-claude-code.cjs`; it does not scan or modify nested repositories. The shared runtime routes every edited file to its own Git root. Install **Repo Hooks** separately inside each nested repository so commits generate summaries and audit files.

Both workspace hook actions are available from the **Tools** menu and from **Find Action** (`Ctrl+Shift+A`) by searching for `Install Workspace Claude Hooks` or `Uninstall Workspace Claude Hooks`.

The managed IntelliJ hook runtime is written as `.githooks/ailoc2-intellij-hook-runtime.sh`. Claude Code synchronizes its canonical rolling state into `.ailoc2-metrics/intellij-state`, allowing the runtime to refresh `.ailoc2-metrics/summary.json` from the final staged diff and annotate terminal or external Git commit subjects with `(AI: percentage)` plus bodies with `(AI-Lines: AI/total)`. Each summary includes aggregate AI/Human/Unknown line counts and exact per-file AI/Human weights. Before committed state is cleared, the summary used for the commit is archived as `.ailoc2-metrics/commit-audits/<commit-hash>.json`.
