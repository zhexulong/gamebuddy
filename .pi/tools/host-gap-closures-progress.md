# Host gap closures — progress log

Owner brief: three Host-side gaps reported by a previous lane; close each only if a real producer exists.
Decision from the matrix owner: take option (B) for item 1 (the opening variant is chosen on the mounted,
not-yet-locked chat — `commitOpening` is legal exactly while `opening_locked_at_event_id === null`, which is
the new-chat window, so this does not contradict design/28's "no workflow for replacing an opening in an
existing chat"). Reuse `commitOpening` + the existing `greeting_variant_id`; do not change the store schema.
No browser-reachable *create* operation. Items 2 and 3 are honest gaps: report the producer each would need,
change nothing.

Shell note: this machine's `bash` tool is PowerShell (no heredocs); files are written with the file tools.

## Item 1 — alternate-greeting variant closure
- [ ] Route to commit a greeting-variant opening on the mounted, not-yet-locked chat (reuses `commitOpening`)
- [ ] Additive `openingVariant` downlink on the opening `BrowserMessageV1` (+ validator)
- [ ] Bounded refusals: locked opening / no greeting opening / unknown variant
- [ ] Host test: variant choice is durable and read back on the opening message
- [ ] Host test: committing on a locked chat is refused with its bounded code
- [ ] Client `< 1/N >` control (absent when locked) + typecheck + playwright
- [ ] Report: `requestChatSelection` having no caller is a separate gap (no browser-reachable create op)

## Item 2 — voice recording state: REPORTED AS GAP, no code
- `TavernVoiceSurfaceStateV1Schema` is closed to `unavailable | ready | speaking`
  (`host/src/tavern/browser-contract/index.ts:772-774`).
- The sole producer `LocalVoiceGatewayClient.createVoiceSurfaceReader` derives the state from
  `#surfaceActiveJobs` (playback jobs) and returns only `ready`/`speaking`
  (`host/src/voice-gateway-client.ts:143-150`); `#trackVoiceSurface` observes only
  `playback_observation` events (`:153-159`).
- No capture/recording signal exists on the wire or in the Host: searches for
  `recording|pushToTalk|ptt|capturing|getUserMedia` find no producer (only unrelated test names). The
  front end has no push-to-talk/getUserMedia; `dialogue-web/src/components/Composer.tsx` maps `ready` to a
  static mic and `speaking` to the pulse.
- Producer a `listening` state would need: the Voice Gateway v2 wire to emit an utterance-in-progress /
  capture observation (today it pushes only `playback_observation`), or a Host-owned capture-session object
  whose lifetime the reader observes. Neither exists. Adding the enum member would be a state nobody can
  produce — exactly the lookalike the brief forbids.
- Change made: none.

## Item 3 — game diagnostics/instances result protocol
- [ ] adjudicate + report

## Command log
| command | result |
| --- | --- |
| `git status --short` | many unrelated M files (other lanes) + untracked junk; no `host/src` M files |
| `git check-ignore -v .pi/...` | `/.pi/` is gitignored → progress files must be `git add -f` |
