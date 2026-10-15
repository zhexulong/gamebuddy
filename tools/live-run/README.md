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
    capture-text.mjs   <- the one place a live run keeps WORDS (bounded + redacted)
    capture-text.test.mjs
    content-gate.mjs   <- persona/macro content facts (personaPresent, macroResidue)
    content-gate.test.mjs
    companion-experience.mjs <- the CONTENT half: redacted exchange + three gates
    companion-experience.test.mjs
    browser-evidence.mjs     <- the RENDERING half: CDP session, screenshots, DOM assertions
    browser-evidence.test.mjs
    persona.mjs        <- the one reviewed card, compiled for every loop
    persona.test.mjs
    evidence-verdict.mjs, authority-identity.mjs, fixture-seeding-gate.mjs,
    player-input-admission.mjs (+ their .test.mjs)
  game/
    run-stardew-native-local-agent-ab-live.mjs  <- Stardew ladder (LADDER=0..N)
    run-stardew-native-local-agent-ab-live.test.mjs
  chat/
    run-chat-live-audit.mjs    <- Chat live audit harness
    run-chat-live-audit.test.mjs
    run-chat-live-content.mjs  <- the content-judging defaults over the SAME harness
  memory/
    run-memory-live-loop.mjs   <- Memory funnel loop (management seed -> chat recall)
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

## The content half: what a reviewer can now judge

The trace answers "which system layer misbehaved". It deliberately cannot answer
"was that pleasant to talk to", because it carries no words. The 2026-10 audit of
the Chat lane recorded the consequence: `passed` for pipeline integrity, with
`naturalness: inconclusive` and nothing to quote.

So the Chat loop now produces a SECOND artifact per run, and every run gets ONE
directory addressed by its own opaque run id:

```
.live-runs/<run-id>/
  chat-run-audit.json          <- the frozen content-free trace (a copy of the report)
  companion-experience.json    <- the redacted exchange + the three content verdicts
  capture-inputs.json          <- what this run was asked to do, and what it skipped
  capture-summary.json         <- what was captured, truncated or failed
  harness-outcome.json         <- only when the run never started (blocked, by name)
  shots/chat-transcript*.png   <- what the player's browser actually rendered
  runtime-root/...             <- identity profile, world book, Magic Context db+log, session logs
```

The directory stays git-ignored (`.live-runs/`), byte-budgeted and
failure-tolerant through `core/capture.mjs`; a capture failure is recorded in
`capture-summary.json` and never fails the run.

### `companion-experience.json`

For every committed companion reply, in the turn that produced it:

- the redacted **player line** and **companion line**, with byte and code-point
  counts, sentence count and the extracted narration beats (`*…*` and `（…）`);
- three gate verdicts, each `pass` | `fail` | `skipped`, each with the rule that
  matched and the matched text, so a reviewer jumps straight to the defect.

Redaction: credentials become `<REDACTED>`; length is bounded by the shared
capture policy (`core/capture-text.mjs`). No prompt internals, no system prompt, no
M0/M1 text. Macros are deliberately NOT redacted here — `{{user}}` residue IS the
finding the hygiene gate reports.

### The gates, and where their thresholds come from

| gate | fires on | bound / vocabulary |
| --- | --- | --- |
| `first_person_anchoring` | a narration beat that names the companion without a first-person marker; a third-person pronoun beat coreferent with a preceding companion-naming beat in the same unbroken beat run | companion display name from the mounted identity; quoted speech is removed first, so her name inside her own dialogue never fires, and a beat about another character carries neither her name nor a bound pronoun |
| `pacing` | a **reply** past its rung | greeting **100 chars / 4 sentences**; task **600 chars / 20 sentences** — see below |
| `hygiene` | template or transport residue, wall-breaking register | `{{…}}`, `<thinking>`, `<|…|>`, `[DEBUG-…]`, `<gamebuddy-…>`, code fences; plus the reviewed card's own forbidden forms (`搭档`, `您`, `主人`) and the audit's observed wall-break (`玩家`) |

