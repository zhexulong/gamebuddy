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
- [x] Additive contract: `BrowserOpeningVariantV1Schema` + optional `openingVariant` on `BrowserMessageV1`,
      `chat.opening` operation/label/route (`PUT /api/tavern/v1/chat/opening`), `ChatOpeningCommandV1`
      + `ChatOpeningResultV1`, and the three bounded problem codes. (banked)
- [x] `GreetingManagementService.readExact()` — durable variant ids + revision + canonical hash (banked)
- [x] `TavernLibraryService.commitOpeningVariant()` — reuses `ChatThreadStore.commitOpening`, legal only
      while `opening_locked_at_event_id === null`; bounded errors `chat_opening_locked`,
      `chat_opening_not_greeting`, `chat_opening_variant_not_found`, `invalid_chat_opening_request`. (banked)
- [x] Route in `tavern-management-dialogue-web.ts` + composition wiring (`chat.opening` into the
      management profile and `ChatManagementService.commitOpeningVariant`)
- [x] Downlink `openingVariant` in `reference-pipeline-state.ts` (position/count from the greeting set;
      omitted unless the committed `sourceRevision` still matches the durable set)
- [x] Bounded refusals wired into `problemFor` (`chat_thread_opening_locked` → `chat_opening_locked`, etc.)
- [x] Host tests: variant choice durable + read back on the opening message; locked refusal; not-greeting
      refusal; out-of-range refusal (`library-service.test.ts`, 2 new tests)
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
| `git status --short -- <3 in-flight paths>` | 3 M files; all-additions diff (+158). Not half-built → banking
| `cd host; node node_modules/typescript/lib/tsc.js -p tsconfig.json` | 2 errors then 0 after fixing the missing request type |
| `node node_modules/typescript/lib/tsc.js -p tsconfig.focus-chat-opening.json` | 0 (outDir `dist-test` so `compiled-test-bootstrap.mjs` binds the same `path-lock.js`) |
| `node --import ./scripts/compiled-test-bootstrap.mjs --test --test-concurrency=1 dist-test/tavern/{browser-contract/index,library-service,greeting-management/greeting-management}.test.js` | **42 pass / 0 fail** (bank) then **44 pass / 0 fail** after the route/downlink tests |
| `node node_modules/typescript/lib/tsc.js -p tsconfig.json` (after route+downlink) | 0 errors |
| `node node_modules/typescript/lib/tsc.js -p tsconfig.focus-chat-opening.json` (adding chat-management-service.test.ts) | TS2532 at `chat-management-service.test.ts:212` - a PRE-EXISTING red-at-HEAD test file, unrelated to this change; dropped from the focused gate |
