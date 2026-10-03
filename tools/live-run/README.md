# Live-run evidence & the live-run tool family

This directory is the home of the **live-run loop** harnesses: the external
tools that drive the whole product and observe every accessible part of it.
They are tools, not Host code — the Host's storage-ownership boundary
(architecture 1.1: Host must not write `m[1]`, must not assemble prompts,
must not become a second authority) constrains the *product runtime*, not the
observation harness.

## Why a dedicated evidence directory

2026-10 audit lesson: the runners previously recorded only *structural* facts
(hashes, ids, counts, receipts). A defect in the **content** of what the model
received — an empty default persona, an unrendered `{{char}}` macro — was
invisible to every gate and every reviewer, because the artifacts never
contained content. The evidence was already on disk in the run's runtime root;
the harness simply never collected it.

Since then every run writes **one local run directory** (default `.live-runs/`
at the repo root, override with `GAMEBUDDY_LIVE_RUN_ROOT`) containing:

- the runtime root's own evidence (`identity-profile.json`, `worldbook.json`,
  the Magic Context database + log, run manifests, session logs) via
  `captureRuntimeRoot`
- the child processes' full stderr (markers and all narration)
- the run's result/report JSON, so evidence and verdict travel together
- a `capture-summary.json` describing what was captured, skipped, or failed

**Disciplines** (enforced structurally by `core/capture.mjs`):

1. Never throws. A capture failure must not fail a real run — it is recorded in
   the run's `capture.failures` field instead, so a broken capture is visible,
   never silent.
2. Bounded. Every copy is charged against a byte/file budget; truncation is
   recorded (`capture.skipped`), never silent.
3. Git-ignored, never committed, never shared. What we *choose* to commit
   under `tools/fixtures/` for cross-run comparison is a separate, deliberate,
   bounded act (content-free digests where possible).

## Layout

```
tools/live-run/
  README.md            <- this file
  core/
    capture.mjs        <- run-directory capture (record / append / copyTree / captureRuntimeRoot)
    capture.test.mjs
```

The runners currently live at `tools/run-*.mjs` (game ladder,
`run-memory-live-loop.mjs`, `run-chat-live-audit.mjs`) and are wired to
`core/capture.mjs`. Splitting them *into* this tree is a mechanical later step;
the capture wiring is the behavior that matters.

## Consumers

- Game ladder: `tools/run-stardew-native-local-agent-ab-live.mjs` opens a
  `game-ladder` capture; the result JSON's `capture` field points at it.
- Memory loop: `tools/run-memory-live-loop.mjs` opens a `memory-loop` capture;
  its report carries the same `capture` field.
- Chat audit: same pattern to be applied when the chat runner next touches the
  harness core.

Reviewers (auditing-runs) should read `capture.dir` from the run artifact to
see *what actually reached the model* before judging claims about content.