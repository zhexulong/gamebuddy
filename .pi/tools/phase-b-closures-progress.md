# Phase B closures progress

Owner brief: three small closures (Voice pulse, Game diagnostics/instances disclosure,
alternate-greeting variant selector) + the Memory origin chips (already committed by another
lane at `9ce3531e`, skipped). One unit at a time, commit immediately, report per unit.

Shell note: this machine's `bash` tool is PowerShell (no heredocs); files were written with the
file tools. Diagnostics that need to survive a proxy death were written to files or read from the
task's own stdout file.

## Checklist

- [x] Item 1 - Voice recording pulse -> **closed as far as the Host's wire allows**
      (`cbd960ce`). The Host reports no recording state, so the halo is keyed to the one
      active-audio state the Host does report (`speaking`), and the missing recording state is
      reported as a Host gap.
- [x] Item 2 - Game diagnostics/instances read-only disclosure -> **implemented over the data that
      is actually reachable** (`398d85af`). The dedicated `game.instances.read` /
      `game.diagnostics.read` routes are unreachable from the composed shell; reported as a Host gap,
      not faked. The disclosure dumps the reachable `game.state.read` projection and says plainly
      that no diagnostics are published.
- [x] Item 3 - Alternate-greeting variant selector -> **NOT CLOSED: reported as a Host gap, no code
      committed.** No route records "this chat's opening is variant N", and the browser cannot even
      read which variant the current opening is. A React-state-only control would be the lookalike
      the brief forbids.
- [x] Item 4 - Memory origin chips -> skipped (already committed by another lane as `9ce3531e`).

## Gap findings (Host side, reported not edited)

1. `game.instances.read` / `game.diagnostics.read`: declared in
   `host/src/game-browser-contract/index.ts` (`GAME_BROWSER_OPERATION_IDS_V1`:465,476 and the
   command bodies at :225,:233, exported at :588,:604) but there is **no result schema**, no route
   in `host/src/composed-reference-game-browser.ts`, no producer, no client method in
   `dialogue-web/src/composed-reference-game-browser-api.ts`, and neither id is mounted in the
   Stardew profile (`host/src/games/stardew/provider.ts:96-114`).
2. Voice surface: `TavernVoiceSurfaceStateV1Schema` closes the union to
   `unavailable | ready | speaking` (`host/src/tavern/browser-contract/index.ts:772-774`), the sole
   producer emits only `ready`/`speaking` (`host/src/voice-gateway-client.ts:143-150`), and the
   projection guard throws on anything else
   (`host/src/tavern/reference-pipeline-state.ts:223-229`). No recording/capturing state exists on
   the wire, so a recording pulse cannot be honest.
3. Chat opening variant: the durable fact exists server-side (`greeting_variant_id`, and
   `GreetingSource.variantId` on the opening message: `host/src/tavern/chat-thread-store.ts:27,1095,
   1511,2300-2304,2380`), and the two seams that would set it exist
   (`TavernLibraryService.createNewChat` with `opening.kind === "greeting"` at
   `host/src/tavern/library-service.ts:36,51-61,108,244-264`; `ChatThreadStore.commitOpening` at
   `host/src/tavern/chat-thread-store.ts:577,1609-1624`, guarded by `opening_locked_at_event_id`).
   Both have **no production caller and no route**; the management dispatcher mounts
   `GET /api/tavern/v1/chats` and `PUT /api/tavern/v1/chat/title` and no opening route
   (`host/src/tavern-management-dialogue-web.ts:838,857`), and no client method exists. The browser
   cannot even read the current variant: `BrowserMessageV1Schema` is strict over exactly
   handle/role/text/locale/order/revision/swipeInfo
   (`host/src/tavern/browser-contract/index.ts:125-133`) and the projector fails closed on any
   violation (`host/src/tavern/reference-pipeline-state.ts:214-219`).

## Log

- `git status --porcelain` -> clean branch `main`; `.pi/` is gitignored (progress files are tracked
  with `git add -f`, as the sibling lanes' files are).
- Item 1 edits: `Composer.tsx` (ring element keyed on `voice.state === "speaking"`),
  `style.css` (`.voice-pulse-ring` + reduced-motion override; this file is shared, and the CSS hunk
  was swept into another lane's commit `c0a5f80f` - verified present in HEAD with
  `git show HEAD:dialogue-web/src/style.css`), `tests/chat-surface-probe.tsx` (`voicePulse()`),
  `tests/chat-surface-voice.spec.ts` (new assertion).
- `pnpm --filter @gamebuddy/dialogue-web exec tsc --project tsconfig.json --noEmit` -> exit 0.
- `pnpm --filter @gamebuddy/dialogue-web exec playwright test tests/chat-surface-voice.spec.ts
  --project=chromium --workers=1` -> **2 passed**.
- Commit `cbd960ce` (3 files, +72): `feat(dialogue-web): key the mic halo to the Host's speaking reading only`.
- Item 2 edits: new `components/GameDiagnosticsDisclosure.tsx`, 2-line wiring in
  `components/ComposedReferenceGameApp.tsx` (import line 38; element after the Game surface's
  `SurfaceModelSettings` block at line 1766), `style.css` (one hunk at +2007), `i18n.ts` (5 en +
  5 zh-CN keys), `tests/composed-reference-game-browser.spec.ts` (new assertion + the null-game
  honest-sentence assertion).
- `pnpm --filter @gamebuddy/dialogue-web exec tsc ... --noEmit` -> exit 0.
- `pnpm --filter @gamebuddy/dialogue-web exec playwright test tests/composed-reference-game-browser.spec.ts
  --project=chromium --workers=1` -> **43 passed**.
- `pnpm --filter @gamebuddy/dialogue-web exec playwright test tests/composed-reference-game-browser.spec.ts
  tests/stardew-installation-discovery.spec.ts --project=chromium --workers=1` -> **46 passed,
  1 skipped, 0 failed** (the previously red discovery-fixture case is green again).
- `node node_modules/.pnpm/dependency-cruiser@17.3.2/node_modules/dependency-cruiser/bin/dependency-cruise.mjs
  --config .dependency-cruiser.dialogue-web.cjs dialogue-web/src/main.tsx` ->
  `no dependency violations found (32 modules, 39 dependencies cruised)`.
- `node tools/check-head-typecheck.mjs` -> `head_typecheck_ok rev=398d85afa281 projects=tsconfig.json`.
- Commit `398d85af` (5 files, +223): `feat(dialogue-web): read-only Game data disclosure at the
  bottom of the Game surface`.
- Item 3: verified the gap with the greps above; deliberately committed no code.
