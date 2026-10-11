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

## Item 3 — game diagnostics/instances result protocol: REPORTED AS GAP, no code
- `game.instances.read` / `game.diagnostics.read` are declared as operation ids
  (`host/src/game-browser-contract/index.ts:465,476`), have command bodies (`:225,:233`) exported in the
  contract schemas (`:588,:604`), but have **no result schema**, no route in
  `host/src/composed-reference-game-browser.ts` (its route table at `:858-890` mounts only discovery /
  lifecycle / cabins), no client method, and neither id is listed in the Stardew profile
  (`host/src/games/stardew/provider.ts:96-114`).
- `game.instances.read`: the only instance producer is
  `createGameBrowserStateProvider.readState` (`host/src/game-browser/game-browser-state-provider.ts:47-55`),
  which projects exactly **one** `GameInstanceV1` (`host/src/game-browser-contract/index.ts:167-172`) from the
  coordinator's lifecycle / attachment / launch-readiness readers. A list would be a list of one and would
  duplicate `game.state.read`'s `game.instance` — no new reachable data. The composed shell already publishes
  that single instance in `GET …/game` and `…/state`.
- `game.diagnostics.read`: **no producer**. The only `diagnostics` in the contract is the
  installation-discovery code list (`GameDiscoveryReadResultV1Schema.diagnostics`,
  `host/src/game-browser-contract/index.ts:246-250`), produced by
  `windows-stardew-installation-discovery/provider.ts` and served by `game.installation.discovery.read`.
  There is no operational/health/log/counter source exposed to the browser; the Host's redacted bridge
  diagnostics (`LocalStardewBridgeDiagnostic`, `boundedSidecarDiagnostic`) are internal tokens never surfaced
  to the browser and would need a new coordinator-owned projection.
- Producer `game.diagnostics.read` would need: a coordinator-owned bounded operational diagnostics
  projection (e.g. attachment/launch/bridge terminal codes with a fixed vocabulary) behind an
  `operationId` the Stardew profile declares. Producer `game.instances.read` would need a genuine
  multi-instance owner (there is only ever one owned Player Host instance today).
- Change made: none (a schema with nothing behind it is worse than a missing one).

## Command log
| command | result |
| --- | --- |
| `git status --short` | many unrelated M files (other lanes) + untracked junk; no `host/src` M files |
| `git check-ignore -v .pi/...` | `/.pi/` is gitignored → progress files must be `git add -f` |
