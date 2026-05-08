# AILoc2 Probe for IntelliJ IDEA

This folder contains an IntelliJ Platform plugin that mirrors the core AILoc2 behavior from the VS Code extension:

- observes edits in IntelliJ projects without asking LLM tools to add prompts, instructions, or source tags;
- classifies edit signals locally as human-leaning or AI-leaning using editor command context, command group metadata, and bulk-apply heuristics;
- persists repo-local metrics under `.ailoc2-metrics/intellij-state`;
- calculates the staged AI percentage from `git diff --cached` during IntelliJ commit handling;
- appends the staged percentage to the commit subject as `(AI 12.34%)`, or `(AI unavailable)` when Git summary generation fails;
- clears metrics for files that were fully committed while preserving metrics for committed paths that still have unstaged work.

The implementation is intentionally local-first. It does not call a hosted service and does not depend on LLM-generated markers in source files.

## Build and run

From this folder:

```bash
gradle buildPlugin
```

This Gradle project supports two explicit targets with no upper `until-build` cap:

- IntelliJ IDEA Community 2025.2.3 (`sinceBuild = 252`)
- IntelliJ IDEA Ultimate 2026.1 (`sinceBuild = 261`)

Community 2025.2.3 is the default local target. To build the Ultimate 2026.1 variant, pass the target properties explicitly:

```bash
./gradlew buildPlugin -PideaEdition=ultimate -PideaVersion=2026.1 -PideaSinceBuild=261
```

GitHub Actions builds both plugin ZIP variants from this folder. Run the `Build IntelliJ Plugin` workflow manually, then download the completed `ailoc2-intellij-plugin-community-2025.2.3` and `ailoc2-intellij-plugin-ultimate-2026.1` artifacts. Each downloaded artifact ZIP is prepared with the plugin root directory at the top level and can be uploaded directly to the IntelliJ Marketplace.

For local development, run:

```bash
gradle runIde
```

To launch the Ultimate 2026.1 target locally instead, pass the same Gradle properties to `runIde`.

## Attribution approach

The plugin registers editor document and command listeners at project startup. Regular IntelliJ edits are counted as human-leaning. Changes made through known AI-assistant command contexts, command group identifiers / classes, or unusually large replacement operations that resemble generated apply flows, are counted as AI-leaning.

Every command start / finish and every persisted document-change event is also written to the IntelliJ log (`idea.log`) with the command context, changed file, edit sizes, and final attribution bucket so you can inspect real-world event patterns.

At commit time the plugin reads the actual staged diff (`git diff --cached --unified=0`) and weights added staged lines against the recorded per-line attribution state. Unknown lines are excluded from the headline percentage unless the file has enough rolling state to provide a file-level fallback.

## Git hooks

The plugin adds two explicit Tools menu actions:

- **AILoc2 Probe: Recompute Repo Summary**
- **AILoc2 Probe: Install Repo Hooks**
- **AILoc2 Probe: Uninstall Repo Hooks**

The recompute action resolves the current project's Git root, refreshes `.ailoc2-metrics/summary.json`, and displays staged and unstaged AI/Human attribution percentages on demand.

Hook installation is opt-in because it writes repo-local Git configuration. The install action resolves the current project's Git root, writes managed hook files under `.githooks`, and sets local `core.hooksPath` to `.githooks`. If the repo already uses another local hooks path, the action prompts to either chain to that existing path after AILoc2 runs or replace it while saving the previous value for uninstall.

The managed IntelliJ hook runtime is written as `.githooks/ailoc2-intellij-hook-runtime.sh`. It reads `.ailoc2-metrics/intellij-state`, refreshes `.ailoc2-metrics/summary.json` from the staged diff, annotates terminal or external Git commit messages with the same `(AI xx.xx%)` suffix used by IntelliJ commit handling, and clears fully committed file metrics from `post-commit`.
