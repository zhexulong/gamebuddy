# Chat frontend naturalness audit — the browser half is UNPROVEN

Auditor: independent read-only subagent (dispatched per the live-run contract: "after each real run, audit
the trace with `auditing-runs` and attribute findings to a system component"). The auditor had no
write/browser tools, so this file was persisted by the supervisor from its returned content; every command
it lists as `not-run` is the exact recipe a reader with a shell must execute.

## Execution Audit Summary

- **Artifact**: `%TEMP%\chat-naturalness-run2.json` (run `09aa9bc5d5f32437c1414884`,
  2026-10-06T06:20:01Z→06:21:03Z, generation `g-muvgz0nr-35432-c741fec5c42e4b178314d13928e67700`) plus its
  side file `%TEMP%\chat-naturalness-run2-transcript.json`; cross-checked against
  `%TEMP%\gamebuddy-chat-live-audit-real.json` (run `90bdff5d5574a6d61d71cea5`).
- **Command**: `node tools/live-run/chat/run-chat-live-audit.mjs --report <tmp>\chat-frontend-run1.json`
  (`GAMEBUDDY_CHAT_AUDIT_OUTPUT_ROOT` selects a disposable generation). Requires the live provider
  credential in the environment (value never printed: `<REDACTED>`).
- **Topology**: single run, composed `chat-only` surface over its authenticated HTTP/SSE API.
  **No browser, no DOM** — the runner imports no browser automation.
- **Primary metrics (run2)**: 25 events, 9 SSE frames, 6 `/state` reads; turn 1 `turn.submitted` 55,612 ms →
  `provider.request.sent` 56,457 ms → 7 frames all at 61,427 ms → `turn.terminal(completed)` +
  `presentation.committed count=1` at 61,437 ms. Launch cost 55.6 s before `run.started`.
- **Primary metrics (the earlier real run)**: `request.sent` 468,269 ms → 25 frames inside
  472,837–473,447 ms (**24 of them within 2 ms**) → the same single-burst shape, with a 467.9 s launch cost.
- **Observed anomaly**: the committed reply is known — `嘿，我在呢。今天想玩点什么，还是先随便看看？`
  (`chat-naturalness-run2-transcript.json`) — but nothing on disk records what the **player** saw.

## Resource & Waste Profile

Zero SSE frames in the ~4.6–5.0 s between `provider.request.sent` and the frame burst: the surface receives
its entire update set inside a **1–5 ms window**, in both runs. No incremental typing/streaming is
evidenceable. The burst also cannot be decomposed: `sse.frame.received` carries no `meta`
(`tools/live-run/chat/run-chat-live-audit.mjs:1010`) and the frozen meta allow-list (`:148-162`) has no
event-type key, so `companion.delta` frames are indistinguishable from `turn.state_changed` /
`message.committed`.

## Integrity & Boundary Assessment

Ordering and text identity are single-sourced and cannot diverge structurally: `/state.chat.transcript[]` is
projected from the durable store in append order (`host/src/tavern/reference-pipeline-state.ts:189,252-263`),
atomically replaces the client snapshot with no reorder/filter
(`dialogue-web/src/reference-pipeline-session.ts:276-289`), and maps 1:1 to `<li data-handle>` /
`.message-bubble` (`Timeline.tsx:59-68`, `MessageBubble.tsx:22,57`). Only a stale snapshot could diverge, and
no such path exists here.

One boundary can expose raw markers: the streaming bubble renders the **raw** provider fragment
(`host/src/tavern/p4-provider-start-execution.ts:300-328` publishes `delta` with only NFC applied - this is
the same publish the audit originally read, in the duplicate runner the pre-live-switch Chat path used;
`dialogue-web/.../ReferenceApp.tsx:213-224` concatenates it verbatim), while the committed durable text is
dehydrated (`host/src/native-companion-content.ts:318-336`; `<thinking>…</thinking>` and `*beat*` removed —
see `companion-speech-dehydration.test.ts:11,22`). A player would see `*转过身微笑* 早安!` and watch it
become `早安!`. Latent only because no delta frame was observed in either run.

**Dead test gate**: the Chat surface declares `frontend-accessibility-baseline`
(`tools/fixtures/tavern-frontend-conformance/required-suites.json:25-30`) but its conformance test never
calls `assertAccessibilityBaseline`, and coverage uses a process-global ledger. It is failing on disk:
`dialogue-web/test-results/companion-turn-browser-con-85385-meets-the-frontend-criteria-chromium/error-context.md:15-23`
→ `+ ['frontend-accessibility-baseline']`.

## Frontend & DOM evidence — UNPROVEN

The surface *is* browser-servable: the ready IPC frame carries
`http://127.0.0.1:<port>/#profile=reference&boot=<token>` (`tavern/reference-pipeline-static-shell-composition.ts:85`);
one listener serves the verified artifact `<generation>/browser/tavern/v1` (index.html + 6 assets, manifest
`gamebuddy.tavern.browser.v1`) and `/api/tavern/v1/*` (`desktop-presentation-admission-owner.ts:155`).

Two hard blockers:

1. **No runner opens a browser** — the Chat loop is fetch/SSE only.
2. **The bootstrap is one-time** (`reference-pipeline-dialogue-web.ts:122-124`) and the runner redeems it at
   `run-chat-live-audit.mjs:860-871`; a browser opened afterwards gets 401. A browser-observed run must let
   the **browser** redeem `boot=<token>` first.

The only on-disk browser artifacts for this surface are a failure screenshot and Playwright snapshot from a
failed conformance capture — not the committed-reply journey.

## Runtime Smells & Mechanism Analysis

- **Visibility Lag (harness)**: terminal + commit are Class A facts at 61,437 ms; the DOM they feed is never
  observed, so "the reply the API reports is the reply the DOM shows" stays inferred.
- **Feedback starvation (harness)**: a content-free trace plus a deleted runtime root left no content capture
  for the Chat lane (`tools/live-run/README.md:92-93`) — since addressed by the side file, not by this audit.
- **Contract drift (prompt vs presentation)**: the Chat prompt invites `*gesture*`
  (`host/src/identity-profile.ts:186-194`: "TTS stripping is the audio gateway's job, not the prompt's"), yet
  the committed Chat text is stripped.

## Seam Attribution & Deterministic Gates

| Seam (file:line) | Mechanism flaw / blind spot | Prescribed fix & gate | Metric target |
| --- | --- | --- | --- |
| `tools/live-run/chat/run-chat-live-audit.mjs:1010` | SSE frames recorded without event type; streaming unjudgeable | Add a bounded `eventType` scalar to the frozen meta allow-list **and** the kernel table (`tools/lib/chat-run-audit.mjs`); gate on a parity test | classify 0/9 frames → 9/9 |
| `host/src/tavern/p4-provider-start-execution.ts:300-328` vs `host/src/native-companion-content.ts:318-336` | Preview renders raw provider text; commit renders dehydrated text | Publish dehydrated fragments (or dehydrate at the render layer); test: concatenated deltas equal committed text | preview ≠ commit → preview == commit |
| `dialogue-web/tests/companion-turn-browser.spec.ts:266-307` | Declares accessibility, never asserts it; ledger order-dependent | Call `assertAccessibilityBaseline(page,"chat")`; reset the ledger per test | chat axe gate 0 → 1 |
| Chat loop (no browser step) | DOM never observed for any run | Extend the same harness (no fork): goto launchUrl, type the fixed prompt, click Send, then assert `ol.message-list > li[data-handle]` sequence == `/state.chat.transcript[].handle`, bubble text == `transcript[].text`, no empty bubble, no `_preview` handle post-terminal, no `{{`, `[DEBUG-`, `<|`, `<thinking>`, bare JSON | DOM assertions 0 → ≥5 per run |

**Cannot prove**: reply tone, real streaming cadence, bubble non-emptiness, raw-marker absence, DOM/`/state`
equality, ordering, or recovery behaviour after reload in a browser. Decision: Chat **pipeline** integrity is
unchanged; **frontend naturalness is not evidenced**.