`pacing` is a ruler for REPLIES. An authored **opening** — the card's `first_mes` and
its `alternate_greetings` — is not a reply (it is shown verbatim once, before the
player has spoken), so it is judged by `opening_legibility` instead: whether the
player can read it on the first screen. The live-run sidecar never runs
`opening_legibility` (it judges landed replies); `chat/check-card-voice.mjs` is its
caller, and it spends no provider turn.

**Measured, not invented.** `PACING_MEASUREMENTS` in
`core/companion-experience.mjs` carries the numbers and a test asserts the ladder
still follows from them:

- the four real committed companion replies that exist on disk are 19 / 20 / 20 /
  33 chars and 1-3 sentences. The greeting rung is 3x the longest of them (33 ->
  100, with 4 sentences), which is still under half the shortest authored scene
  turn, so no scene-length reply can pass as a greeting;
- the reviewed card's own `mes_example` companion turns are 238 / 280 / 304 chars
  and 8 / 11 / 14 sentences. The task rung is the capture policy's own per-entry
  bound (600 chars, 1.97x the longest authored turn) and 14+6 sentences. The named
  failure — a 500-word screenplay dump — is an order of magnitude past it.

The opening ruler is measured the same way. `OPENING_LEGIBILITY_MEASUREMENTS`
records the real 400x800 surface (`D:\gb-modcheck\shots-final10`: the message list
starts at y=138 and the composer at y=714, so the first screen is 576px; the shipped
opening's bubble is 246px at y=188..433 and the list is NOT scrollable there, so the
bubble may grow to 714-188 = 526px), and `openingTypesetHeightPx` typesets an opening
against the bubble's own metrics (padding 10/14, 14px type at line-height 1.72, an
8px gap between blocks, 19 characters to a rendered line). The model reproduces its
own measurement: the shipped 155-char, 2-block opening typesets to 245px against the
measured 246px.

A gate that cannot be evaluated reports `skipped` with a named reason (for
example `companion_identity_name_unavailable`). Absence is never a pass.

### The rendering half, and the one-time `boot=` token

`shots/` and the DOM assertions come from the product's own browser surface driven
over CDP — the same stack the earlier screenshot lanes used (Edge/Chrome with
`--remote-debugging-port`, raw CDP over Node's built-in `WebSocket`), no new
browser dependency.

The one-time `boot=<token>` handoff used to be spent by the loop's own `fetch`,
which is why a browser arriving afterwards got 401. Now **the browser redeems the
token first** and the loop attaches to the session it created: the session cookie
is read over CDP and the CSRF token comes from the authenticated `/state` body (a
read never needs a CSRF header). The launch URL is delivered by `Page.navigate`,
so it never reaches the browser's command line either. A run on a machine with no
browser falls back to exchanging the token itself and records
`browser: {state: "skipped", reason: "no_browser_executable_found"}`.

DOM assertions compare the rendered `ol.message-list > li[data-handle]` sequence
and bubble text against the SAME authenticated `/state` transcript the trace's
durable facts come from, and fail on an empty bubble, a `_preview` handle after
terminalisation, macro/transport/debug residue, or a player line that never
rendered.

### Running it, and what CI would need

```
pnpm run:chat-live-audit            # the audit's fixed two-turn sweep
pnpm run:chat-live-content          # the content-judging defaults (real intents, browser on)
pnpm test:chat-live-audit           # harness + content-half unit tests
```

Both run scripts need a live provider credential in the environment
(`CPA_OAI_API_KEY`, present|absent only — no harness ever prints it) and a built
generation at `host/dist` or `GAMEBUDDY_CHAT_AUDIT_OUTPUT_ROOT`. The content half
additionally needs a Chromium-family browser; without one it skips by name.
**CI cannot run the live loop today**: it needs a provider credential and a
browser, neither of which CI has. CI CAN and does run the deterministic half —
`test:chat-live-audit` now includes the gate tests, which prove the rules against
real recorded replies and the archived breach without touching the network.
