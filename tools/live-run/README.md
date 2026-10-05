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

**Timing semantics** (audit NOTE-4): the capture happens while the game
runtime is still alive, so `context.db` and session JSONL are
as-of-capture snapshots, not transactional backups — a session line may be
truncated mid-write. Treat captured transcripts as "what the harness could
see at teardown", never as proof a message was absent.

**Self-reference** (audit NOTE-1): the `result.json` inside a run directory
is written by `closeCapture` BEFORE the `capture` field is attached to the
returned result, so the inside copy has no `capture` field. The sibling
`capture-summary.json` (written at close) is the authority for what was
captured; older captures may also lack brand-new gates (`contentGate`,
`worldBookGate`, `steerObserved`) — do not read them as evidence of those
facts, only of what was recorded at the time.

**Content gates** (audit MEDIUM-2): `worldBookGate` distinguishes "product
has no world book configured" (`expected: false`, nothing to assert) from
"a world book WAS expected but nothing mounted" (`expected: true,
assembled: false` → the run blocks). Absence-as-pass is only valid for the
former.

## Layout

```
tools/live-run/
  README.md            <- this file
  core/
    capture.mjs        <- run-directory capture (record / append / copyTree / captureRuntimeRoot)
    capture.test.mjs
    content-gate.mjs   <- persona/macro content facts (personaPresent, macroResidue)
    content-gate.test.mjs
  game/
    run-stardew-native-local-agent-ab-live.mjs  <- Stardew ladder (LADDER=0..N)
    run-stardew-native-local-agent-ab-live.test.mjs
  chat/
    run-chat-live-audit.mjs   <- Chat live audit harness
    run-chat-live-audit.test.mjs
  memory/
    run-memory-live-loop.mjs  <- Memory funnel loop (management seed -> chat recall)
```

The runners live under this tree (`game/`, `chat/`, `memory/`) and share
`core/capture.mjs` and `core/content-gate.mjs`. The chat runner is also
imported by the memory loop (event stream / probe verdict helpers), and the
memory loop by the game ladder (management-surface seeding); those imports
stay within `tools/live-run/` so the harness family is one movable unit.

## Consumers

- Game ladder: `tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs` opens a
  `game-ladder` capture; the result JSON's `capture` field points at it.
- Memory loop: `tools/live-run/memory/run-memory-live-loop.mjs` opens a `memory-loop` capture;
  its report carries the same `capture` field.
- Chat audit: `tools/live-run/chat/run-chat-live-audit.mjs` (capture wiring follows the
  same pattern when it next touches the harness core).

Reviewers (auditing-runs) should read `capture.dir` from the run artifact to
see *what actually reached the model* before judging claims about content.
## Window mode: what a human can actually watch

A live run needs a window only when a person wants to watch it. The mode is
configuration, not a constant: `GAMEBUDDY_LADDER_WINDOW_MODE` with the frozen
five-word vocabulary (`visible | foreground | minimized | hidden | background`),
default `hidden` so a run never takes the screen or the focus. Pass `foreground`
when you intend to watch, and `minimized` when you want it present but out of the
way.

Measured on real runs (2026-10-05, target build 1.6.15), so the next person does
not rediscover it:

| Step | Result |
| --- | --- |
| Mod applies the mode | works - the log prints `applying foreground window mode` (the mode-collapsing implementation could never print that) |
| `SetForegroundWindow` | **refused** - Windows reserves the foreground for the foreground process |
| `SetWindowPos(HWND_TOPMOST)` | **also refused** - z-rank stayed 12 while an independent probe kept reporting the other app as foreground |
| `FlashWindowEx` (now the fallback) | permitted to a background process; this is the only "look here" Windows allows from behind |
| Source of the window handle | was `GameRunner.instance.Window.Handle`, which a real run showed is **never a usable window** during ten seconds of retries |

The Mod now enumerates this process's visible top-level windows and picks the
SDL2-class window (`SDL_app`), falling back to the largest visible window, and
reports which window class it used plus which of the four raise outcomes happened
(`Activated` / `Raised` / `Signalled` / `NoWindow`). A reader should trust that
report instead of assuming the mode was honoured.

Watching a run therefore cannot be guaranteed by asking Windows harder: the
honest outcomes are "activated", "raised", "taskbar entry flashed", or "no usable
window yet". If none of the first three happens, watch the game through the
taskbar or make that window the active one yourself.

**Open question, with the evidence that raised it.** With the enumeration in
place, a run logged

    window mode foreground: game window class=SDL_app.
    window mode foreground: SetForegroundWindow=refused; raised to the top of the z-order.

and an independent probe of that same process then found exactly ONE visible
top-level window: class `SDL_app`, size **158x26**, titled with the game version -
i.e. the SMAPI console window, not a game-sized rendering window, and
`topmost=False`. So the raise reports success on a window that cannot be what a
person watches, and the topmost flag does not persist.

Answer "which window is the game actually rendering into under
`StardewModdingAPI.exe`" before any further raise work: unless the real game
window (or a child of it) can be identified, `foreground` cannot be made to mean
"a human is watching this". Until then treat `foreground` as best-effort.
