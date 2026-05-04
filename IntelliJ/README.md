# AILoc2 Probe for IntelliJ IDEA

This folder contains an IntelliJ Platform plugin that mirrors the core AILoc2 behavior from the VS Code extension:

- observes edits in IntelliJ projects without asking LLM tools to add prompts, instructions, or source tags;
- classifies edit signals locally as human-leaning or AI-leaning using editor command context and bulk-apply heuristics;
- persists repo-local metrics under `.ailoc2-metrics/intellij-state`;
- calculates the staged AI percentage from `git diff --cached` during IntelliJ commit handling;
- appends the staged percentage to the commit subject as `(AI 12.34%)`, or `(AI unavailable)` when Git summary generation fails.

The implementation is intentionally local-first. It does not call a hosted service and does not depend on LLM-generated markers in source files.

## Build and run

From this folder:

```bash
gradle buildPlugin
```

For local development, run:

```bash
gradle runIde
```

The Gradle project targets IntelliJ IDEA Community 2024.3.5 and Java 17.

## Attribution approach

The plugin registers editor document and command listeners at project startup. Regular IntelliJ edits are counted as human-leaning. Changes made through known AI-assistant command contexts, or unusually large replacement operations that resemble generated apply flows, are counted as AI-leaning.

At commit time the plugin reads the actual staged diff (`git diff --cached --unified=0`) and weights added staged lines against the recorded per-line attribution state. Unknown lines are excluded from the headline percentage unless the file has enough rolling state to provide a file-level fallback.
