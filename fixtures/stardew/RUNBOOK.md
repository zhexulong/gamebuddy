# Stardew native Game Action runbook

This runbook is the required procedure for promoting a Stardew Game Action that
changes the world, inventory, relationships, or player state. It separates
**fixture preconditions** from the **production action proof**: a fixture can
make a target available, but it is never evidence that an action succeeded.

It defines two **non-interchangeable** target-version native lanes:

- **Farmhand promotion lane** — formal Host-first attachment to the independent
  native AI Farmhand. This is the only lane that can establish or retain a
  Farmhand topology publication claim.
- **Native-local action lane** — one isolated target-version SMAPI process and
  its current native local Player, using the same shared typed bridge and
  `ExecutionManager`. It validates reusable action mechanics without LAN,
  Farmhand, Portfolio runtime, a second process, or UI/input automation.

Evidence never crosses lanes: native-local evidence cannot be relabelled as a
Farmhand receipt or Portfolio `pass`, and Farmhand evidence does not make a
single-player fixture safe. Neither lane permits save-XML editing, a
hand-written receipt, an in-memory `Farmer`, UI automation, or raw native-call
fallback.

## Fixture roots and multi-lane isolation

One lane owns two local fixture roots, and both are resolved in exactly one
shared place, `tools/lib/stardew-fixture-roots.mjs`:

| Root | Default | Owns |
| --- | --- | --- |
| profile root | `%LOCALAPPDATA%\GameBuddy` | `stardew-profiles` profiles `A-host` / `A-ai-client` / `A-ai-probe`, the `.stardew-fixture-profile.lock` transaction and its backups, and the launcher's `farmhand-companion-preview-*` run roots |
| fixtures root | `%LOCALAPPDATA%\GameBuddy\stardew-fixtures` | the native save templates, the bootstrap binding artifacts, and the `.stardew-native-local-player-fixture.lock` transaction |

The two locks are different files in different roots; do not confuse them. An
unset environment keeps these exact paths. Two environment variables move a lane
onto private roots so two lanes stop sharing one transaction:

- `GAMEBUDDY_STARDEW_PROFILE_ROOT` — the profile root. The fixtures root then
defaults to `<that root>\stardew-fixtures`, so setting only this variable
isolates a lane completely.
- `GAMEBUDDY_STARDEW_FIXTURE_ROOT` — the fixtures root alone.

A configured root must be absolute; a relative one fails closed with
`stardew_fixture_profile_root_unresolved` / `stardew_fixture_root_unresolved`.
The launcher and the ladder launcher print the resolved roots once per run
(`[stardew-fixture-roots] profileRoot=… fixturesRoot=…`), and every helper
process that resolves them prints the same line once. A lane root must already
exist before the launcher starts, with its own `stardew-profiles\A-host` and
`A-ai-client` profiles seeded from the default root. Native-local drivers that
take an explicit `-FixtureRoot` keep taking the root you pass them; the
environment variables drive the default-computing entries
(`tools/launch-stardew-navigation-fixture.ps1`,
`tools/live-run/game/launch-ladder-live.mjs`) and the launcher.

**What this does not do.** The process guard stays global: a run still refuses
to start while any `StardewModdingAPI` / `Stardew Valley` process is running,
whichever root it holds. The two roots only stop two lanes from sharing
profiles, Mod bundles, backups and locks, not from contending for the game.

## Farmhand Companion Preview entry (preview-only)

The formal Preview entry is a separate, short-lived Host-first attachment surface. It is not semantic authority, a Portfolio entry, a local bootstrap, or a publication/release gate. The trusted launcher must create an absolute JSON config with exactly this shape and must never source any field from model output:

```json
{"schemaVersion":1,"runtimeRoot":"<absolute Host-owned GameBuddy root>","runtimeInstanceId":"<opaque per-launch id>","requiredPresentationLocale":"zh-CN","identity":{"playerId":"<opaque>","companionId":"<opaque>","saveId":"<opaque>","worldId":"<opaque>"},"bridge":{"pipeName":"<short-lived pipe>","bridgeToken":"<short-lived token>"},"evidence":{"path":"<new absolute JSONL path>","manifestSha256":"<64 lowercase hex>"}}
```

The only supported Preview orchestration is `tools/start-farmhand-launcher.ps1`. It is Windows-only and requires the native Stardew `startup_preferences` language setting to be `zh` before starting either title. The launcher embeds required `zh-CN` in its private Preview config, and Preview passes that bounded expectation to the authenticated bridge launch: the observed Farmhand snapshot must exactly match it or the run fails closed before Pi construction. Any missing, non-Chinese, or mismatched locale fails closed rather than rendering CJK input/output with an English font. It then starts the Host first under the reversible A-host/A-ai-client transaction using the existing `native_pickup_item_v1` fixture semantics; Preview introduces no action setup. After authenticated fixture/native readiness, it obtains a **fresh** signed attachment manifest while the expected Farmhand remains offline and validates it against the fresh Host advertisement. It writes the manifest's exact identity plus one run's short-lived pipe/token credentials into the transaction-owned AI config. The attachment manifest and launcher startup deadline bound pre-ready admission only; after receipt-backed Preview readiness, bridge authority remains bound to the authenticated token, exact scope, live generation, game-thread policy, and launcher-owned teardown rather than a fixed wall-clock lease. It launches the AI title next, then immediately starts immutable Preview. Preview's successful receipt-backed exact bridge snapshot admission is both the external AI-ready proof and Preview start; there is no separate log-derived ready state.

The required launcher input `-HostRuntimeRoot` is an existing absolute Host-owned root. Its optional `settings/model-profiles.json` is read only when present; when absent, the Host-owned `ModelProfileStore` uses its fixed game default. The launcher never creates, copies, deletes, restores, or treats a model profile as a caller-supplied bridge credential. The root is passed only as Preview's current immutable entry dependency. The separate run-owned root contains only short-lived preview config/evidence/session exchange files and is deleted at teardown. No CLI/env accepts pipe, token, manifest, policy, capability, control endpoint, or credentials. The launcher owns Host, AI, and Preview children; it tears down Preview → AI → Host, deletes known attachment exchange artifacts, and restores the transaction only after all children exit. Failed restore deliberately retains backup and lock for recovery.

For the immutable entry, the launcher uses:

```powershell
cd host
pnpm start:farmhand-preview --config '<absolute-preview-config.json>'
```

The entry validates the entire config before bridge I/O; connects through `STARDEW_INTEGRATION_LAUNCHER`; requires the adapter-observed exact initial snapshot before Pi construction; then installs the current runtime, native chat/player-control Host path, STOP/ledger/worker bindings and optional read-only hash-only evidence artifact before releasing initial facts. `Ctrl+C` first revokes bridge execution and then closes Host/runtime/bridge. It neither accepts capabilities, policies, credentials nor action authority from a model, configures a control endpoint, or performs attachment itself. Delete the short-lived config and bridge token after close.

## Native ordinary-chat and `/stop` live observation (read-only)

> **Note:** For full-featured embodied companion live verification (including micro-actions `face_direction`, `express_emote`, `equip_tool`, chat presentation, and sensory facts), follow the comprehensive [`## Native humanlike companion live observation and verification SOP`](#native-humanlike-companion-live-observation-and-verification-sop) below.

The Farmhand companion preview may observe the already-implemented native ordinary
chat and bare `/stop` ingress without adding a control port or injecting UI/input.
Start only the official production Host, AI Farmhand, Mod bridge and the existing
`native_ai_farmhand_multiplayer` runbook profile. Configure the Host process with
both `GAMEBUDDY_COMPANION_LIVE_EVIDENCE_ARTIFACT=<new absolute JSONL path>` and
`GAMEBUDDY_COMPANION_LIVE_EVIDENCE_MANIFEST_SHA256=<64 lowercase hex manifest digest>`.
The path must be a new run-owned file; the Host appends only redacted records.

After the attached Farmhand is ready, a human opens Stardew's native chat and
submits one ordinary chat line, waits for the corresponding real Pi turn, then
submits bare `/stop` during an active execution or provider/tool wait. The observer
stores hashes only: native ingress kind/source/control identity, authenticated
Farmhand bridge lineage, Pi accepted/settled disposition, and STOP epoch seal/settle.
It never stores ordinary-chat text, prompt, token, audio, receipt bodies or hidden
reasoning. After the typed STOP settles, the production observer requires a fresh
Mod/game-thread `body_settled` observation with its authoritative revision and the
same hashed stop/source/epoch lineage. It records `old_epoch_quiet` only after that
observation and the already-settled old-epoch ledger, Pi, worker, presentation, and
voice cancellation fence; this is a state proof, not a timed quiet-window inference.
If either exact proof is absent or mismatched, the runner remains `blocked`. Do not
hand-write, edit, or treat a fixture artifact as live evidence.

## Native humanlike companion live observation and verification SOP

This SOP defines the task-generic procedure for live in-game verification of embodied companion micro-actions (`face_direction`, `express_emote`, `equip_tool`), conversation presentation (`companion_presentation_request` via `Game1.chatBox`), and sensory bridge ingress (`world_fact`: `day_started`, `time_milestone`). It governs any companion action verification run while treating scenario-specific parameters as parameterized inputs.

### 1. Preflight and offline parity gate

Before launching the game or initiating a live run, operators must verify environment baselines and run offline regression gates:

- **Target version baseline:** Stardew Valley `1.6.15.24356`, SMAPI `4.5.2`.
- **Mod assembly deployment:** Mod DLLs must be compiled in Release and deployed to the active target installation:
  ```powershell
  dotnet build integrations/stardew/GameBuddy.Stardew.sln -c Release
  # Ensure GameBuddy.dll and dependencies are present in:
  # <StardewValleyPath>\Mods\GameBuddy\
  ```
- **Save fixture isolation:** Use an isolated, event-free fixture save (such as `GameBuddyFixtureArtifact_446066223`, SaveId `446066223`, PlayerId `-897170067170526186`). Never execute live action gates on a personal or production save.
- **Offline test suite execution:**
  ```bash
  # C# Core and Integration suites
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ --nologo
  dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/ --nologo

  # Action-development package tests and source projection parity
  pnpm --dir integrations/stardew/action-development test
  node integrations/stardew/action-development/src/action-source-projection-check.mjs

  # Host TypeScript typecheck
  pnpm --filter @gamebuddy/companion-host typecheck
  ```

### 2. Execution topologies and attachment modes

Live verification supports two operational modes:

- **Mode A: Automated driver (recommended for continuous regression):**
  The production Farmhand Companion Preview launcher owns the whole two-process
  multiplayer run: starts the Host first, authenticates readiness and a fresh
  attachment manifest, then starts the silent AI client and the immutable
  Preview, keeping the Host window visible for human inspection:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/start-farmhand-launcher.ps1 ``
    -GamePath "D:\Steam\steamapps\common\Stardew Valley" ``
    -HostRuntimeRoot "C:\Users\you\AppData\Local\GameBuddy" -ExpectedFarmhandId "<native-id>"
  ```
  It requires no pre-existing game process, binds to a fresh run-owned pipe and
  token, tears down Preview > AI > Host, and never accepts credentials.
- **Mode B: Attached driver (obsolete):** The former standalone attached driver
  (`tools/start-smapi-and-run-live.mjs`, `tools/run-stardew-companion-live-coop-01.mjs`)
  was retired because it hardcoded a private install path, hand-rolled its own
  bridge connection instead of the shared protocol harness, and its function is
  covered by the production launcher above for live Farmhand preview. For an
  already-running save, use the hosted companion conversation path directly.
- **Concurrency discipline:** The Mod `ExecutionManager` enforces that the embodied actor executes at most one active native mutation at any time on the game thread. Multi-action sequences must be executed serially with unique `{requestId, idempotencyKey}` pairs, waiting for terminal `succeeded` before dispatching the next.

### 3. Generic visual observability principles

To ensure human-in-the-loop and camera-based evaluation produces trustworthy evidence, all companion action verifications must follow two generic observability rules:

- **Delta Observability Principle (状态差量可辨识性原则):**
  A visual verification is valid only if the post-action physical state visibly contrasts with the actor's immediate pre-action state. If a target action's requested state is identical to the actor's current resting state (e.g. asking to face down when already facing down, or equipping slot 0 when slot 0 is already active), the test sequence must establish a contrastive delta (e.g. transitioning through an intermediate distinct state) before asserting visual completion.
- **Animation Settling Window (动画落定与稳定观察窗口):**
  Actions with native sprite animations, emote balloons, or tool-wielding effects require engine settling time. After receiving the bridge's `succeeded` receipt, drivers and human observers must pause for an observation settling window (typically 2.0–2.5 seconds) before triggering subsequent actions or exiting, ensuring the visual transition is captured and settled.
- **Observation fact verification:**
  Terminal receipts must carry an attached `BridgeLocalObservation` (capturing `location`, `tile`, `facing`, `inGameTime`, `playerNearby`, and `revision`). Operators must confirm that the receipt observation matches the live game reality.

### 4. Specific operational caveats (现场核验注意点)

These caveats address specific engine constraints and edge cases encountered during live in-game verification:

1. **Initial spawn facing in bed:**
   When a save is loaded, the player character spawns in bed facing `Down` (`facing: 2`). Direct verification of `face_direction: down` produces 0 pixel delta.
   *Guideline:* Always verify facing against a contrasting direction (e.g. turn `left` towards the open bedroom first, observe the 90° rotation, then turn `down`), or verify after stepping out of the bed.
2. **Default active tool slot:**
   The player's toolbar defaults to `Slot 0` (typically Axe). Direct dispatch of `equip_tool: slot 0` causes no sprite swap or toolbar highlight transition.
   *Guideline:* Verify tool equipping by selecting a slot different from `CurrentToolIndex` (e.g. switch to Slot 1 Pickaxe first, then switch to Slot 0 Axe) to confirm observable toolbar cursor movement.
3. **Emote animation busy mutex:**
   `Farmer.doEmote` executes a native balloon animation lasting ~2 seconds. Dispatching a new emote while `actor.isEmoting == true` is rejected by the Mod guard with `rejected/emote_busy`.
   *Guideline:* Allow ≥ 2.5 seconds between successive emote dispatches to let the previous animation conclude and the actor return to a non-emoting state.
4. **ChatBox presentation readiness:**
   Companion speech is routed to `Game1.chatBox` via `NativeChatPresentationPolicy`. In single-player host test topologies (where Host == Farmhand), ensure the game has fully completed the save load fade-in and the chatBox is active before dispatching speech bubbles, avoiding unhandled drops.

### 5. Failure taxonomy and diagnostic reason codes

- `missing_client_config`: The runner could not locate `Mods/GameBuddy/config.json` or equivalent client configuration.
- `pipe_connect_timeout`: The game did not start within the timeout budget, the Mod failed to load, or the save was not loaded to open the pipe listener.
- `scope_mismatch`: The active player's UniqueMultiplayerID does not match the configured `BridgeScope.PlayerId`.
- `rejected/emote_busy`: Emote requested while a previous emote is still animating.
- `rejected/actor_moving`: Facing direction requested while the actor is walking or under pathfinding control.
- `rejected/tool_index_out_of_range`: Requested slot is outside the valid inventory bounds (`0..11` or `0..35`).

### 6. Artifact retention and Git hygiene

Live verification generates local diagnostic logs (`tools/*.log.json` and `tools/*.report.md`) for operator inspection. **These files are ephemeral debug artifacts and must NEVER be committed to git.** Production evidence consists only of reproducible gate exit codes, redacted receipts, and stable documentation.

## Farmhand promotion standard (Farmhand lane only)

An action is eligible for `published` only when all of the following are true:

1. **Native contract reviewed.** The locked target-version (currently Stardew
   1.6.15) source/IL identifies the exact native entrypoint, its relevant
   side effects, its cancellation/animation lifecycle, and all necessary
   postconditions.
2. **Bounded adapter.** The Mod accepts only a small, action-specific request
   shape derived from a live snapshot. It revalidates scope, policy,
   capability, revision, deadline, target identity, range, ownership and
   native preconditions on the game thread.
3. **Fail-closed evidence.** The adapter never treats `accepted`, a callback,
   an animation start, or a native boolean alone as success. Its terminal
   receipt proves the action-specific native state transition. It must also
   preserve target-version bookkeeping that is part of the interaction (for
   example, crafting quest/recipe/achievement updates); direct item creation
   plus manual ingredient removal is not a substitute.
4. **Static closure.** C# Release, Host build/tests, schema parsing, runner
   parsing, protocol fixtures, registry uniqueness, and `git diff --check`
   pass in a serial order.
5. **Formal live proof.** A formal Host-first attachment reaches the exact
   native Farmhand. A fresh production snapshot finds the target, a production
   bridge request obtains the authoritative terminal receipt, and a fresh
   snapshot verifies every postcondition.
6. **Lifecycle and policy review.** The action is not published until its
   catalog, Mod default-consent policy, Host registry, documentation and BDD
   status agree. A published registry entry alone grants nothing: the live Mod
   capability remains authoritative.

If any item is missing, keep the action `experimental` (or withdraw it).
`blocked` means there was no safe live target; it is not a successful action.

## Safety invariants

- Never edit a user save, save XML, active profile configuration, receipt,
  manifest, bridge token, inventory field, animal product, or world target.
- Farmhand lane templates and working names must both match
  `GameBuddyFixture_*`; native-local names must match
  `GameBuddyFixture[A-Za-z0-9]*` and their observed physical slots must append
  `_<nativeUniqueId>`. Never translate an observed slot into a logical name by
  guessing.
- Fixture and normal Stardew save roots must be absolute and disjoint.
- Never touch fixture files while Stardew or SMAPI is running.
- A fixture initializer is allowed only when it is explicitly allowlisted,
  runs on the Host game thread **before** formal attachment, targets an
  isolated working fixture, and uses reviewed target-version native APIs.
- An initializer may create starting preconditions only. It must not call the
  production action, emit a bridge request/receipt, or manufacture the action
  postcondition.
- Do not bypass native placement or capacity safety (`skipSafetyChecks`, direct
  collection mutation, direct `Items` writes, or save patching).
- Do not infer a Farmhand ID. It must match the retained Cabin owner and the
  formal manifest binding.
- Do not leave a modified profile, working fixture, session exchange, game
  process, UDP listener, or locked DLL behind.

## `collect_crab_pot_output` fixture provenance contract (bounded, non-live)

Before any future collection implementation, the only approved Batch 4
artifact is `fixtures/stardew/crab-pot-output.fixture.example.json`. Validate
its metadata with:

```text
node tools/check-crab-pot-output-fixture-contract.mjs --contract fixtures/stardew/crab-pot-output.fixture.example.json
```

The checker is fail-closed for unknown/missing fields, placeholder or
unprovisioned template hashes, unapproved target-version assembly/content
hashes, weakened native lifecycle or forbidden behavior controls, production or
live-closure claim escalation, and accidental opaque target IDs. The checked-in
contract is explicitly `save.provisioningState=unprovisioned` with
`templatePayloadSha256=null` and `provisioningAttestation=null`; therefore a successful check reports
`fixture_needed`, `provenance_contract_only`, `liveClosure=none`, and no template
validation. It is provenance planning metadata only. A real provisioned
instance would require a canonical native template payload hash, a nonempty
attestation reference, and independent native `Saving/Saved` and reload proof.
It must still not be
called action evidence, publication, release evidence, or live closure.

Its bounded lifecycle is ordinary target-version CrabPot placement, ordinary
bait interaction, an ordinary day transition running `CrabPot.DayUpdate`, then
native save/reload before capture. Save/XML edits, direct readiness/output/bait/
owner/inventory mutation, UI/input automation, raw dispatchers, collection
ingress, bridge requests, receipts, and fixture-produced success evidence are
forbidden. The production target is not stored; it must be rediscovered as a
fresh opaque target from a future live snapshot. This section does not authorize
or execute a production action, Host/Mod protocol, registry publication, smoke
runner, game launch, or template provisioning.

## Native-local single-player SOP

Use this lane to validate an existing shared typed action when a second player
is irrelevant to its native result. It is deliberately a **thin harness**, not
an alternate action runtime.

### A. Bootstrap an event-free template

> **The fixture root is lane-private.** `%LOCALAPPDATA%\GameBuddy` used to hold the dev/QA
> `stardew-profiles` and `stardew-fixtures` directories. On 2026-10-07 that path was re-created as the
> product's partitioned layout (`data/`, `operational/`, `presentation/`) and the old contents were gone —
> the template, the binding artifact and the Mod profile had disappeared while the game saves stayed in
> `%APPDATA%\StardewValley\Saves`. Bootstrapping then failed with `no native-local binding for save …`.
> Point the lane at its own root with `GAMEBUDDY_STARDEW_PROFILE_ROOT` (the resolver supports it for exactly
> this reason — see `tools/lib/stardew-fixture-roots.mjs`) and bootstrap again. That rebuilds the environment
> in about a minute: step A.2 with `-BootstrapNativeSave`, then step A.4 to capture the template. Record
> the observed slot it prints; nothing else survives from the previous root.

1. Use a dedicated Mods profile and an empty logical name matching
   `GameBuddyFixture[A-Za-z0-9]*`; never reuse a Farmhand fixture, a personal
   save, or a save whose route triggers an unbounded event/cutscene.
2. Run `tools/run-stardew-native-local-player-move-fixture.ps1` with
   `-BootstrapNativeSave`. The Mod invokes only target-version native new-game
   creation (`skipIntro: true`), keeps the bridge closed, then waits for real
   `SaveLoaded`.
3. Accept bootstrap only when it has disarmed and emitted its observed physical
   slot plus the binding artifact (logical name, observed slot, Save/World/
   Player/Companion identity). Bootstrap itself is **not** action evidence.
4. Capture the complete native save directory as an external, read-only
   template using `tools/prepare-stardew-action-fixture.ps1`. The template and
   working names must be the exact observed physical slot from bootstrap, not
   the logical name:

   ```powershell
   $slot = 'GameBuddyFixtureStable_<nativeUniqueId>'
   powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 `
     -FixtureRoot '<absolute-fixture-root>' `
     -TemplateName $slot -SaveName $slot `
     -InitializeFromSaveName $slot
   ```

   The bootstrap-generated `<logical-name>.native-local-binding.json` remains
   in `FixtureRoot`; it is not a save template and must match `$slot`. Do not
   rename or edit save XML, inventory, world state, receipts, or postconditions.

### B. Run one action from a disposable copy

1. Restore a fresh working save from that template with
   `tools/prepare-stardew-action-fixture.ps1`; source/template and working
   roots must remain disjoint:

   ```powershell
   powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 `
     -FixtureRoot '<absolute-fixture-root>' `
     -TemplateName $slot -SaveName $slot
   ```
2. Start the same runner without `-BootstrapNativeSave`. It requires the
   bootstrap-captured binding for the exact observed slot, acquires its
   profile transaction, deploys the one Release bundle, and exposes only the
   bounded legacy `EnabledActions` needed by the slice. A harness or protocol
   failure after production ingress is a **real mutation**, even if the
   disposable save is later restored. Never recast it as a dry run, and do not
   rerun a mutation merely to repair its evidence: stop and obtain an explicit
   acceptance decision for a new fixture identity/lane before any further
   mutation gate.
3. Fixture setup may provide only reviewed native prerequisites before bridge
   attachment (for example, a Hoe and bare diggable ground for `till_soil`, an
   intact adjacent `(O)590` artifact spot plus one Basic Hoe for
   `dig_artifact_spot`, or one untouched `(O)710` plus a read-only CrabPot
   predicate-discovered target and exactly one cardinal standing tile for
   `place_crab_pot`). The CrabPot fixture must reject Caldera, VolcanoDungeon,
   and MineShaft, require the exact native predicate, and find exactly one valid
   `(O)710` stack with **exactly one** item. An existing pot stack is reused by
   object identity and count; duplicate, invalid, or conflicting pot stacks fail
   closed. Native inventory insertion may normalize unrelated item object
   references, so the fixture preserves their slot, qualified-ID, and stack facts
   rather than their object references. Only a genuinely empty inventory slot in
   an otherwise fresh disposable save may receive one one-time pot, and the
   postcondition must prove every pre-existing item identity and count is
   unchanged. The fixture must never remove or rebuild a pot, call
   `placementAction`, reduce inventory, modify water/objects, create output, or
   emit a receipt. Its preparation runner stops after fixture invocation and
   fresh target/capability isolation; it sends no production request. The
   fixture-only CrabPot runner is
   `run-stardew-native-local-player-place-crab-pot-fixture-smoke.mjs`; production
   is separately mapped to `run-stardew-native-local-player-place-crab-pot-smoke.mjs`.
   For `native_bait_crab_pot_v1`, the pre-attachment initializer may use only a
   native-owned, exact `(O)710` CrabPot candidate that is already current-player
   owned, unbaited, has no held output, and is adjacent to a cardinal standing
   tile; it may supply exactly one `(O)685` Bait stack and select it. It must not
   call `performObjectDropInAction`, `checkAction`, `CrabPot` bait methods, a raw
   dispatcher, direct bait/object/inventory mutation, or emit a receipt. It must
   preserve the existing pot identity. The unique production mutation gate is
   `run-stardew-native-local-player-bait-crab-pot-smoke.mjs`; it must use one
   guarded `GameLocation.checkAction` ingress and prove same request/execution,
   the original opaque pot identity, current-player owner, unbaited→baited,
   Bait `1→0`, revision advance, and fresh `actionable=true` with no active
   execution. It must not claim pot output/collection, Farmhand, Portfolio,
   publication, release, or save/reopen closure.
   The completed native-local mechanics gate selected opaque target
   `crab_pot_f64d58b4927b2be4` at Farm `(34,52)`, returned same-request/execution
   `succeeded/crab_pot_placed`, and proved source disappearance, result
   appearance, owner binding, inventory `1→0`, and fresh `actionable=true`
   without an active execution. Its all-water neighborhood produced native
   `directionOffset=(0,0)` and no overlay tiles; both are valid target-version
   facts, not failure signals. This is not bait/output/day/collection, Farmhand,
   Portfolio, publication, release, or save/reopen closure. The artifact fixture must not invoke `Hoe.DoFunction`,
   `digUpArtifactSpot`, remove the source, manipulate rewards/debris, change
   inventory as an outcome, or emit a receipt. `native_dig_artifact_spot_v1`
   has target-version native-local mechanics evidence only: the production
   request equipped Hoe slot `4` then returned same-execution
   `succeeded/artifact_spot_dug` for Farm `(19,31)`, with the exact source
   `artifact_spot_44253872405796f4` removed, same-tile crop-free `HoeDirt`
   result `artifact_spot_result_ba2a626c2326abec`, Farm source count
   `2→1`, and native-Hoe stamina evidence `270→268` (`delta=-2`,
   `expected_stamina_cost=2`). The runner and Host parser bind the reported
   expected cost to the observed nonpositive stamina delta before accepting
   the receipt. The fixture itself does not establish stamina or invoke the
   Hoe lifecycle. Rewards/debris/pickup/inventory outcomes remain
   outside this source-only action; it is not Farmhand, Portfolio, publication,
   release, or save/reopen evidence.
4. For the action under evaluation, require its same-`executionId`
   authoritative terminal `succeeded` receipt with native evidence and its
   fresh action-specific postcondition. Prerequisite movement, travel, and
   equipment actions each require their own receipt and must not be attributed
   to the action under evaluation. Rejected navigation or stale revisions are
   diagnostics; re-read the snapshot before any new request and never recycle
   its revision. A scenario-specific initializer may use a reviewed
   target-version native setup entrypoint before bridge attachment only; it
   must establish prerequisites and assert that the action terminal state is
   absent. It is never a generic production native-call fallback.
5. Before **any** fixture profile/config/bundle mutation, refuse every existing
   `StardewModdingAPI`, `StardewModdingAPI.exe`, `Stardew Valley`, or
   `StardewValley` process. The runner may launch exactly one SMAPI process;
   after force-stop it must verify no Stardew/SMAPI process remains before it
   restores the transaction.
6. For `native_water_crop_v1`, the native-local initializer is limited to a
   nonempty current-local-player Watering Can and target-version `SpreadDirt`
   followed by `SpreadSeeds 472`, yielding an observed unwatered crop. The
   event-free template has no `HoeDirt`, and target-version `SpreadSeeds`
   populates only existing dirt. It must not call `SetupBigFarm`,
   establish/reuse a Cabin or Farmhand binding, call debug `Water`, write
   `HoeDirt` water state, call `water_crop`, or emit a receipt. Farmhand
   fixture setup/evidence is a different lane and cannot be copied into this
   one.
7. For `native_plant_seed_v1`, the native-local initializer is limited to a
   current-local-player native inventory stack of in-season Spring seed `(O)472`
   and target-version `RemoveDirt` followed by `SpreadDirt`, yielding observed empty native
   `HoeDirt` after the Farmer reaches Farm. It must not call `plant_seed`,
   `placementAction`, reduce an item stack, create a crop/terminal state, or
   emit a receipt/postcondition. Its
   runner rediscoveres a fresh opaque `seedTargets` entry and its published
   seed slot, separately receipts travel/movement, then requires
   same-execution `succeeded/seed_planted` native crop/inventory evidence:
   exact target/item, nonempty crop, and inventory `after == before - 1`, plus
   a fresh snapshot where that exact target is absent. In the verified
   target-version run, production alone returned `succeeded/seed_planted` for
   opaque target `seed_fc52b3b227bddefc` at Farm `(62,18)`, with `(O)472`
   inventory `2→1` and same-execution `crop=472`; fresh state omitted the
   exact seed target at matching revision while the Player remained actionable
   and stationary. This is shared native-local mechanics evidence only, not
   Farmhand, Portfolio, publish/release, save/reopen, crop-growth, harvest, or
   generic seed-family closure.
8. `native_fertilize_tile_v1` has met this lane's target-version live mechanics
   closure. Its pre-attachment setup may provide `(O)368` Basic Fertilizer and
   eligible empty native `HoeDirt` through `RemoveDirt → SpreadDirt`, but must
   not apply fertilizer, call `placementAction`, or emit a receipt. Its exact
   legacy allowlist is `move_to_tile`, `travel`, `fertilize_tile`. The production
   action independently discovered fresh opaque target `fertilizer_…` at Farm
   `(62,18)`, returned same-execution `succeeded/fertilizer_applied`, proved
   `fertilizer_before=none`, `fertilizer_after=(O)368`, and inventory `2→1`, then
   a fresh snapshot omitted that target. This is only
   `native_local_player_fixture` shared mechanics evidence.
9. `native_harvest_crop_v1` has met this lane's target-version live mechanics
   closure. Its setup may create only a ready ordinary non-forage `Grab` crop and
   prove inventory capacity; it must not harvest, remove/change that ready crop,
   or add/delete harvest output. Its exact legacy allowlist is `move_to_tile`,
   `travel`, `harvest_crop`. The runner handles the bounded transient after the
   production terminal without weakening pre-request actionability. The production
   action independently discovered opaque target `crop_…` at Farm `(70,17)`,
   returned same-execution `succeeded/crop_harvested`, proved non-regrowing crop
   removal and inventory `0→1`, and a fresh actionable snapshot omitted that
   target. This is only `native_local_player_fixture` shared mechanics evidence.
   These two scenarios remain separate and never expose both actions in one fixture.
10. `native_pickup_forage_v1` has met this lane's target-version live mechanics
   closure. Before bridge attachment it derives a bounded Farm search from the
   current native local Player's FarmHouse-to-Farm warp and uses target-version
   `dropObject` only to establish one genuine `isForage`/`IsSpawnedObject`
   precondition; it must not call `tryToCheckAt`, `checkAction`, the production
   request, remove the object, mutate pickup inventory, or emit a receipt. Its
   exact legacy allowlist is `move_to_tile`, `travel`, `pickup_forage`. Production
   independently rediscovered opaque target `forage_…` at Farm `(63,17)`, returned
   same-execution `succeeded/forage_picked_up`, proved `(O)399` was removed and
   inventory `0→1`, and a fresh actionable snapshot omitted that target. This is
   only `native_local_player_fixture` shared mechanics evidence.
11. `native_pickup_item_v1` has met this lane's target-version live mechanics
   closure. Before attachment it uses `Game1.createItemDebris` only to establish
   one bounded native OBJECT Debris/chunk `(O)388`; it never calls collection,
   removes a chunk, writes inventory, or emits a receipt. Its exact legacy
   allowlist is `move_to_tile`, `travel`, `pickup_item`. Production rediscovered
   opaque target `item_4f15e84d0c216dc9` at Farm `(64,17)`, returned same-execution
   `succeeded/item_picked_up`, proved `native_auto_collect=true`, chunk removal,
   and inventory `0→1`; a fresh snapshot omitted the target. This is only
   `native_local_player_fixture` shared mechanics evidence.
12. `native_machine_inspect_v1` has met this lane's target-version live mechanics
   closure. Before attachment it uses target-version `dropObject` only to place
   an adjacent empty `(BC)12` machine in the current FarmHouse; it does not open
   a menu, load, collect, alter machine state, or produce a receipt. Its exact
   legacy allowlist is `move_to_tile`, `machine_inspect`. Production rediscovered
   the opaque target, returned `succeeded/machine_inspected` at FarmHouse `(8,10)`,
   and a fresh snapshot confirmed identical machine/input/output/ready facts. This is only
   `native_local_player_fixture` shared mechanics evidence.
13. `native_use_item_v1` has met this lane's target-version live mechanics closure.
   Before attachment it supplies ordinary `(O)216` Bread through the current
   Player's native inventory API only; it never invokes eating, alters stack,
   stamina, health, or emits a receipt. Its exact legacy allowlist is `use_item`.
   Production returned same-execution `succeeded/item_used` for `(O)216` in
   slot `5`; invariant-culture stamina/health evidence matched fresh before/after state and the food target
   disappeared after native animation. This is only `native_local_player_fixture`
   shared mechanics evidence.15. `native_feed_animal_v1` is a native-local-only disposable-working-save
    slice with exact legacy profile `move_to_tile`, `travel`, `enter_exit`,
    `feed_animal`. Before bridge attachment, it may call target-version
    `SetupBigFarm` only to create and verify one native `AnimalHouse`, its
    resolvable Farm entry fact, and an empty `Trough`; it may add Hay to the
    current local Player. It must not fill a trough, call
    `AnimalHouse.checkAction`, decrement Hay, create a receipt, modify the
    template, or simulate any production postcondition. The runner separately
    receipts typed travel/movement/enter-exit setup, then uses a post-entry
    fresh snapshot as the sole source of opaque `feedTroughTargets`. It blocks
    on zero targets and deterministically selects one fresh valid opaque target;
    it requires feed's own same request/execution
    `succeeded/hay_placed_in_trough` receipt, Hay `N→N-1`, filled/trough-gone,
    and a fresh actionable snapshot. The serial target-version gate passed from
    the source-pinned first `SetupBigFarm` Deluxe Barn `AnimalHouse`: a fresh
    snapshot selected opaque target `feed_trough_6b8d0c86fd28f075` at `(8,3)` in
    Hay slot `5`; production alone returned
    `succeeded/hay_placed_in_trough` with `native_handled=true`,
    `trough_filled=true`, and Hay `2→1`. A fresh snapshot changed eligible
    targets `2→1` and omitted that exact target. The pre-bridge fixture only
    established the AnimalHouse, empty trough, and Hay; it did not feed.
    This is native-local shared mechanics evidence only, never Farmhand,
    HostAutomation, Portfolio, publication, release, or save/reopen evidence.
16. `native_break_rock_source_v1` has met this lane's target-version live mechanics closure. Before bridge attachment, fixture setup supplies exactly one basic Pickaxe and one ordinary adjacent one-hit `(O)2` breakable stone (`MinutesUntilReady=1`) in the disposable Farm working save; it does not invoke `Pickaxe.DoFunction`, damage/remove the source, collect drops, alter inventory output, or emit a receipt. Its exact legacy allowlist is `move_to_tile`, `travel`, `equip_tool`, `break_rock_source`. Production independently reached Farm, equipped slot `4` `(T)Pickaxe`, then targeted opaque `rock_source_d070382fe9bc99dd` at Farm `(64,17)`. The same execution returned `succeeded/rock_source_broken` with `tool=pickaxe`, `qualified_item_id=(O)2`, `durability_before=1`, `durability_after=removed`, and `removed=true`; the fresh snapshot changed eligible rock targets `1→0` and omitted that exact target. Drops and pickup are intentionally outside this action. This is only `native_local_player_fixture` shared mechanics evidence, never Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen evidence.
17. `native_chop_tree_source_v1` has met this lane's target-version live mechanics closure. Before bridge attachment, fixture setup supplies exactly one basic Axe and one ordinary mature terrain-feature tree at `health=1`, with `stump=false`, `moss=false`, `tapped=false`, and an independently reachable approach in the disposable Farm working save. It does not invoke `Axe.DoFunction`, damage or transform the tree, collect falling drops, alter inventory output, or emit a receipt. Its exact legacy allowlist is `move_to_tile`, `travel`, `equip_tool`, `chop_tree_source`. In the target-version run, production alone reached Farm, equipped `(T)Axe` slot `4`, and targeted `tree_chop_source_db2e14e373c76083` at Farm `(64,17)`. The same execution returned `succeeded/tree_source_chopped` with `health_before=1`, `health_after=5`, `stump_before=false`, `stump_after=true`, and `source_transformed=true`; the fresh snapshot changed `treeChopSourceTargets 1→0` and `treeChopResultTargets 0→1`, showing the same-location, same-type stump result. This is only `native_local_player_fixture` shared mechanics evidence, never Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen evidence. Tree-fall drops and subsequent pickup remain separate actions.
18. `native_clear_debris_resource_clump_v1` has met this lane's target-version live mechanics closure. Before bridge attachment, fixture setup uses the target-version native placement API to establish exactly one intact `2×2` `ResourceClump` at Farm `(62,17)`, `parentSheetIndex=752`, default health `8`, and one basic Pickaxe in the disposable working save. It validates every footprint placement tile, rejects unavailable fixed geometry and a pre-existing `parent=752` clump, and must not invoke `Pickaxe.DoFunction`, decrement health, remove the clump, collect drops, alter output inventory, or emit a receipt. Its exact legacy allowlist is `move_to_tile`, `travel`, `equip_tool`, `clear_debris`; its runner may approach only `(61,17)`, `(64,17)`, or `(62,19)`, blocks rather than searching elsewhere, and accepts only the fixed fixture tuple. Production independently reached `(61,17)`, equipped `(T)Pickaxe` slot `4`, and hit the same fresh opaque target at `(62,17)` eight times. Each hit used its own typed request and matching execution receipt: the first seven were `partially_succeeded/debris_hit`, with health descending `8→1`; the eighth request's terminal receipt was `succeeded/debris_cleared` with `health_before=1`, `health_after=0`, and `clump_removed=true`. A fresh snapshot had `debrisTargets=0` and omitted the exact target. The fixture transaction restored its exact profile, removed backup/lock and working save, and left no Stardew/SMAPI process. This is only `native_local_player_fixture` shared mechanics evidence, never Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen evidence. Drops and pickup are deliberately outside this action.
19. `native_clear_hoedirt_v1` has met this lane's target-version live mechanics closure. Before bridge attachment, fixture setup provides exactly one Basic Pickaxe and one intact ground, crop-free, non-`IndoorPot` `HoeDirt` in the disposable Farm working save; the asynchronous native FarmHouse→Farm warp only establishes a lawful adjacent Player position. It does not invoke `Pickaxe.DoFunction`, remove terrain, alter inventory, or emit a receipt. Its exact legacy allowlist is `move_to_tile`, `travel`, `equip_tool`, `clear_hoedirt`. The production run independently selected slot `4` `(T)Pickaxe`, then targeted opaque `clear_hoedirt_8239e9dc24a59295` at Farm `(64,18)`. The same execution returned `succeeded/hoedirt_cleared` with `crop_before=false`, `hoedirt_present_before=true`, `hoedirt_present_after=false`, and `removed=true`; its fresh snapshot changed eligible targets `1→0` and omitted the exact target. This is only `native_local_player_fixture` shared mechanics evidence, never Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen evidence.
20. `native_pet_animal_v1` has met this lane's target-version live mechanics closure. Before bridge attachment, the fixture establishes and validates exactly one native Dog at FarmHouse `(9,10)`, friendship `0`, unpetted today, and `grantedFriendshipForPet=false`; it does not call `Pet.checkAction`, mark a pet day, change friendship, or emit a receipt. Its isolated legacy allowlist is `pet_animal`. Production alone targeted opaque `pet_b4915a66ae52ef35` and returned `succeeded/pet_completed` with same-execution evidence `friendship_before=0`, `friendship_after=12`, `day_recorded=true`, and `friendship_callback=true`. The fresh snapshot contained no eligible unpetted target. The fixture transaction restored the profile and removed its backup/lock and working save. This is only `native_local_player_fixture` shared mechanics evidence, never Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen evidence.
21. `native_npc_relationship_v1` has met this lane's target-version live mechanics closure. Before bridge attachment, fixture setup establishes bounded native Robin at Farm `(64,17)` with persisted friendship `250`, `Friendly`, `talkedToToday=false`, and zero gifts; it does not mutate relationship facts or invoke an NPC interaction/read receipt. Its isolated legacy allowlist is `move_to_tile`, `travel`, `npc_relationship`. Production traveled FarmHouse→Farm, independently moved to legal adjacent `(64,16)`, and returned `succeeded/npc_relationship_inspected` for opaque `npc_relationship_c3821ad1c48f764f`, with same-execution evidence matching Robin and all five relationship facts. A fresh reread matched the same target and unchanged facts. The transaction restored profile/working-save state and removed backup/lock. This is only `native_local_player_fixture` shared mechanics evidence, never Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen evidence.
22. The current runner force-stops its single process during teardown. Its
   result is a live mechanics receipt/postcondition proof only, not native
   save/reopen or persistence proof. An action whose declared result requires
   persistence needs a separate topology-scoped native save/reopen gate before
   any corresponding claim.
23. `native_tool_recovery_chain_v1` has met this lane's target-version live
   recovery-chain closure. The chain runner (`run-stardew-native-local-player-tool-recovery-chain-smoke.mjs`)
   drives one full Agent recovery loop inside a single game session against
   `GameBuddyFixtureStable_445936768`'s disposable working save: breakpoint
   `till_soil` without equipping the Hoe → terminal `rejected/hoe_not_equipped`;
   recovery `equip_tool {tool:hoe}` → `succeeded/tool_equipped`; retry
   `till_soil` → `succeeded/soil_tilled` with Farm `(62,18)`
   `before=none;after=HoeDirt`, fresh bare-soil targets `2→1`, and native
   stamina `270→268` (`delta=-2`). The three receipts share one contiguous
   journal (`revision` strictly increasing `26<27<28`, distinct execution IDs),
   proving the §1.4 recovery contract: breakpoint receipt → recovery receipt →
   retry receipt, all observable in one session. The profile transaction
   restored and removed backup/lock and working save; no Stardew/SMAPI process
   remained. This is native-local shared mechanics AND recovery-chain evidence
   only — it proves the Agent-visible recovery loop for `hoe_not_equipped`,
   not Farmhand, HostAutomation, Portfolio, publication, release, or
   save/reopen evidence.
23. The runner must restore the exact profile transaction. Then remove the
   working save through `prepare-stardew-action-fixture.ps1 -Cleanup`; verify
   no backup, lock, SMAPI/Stardew process, or working save remains.
24. `water_crop_resource_recovery_chain` and
   `harvest_inventory_full_recovery_chain` have met this lane's target-version
   live recovery-chain closure (2026-09-28), extending item 23's
   breakpoint → recovery → retry shape to two more §1.4 modes. **Resource
   depletion**: `rejected/watering_can_empty` (rev 2) →
   `succeeded/watering_can_refilled` (rev 3, water `0→40` of `40`) →
   `succeeded/crop_watered` (rev 4, same crop target, `before_watered=false` →
   `after_watered=true`, water `40→39`, stamina `270→268`). **Container full**:
   `rejected/inventory_full` (rev 19) → `succeeded/chest_stored` (rev 20) →
   `succeeded/crop_harvested` (rev 21, same crop target, inventory gained, crop
   target gone). Both chains showed three terminals on one journal with strictly
   advancing revisions and distinct execution ids, and both profiles restored
   with backup/lock and working save removed and no Stardew/SMAPI process left.
   Two real defects were found by these live runs and are worth remembering:
   (a) the container-full runner validated target ids against an invented
   `harvest_` prefix while the Mod emits `crop_<hex16>`, so **every** real target
   failed validation and the actor circled the map for 152 waypoints — a test now
   pins the accepted prefix against the Mod source, because an offline mock
   shares the runner's own regex and cannot catch that drift; and (b) the
   approach search must be anchored on the crop target, not on the moving actor's
   tile (a self-centred ring re-centres each step and never tries the tiles that
   reach both targets), and a usable chain position requires the crop AND the
   chest in reach, since settling on a crop-only tile strands the recovery step.
25. `stamina_recovery_chain` has met this lane's target-version live recovery-chain
   closure (2026-09-28), proving the fourth §1.4 mode. It is deliberately **not**
   rejection-triggered: the contracts record that no `insufficient_stamina`
   reasonCode exists, because stamina is a continuous fact every tool handler spends
   and every tool receipt reports. The breakpoint is therefore a READING:
   `succeeded/soil_tilled` (rev 21) with the receipt's own evidence showing stamina
   `12 -> 10`, then `succeeded/item_used` (rev 23) showing the eaten Bread restoring
   `10 -> 60` and the stack leaving `1 -> 0`, then `succeeded/soil_tilled` (rev 24)
   on a DIFFERENT bare tile with stamina `60 -> 58` and the tile gone from the next
   snapshot. Three terminals, one journal, strictly advancing revisions and distinct
   execution ids; the profile restored with backup/lock and working save removed and
   no Stardew/SMAPI process left. Every assertion stays strictly above the native
   pass-out floor of `-15` (`Game1.cs:6452`), so this gate cannot silently become a
   pass-out test. The scenario sets `player.stamina` directly as its precondition
   (the same technique `native_pass_out_v1` uses) and never tills, eats, or emits a
   receipt. This is native-local shared mechanics AND recovery-chain evidence only —
   never Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen
   evidence.
26. `craft_partial_recovery_chain` has met this lane's target-version live
   recovery-chain closure (2026-09-28), proving the fifth §1.4 mode
   (断点续作 / 部分完成). Like the stamina mode it is NOT rejection-triggered: the
   native recipe transaction really runs and the product really exists, so the
   honest terminal is `partially_succeeded` (line `partially_succeeded`,
   `farmhandexecutioncontroller.craftingactions.cs`) with
   `disposition=partially_dropped_on_ground`, and the Mod's own comment forbids
   reporting that as a full success. Measured chain: `partially_succeeded` /
   `crafted_item_created` (rev 1) with gained `1` + dropped `4` = produced `5`,
   then `succeeded/chest_stored` (rev 2) moving the retained `999` into the chest,
   then `succeeded/crafted_item_created` (rev 3) re-crafting the SAME recipe to
   `disposition=added_to_inventory` with gained `5` and dropped `0`. Three
   terminals, one journal, strictly advancing revisions, distinct execution ids,
   and conservation `999 + 9 = 998 + 5x2`; the profile restored with backup/lock and
   working save removed and no Stardew/SMAPI process left. The scenario learns Bait
   (data row `684 1/Home/685 5/false/Fishing 2/`: one Bug Meat becomes five Bait,
   and `(O)685`'s native max stack is 999), fills the backpack with `(O)685` at 998
   plus `(O)684` at 2 plus Tool fillers, and warps to a lawful tile beside one owned
   Chest; it never crafts, stores, or emits a receipt. The Bug Meat stack is 2 so
   that consumption leaves a live stack behind — with a single Bug Meat the consume
   would free the very slot that absorbs the drop and hide the breakpoint.
   Four live iterations were needed, and they exposed **three** real defects that
   the offline mock could not catch, all of the same class (the mock encoded the
   runner's wrong assumption): (a) the recipe selector matched on `displayName`,
   but the Mod publishes `BridgeRecipeTarget(wireIdentity, recipe.DisplayName, …)`
   and that display name is LOCALIZED (the Bait content row is
   `[LocalizedText Strings\Objects:Bait_Name]`, measured as 鱼饵), so the runner
   found no target while the live snapshot was advertising `Bait`; it now matches
   on the wire identity. (b) The resume leg submitted an explicit `pickup_item`,
   but `Debris.updateChunks` homes the chunks onto the nearest farmer and collects
   them whenever `farmer.couldInventoryAcceptThisItem(this.item)` holds (OBJECT
   debris also bounces for 600 ms), so a full backpack keeps them still and
   `chest_store` freeing a slot makes the GAME deliver them — the explicit pick
   measured `rejected/no_native_path` mid-bounce, and after a settle wait found no
   target at all. The chain now follows the contract's own shape (breakpoint →
   container recovery → retry of the SAME action) and proves completion by
   conservation instead of claiming a pickup the agent never needed. (c)
   `CRAFT_EVIDENCE_KEYS` was a module-scope `const` declared below the
   `import.meta.main` block, so the first live run threw "Cannot access before
   initialization"; importing the module always evaluates the whole file first, so
   no import-based test could see it — a structural test now pins the declaration
   order. The offline suite (11 cases) binds state/reason/disposition to the Mod
   source by anchor+regex extraction, so drift in either the `PartiallySucceeded`
   terminal or the `partially_dropped_on_ground` literal fails it. It also mirrors
   the Mod's own `droppedToGround` guard (`dropped_stack == 0 || dropped_debris
   == 1`, `craftingactions.cs`), which the chain had read but not validated: the
   breakpoint (a partial drop) must carry `dropped_stack=4`/`dropped_debris=1` and
   the retry (a full pickup) `dropped_stack=0`/`dropped_debris=0`, both measured
   live in the recorded run, so a receipt claiming a drop with no debris behind it
   is refused instead of passing a check the Mod would have called Uncertain.
   This is native-local shared mechanics AND recovery-chain evidence only — never
   Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen
   evidence.
27. `chop_tree_approach` has met this lane's target-version live closure for the
   shared tool-family approach leg (design §5.2), proving the geometry the native
   click path enforces and the bridge used to refuse. `Game1.cs:11509` requires
   `tileWithinRadiusOfPlayer(grabTile, 1)` before `checkAction`, and
   `Character.GetToolLocation` (`:1218-1228`) only returns the clicked tile inside
   that radius — farther away it swings at the tile in front — so a real player
   walks into range while the bridge returned `target_out_of_range` and left the
   walking to the Agent. The harness reuses the UNCHANGED
   `native_chop_tree_source_v1` fixture and the UNCHANGED published
   `chop_tree_source` action; only the runner's geometry differs. It deliberately
   separates the actor from the tree first, then issues the action from outside the
   interaction radius. Measured: requested from Chebyshev distance `2`
   (`(62,15)` for the tree at Farm `(64,17)`), one accepted execution, and one
   journal lineage `accepted → controller_started → tile_advanced →
   tool_approach_completed → tree_source_chopped` (rev `21`). The terminal carries
   `health_before=1`, `health_after=5`, `stump_before=false`, `stump_after=true`,
   `source_transformed=true`, and the full tool-family stamina shape `270→268`
   (`expected_stamina_cost=2`); the fresh snapshot dropped
   `treeChopSourceTargets 1→0` and gained `treeChopResultTargets 0→1` with the
   stump at the same tile and type. The arrangement is the load-bearing part:
   `tool_approach_completed` is minted as `Running`, not a terminal, so the runner
   refuses to treat arrival as the action's outcome, and it also refuses to pass a
   Mod that chops from a distance without walking. The transaction restored its
   profile, removed backup/lock and working save, and left no Stardew/SMAPI
   process. Three live iterations were needed and exposed two real defects the
   offline mock could not catch, both of the same class — the mock encoded the
   runner's assumption instead of the game's behaviour: (a) the mock reused the
   SOURCE tree's `targetId` for the stump, but the live projection mints a distinct
   identity (`tree_chop_source_*` → `tree_chop_result_*`), so a targetId-matching
   readback passed offline and failed live; (b) the runner's snapshot summary never
   forwarded `treeChopResultTargets` at all, so the postcondition could never be
   observed regardless of the world. The mock now mirrors the real identity split
   and the failure report names which clause failed instead of printing a bare
   mismatch. This is native-local shared mechanics evidence only — never Farmhand,
   HostAutomation, Portfolio, publication, release, or save/reopen evidence. The
   checker's tool-family stamina invariant is unchanged; it now follows the
   action's own delegations to the shared execution body, and a negative case pins
   that a wrapper delegating to an incomplete body is still reported.
28. The **5.2 migration regression** re-ran two actions that already had live
   closure, after the shared mechanism was generalized from a closed
   `PendingToolApproachKind` enum to a caller-supplied action id plus an
   on-arrival closure, and after all 18 actions were moved onto it. Both were
   driven with the UNCHANGED fixture scenarios and the UNCHANGED published
   actions; the point is that the generalization is behaviour-preserving.
   `water_pet_bowl` returned same-execution `succeeded/pet_bowl_watered` for
   opaque `pet_bowl_8b416b60dd7e64e7` at Farm `(4,21)` with
   `before_watered=false → after_watered=true`, water `39→38`, stamina `270→268`
   (`expected_stamina_cost=2`), `native_menu_opened=false`, and
   `petBowlTargets 1→0` in the fresh snapshot. `water_slime_hutch_trough`
   returned same-execution `succeeded/slime_hutch_trough_watered` for opaque
   `slime_hutch_trough_9fbb4a363c05d6e4` at `SlimeHutch1dba5809-…` `(16,6)` with
   the same water/stamina shape, `troughTargetCountBefore=2`,
   `sourceTargetGone=true`, and `freshPostcondition=true`. Both transactions
   restored their profile, removed backup/lock and the working save, and left no
   Stardew/SMAPI process. Native-local shared mechanics evidence only — never
   Farmhand, HostAutomation, Portfolio, publication, release, or save/reopen
   evidence.
29. The `water_pet_bowl` / `water_slime_hutch_trough` live runners load the Host
   client from `host/dist-test`, so a missing or stale test artifact blocks them
   before the game is ever driven. The artifact could not be built with the
   committed `build:test` because 88 type errors in **test files only** (all
   HEAD-committed, none touched by this lane) fail `tsconfig.test.json`. The two
   regressions above were therefore run against an artifact emitted with a
   scratch project that is `tsconfig.test.json` with two deltas: `exclude` adds
   `src/**/*.test.ts`, and `noUnusedLocals` / `noUnusedParameters` are relaxed to
   `false`. Only `local-stardew-bridge.js` and its module graph were consumed, and
   the emitted `protocol.js` / `snapshot-projection.js` / `action-registry.js` were
   verified to carry `petBowlTargets` and `slimeHutchTroughTargets` before the
   runs; the two passing live gates are themselves the fidelity evidence for the
   artifact. This is a local workaround for a broken shared build entry point, not
   a change to the committed build: `build:test` is still red for its own reasons
   and that repair belongs to whichever lane owns those test files.
Current native-local validation record: `move_to_tile`, `till_soil`,
`equip_tool`, `travel`, `enter_exit`, `plant_seed`, `fertilize_tile`,
`harvest_crop`, `pickup_forage`, `pickup_item`, `machine_inspect`, `use_item`, `chop_tree_source`, `clear_debris`, `clear_hoedirt`, `refill_watering_can`, `feed_animal`, `break_rock_source`, `collect_animal_product`, `pet_animal`, and `npc_relationship` have met this lane's live
receipt-plus-fresh-postcondition standard. The built-in kitchen fridge has
also met this lane's standard as a **container target**, over the same
`chest_store`/`chest_retrieve` capability: the fridge IS a `Chest`
(`FarmHouse.fridge`/`IslandFarmHouse.fridge` are `NetRef<Chest>` built with
`playerChest: true`) and runs the identical `Chest.addItem` /
`GetItemsForPlayer().Remove` transaction, so only resolution differs — the
fridge never enters `location.objects` and can only be reached through
`GameLocation.GetFridge()` plus the room's cached `fridgePosition` tile, which
is why `chest_store`/`chest_retrieve` previously silently missed it. Both
scenarios upgrade the real house to a kitchen (`HouseUpgrade 1`, the same class
of target-version native setup as `SpreadDirt`/`SetupBigFarm`) so
`GetFridge()` returns the built-in `Chest`, supply one `(O)24` in the backpack
(store) or inside the fridge (retrieve), and warp only to a lawful fridge
approach tile; the fixture never runs the container transaction. `fridge_store`
returned same-execution `succeeded/chest_stored` for opaque
`fridge_17a1dedfce967e56` at FarmHouse `(6,4)`, with `container=fridge`,
`item=(O)24`, `player_stack_before=1`, `player_stack_after=0`,
`source_consumed=true`, `chest_stack_before=0`, `chest_stack_after=1`, and
`native_menu_opened=false`. `fridge_retrieve` returned same-execution
`succeeded/chest_retrieved` for the same fridge identity, with
`chest_stack_before=1`, `chest_stack_after=0`, `inventory_before=0`,
`inventory_after=1`, and `native_menu_opened=false`. Both transactions restored
their profile, removed backup/lock and the working save, and left no
Stardew/SMAPI process. This is only `native_local_player_fixture` shared
mechanics evidence, never Farmhand, HostAutomation, Portfolio, publication,
release, or save/reopen evidence. `ship_item` has also met this lane's standard
over the **island** shipping bin, which is the same capability rather than a new
action: `IslandWest.leftClick` ships through `farm.getShippingBin(who)`, and the
game's own `ItemGrabMenu` path for that bin passes `Game1.getFarm().shipItem`,
so only target resolution differs. `native_ship_item_island_v1` enables the real
island house upgrade (`farmhouseRestored`, the same class of target-version
native setup as `HouseUpgrade 1`) because the shipping branch is gated on it,
clears the native bin, supplies one shippable object, and warps only to a lawful
tile beside the bin footprint; it never ships the item or writes bin contents.
`ship_item_island` returned same-execution `succeeded/item_shipped` for opaque
`shipping_bin_island_22f174a4433bc2c2` at IslandWest `(90,38)`, with inventory
`1→0`, bin `0→1`, `last_item_shipped_matched=true`, and
`native_menu_opened=false`. The transaction restored its profile, removed
backup/lock and the working save, and left no Stardew/SMAPI process. This is
only `native_local_player_fixture` shared mechanics evidence, never Farmhand,
HostAutomation, Portfolio, publication, release, or save/reopen evidence. The
`water_pet_bowl` action has met this lane's standard on
`GameBuddyFixtureStable_445936768`. It is a **distinct** action, not an alias:
`PetBowl.watered` is a bowl postcondition, and `Pet.cs` reads it at day update
to add `+6` pet friendship before clearing it, so `water_crop`'s `crop_watered`
receipt would assert something false. The scenario supplies one charged
Watering Can and warps only to a lawful tile beside the bowl's waterable tile;
it never waters. The action independently equipped `(T)WateringCan` and reached
the fresh opaque bowl target at Farm `(4,21)`: same-execution receipt
`succeeded/pet_bowl_watered` recorded `before_watered=false`,
`after_watered=true`, water `39→38`, and stamina `270→268` (`delta=-2`,
`expected=2`) with `native_menu_opened=false`; the target was absent from the
following production snapshot. That live run also proved a **target-resolution**
fact worth recording: the PetBowl tile property sits at the building-data's
**relative** offset, and the sampled template placement put it off the footprint
origin, so footprint arithmetic would silently miss it — resolution therefore
asks the building for the tiles its own property data declares waterable. The
same run showed the template's bowl placement has **no** lawful adjacent
standing tile at all, so the fixture relocates that bowl onto clear ground while
preserving its pet assignment. The transaction restored its profile, removed
backup/lock and the working save, and left no Stardew/SMAPI process. These are
only `native_local_player_fixture` shared mechanics evidence, never Farmhand,
HostAutomation, Portfolio, publication, release, or save/reopen evidence.
Independent review of `water_pet_bowl` (2026-09-28) returned **no blockers**: one
native mutation call, every rejection before it, `succeeded` reachable only from
the action's own before/after `watered` observation, and resolution/discovery/
identity all flowing through the single `PetBowlWaterableTiles` helper. The review
found one real coverage gap — the test pinned the building predicate but not the
**yielded** tile, so a regression that kept `doesTileHaveProperty` while yielding
the footprint origin would have passed. `PetBowlWateringActionTests` now pins the
yielded expression as well (`71a076d`), and that pin was confirmed against a
simulated origin-yield revert. The behavioural proof of that tile stays the live
gate above, which is what originally caught the bug; the integration test project
has no Game1 harness for constructing a bowl with building data.
`water_slime_hutch_trough` has also met this lane's standard (2026-09-28). It is a
**distinct** action, not an alias of `water_crop` or `water_pet_bowl`: the native
terminal is `SlimeHutch.waterSpots[y - 6]` (`SlimeHutch.cs:154-161`), and
`SlimeHutch.DayUpdate` (`:68-94`) consumes those spots to produce slimes, so a
`crop_watered` receipt would assert something false. The template save has neither
a Slime Hutch building nor a `SlimeHutch` location, so `native_water_slime_hutch_trough_v1`
**builds** the real building through the target-version `Build` debug route
(`DebugCommands.cs:1420-1446`, which calls `buildStructure` then completes
construction), takes the lazily created interior from `Building.createIndoors`
(`Building.cs:1873-1920`), supplies one charged Watering Can, and enters through the
normal warp lifecycle; it never waters a spot, never writes `waterSpots`, and emits
no receipt. `water_slime_hutch_trough` returned same-execution
`succeeded/slime_hutch_trough_watered` for opaque
`slime_hutch_trough_06850c49f949ac00` at interior tile `16,6`, with
`before_watered=false` -> `after_watered=true`, water `39 -> 38`,
`native_menu_opened=false`, and stamina `270 -> 268` (`delta=-2`, `expected=2`);
the target was absent from the following production snapshot. A later confirming
run after the in-place fix below produced the same evidence shape for
`slime_hutch_trough_aad2a79e8ca37f6c`. The transaction restored its profile,
removed backup/lock and the working save, and left no Stardew/SMAPI process. An
earlier revision of this gate passed only by accident: the trough is a COLUMN of up
to four tiles, so a lawful standing tile is adjacent to several of them at once,
and a runner that demanded exactly one reachable target (the single-waterable-tile
Pet Bowl rule) treated a reachable trough as unreachable and walked a 27-waypoint
circle until it happened to land on a tile with a unique neighbour. Any accepted
tile is a valid target, and the settle now polls through the pre-attachment interior
warp rather than rejecting the first mid-transition snapshot; the confirming run
traces `equip_tool` then `water_slime_hutch_trough 16,6` with no waypoint, and
`run-stardew-native-local-player-water-slime-hutch-trough-smoke.test.mjs` pins the
multi-tile case (verified to fail against the old exactly-one rule). This is only
`native_local_player_fixture` shared mechanics evidence, never Farmhand,
HostAutomation, Portfolio, publication, release, or save/reopen evidence.
`water_crop` has also met this lane's live
receipt-plus-fresh-postcondition standard. Its scenario first uses the exact
pre-attachment native setup `SpreadDirt → SpreadSeeds 472` to make dry crops;
that initializer itself is not evidence. The action run independently equipped
`(T)WateringCan`, traveled to Farm, and reached the fresh opaque crop target
at Farm `(62,18)`: same-execution receipt
`succeeded/crop_watered` recorded `before_watered=false`,
`after_watered=true`, and water `40→39`; the exact target was absent from the
following production snapshot. `plant_seed` independently traveled to Farm,
reached the fresh opaque seed target at `(62,18)`, and received same-execution
`succeeded/seed_planted` evidence with matching target,
`item=(O)472`, `crop=472`, and inventory `2→1`; that target was absent from
the following production snapshot. `enter_exit` independently moved to its fresh
published FarmHouse door `(3,12)` then received
`succeeded/enter_exit_completed` with fresh `Farm (64,15)` postcondition.

`enter_exit` also proves the **native door gate** on the same run. Since
gate fix, the action dispatches the same native entry a real player click uses
(`GameLocation.performAction` for Buildings-layer Action doors, `Building.doAction`
for building human doors) instead of resolving the door with `getWarpFromDoor`
and calling `warpFarmer` itself. The fixture Farm advertises a Greenhouse human
door at `(28,15)` whose `GreenhouseBuilding.OnUseHumanDoor` refuses while
`ccPantry` is absent (the fixture grants none of `ccPantry`/`ccDoorUnlock`/
`JojaMember`). The second phase moved to the adjacent standing tile `(28,16)` and
then received the honest refusal:

```
phase=enter_exit_gated  args=(28,15)  request=...enter_exit_gated..._3
  receipt = { state: "rejected", reasonCode: "door_gate_refused", revision: 66, hasEvidence: true }
after   = Farm (28,16)  actionable=true  activeExecution=null
```

The actor stayed on the near side (`Farm (28,16)`, not `Greenhouse (10,23)`), the
Game's own locked-door `DialogueBox` was closed by the Mod (the following
`observeFresh({actionable:true})` succeeded, which a mounted modal would have
failed closed), and `doorGate.state=passed` records the whole phase. Before this
change the same request warped straight into the Greenhouse. This is
`native_local_player_fixture` shared-mechanics evidence only.
`equip_tool` ran on the event-free
`GameBuddyFixtureStable_445936768` disposable copy: a fresh snapshot selected
`(T)Hoe` in slot `1`; its same-execution receipt was
`tool_equipped` with `expected=(T)Hoe;after=(T)Hoe`; and its fresh
post-observe reported `currentTool=(T)Hoe`. `travel` is a distinct action, not
an alias for `move_to_tile`: a separate prerequisite move reached the
FarmHouse source warp `(3,12)`, then travel's own execution reached
`succeeded/travel_completed` after the native `Warped` boundary, with fresh
`Farm (64,15)` matching the published target. The profile transaction restored,
its backup/lock were removed, and the disposable working save was cleaned.
`machine_load` and `machine_collect_output` passed the same target-version serial
native-local mechanics run on `GameBuddyFixtureStable_445936768`’s disposable
copy. `native_machine_coffee_load_v1` supplied only idle Keg `(BC)12` at
FarmHouse `(8,10)` and exactly five Coffee Beans `(O)433`; it did not load,
advance time, create ready output, add Coffee, or emit a receipt. Production
first returned `succeeded/machine_coffee_loaded`, with the fresh same-Keg
processing state `held=(O)395`, `lastInput=(O)433`, and
`minutesUntilReady=120`. The runner then waited for actual target-game clock
progression (no timer skip or field mutation) until the fresh same-target
snapshot reported `readyForHarvest=true`, `minutesUntilReady=0`, held Coffee,
and `collectOutputReady=true`. Production collection returned
`succeeded/machine_coffee_collected`; its authoritative evidence recorded
Coffee inventory `0→1`, cleared held output/ready state, and
`native_check_action=true`. The fresh reread showed the same idle Keg with no
held output, `readyForHarvest=false`, and `minutesUntilReady=0`. The profile
transaction restored, working save was cleaned, and backup/lock/game process
were removed. This is shared native-local mechanics evidence only, not
Farmhand, Portfolio, publication, release, save/reopen, capacity-failure, or
full machine-family closure. `machine_configure` is **not applicable and excluded from the pinned-version release action set**, rather than a missing live run: the hash-bound pinned `Machines.xnb` decode exhausts all `39` machine entries and reports zero nonempty `InteractMethod` values. Since the target `Object.CheckForActionOnMachine` calls a `MachineInteractDelegate` only for a non-null method, the target exposes no normal configuration ingress. Do not add a generic configuration request, fixture, runner, direct delegate invocation, or state mutation; reconsider only after target game/content drift yields a finite native ingress.

`water_crop` native-local setup may use only target-version `SpreadDirt`
followed by `SpreadSeeds 472` before bridge attachment to establish truly
live, unwatered crops and native inventory APIs to provide a nonempty Watering
Can. It must never invoke debug `Water`, write a watered `HoeDirt` state,
invoke `water_crop`, or manufacture a receipt/postcondition. Its runner must
rediscover exactly one fresh opaque `cropTargets` ID, use its exact revision,
independently receipt equip/travel/movement, then require
`succeeded/crop_watered` with same-execution lowercase native evidence,
Watering Can charge `-1`, and a fresh `cropTargets` transition of exactly
`1→0`.

They remain shared action mechanics, not Portfolio capability rows or Farmhand
evidence.

## Farmhand promotion lane phases

The following promotion phases apply only to
`native_ai_farmhand_multiplayer`. Native-local validation follows the SOP above
and must not start a Host, AI client, LAN server, or Farmhand attachment.

## Farmhand lane inputs

Record these values outside source control; do not put secrets in this file or
commit them:

| Input | Required fact |
| --- | --- |
| Game path | Licensed target-version Stardew install |
| Fixture root | Absolute directory outside the repository and active save root |
| Template/save name | Exact matching `GameBuddyFixture_*` name |
| Host/AI profiles | Separate Mod profile roots |
| Session directory | Absolute shared, disposable session exchange directory |
| Native Farmhand ID | Explicit owner of the retained fixture Cabin |
| Action | The exact action under evaluation and its smoke runner |
| Config backups | Byte-for-byte transaction backup of both sidecar and actual `Mods/GameBuddy/config.json` sources for Host and AI profiles |

## Farmhand Phase A — preflight and restore

1. Stop every known Host/AI Stardew process. Verify the fixture harness itself
   accepts the process state; do not work around its process guard.
2. Run the action-specific `tools/prepare-<action>-fixture.mjs` wrapper (or
   `tools/prepare-stardew-fixture-profile.mjs` for an already allowlisted new
   scenario). The shared transaction refuses unknown scenarios and to overwrite
   an existing backup, captures both sidecar
   and **actual SMAPI `Mods/GameBuddy/config.json`** files (including absence).
   Because profile root is the configured SMAPI `--mods-path`, it also backs up
   and temporarily removes sidecar `GameBuddy` DLL/manifest/deps files, then
   deploys exactly one Release bundle at `Mods/GameBuddy`; matching restore
   reinstates every sidecar file byte-for-byte. It verifies the effective
   Host/AI scenario and policy before a game process starts. It takes an atomic root-scoped fixture
   transaction lock, so only one fixture prepare/restore may mutate the shared
   profiles at a time. A surviving lock is fail-closed: inspect and restore its
   matching backup; never delete or steal it merely because its owner process
   ended. Do not hand-edit profile config after this preflight.
3. If a prior run was interrupted, first use the **read-only** transaction inspector; it never restores, deletes, kills, or edits anything:

   ```powershell
   node tools/inspect-stardew-fixture-transaction.mjs
   # Or inspect one known backup:
   node tools/inspect-stardew-fixture-transaction.mjs --backup-name <action>-fixture-backup
   ```

   A `locked`, `lock_invalid`, `orphaned_backup`, or `ambiguous_backups` state is a recovery stop: do not start another prepare or delete a lock. Confirm the owning backup and use only its matching restore command after known fixture processes have stopped. The inspector reports file hashes/presence and profile divergence only; it does not expose config contents or session tokens.

4. Restore the working copy from an existing native template:

   ```powershell
   powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 `
     -FixtureRoot "$env:LOCALAPPDATA\GameBuddy\stardew-fixtures" `
     -TemplateName GameBuddyFixture_Example_1_6_15 `
     -SaveName GameBuddyFixture_Example_1_6_15
   ```

5. Confirm the returned JSON says `state: restored`, includes the native named
   save and `SaveGameInfo`, and states that no XML/action/inventory data was
   edited. This restore only creates the working save; it is separate from
   profile preflight.
6. Deploy the current Release DLL to **both** profile Mod directories only
   after verifying the files are unlocked. Verify hashes or byte equality.
7. Configure only the isolated AI profile for the test action. For an
   experimental action, use valid `ActionPolicyVersion: 1` with only that
   action in `ExperimentalActions`; do not retain legacy `EnabledActions` in
   that v1 config. A published action needs no experimental opt-in.
8. If a reviewed fixture scenario is needed, configure the Host profile with
   the exact allowlisted scenario and the matching fixture `SaveName`. Verify
   the scenario will run before attachment and preserves/revalidates the Cabin
   binding.
9. Clear only the fixed, known session-exchange files. Never accept a manifest
   path supplied by a tool response.

## Farmhand Phase B — fixture readiness barrier and formal attachment

1. The formal attachment runner starts the Host first and waits for the fixed,
   Host-authenticated `stardew-fixture-readiness.json` **before** it starts any
   AI client or sends an attachment request. A `fixture_ready` report proves
   only that the allowlisted game-thread initializer established its declared
   native preconditions. It is not a bridge receipt, cannot supply a reusable
   target ID, and cannot prove production action success.
2. Treat `fixture_blocked/<reasonCode>` as a terminal preflight result. Typical
   reasons include `fixture_native_save_load_failed`,
   `fixture_native_save_load_timeout`, or an action-specific native fact such
   as `fixture_native_ready_grab_crop_missing`. Stop, inspect the initializer
   and target-version contract, then restore the fixture; do not start an AI
   client or retry an action request.
3. The runner verifies HMAC, protocol, scenario, save name, launch freshness,
   and bounded clock skew for this report. Missing, stale, malformed, or
   unauthenticated reports fail closed rather than falling through to an
   attachment timeout.
4. Run the normal Host-first attachment regression, not a hand-started Host:

   ```powershell
   powershell -NoProfile -File tools/run-stardew-attachment-regression.ps1 `
     -GamePath '<game-path>' `
     -HostModsPath '<host-profile-root>' `
     -AiClientModsPath '<ai-profile-root>' `
     -HostConfigPath '<host-profile-root>\GameBuddy\config.json' `
     -SaveName GameBuddyFixture_Example_1_6_15 `
     -ExpectedFarmhandId '<explicit-native-id>' `
     -SessionDirectory '<session-directory>' `
     -TimeoutSeconds 300 -KeepProcesses
   ```

5. Require all formal evidence: initial attachment, real client-exit
   `Saving/Saved`, same-Host reconnect after the Host advertises the target
   Farmhand as not busy, Host-restart nonce rotation, stale-manifest rejection,
   and restart attachment. The runner also atomically writes
   `stardew-attachment-telemetry.json` with per-stage elapsed milliseconds and
   pass/fail state. This is an unsigned, non-authoritative performance
   diagnostic: it must never be used as receipt evidence, target evidence, or
   a success decision. Preserve it only long enough to diagnose the run, then
   remove it as a known session artifact during teardown.
6. Read the production snapshot over the authenticated named pipe. Confirm the
   live Mod advertises the action capability. Do not treat fixture logs,
   metadata, or old target IDs as live target evidence.
7. If the fixture initializer created an initial condition, verify it through
   the topology-matching live state (native-local uses its fresh current-local-
   Player snapshot; Farmhand uses the live AI Farmhand state). For example,
   `native_feed_animal_v1` supplies Hay but does not fill a trough;
   `native_plant_seed_v1` supplies only season-valid seed and uses target-version
   `RemoveDirt`/`SpreadDirt` for empty ground HoeDirt, never crop creation; the
   production snapshot must still discover its target itself. `native_till_soil_v1`
   may supply only a Hoe and bare legal diggable ground after target-version
   `SetupBigFarm`/`RemoveDirt`; it must not call `Hoe.DoFunction` or create
   `HoeDirt`.

## Farmhand Phase C — production action proof

1. Use only already-published movement/transport actions to reach the target.
   Each move, warp, and door transition needs its own authoritative receipt;
   none counts as the action under evaluation.
2. Before execution, obtain a **fresh** snapshot and select exactly one target
   that the action-specific smoke runner validates. Never reuse target IDs,
   location IDs, animal positions, slots, or coordinates from a prior run.
3. Run the action-specific production smoke runner. It must submit only one
   normal bridge request and wait for the terminal receipt for that execution.
   For asynchronous actions, use `tools/lib/stardew-formal-action-gate.mjs`:
   it keeps the authenticated bridge alive, correlates facts to that exact
   `executionId`, rejects a nonterminal `accepted` response as success, fails
   closed on disconnect, and performs the required fresh post-receipt reread.
   It does not choose targets, navigate, invoke native APIs, or decide an
   action-specific postcondition.
4. Require the action-specific receipt and postconditions. If a migrated runner
   reports a `failure` object, use its stable diagnostic category and suggested
   investigation step to choose fixture, attachment, bridge, target freshness,
   or postcondition follow-up. The raw receipt state and native `reasonCode`
   remain authoritative; diagnostics never alter their meaning. Examples:

   | Action | Required success proof |
   | --- | --- |
   | `collect_animal_product` | `succeeded/animal_product_collected`; native tool animation done; exact animal `currentProduce` cleared; fresh selected-target removal; fresh bounded aggregate inventory facts show the exact produced `qualifiedItemId` increased by at least published `produceStack` |
   | `feed_animal` | `succeeded/hay_placed_in_trough`; exact trough contains Hay; same topology-matching player's Hay total decreases by one; target gone |
   | `water_crop` | `succeeded/crop_watered`; exact live `HoeDirt` changes from unwatered to watered; Watering Can charge decreases by one; target gone |
   | `fertilize_tile` | `succeeded/fertilizer_applied`; exact live ground `HoeDirt.fertilizer` changes from none to the requested fertilizer; Farmhand inventory decreases by one; target gone |
   | `plant_seed` | `succeeded/seed_planted`; exact live ground `HoeDirt` gains a native crop; same Farmhand seed inventory decreases by one; target gone |
   | `till_soil` | `succeeded/soil_tilled`; exact previously bare live diggable tile gains native `HoeDirt`; target no longer appears as bare soil. Hardened shared native-local rerun: Farm `(62,18)`, receipt revision `27`, `before=none`, `after=HoeDirt`, fresh bare-soil targets `2→1`, with the Player stable at Farm `(62,17)`, `actionable=true`, and no active execution. The runner requires the exact isolated fixture profile and imports the bridge client from the verified immutable Host production generation, not a flat mutable `host/dist` path. |
   | `pickup_forage` | `succeeded/forage_picked_up`; same opaque native forage object removed; exact Farmhand qualified-item inventory increases by one; target is absent in a fresh snapshot. The bridge must enter target-version `Game1.tryToCheckAt`, never directly `GameLocation.checkAction`. |
   | future action | Exact reviewed native postcondition(s), not UI/menu/callback evidence |

5. If the runner reports `blocked`, record the reason and stop. If it reports
   `uncertain`, `rejected`, timeout, stale target, or incomplete evidence,
   investigate and rerun from a freshly restored fixture. Do not retry the same
   request ID or convert it into success.
6. Add a native save/reload check for persistent state whenever the action's
   contract requires it. Do not claim a persistence audit if processes must be
   force-stopped before saving.

## Farmhand Phase D — promotion and regression

1. Update the exact action lifecycle in all of:
   - `integrations/stardew/ModConfig.cs` published/experimental catalogs;
   - Host `action-registry.ts` and its expected published list;
   - protocol/schema/fixtures/runner where applicable;
   - integration and tool documentation;
   - implementation plan and BDD scenario status.
2. Keep the action description semantically narrow. For example,
   `feed_animal` means *place Hay in a trough*, not *an animal is full*.
3. Run serially, after source changes and before declaring promotion:

   ```powershell
   dotnet build integrations/stardew/GameBuddy.Stardew.csproj -c Release --no-restore
   cd host; pnpm build; pnpm test
   cd ..\voice-gateway; pnpm test
   node -e "JSON.parse(require('fs').readFileSync('protocol/bridge-v1.schema.json','utf8')); console.log('schema_json_ok')"
   node --check tools/run-stardew-<action>-smoke.mjs
   powershell -NoProfile -Command "[void][scriptblock]::Create((Get-Content -Raw 'tools/prepare-stardew-action-fixture.ps1')); 'fixture_parser_ok'"
   git diff --check
   ```

   Run build before tests so tests never read stale `host/dist`.
4. Run the promotion checks after registry/Mod/tool changes:

   ```powershell
pnpm --dir integrations/stardew/action-development action:ci
pnpm test:stardew-action-gate-descriptors
   ```

   The publish-surface checker verifies the published action set has no
   duplicates, matches the Mod's published policy, has a Host live-tool gate
   and registry coverage, and that the count assertion is current. The action
   descriptor test additionally requires every published action to declare its
   checked runner and terminal receipt code; fixture-backed actions must agree
   across the Mod allowlist, Host initializer, and profile transaction
   allowlist. These checks are static guards only and never replace an
   independent native live receipt/postcondition gate. Verify the default
   policy only exposes published actions that the current live Mod capability
   advertises. The current Stardew published count is 15, including `pickup_forage`,
   `pickup_item`, `use_item`, and `harvest_crop`; `clear_debris`,
   `npc_relationship` and other unverified slices remain experimental. The former `collect_resource` bridge action is retired: a native Tree source transform and later uncorrelated RESOURCE Debris delivery are separate lifecycles. Future support must use independently verified source-transform plus fresh `pickup_item` delivery steps; no smoke runner may send the retired identifier.
   `native_use_item_v1` may only supply ordinary `(O)216` Bread through target-version `Farmer.addItemToInventory`; published `use_item` production must still provide the native animation and stack receipt. It must not invoke `Farmer.eatHeldObject` or manufacture item-use evidence. `native_pickup_item_v1` may keep its fixture-only dropped-by identity only as a short attachment handoff guard. Target-version `Debris.updateChunks` begins magnetic pickup after roughly 600 ms and owns `Debris.collect`, so published `pickup_item` does not issue a synthetic click-style collect call: its bounded production action guides the Farmhand to the live opaque chunk and waits for native magnetic collection. Its formal gate returned `succeeded/item_picked_up` for Farm `(21,29)` `(O)388`, proving `native_auto_collect=true`, exact chunk removal, Farmhand inventory `0→1`, and target disappearance. Fixture setup is never action evidence.

## Farmhand Phase E — teardown

1. Stop the exact Host/AI processes started for the run. Verify the named-pipe
   / UDP listener is gone and deployed DLLs can be opened exclusively.
2. Restore both sidecar and actual SMAPI Mod configurations through
   `node tools/restore-stardew-fixture-profile.mjs --backup-name <action>-fixture-backup`.
   The transaction verifies saved hashes, removes configs which did not exist
   before the run, and deletes its backup only after byte-for-byte restoration;
   the matching restore is also the only operation that releases the fixture
   transaction lock.
3. Remove the working fixture only through the harness:

   ```powershell
   powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 `
     -FixtureRoot "$env:LOCALAPPDATA\GameBuddy\stardew-fixtures" `
     -TemplateName GameBuddyFixture_Example_1_6_15 `
     -SaveName GameBuddyFixture_Example_1_6_15 -Cleanup
   ```

4. Delete only known session-exchange files and temporary local scripts.
5. Verify: no Stardew/SMAPI process, no UDP `24642` listener, no working
   fixture directory, no session files, and no temporary fixture scenario in
   the restored configuration.
6. Report separately: production receipt evidence, static checks, cleanup
   evidence, untested persistence/cancellation cases, and residual risks.

## Live-record coverage: this runbook is not the whole live surface

**`live_verified` is a claimed lifecycle for 66 actions; this runbook holds a receipt-level record for
only part of that set.** The rest are recorded in per-lane cards and design docs, so "the action is
not in the RUNBOOK" does not mean "the action has no live proof" — and, read the other way, a
RUNBOOK search is not a coverage check. This section states where to look, measured on `2026-10-06`
against the 64 published gates.

**Method, so the next reader can redo it rather than trust it.** For every entry in
`STARDEW_PUBLISHED_ACTION_GATES`, search this file for the action id OR its registered
`terminalReasonCode`, then classify: a per-action record under
`### B. Run one action from a disposable copy`, or a record-looking `##` heading, counts as
receipt-level; a claim in another document counts as recorded elsewhere; neither counts as
asserted-only.

| category | count |
|---|---|
| receipt-level record in this file | **40** |
| record in another document (listed below) | **24** |
| asserted only, with no record anywhere | **0** |

**Receipts read from another document — the proof exists, just not here.** These are not gaps; they
are records whose home is a lane card or a domain doc, and this list exists so the next reader does
not have to grep 60 files to find out:

```text
place_wood_fence  bait_crab_pot          design/22_STARDEW_NATIVE_LOCAL_CLOSURE_BOARD.md
interact_npc_with_item                    design/analysis/ladder4-live-run-audit.md
advance_day                               design/domains/stardew/world-interruption-arbitration.md
cook_recipe                               design/domains/stardew/gameplay-capability-expansion.md
chop_stump  plant_sapling  scythe_crop    design/archive/tasks/stardew-gameplay-loop-closure-implementation.md
harvest_bush  harvest_fruit_tree  shake_tree  take_pedestal_item  toggle_fence_gate
                                          design/tasks/active/cards/lane-loop-closure-waves.md
clear_cask  dress_mannequin  set_sign_display  deposit_silo_hay  toggle_tool_light
                                          design/tasks/active/cards/lane-L2-facility-seams.md
use_raft  mount_transport                 design/tasks/active/cards/lane-L3-movement-seams.md
collect_crab_pot_output                   design/tasks/active/cards/lane-L2-facility-seams.md
```

**Four actions appear in this file only as coverage prose, not as receipts**, and are called out
because a plain search finds them and they look like a pass:

| action | what the mention actually is | read the receipt at |
|---|---|---|
| `collect_crab_pot_output` | a heading that says **bounded, non-live** — it documents the fixture's provenance, not a run | `lane-L2-facility-seams.md` |
| `enter_mine` | quoted inside section 36's discussion of `select_mine_elevator_floor` ("verified live at 10,4 vs the requested 6,6") | `lane-L3-movement-seams.md` |
| `express_emote`, `face_direction` | named in the SOP header as *covered by* the read-only observation procedure, plus one audit-table row | `design/analysis/ladder4-live-run-audit.md` |

**A count check for the next reader**: the table above lists 24 names and the code block lists 24
names; if your re-run disagrees, the classifier's rule is the one to compare against, not this
prose. (`mount_transport` is the one that is easy to drop by eye: it sits on the `use_raft` line.)

**The integrity statement, since this is the number that matters:** zero gated actions are
live_verified without any record anywhere. Every one of the 64 has either a receipt in this file or a
named record in another document. That is a weaker claim than "every action has a receipt in the
RUNBOOK" — which was never true — and a stronger one than nothing.

## Failure rules

- **No target:** `blocked`; do not issue an action request.
- **Attachment incomplete:** stop; it is not an action result.
- **Native precondition builder fails:** fail closed and withdraw that scenario
  until its target-version contract is understood.
- **Stale or changed live target:** reject; re-read snapshot rather than reuse
  old coordinates or opaque IDs.
- **Runner/output timeout:** inspect the live receipt/session/logs before
  retrying; an output timeout cannot be classified as success or failure.
- **Profile/session cleanup failure:** retain the cleanup todo. Do not start a
  different action fixture on a contaminated environment.


### Native-local refill Watering Can mechanics closure

Use the isolated disposable native-local working-save fixture with action `refill_watering_can`. Its profile is exactly `move_to_tile,equip_tool,refill_watering_can`; the scenario `native_refill_watering_can_v1` supplies one ordinary partially filled Watering Can and marks the current FarmHouse Back-layer tile with the target-version-recognized `WaterSource` property. It immediately verifies the native `CanRefillWateringCanOnTile` predicate before bridge attachment. This audited, working-save-only precondition must not invoke `DoFunction`, refill water, create a receipt, or modify a template/user save. Production discovers the bounded opaque source from a fresh snapshot, revalidates it on the game thread, and requires its own same-execution receipt plus a fresh same-slot can fact at max water.

The target-version native-local gate passed for `watering_can_refill_cad28f88543b9ef7` at FarmHouse `(9,9)`: equipped `(T)WateringCan` slot `4`, then `succeeded/watering_can_refilled` with `water_before=39;water_after=40;water_max=40`; a fresh snapshot confirmed that same slot at `40/40`. This is shared native-local mechanics evidence only, never Farmhand or Portfolio evidence.

### Native-local `ride_minecart` mechanics closure

Use the isolated disposable native-local working-save fixture with action `ride_minecart`. Its profile is exactly `move_to_tile,ride_minecart`; the scenario `native_ride_minecart_v1` writes the native station selector (`Action` = `MinecartTransport Default` on the Farm Buildings layer) and grants the vanilla `ccBoilerRoom` network unlock. The fixture never calls `MinecartWarp`, never picks a destination and emits no receipt: every other fact — the network, its destinations, each destination's `Condition` and its `Price` — comes from the live `Data/Minecarts`, and production alone discovers, resolves and rides.

`ride_minecart` is a separate action, not a `travel` objective family. Both the Mod's execution parser (`BridgeProtocol.TryDeserializeExecutionRequest` -> `HasExactProperties`) and `FarmhandExecutionAcceptance.HasExactArgumentShape` are exact-shape allow-lists, and `FarmhandActionArgument` has no optional-argument concept, so a second argument shape means a second action: `travel` keeps `{x, y}` and `ride_minecart` declares `{x, y, expectedTargetId}`, where `x,y` is the minecart STATION tile. The rejected alternative was verified live first — an optional `expectedTargetId` on `travel` died at the parser as `navigation_execution_parse_rejected` and at acceptance as `bridge_rejected:invalid_execution_request`.

The target-version native-local gate passed for `minecart_fe403a3191f92427` (station Farm `(2,9)`, network `Default`, destination `Town`, target tile `(105,80)`): one `accepted/accepted` response at revision `1`, then the action's own terminal `succeeded/minecart_ride_completed` at revision `2`, with a fresh post-terminal observation at revision `2` reporting `Town (105,80)` and `actionable=true`. The receipt's `expected/actual` pair agreed and echoed `network=Default;destination=Town`, so the run names the objective it actually rode. The opaque id binds exactly: `SHA-256("minecart:Default:Town:2,9")[:16] = fe403a3191f92427`.

The arrival observation settles rather than sampling once: the native ride sets `Game1.player.freezePause = 700` (`GameLocation.cs:10311`) and `Farmer.Update` forces `CanMove = false` for that window (`Farmer.cs:7595-7603`), so the Mod's snapshot `Actionable` is legitimately false for ~700 ms after a successful ride. A single-shot read reports that window as a harness artefact, not a product failure. Pre-ride reads stay strict: the actor must be actionable before a request is submitted.

This is shared native-local mechanics evidence for one single-player ride only — never Farmhand, Portfolio, publication, release, cancellation, replay, or save/reopen closure. `ride_minecart` remains `experimental` in the Mod catalog until its own publication review, and its ticket-price branch is unexercised here because the vanilla `Default` network's destinations are free.

**Promotion to `live_verified` (2026-09-30):** the same gate re-ran after the fixture was repaired. Two independent defects had silently landed in the fixture path: the pre-attachment scenario name had drifted back to the retired `native_minecart_travel_v1` in `ModEntry` (the fixture and `ModConfig` both emit/accept `native_ride_minecart_v1`, so the gate was rejected before attachment), and the unlock assertion used the hand-written query `PLAYER_MAIL ccBoilerRoom`, which is not a registered `GameStateQuery` key (the registered key is `PLAYER_HAS_MAIL`, and `PLAYER_MAIL` fails closed to `false` every time). The fixture now re-reads the network's real `UnlockCondition` via `DataLoader.Minecarts` and evaluates that rather than inventing a query string, restoring the pre-f309202 behaviour. With the fixture repaired the gate passed identically: `minecart_fe403a3191f92427` (station Farm `(2,9)`, network `Default`, destination `Town`, target `(105,80)`), `accepted` at revision 1, `succeeded/minecart_ride_completed` at revision 2, fresh postcondition `Town (105,80)` and `actionable=true`, teardown clean. `ride_minecart` was then moved to `FarmhandActionLifecycle.LiveVerified` in the Mod catalog, which makes it default-consent for the Agent (design/10 3.1.1) and admits it to the published gate descriptor set; publication review is still owed for the final `published` rung. Because it was the last experimental registration, the fixture's experimental-set reader had to accept an empty set (a push-only ladder: every promoted action removes itself). Its ticket-price branch remains unexercised because the vanilla `Default` network's destinations are free.
### Native-local path-goal-predicate measurement (read-only, no mutation)

This entry records a measurement, not an Action closure. It answers whether
replacing the native pathing target's exact coordinate with an `isAtEnd`
predicate actually stops A* at a neighbouring tile, and where that path ends.

Run it with `tools/run-stardew-native-local-path-predicate-probe.mjs`, which
wraps the ordinary native-local fixture transaction around the Mod-side
`PathPredicateProbe` (`integrations/stardew/PathPredicateProbe.cs`). The probe
never assigns a controller, never moves the actor, and never sends a bridge
request; it calls `PathFindController.findPath` directly on the game thread,
once per goal, from a fixed start tile. Three goals are measured against the
same target tile in one tick: the exact coordinate, "target or cardinal
neighbour" (Manhattan <= 1), and "target or any neighbour" (Chebyshev <= 1).
Targets are scanned in two families so the diagonal case is reachable at all:
`cardinal_approach` (a walkable cardinal neighbour exists) and
`diagonal_only_approach` (all four cardinal neighbours blocked, a walkable
diagonal exists). Every measured target is at least two tiles from the actor,
so the start node never satisfies a goal and each returned path is a real A*
result. Obstacle classification calls the planner's own
`isCollidingPosition(...)` with findPath's arguments except
`skipCollisionEffects: true`, which removes the one side effect findPath itself
has (`FarmAnimal.farmerPushing`, `GameLocation.cs:2572-2575`) without changing
any return value.

The target-version run passed on `GameBuddyFixtureStable_445936768` (Stardew
`1.6.15`, actor at FarmHouse `(9,9)`, 6 candidate targets: 3 cardinal-approach
and 3 diagonal-only-approach). Start-node control: exact goal on the start tile
returned one node, `9,9`. Results:

| Target | Family | exact goal | cardinal goal | Chebyshev goal |
| --- | --- | --- | --- | --- |
| `7,11` | cardinal | `NULL` | 4 nodes -> `7,10` (cardinal) | 3 nodes -> `8,10` (**diagonal**) |
| `8,11` | cardinal | `NULL` | 3 nodes -> `8,10` (cardinal) | 3 nodes -> `8,10` (cardinal) |
| `11,7` | cardinal | `NULL` | 6 nodes -> `10,7` (cardinal) | 6 nodes -> `10,7` (cardinal) |
| `9,11` | diagonal-only | `NULL` | `NULL` | 3 nodes -> `8,10` (**diagonal**) |
| `11,8` | diagonal-only | `NULL` | `NULL` | 2 nodes -> `10,9` (**diagonal**) |
| `11,10` | diagonal-only | `NULL` | `NULL` | 2 nodes -> `10,9` (**diagonal**) |

Two conclusions, both direct readings of that table:

- **The predicate premise holds.** All 6 targets are unwalkable by the
  planner's own test, and the exact-coordinate goal returns `NULL` for all 6.
  The adjacent-tile goal returns a non-null path for all 6, ending on a real
  neighbour. The A* obstacle field did not change across the calls
  (`targetWalkableBeforeCalls=false` and `targetWalkableAfterCalls=false` for
  every target).
- **The arrival test is a real bug, not a theoretical one.** The Chebyshev goal
  ends **diagonally** on 4 of the 6 targets, including `7,11` where a cardinal
  neighbour (`7,10`) was already walkable and available - A* simply dequeued
  the diagonal `8,10` first. The Mod's Manhattan-1 `IsCardinalAdjacent`
  (`StardewBodyController.cs:218-223`) would therefore read a finished diagonal
  route as **not arrived**, while the `DistanceSquared <= 0.04f` exact test also
  fails, and the action would end `failed/native_path_ended` on a path that had
  in fact reached the target's vicinity. A Chebyshev-1 (`max(|dx|,|dy|) == 1`)
  test matches every ending this run observed.

The actor did not move: `actorTileBefore == actorTileAfter == "9,9"`,
`actorMoved=false`, `temporaryPassableTilesChanged=false`, and the location had
0 animals. The transaction restored its profile (the runner-added
`PathPredicateProbe` block is gone from the restored config), removed its
backup and lock and the working save, and left no Stardew/SMAPI process.

This is a `native_local_player_fixture` single-player read-only measurement of
one target-version collision field at one actor tile. It is not Farmhand,
Publication, Portfolio, release, or save/reopen evidence, and it does not itself
change the arrival test or the pathing target - it only measures them.
## 27. Move-stall probe: Pet and Horse both block move_to_tile; retry does not help (2026-10-02)

Two live gates (`move_stall_probe_pet` then `move_stall_probe_npc`) measure what
happens when a NATIVE character stands on the middle tile of a three-collinear
walkable line (actor → blocker → target), with the fixture verified by the same
findPath the action uses. Both drive the PUBLISHED move_to_tile action twice:
once as an action would issue it, then (only on a blocker terminal) the
re-observe + re-issue an agent would perform from its failure receipt. The
probe MEASURES; it does not pass or fail the action.

**Pet (native_move_stall_probe_pet_v1):**

- phase1 accepted → controller_started → tile_advanced → deadline_expired (25s),
  finalTile (40,5) = the blocker tile; the Pet was pushed to (41,5) but walked
  back onto the route during the attempt.
- phase2 (re-observe + re-issue) accepted → controller_started →
  native_path_ended (~22s): the Pet was back on (40,5), same A* → same path →
  same collision.
- conclusion: blocker_survived, retryResolved=false, moved=true.

**Horse (native_move_stall_probe_npc_v1):**

- phase1 accepted → controller_started → native_path_ended (5.2s), finalTile
  (40,4) = START tile: the actor never moved at all. A Horse is a Character, not
  an NPC: it overrides no behaviorOnFarmerPushing and no Farmer-push pass-through
  (only rider Halt/mount transitions ever touch farmerPassesThrough, and only to
  false), so pushing does nothing and pass-through never engages.
- phase2 identical: native_path_ended, still on (40,4).
- conclusion: blocker_survived, retryResolved=false, moved=false.

**Reading:** native A* plans with pathfinding:true, which skips the whole
character-collision loop, so the straight line is always planned; execution then
collides. Neither target-version mechanism (Pet push-away, NPC pass-through)
clears the block for these two kinds, and re-issuing the same move does not
either — the same A* is character-blind and produces the same route. Design
5.3's "stall → re-plan" therefore cannot be a simple same-target retry; the
evidence says the re-plan must take the observed blocker into account (different
arrival neighborhood, wait for the character to wander, or a path around it).

Both runs restored profile, removed backup/lock and working save, and left no
Stardew/SMAPI process.

## 28. WIA live proofs: pass_out and modal_interrupted classifications (2026-10-04)

Two native-local live gates (scenario `native_wia_pass_out_v1` /
`native_wia_modal_interrupt_v1`, fixture `GameBuddyFixtureStable_445936768`,
profile `native-local-move`, private bundle staging, test-module host loader)
prove the WIA world-change classifications against the real game
(world-interruption-arbitration.md §4.1 ② / §4.3):

- **pass_out**: the fixture stages a stamina drop below the native floor
  (Game1.cs:6452) a few ticks after a running move; the body loop must surface
  the world fact, not an admission refusal.
  `state=passed reasonCode=pass_out receipt=invalidated/pass_out revision=3`
  evidence `stamina=-20;time_of_day=600;tile=20,19;revision=1`; target `18,16`
  (distant soil tile), accepted revision 1 → invalidated revision 3, actor not
  actionable afterwards, activeExecution released. 355 ms.
- **modal_interrupted**: the fixture opens a real native modal
  (Game1.drawObjectDialogue, the same call the door-gate refusal uses) mid-move;
  the body loop must classify it with the intent breakpoint.
  `state=passed reasonCode=modal_interrupted receipt=invalidated/modal_interrupted
  revision=3` evidence `interrupted_by=DialogueBox;target_tile=18,16;
  interrupted_at=20,19;remaining_distance=3.61;revision=1`; 401 ms.

Both receipts carry the WIA body/intent facts the Agent replans on (vs. the
pre-WIA opaque `menu_opened` / `player_not_actionable` terminals). Both runs
restored profile, removed backup/lock and working save, and left no
Stardew/SMAPI process.

Gate notes (each fixed a real defect on the way): the runner identity must
match `run-stardew-native-local-player-*` (move-fixture.ps1 resolver regex);
the fixture action/scenario allow-lists in `tools/lib/…fixture.mjs` must
contain the harness action; `move_to_tile` args must be exactly `{x,y}` (the
Mod's exact-shape parse rejects extra fields, `navigation_execution_parse_rejected`).

## 29. L3 stall watchdog live evidence: stalled_waiting then native_path_ended (2026-10-04)

Re-run of the Pet move-stall probe (`native_move_stall_probe_pet_v1`, action
`move_stall_probe_pet`, fixture `GameBuddyFixtureStable_445936768`, private
bundle staging, test-module host loader) on the tree that carries the L3 stall
watchdog (e1d0893): the watchdog fires a non-terminal `stalled_waiting`
progress after 120 ticks of zero tile progress, and only fails
`native_path_ended` after the bounded budget — instead of failing the moment
the native controller ends.

- geometry actor(40,4) → blocker Pet(40,5) → target(40,6).
- phase1 trace: accepted(r1) → controller_started(r2) → tile_advanced(r3) →
  **stalled_waiting(r4)** → native_path_ended(r5); 5121 ms; finalTile (40,5);
  Pet pushed to (41,5).
- phase2 trace: accepted(r6) → controller_started(r7) → **stalled_waiting(r8)**
  → native_path_ended(r9); 5035 ms; same finalTile, Pet back on route
  (41,5).
- conclusion blocker_survived, moved=true, blockerStillOnRoute=true, no
  retry resolution; elapsed 12.6 s across both attempts.

**Reading:** the watchdog behaved as designed under a real 5s native-path-cancel
stall — it held the execution alive through `stalled_waiting` (a meaningful,
non-terminal progress the Agent can observe) and then terminated honestly with
`native_path_ended`, never looping or fake-retrying internally. The probe also
confirms the design-5.3 conclusion still holds on this tree: same-target retry
does not help against a walking Pet (pushing moves it one tile, it returns), so
recovery must remain an Agent-level decision with fresh observation.

Profile restored, backup/lock removed, working save cleaned, no residual
Stardew/SMAPI process.

## 30. WIA full modal-handling chain live: interrupt → dismiss → resume (2026-10-04)

New action `dismiss_modal` (experimental, WIA §4.2 modal-handling family) plus the
three-phase chain runner (`wia_modal_dismiss_chain`, scenario
`native_wia_modal_dismiss_chain_v1`, fixture GameBuddyFixtureStable_445936768)
prove the 全链路闭环 the single interruption receipts could not:

- phase interrupt: move_to_tile accepted(r1) → invalidated/modal_interrupted(r3)
  with the intent breakpoint (target 18,16; fixture drawObjectDialogue modal).
- phase dismiss (admission half-loop): with the dialogue still on screen,
  dismiss_modal is admitted by the Modal profile through the exact-shape empty
  args and succeeds immediately (r4, modal_dismissed; bridge response IS the
  terminal — the action is instantaneous), closing the menu.
- phase resume (resumption leg): the same-intent move_to_tile re-issue
  accepted(r5) → succeeded/target_reached(r11); fresh snapshot actionable with
  activeExecution released.

1.17 s total; teardown restored profile, removed backup/lock and working save,
left no Stardew/SMAPI process. dismiss_modal verified against the real game
three times in this session (once blocked at runner parity before the
instantaneous-terminal shape was accepted; the product receipt was
succeeded/modal_dismissed in every run).


## 31. WIA non-movement use-item modal interruption (implemented; live pending)

The native-local `wia_eat_interrupt` runner and fixture are implemented for
`native_wia_eat_interrupt_v1` on `GameBuddyFixtureStable_445936768`; execute the
live gate serially before treating it as evidence. The fixture supplies two
`(O)216` Bread items, starts a real `use_item`, opens `drawObjectDialogue` after
native eating begins, and the runner requires `invalidated/modal_interrupted`
with `native_animation_pending=true`, a fresh released actor, `dismiss_modal`,
and a retry that settles `succeeded/item_used` with the remaining item consumed.
The first native consumption occurs synchronously before the accepted bridge
response (stack 2 -> 1), so this proof does not claim rollback or zero side
 effects on interruption; the retry consumes stack 1 -> 0. Non-movement intent
breakpoint fields such as `target_tile` are not asserted because their shape is
not frozen for item use.

## 32. WIA non-movement slot live: use_item interrupted then dismissed then retried (2026-10-04, PASSED)

live gate `wia_eat_interrupt` on `GameBuddyFixtureStable_445936768`:
- interrupt: `use_item`(slot 5, (O)216) accepted(r1) → `invalidated/modal_interrupted`(r2),
  evidence `native_animation_pending=true` (the non-movement slot's honest shape;
  move-slot intent-breakpoint fields are not fabricated here).
- release: fresh snapshot r2 has `activeExecution=null` (clean release).
- dismiss: `dismiss_modal` → `succeeded/modal_dismissed`(r3).
- retry: `use_item` accepted(r4) → `succeeded/item_used`(r5); evidence stack 1→0,
  stamina 270→270, health 100→100, animation_complete=true.

5.4 s total, teardown restored profile and removed backup/lock and working save.
This closes the Non-Movement Slots evidence: two of the eight WIA slots now have
live receipts (move + activeItemUse).

## 33. WIA answer_dialogue live: real native question modal answered (2026-10-04, PASSED)

live gate `wia_answer_question` on `GameBuddyFixtureStable_445936768`:
- interrupt: `move_to_tile` accepted(r1) → `invalidated/modal_interrupted`(r3); the
  fixture opens a REAL question dialogue (`createQuestionDialogue` →
  `drawObjectQuestionDialogue`, response keys yes/no) a few ticks into the move,
  so the intent breakpoint exists (interrupted_by=DialogueBox,
  target_tile=18,16, interrupted_at=20,19, remaining_distance=3.61).
- answer: `answer_dialogue`{responseKey:yes} → `succeeded/answer_dialogue_answered`(r4)
  with evidence modal_type=DialogueBox;question=true;response_key=yes;
  native_answered=true;outro_started=true;postcondition=dialogue_outro_started.
  The native answerDialogue accepted and beginOutro started; the dialogue closes
  on the next frame, which the fresh snapshot observes (actionable=true,
  activeExecution=null).

0.5 s total, teardown restored profile and removed backup/lock and working save.
Domain 7.4.2 question-answer closes with the Modal admission family: dismiss
(informational) and answer (question) are both live-proven.

## 34. WIA slot live proofs: tool approach, the async animal-product animation, and the pickup window

Three gate scenarios, three runners, 2026-10-05, all on
`GameBuddyFixtureStable_445936768`. Together with the move slot (§30/§33) and the
use-item slot (§32) this closes **five** of the WIA slots with real receipts:
`activeNavigate`, `activeItemUse`, `activeToolApproach`, `activeAnimalProduct`
and `activeItemPickup`.

### 34.1 `native_wia_tool_approach_interrupt_v1` — 802 ms

The tool family's walk leg holds BOTH the approach spec and the body controller,
so its release runs through the manager's `RecordControllerTransition` path.

```
interrupt  chop_tree_source  accepted(r2) -> invalidated/modal_interrupted(r4)
dismiss    dismiss_modal     succeeded/modal_dismissed(r5)
retry      chop_tree_source  accepted(r6) -> succeeded/tree_source_chopped(r8)
```

Interrupt evidence is the slot's honest shape plus the wrapped breakpoint:

```
location=Farm;target=tree_chop_source_db2e14e373c76083;tile=64,17;reach=1;
approach=invalidated;                                  <- derived from the terminal state
body_evidence=interrupted_by=DialogueBox;target_tile=64,17;
              interrupted_at=62,17;remaining_distance=2;revision=2
```

`approach=invalidated` rather than `failed` is the live confirmation of
`2c10b0a`. Retry: health 1 -> 5, stump false -> true, source_transformed=true,
stamina 270 -> 268 (expected 2), source targets 1 -> 0 and result targets 0 -> 1.

### 34.2 `native_wia_animal_product_interrupt_v1` — 2039 ms

The **asynchronous** slot: the MilkPail/Shears animation completes on later ticks.
First live attempt failed with `native_fresh_snapshot_timeout`: the interruption
minted its receipt but the slot stayed owned, so no later snapshot was actionable.
That was a real defect, fixed at the interruption point —
`InvalidateForLifecycle` now releases `activeAnimalProduct`/`activeItemUse`
immediately instead of parking them in `DeferredTerminalState` until an animation
that a modal cut short may never report (WIA: a world change releases the body).

```
interrupt  collect_animal_product  accepted(r1) -> invalidated/modal_interrupted(r2)
dismiss    dismiss_modal           succeeded/modal_dismissed(r3)
retry      collect_animal_product  accepted(r4) -> succeeded/animal_product_collected(r5)
```

Interrupt evidence: `native_animation_pending=true` (the non-movement slot shape).
Retry evidence: `location=Barn373f33aa3…`, `animal=2048459012`,
`tool=shears`, `produce=(O)440`, `produce_cleared=true`,
`inventory 0 -> 1`, `animation_complete=true`,
`stamina 270 -> 266` (expected 4).

### 34.3 `native_wia_item_pickup_interrupt_v1` — 1089 ms

First live attempt failed with `no_fresh_live_item_target` (empty
`itemTargets` at the very first observe). The fixture log showed it had
initialized (`item=(O)388; anchor_tile=20,19; debris_tile=19,17`), and the source
gave the reason: `Debris.playerInRange` (Debris.cs:582-595) compares **each axis**
against the magnetic radius — a rectangle, not a euclidean disc — so a debris at
Chebyshev 2 (dx 64 px, dy 128 px, exactly the default radius) is magnetized away by
`updateChunks` before any approach can happen. The fixture now requires
**Chebyshev >= 3** (both axes genuinely outside the radius) and validates with the
same rectangle formula the game uses.

```
interrupt  pickup_item   accepted(r1) -> invalidated/modal_interrupted(r3)
dismiss    dismiss_modal succeeded/modal_dismissed(r4)
retry      pickup_item   accepted(r5) -> succeeded/item_picked_up(r10)
```

Interrupt evidence (the pickup slot's own shape plus the wrapped breakpoint):
`tile=24,19;native_auto_collect_pending=false;
body_evidence=interrupted_by=DialogueBox;interrupted_at=20,19;remaining_distance=4`.
Retry evidence: `item=(O)388`, `native_auto_collect=true`,
`chunk_removed=true`, `inventory 0 -> 1`, and the target is gone from the fresh
snapshot. No magnet race occurred (`native_auto_collect_pending=false` at
interruption), which is exactly what the placement fix bought.

## 35. ride_bus live proof: the game's own bus interaction, driven end to end

Scenario `native_ride_bus_v1`, runner
`run-stardew-native-local-player-ride-bus-smoke.mjs`, 2026-10-05. First pass,
14094 ms.

This action deliberately does NOT re-implement the bus. The fare, the driver
check, the eight-second control freeze, the walk to the door and the cutscene all
live inside `BusStop.answerDialogue("Bus_Yes")`, so the Mod verifies the native
facts itself (so a refusal carries a named reason) and then drives the **game's
own** ticket interaction: `BusStop.checkAction` raises the question and
`GameLocation.answerDialogue(Response("Yes"))` answers it. The Mod only observes
the arrival the world produces.

```
bus_departure_started (revision 1)   <- admission is instantaneous
Warping to Desert                    <- the native cutscene
bus_arrived          (revision 2)
```

Receipt evidence:

```
origin=BusStop;destination=Desert;fare=500;money_before=5500;money_after=5000
```

Three things the receipt alone could not have proven, all independently checked by
the runner:

1. the native terminal is `bus_arrived` (not a fixture-authored warp);
2. the fare was **actually deducted** — `money_after == money_before - fare`
   (5500 -> 5000 with fare 500);
3. the world really moved the actor — the fresh post-terminal snapshot reports
   `location: Desert`.

The fixture establishes only the declared Given (vault complete, Pam on the native
on-duty tile 21,10 **and in the BusStop character list**, fare affordable, actor
beside the ticket machine at 16,10 which the Buildings-layer index 1057
identifies) and emits no receipt.

Promoted to `live_verified` on this evidence
(`FarmhandActionLifecycle.LiveVerified`, with its gate moved into
`STARDEW_PUBLISHED_ACTION_GATES`).

### Three environment failures this gate had to get past (all diagnosable now)

- **Fixture transaction contention.** Other lanes hold the same single fixture
  transaction; the runner backs off and retries rather than preempting.
- **SMAPI crash data.** A previously killed run leaves crash data, and the next
  launch stops at "Press any key to delete the crash data and continue playing" —
  unsatisfiable headless, so the bridge never becomes ready and the failure looks
  like a pipe timeout. The runner clears it before each attempt.
- **Stale release dir.** The fixture preparer validates a COMPLETE bundle
  (`manifest.json` included), so staging only the DLLs fails with
  `release_bundle_missing`. Both that code and the underlying error are now
  published instead of collapsing into `native_local_fixture_preparation_failed`.
## 36. select_mine_elevator_floor live proof: the mine elevator as a typed action

Scenario `native_mine_elevator_v1`, runner
`run-stardew-native-local-player-mine-elevator-smoke.mjs`, 2026-10-05. First pass,
737 ms.

The Lane L3 card (§3.7) ruled that `enter_mine` keeps its tile semantics and that
the elevator becomes its **own** action if the product wants "any already-unlocked
floor" — letting `enter_mine` take a level would make it an arbitrary-level
teleport that bypasses `lowestLevelReached`. This is that action.

```
accepted                     (revision 0)  <- the warp has started, not finished
succeeded / mine_elevator_floor_selected (revision 1)
```

Receipt evidence:

```
expected=UndergroundMine10:6,6;actual=UndergroundMine10:12,6;level=10
```

Four things proven, independently checked by the runner:

1. **The world moved.** Fresh post-terminal snapshot: `location=UndergroundMine10`,
   `terminalLevel=10`, `originFloor=5`. The landing tile is the native layout's
   choice (12,6, not the requested 6,6) — the same phenomenon already recorded for
   `enter_mine` ("verified live at 10,4 vs the requested 6,6"), which is why the
   postcondition is the LEVEL and not a fixed tile.
2. **Progress gates the offer, and the projection follows.** `floorsBefore=0/5*/10`
   → `floorsAfter=0/5/10*`: the current-floor marker migrated to the arrival floor.
3. **The native facility was really there.** The dispatch receipt reports
   `elevatorTile=10,5` — tile 112 freshly observed in that MineShaft's Buildings
   layer, which is the native elevator (MineShaft.cs:3057/3066).
4. **Floor 0 is not "level 0".** The implementation routes it to
   `Game1.warpFarmer("Mine", 17, 4)` (the mine entrance) rather than
   `Game1.enterMine(0)` → `UndergroundMine0`.

The fixture stages mine progress to floor 10 (`lowestLevelReached`), **fails closed
if `mine_lowestLevelReachedForOrder` is not its untouched `-1`**, and places the
actor on `UndergroundMine5` via the game's own `warpFarmer`. It emits no receipt —
the action under test is the one that selects a floor.

### What this gate caught (both were real defects, in code I had just written)

- **`enterMine` is asynchronous.** The first live attempt read
  `Game1.CurrentMineLevel` in the same frame and got the OLD level
  (`expected_floor=10;actual_floor=5`). Fixed by taking the travel family's shape:
  accept, hand the specification to `activeTravel`, and let
  `CompleteTravelAfterWarp` mint the single terminal on the Warped edge.
- **The runner asserted an implementation detail as a contract.** It required the
  accepted receipt's `ridingMineElevator` to be true. That flag is a real
  implementation requirement (the mine entrance reads it to choose the elevator
  landing tile) but the native layout may consume and reset it during the warp, so
  it is now observed, never asserted.

## 37. Ladder 6 live: a self-directed play session and the capability audit it produces (2026-10-05, PASSED-with-findings → rung `blocked` on the interaction axis)

Ladder 6 answers a different question from ladders 0-5. Those accept a scripted
chain; ladder 6 hands the Agent an **open play goal** in a real save, lets it choose,
and its output is a per-capability audit: what it could do, what the system stopped,
and what it never tried (`capabilityAudit`,
`gamebuddy_stardew_play_session_capability_audit/v1`).

**Recipe (one command; the launcher owns order, fixture transaction and teardown):**

```powershell
node tools/live-run/game/launch-ladder-live.mjs --ladder 6 --action play_session --label c
```

The launcher restores the native template as the disposable working save, prepares the
`play_session` fixture into the REAL game `Mods` directory ladder runs attach to,
launches game + runner through the ladder orchestrator, then restores the transaction.
It refuses to start on a busy fixture root (waits; renames an ORPHANED transaction
aside rather than deleting it) and gives each run its own result/log pair.

**Fixture (`native_play_session_v1`).** A farm offering several independent
affordances and nothing else — no quest, no order, no expected chain — so the audit
has something to measure. Target-version log line:

```text
initialized play-session fixture before bridge attachment:
weed=2,9; weed=2,10; grass=3,9; stone=3,8; ready_crop=3,12;
tools=hoe+can+scythe; seeds=2; standing=3,9;
```

Production performs every action; the fixture places objects and gets out of the way.

**The run.** One player turn, 446 s, `steerObserved=true`; fixture recorded in the
artifact as `configuredFixtureScenario=native_play_session_v1`.

| action | dispatches | terminals | refusals | verdict |
|---|---|---|---|---|
| `move_to_tile` | 16 | 0 | `no_native_path` ×10 | **blocked** |
| `harvest_crop` | 5 | 2 × `crop_harvested` | `target_out_of_range` ×3 | succeeded |
| `cut_weeds` | 2 | 2 × `weeds_cut` | — | succeeded |
| `equip_tool` | 2 | 2 × `tool_equipped` | — | succeeded |
| `break_rock_source` | 1 | `rock_source_broken` | — | succeeded |
| `cut_grass` | 1 | `grass_cut` | — | succeeded |
| `plant_seed` | 1 | `seed_planted` | — | succeeded |
| `express_emote` | 1 | terminal | — | succeeded |

`advertisedCount=67`, `advertisedSampleCount=2`, `advertisedAxisUsable=true`,
`notAttempted=59 of 67` — the companion used 8 of the 67 capabilities it could see.
Its own closing report names the stall in player terms: crops and weeds "围成了迷宫",
so it never reached the house, chests or machines — which is exactly what the audit
independently shows.

**Outcome: rung `blocked`, on the companion-quality axis only.**
`interactionAssessment={passed:false, reasons:["summary_too_long"], length:176}`. Every
action that reached a native terminal is real (inventory/stamina/durability/warp
postconditions), so this is not a capability failure — it is the companion
over-reporting after doing the work, which is what the goal's wording forbids. Ladder 6
is included in the interaction gate precisely so that axis is not off (it was, until
this run).

**Two harness defects the runs caught (both now fixed and guarded).**
1. The turn machinery was extracted into a module-level function that referenced `tools`
   from a **block-scoped** declaration: the first real run failed with
   `ReferenceError: tools is not defined` at the admission callback. Fixed by passing
   the handle explicitly. It is a harness defect the rung reported as `blocked`
   (+`steerObserved=false`, `bridgeFacts=0`) instead of a hollow pass.
2. `fixtureScenario("play_session", …)` resolved to the **strawberry-covenant**
   fixture, so an earlier run armed the wrong world and proved nothing about the
   fixture it was supposed to exercise: the play-session action set publishes
   `harvest_crop` + `ship_item`, which is exactly the covenant's fallback trigger, and
   the action-keyed override sat *after* that fallback. Fixed by moving the key into
   the action-keyed branch group, and guarded by
   `tools/stardew-fixture-scenario-resolution.test.mjs`, which asserts that every
   action-keyed branch is reachable through its own action set (mutation-verified: with
   the ordering restored to the broken shape, the guard fails and names
   `play_session → native_strawberry_covenant_v1`).

**What this run cannot prove.** One run, one world, one model: no baseline and no
repeat. `notAttempted` names 59 capabilities the session never touched, and 8 of them
(`shop`-like, `machine_*`, `chest_*`, `travel`, `observe_scene`…) stay unproven as
*playable* by this evidence. The interaction verdict is a length threshold, not a
judgement of the report's content. Model non-determinism is uncontrolled; a second run
will differ in both coverage and wording.

## 38. move_to_tile was refusing work it had already done (2026-10-05, fixed + verified live)

The §36 play session reported ten `no_native_path` refusals and the companion told the
player the farm was "围成了迷宫". Reading the trace against the Mod's own evidence, both
halves of that were the Mod's fault:

1. **FALSE REFUSAL.** Six of the ten requests named a tile the actor was *already inside
   the arrival contract of* (the requested tile, or — when adjacency is allowed — one of
   its neighbours). The native planner then has nothing to plan, its `pathToEndPoint`
   comes back empty, and an empty path was reported as "unreachable". The Mod's own
   probe contradicted that verdict in the same evidence string: `target_enclosed=false`
   means the probe found a traversable neighbour — the one the actor was standing on.
2. **UNAPPROACHABLE TARGET.** The rest named a tile that holds the object the caller
   wants to touch (a crop). Every other interaction in this Mod is a native action from
   an adjacent tile, so "walk to the object" was asking for something the action could
   not express.

Fixes (`farmhandexecutioncontroller.movementactions.cs`, `StardewBodyController.cs`):

- A satisfied arrival contract is now **success**: `target_reached;already_at_target=true`
  (checked on the effective destination, after any substitution). Nothing native moves,
  because nothing needs to.
- An unstandable named tile is **approached from a standable cardinal neighbour**
  (deterministic: nearest to the actor, ties keeping the declared left/right/up/down
  order), and the receipt says so: `target=<approach>;requested=<asked>;adjacent_arrival=true`.
  The substitution is never silent.
- Refusals now name **why**: `target_standable`, `blocked_by=<qualifiedItemId>@x,y` or
  `terrain:<Type>@x,y` (or `none`), plus an explicit `probe_says_reachable` so the
  probe/verdict disagreement is visible instead of derivable.

Three consecutive real sessions, same ladder-6 play-session goal and fixture world:

| | run C (before) | run D | run E (final) |
|---|---|---|---|
| `move_to_tile` dispatches | 16 | 12 | 17 |
| `no_native_path` refusals | **10** | 1 | **2** |
| immediate `target_reached` | 0 (impossible) | — | **7** |
| `adjacent_arrival` substitutions | 0 (feature absent) | 24 receipts | 2 |
| `move_to_tile` verdict | **blocked** (0 terminals) | blocked | **succeeded** |
| `blockedBySystem` | `[move_to_tile]` | `[move_to_tile]` | **`[]`** |
| crops harvested | 2 | 3 | **16** |
| rung state | blocked (interaction) | blocked | **passed** |

The two refusals that remain are **genuine** and now self-explanatory:
`from=6,8;to=8,10;target_standable=false;blocked_by=terrain:…` and
`from=10,11;to=11,13;…;blocked_by=terrain:…` — real terrain blockers, named, instead of an
unexplained "no path". The companion's report stopped describing a maze and started naming
what blocks it and what to clear first.

Arithmetic covered by `MoveApproachSubstitutionTests` (8 cases; two mutations — tie-break
weakened to `<=`, distance preference removed — each fail exactly the intended test).

**Residual found while reading run E's own artifact:** the rung reported `passed` on a
session whose turn **timed out** (`agent_turn_timeout` at 609 s ≈ the 600 s default wait).
The Agent worked productively the whole time (39 dispatches, 16 crops) but never produced
a closing report, and `presentedSummary` was the single 10-character line
`我先看看周围有什么。` — which the interaction gate passes. A play session that never
settles must not be reported as a completed session; see §39.

## 39. A session the harness cut off is not a completed session (2026-10-05)

Run E (§38) reported `state: passed` while `sessionTurns[0].turn.error` was
`agent_turn_timeout`: the turn had been cut off at the harness's 600 s wait, the
companion had done 39 productive actions, and the only text it ever delivered was the
10-character fragment `我先看看周围有什么。` — which the interaction gate passes, because
that gate measures how a line is written, not whether a session finished. The verdict
was true about the ACTIONS and false about the SESSION.

Two changes:

- **The verdict now requires a settled session.** `ladderSixPassed` needs a real attempt
  AND `sessionVerdict === "completed"`; the artifact publishes
  `sessionVerdict` (`completed` | `turn_timeout` | `turn_unsettled` | `no_turns`) and
  `sessionTurnErrors`, so a reader can always tell "the play session finished" from "the
  harness stopped waiting". Findings still never fail the rung — a truncated session does.
- **Ladder 6 gets a play-session budget.** The 600 s default is a scripted rung's bound;
  an open session doing dozens of native actions legitimately runs longer, so ladder 6
  defaults to 1800 s (still overridable with `GAMEBUDDY_AGENT_WAIT_SECONDS`). This is a
  harness bound, not a product verdict: a timeout is a gate/harness fact, never a claim
  about the companion.

- **The length budget the gate enforces is now stated in the goal.** Run F's session settled
  properly (`sessionVerdict: completed`, 9/9 attempted capabilities succeeded,
  `blockedBySystem: []`) and its closing report was a genuine play report — 202 characters
  naming what it did, where it got stuck ("田心那片：石头、杂草、枯枝和树把格子堵得太密"),
  and what it would do next. It was rejected by `summary_too_long`, because
  `tools/lib/companion-interaction-gate.mjs` caps a summary at **120 code points** and the
  goal had never said so. Runs C (176) and F (202) were both rejected by an unstated rule,
  so ladder 6's goal now states the budget directly (a speaking-length contract, not a tool
  sequence — the rung's "no smuggled tool sequence" test still holds). The gate itself is
  untouched: it protects other rungs' verdicts too, and loosening a shared threshold to make
  one rung pass would be exactly the kind of silent relaxation this file's contract forbids.

### 38.1 The verdict still passed a session that accomplished nothing (run H, fixed)

Run H (14 dispatches, **14 refusals**, one successful walk, nothing harvested) reported
`state: passed`. The verdict required "a real attempt and a settled session" — true, and
still the wrong thing to call a played session. Run H's own closing line is the honest
report of a failed session: "刚迈步下地，动作就卡住了…一棵花椰菜都没收到".

The verdict now also requires at least one action that **changed the world**:
`accomplishedActionIds` = terminals outside a declared non-accomplishment set
(`move_to_tile`, `travel`, `enter_exit`, `navigate_to_destination`, `observe_scene`,
`inspect_world_map`, `express_emote`, `face_direction`, `equip_tool`), and a session
without one is `sessionVerdict: nothing_accomplished` → `blocked`. The set is published
in the artifact next to the ids it filters, so the rule is readable rather than implied.

Replayed over every stored run, the criterion separates exactly the intended cases:

| run | accomplishments | sessionVerdict | state |
|---|---|---|---|
| C (before the move fix) | 5 families | completed | blocked (interaction length) |
| D | 4 | completed | blocked |
| E | 2 | **turn_timeout** (609 s cut-off) | blocked |
| F | 6 | completed | blocked (interaction length) |
| G | 4 | completed | passed |
| H | **0** | **nothing_accomplished** | **blocked** |
| L (all fixes) | 3 | completed | blocked (interaction length) |

**Run L is the run that closed this line**, and it also found the blocker that had been
masquerading as a companion failure: `I`, `J` and `K` produced **zero** attempts because the
Host's logical-action recovery journal had filled its 256-record cap with settled history
and, having no eviction, refused every later action creation
(`recovery_journal_budget_exceeded` — the companion reported it as "动作没建起来"). Fixed in
`e4dbb8a`; run L, on the same world and goal, reached **6/6 capabilities with a terminal**
(`blockedBySystem: []`), harvested 6 cauliflowers, cut 2 weed clusters, broke 2 rocks, and
said so in a report that names the real obstacle:

> 收了 6 株花椰菜，割掉 2 丛杂草，敲了 2 块石头。麻烦在地中间那片：石头和杂草把路围死，
> 人挤不进去，里面的花椰菜够不着；让伙伴替我先跑一趟，也卡在寻路上，白磨掉不少时间
> （现在都快傍晚了）。要我把外围一圈清干净，再往中间推吗？

Its remaining 4 `no_native_path` refusals now read as the distinction this section built:
`to=3,12;target_standable=false;target_walkable=true;blocked_by=terrain:HoeDirt@3,12` (a cropped
tile, walkable, and still unrouted) and `to=5,8;target_standable=true;target_walkable=true;blocked_by=none`
— **a completely free tile the native path finder still could not route to** from the pocket
the actor stands in. That is a path/search fact, not a tile fact, and it is the next thing to
investigate (the native controller's A* node limit on a densely walled field), not a refusal
to invent a workaround for.

The rung's own verdict stayed `blocked` for one reason only: the closing report was 132
characters against the interaction gate's 120. The goal now states that budget, and the model
overshot it by 12 — which is the gate doing its job on a real quality axis, not a harness bug.

Run H also exposed the last refusals' character: with the planner-walkability predicate in
place, its two `no_native_path` receipts read
`target_standable=false;target_walkable=true;probe_says_reachable=true` — the *tile* is
walkable and the flood probe reached a neighbour, but the native path finder found no
route from where the actor stood. That is a **path** fact, not a tile fact, and it is now
visible in the evidence instead of being collapsed into "unreachable".

### 38.2 The native finder's budget, and one productive step instead of a refusal (run M)

Run L left four `no_native_path` refusals whose evidence read
`target_standable=true;target_walkable=true;blocked_by=none` — a **free, walkable tile the native
path finder could not route to** from the pocket the actor stood in. Reading the decompiled finder
settles what that means:

```csharp
// PathFindController.cs:74  (the game's own constructor for a player's click)
: this(c, location, isAtEndPoint, finalFacingDirection, null, 10000, endPoint)
// PathFindController.cs:232
num++;
if (num >= limit) { return null; }
```

`limit` is a **node-expansion budget**, and `null` is what the Mod saw. The Mod had been passing the
game's own `10000`.

**Corrected by measurement (2026-10-07).** The paragraph that used to follow this — "a dense plot exhausts the
budget while the walkable component still contains the target" — was not measured, and it was wrong. Running
the path-probe against the real fixture (`actor 3,9 -> target 4,8`) returned **no path at 10000, 40000 AND
400000** expansions: the limit was never the variable. Two constructs produced that story:

- the flood enumerated **eight neighbours**, but `PathFindController.Directions` is cardinal only
  (`PathFindController.cs:45-51`), so it called a tile reachable that a cardinal stepper must walk around a
  corner to reach — and on a cropped field the corner is exactly what is blocked;
- `ComponentContainsTarget` was seeded from `canTraverse(targetTile)` ("is this tile passable"), a single-tile
  test reported as if a route had been verified.

The corrected verdict for that pair, measured live: `targetEnclosed=true`, `componentContainsTarget=false`,
`path_search=no_cardinal_route`. The adjacent-goal search resolves in **one** node (the actor's own tile),
which is why the interaction could proceed while an exact move to that tile could not.

The refusal still separates two facts, now both measured:

- **no cardinal route**: the planner's own (cardinal) component never reaches the target's neighbourhood
  (`route_exists_cardinal=false`, `path_search=no_cardinal_route`), or
- **planner anomaly**: it does reach it and the finder still returned null
  (`path_search=planner_null_with_cardinal_route`) — the only case in which a limit explanation is even
  possible.

Three changes (`StardewBodyController`, `ExecutionModels`):

1. **The budget is raised** for Mod-initiated moves: `NativePathNodeBudget = 40000`, with the source
   anchors above in the comment. One bounded search on the game thread; the receipt names the budget
   so a future failure of this kind is attributable.
2. **The facts are separated** in the refusal: `route_exists_cardinal`, `component_tiles`, `path_search`,
   `budget`, alongside the existing `target_standable` / `target_walkable` / `blocked_by`. The
   probe's staging answer (`ComponentContainsTarget`, `ClosestToTarget`, `ComponentTiles`) is
   computed only on the already-failing path, and an unbounded component still yields **no claim**
   (the handler falls back to its bounded fast-path probe).
3. **A reachable far goal gets a staged approach instead of a refusal**: when the probe says the
   target is reachable, the Mod plans one step towards it — the actor's own traversable neighbour
   that most reduces the distance, so the step is always adjacent and always routable — and every
   receipt that names the goal also names the request
   (`staged_approach=true;requested=<asked>`). `target_reached` can therefore never be misread as
   the requested tile having been reached.

Measured on the same fixture world and open goal:

| | run L | run M |
|---|---|---|
| `no_native_path` refusals | **4** | **0** |
| `move_to_tile` terminals | 4 of 13 dispatches | 1 of 2 |
| capabilities with a terminal | 6/6 | 5/6 (`harvest_crop` blocked) |

Run M's remaining refusals are a different, smaller matter: `harvest_crop` ×3 `stale_snapshot` and
×1 `target_out_of_range`. `stale_snapshot` is the bridge's revision CAS (`BridgeSession.cs:1318`),
refused **before** any execution, so nothing was half-done; the Host synchronizes its cached revision
from each receipt (`local-stardew-bridge.ts:745`), so a bump that no receipt carries can still leave
it one behind and cost a wasted round trip. That is the next thing to chase.

Run M also exposed a hole in this rung's own verdict, now closed: it reported `passed` after
**fifteen minutes and 17 native actions with no player-facing line at all** (`presentedSummary: null`).
A play session that never speaks is not a companion session, so silence is its own verdict
(`sessionVerdict: "silent"` → `blocked`), and `spokeToPlayer` is published for every ladder.

### 38.3 A session that finally left an artifact (run Q, same goal and world)

Runs N, O and P each played a real session and wrote **no result artifact**: the failure path itself was
broken (a try-scoped binding read from the catch, the root error logged only after assembling the
partial result, and `sessionSpoken` read through a temporal dead zone), so nothing escaped to analyse.
Fixed in `bdd2e5e`/`57d0307`, with a process-level guard so that whatever escapes the run's own
try/catch still writes `{state: blocked, reason: runner_failed_before_reporting, error: …}`. Verified
deterministically in ~2 s without a game: an unreachable runtime root now produces that artifact where
three sessions previously produced nothing.

Run Q is the first session since to leave a full artifact, and it closes this section's changes:

| observation | run O (before) | run Q (after) |
|---|---|---|
| artifact written | **no** | **yes** (`state: passed`, `sessionVerdict: completed`) |
| fixture scenario | (unknown) | `native_play_session_v1` |
| `target_out_of_range` | **9** | **0** |
| `approach=adjacent` (the walk-in leg) | 0 (feature absent for harvest) | **9** |
| `stale_snapshot` / `bridge_response_timeout` / `no_native_path` | 0 / 0 / 0 | 0 / 0 / 0 |
| `harvest_crop` | 9 refusals, 3 terminals | 2 accepted walks, 1 honest `target_out_of_reach` |

Two honest readings from the same artifact: the session was **short** (63 s, 9 actions, one line
"我到处转转看。") compared with run O's 36 dispatches over 480 s, so model behaviour varies far more than
the harness does — a single run can measure a fix (as above) but cannot carry a product claim. And two
`harvest_crop` approaches were still in flight when the turn ended (`disp=3, term=0`), which is the
"session ended mid-walk" state rather than a refusal.
## 37. shop_purchase live proof: buying from a shop the actor stands next to

Scenario `native_shop_purchase_v1`, runner
`run-stardew-native-local-player-shop-purchase-smoke.mjs`, 2026-10-06.

```
{"state":"passed","reasonCode":"item_purchased",
 "shopId":"SeedShop","owner":"Pierre","item":"(O)472","quantity":1,
 "purchased":1,"unitPrice":20,
 "moneyBefore":500,"moneyAfter":480,
 "ownedBefore":0,"ownedAfter":1,"gained":1,
 "ownerTile":"1,6","menuClosed":true}
```

Scope (owner decision): the action BUYS and nothing else. It does not walk. The fixture
establishes only the declared Given — the clock inside trading hours, Pierre present in the
SeedShop one step from the actor — and emits no receipt. Shop identity, owner eligibility,
stock and price are all read from the game at admission, and the transaction runs through
the game's own `ShopMenu`, including the purchase itself (`tryToPurchaseItem` is private and
is never re-implemented).

The runner independently proves the three things a receipt cannot: the terminal is the
native `item_purchased`; the purse really paid (`500 - 480 == 1 * 20`); and the goods
really arrived (`ownedAfter - ownedBefore == 1`). It also requires the menu to be closed, so
the body is free for the next action.

### Repeat run

The gate was re-run after the promotion to confirm the pass is not a one-off. Both runs:

```
attempt 1  15:04:17  PASS   (attempt 1 of 1)
```

```json
{"state":"passed","reasonCode":"item_purchased","shopId":"SeedShop","owner":"Pierre",
 "item":"(O)472","purchased":1,"unitPrice":20,
 "moneyBefore":500,"moneyAfter":480,"ownedBefore":0,"ownedAfter":1,"gained":1,
 "ownerTile":"1,6","menuClosed":true,"durationMs":397}
```

Identical to the first pass in every field. Note on evidence retention: the harness
OVERWRITES `live-shop_purchase.out.txt` per run, so the earlier verdict is only recoverable
from `live.log`; the run summary quoted above is the second one.

### What this gate caught

**Nine rounds, and the failure point moved one layer deeper every time.** Only the last
three were in the game's own semantics; the first six were contract and tooling defects that
made the real cause invisible:

1. **The bridge's diagnostic could displace the real fault with its SUCCESS marker.** A
   rejected snapshot surfaced as `bridge_disconnected:accepted`, because
   `diagnoseBridgeMessage` returns the literal `"accepted"` when it has no rule for a field
   and the caller used `diagnosis ?? fault`. Three rounds went into a wrong hypothesis (a
   third-party pipe takeover, disproved by 574 samples showing the pipe instance count never
   exceeding one). Fixed structurally, and `diagnoseSnapshot` now names the ten snapshot
   families it had been silently skipping.
2. **A nullable snapshot field the serializer omits.** `BridgeShopTarget.ClosedMessage` was
   the only nullable member and `WhenWritingNull` dropped the key, so an OPEN shop failed the
   Host's exact-key check. Removed: a refusal detail is not a snapshot fact.
3. **Discovery did not say what a shop sells.** The first request the Mod actually accepted
   was refused with `item_not_sold_here`, because a caller could learn a shop exists but not
   what it offers. Real capability gap — any agent hits it. Shop targets now publish
   `StockItemIds`, a never-null list.
4. **The offer was matched by object reference.** `forSale.IndexOf(offer)` compares
   instances, but `GetShopStock` builds its own, so it could only ever miss.
5. **The button index is not the sale index.** The game resolves a clicked button k as
   `forSale[currentItemIndex + k]` (ShopMenu.cs:1096-1102), so returning the raw sale index
   desynchronises the coordinate and the item as soon as the view scrolls.
6. **`staged artifact` ≠ `build succeeded`.** An incremental build reported success while
   the staged Core.dll still lacked the new field. The live script now reads the staged bytes
   and refuses to run on a stale bundle. (The first version of that probe searched UTF-8 in a
   .NET assembly and gave a FALSE NEGATIVE, because .NET stores literals as UTF-16; it now
   checks both encodings and probes a literal unique to this action.)
7. **The runner threw before recording the evidence**, so the receipt's own facts never
   reached the report — the per-click diagnostics existed for two rounds before they were
   visible.
8. **The native purchase is two-phase.** `tryToPurchaseItem` leaves the goods ON THE CURSOR
   (`heldItem = item.GetSalableInstance()`, ShopMenu.cs:1352) and only clears it for items
   with `actionWhenPurchased`. A real player then clicks an empty inventory slot.
9. **`ClickableComponent.item` is ALWAYS null.** InventoryMenu builds its slots as
   `new ClickableComponent(bounds, j.ToString())` (InventoryMenu.cs:103) — the string
   overload — and never assigns `.item`. Selecting on `slot.item is null` therefore picked
   **slot 0 every time**; when slot 0 held a tool, `InventoryMenu.leftClick` refused
   (`actualInventory[num] != null && !canStackWith`, InventoryMenu.cs:318) and returned the
   held item unchanged. The receipt said it plainly:
   `drops=1[drop0:empty_slot=0;at=412,544;held=(O)472->(O)472]`. The fix reads
   `menu.inventory.actualInventory` — the real item list — instead of the component.

Items 1, 2, 6 and 7 are not defects in this action at all: they are defects in the harness
that made this action's defects unobservable. The two that cost the most were the diagnostic
alias (three rounds) and the always-null field (two rounds), and both were found by making
the artefact report **what it actually did** rather than by reasoning about what it should do.

### Deliberate deviations, stated

- `menu.safetyTimer = 0` is cleared before clicking. **Kept by owner ruling (2026-10-06).**
  `ShopMenu.receiveLeftClick` only reaches its purchase branch when `safetyTimer <= 0`
  (ShopMenu.cs:1022); the field starts at 250 (:264) and is decremented every frame (:1751).
  It is ConcernedApe's debounce against a human double-clicking the mouse, not world state,
  so a scripted same-frame or rapid repeat call clears it rather than waiting out a
  hand-speed constraint. The rounds that followed this change did NOT observe it firing, but
  that is not evidence it is unnecessary: by the time those clicks were dispatched the menu
  had already been open for many ticks and the counter had naturally reached zero. Leaving
  it armed can silently swallow the click inside the first 250 ms and surface as a sporadic
  `purchase_not_effective` — the failure mode this whole gate was chasing. Keeping it is the
  deterministic fix; removing it trades a known mechanism for an intermittent one.
- The runner prefers a non-seasonal shop with stock. Discovery advertises every shop whose
  owner entry is currently eligible, and a live run picked `DesertFestival_Pierre` — a
  festival stall — because the content data lists it first. Demonstrating "buy something"
  must not depend on that ordering.

## `enter_exit` — the door-gate widening, and what it actually closes

```text
fixture  native_enter_exit_warp_action_v1   (Farm, tile 78,19 carries Action "WarpCommunityCenter")
runner   tools/run-stardew-native-local-player-enter-exit-warp-action-smoke.mjs
result   passed · reasonCode=door_gate_refused · 383 ms · teardown restored + cleaned
```

The receipt, verbatim in the parts that matter:

```text
doorTableHoldsTarget : false
standing             : 78,18      target: 78,19
receipt              : rejected / door_gate_refused · revision 2
evidence             : source=78,19;gate=refused;entry=perform_action;dialogue=锁上了。
before               : Farm (78,18)  actionable=true
after                : Farm (78,18)  actionable=true
```

### What the widening is, precisely

`DispatchNativeDoor` no longer asks `location.doors.ContainsKey(tile)`; it reads the **live**
Buildings layer and admits a tile whose Action contains `Warp` — the predicate `updateDoors`
itself applies (`GameLocation.cs:17601`). Those two are not the same set, and an earlier reading of
this change overstated the difference:

* `updateDoors` (:17586-17641) returns early when `Game1.IsClient`, then clears and rebuilds
  `doors` — a network-synced `NetPointDictionary` (:273). `WarpBoatTunnel`, `WarpCommunityCenter`
  and `Warp_Sunroom_Door` are added **unconditionally** through explicit `case … doors.Add(…);
  continue;` arms (:17609-17617); the other warp actions, and anything merely *containing* "Warp",
  must reach the token-3 read (:17631-17638). So on a normally-loaded map the old predicate already
  admitted those three, and the old code **did** run their gate.
* The disagreement is **staleness**: a Warp Action present in the live layer but absent from the
  cache — written after the last `updateDoors`. In that case the old code fell through to
  `ResolveDoorWarp` (`farmhandexecutioncontroller.cs:1918-1932`), and `getWarpFromDoor` resolves
  `WarpCommunityCenter` **explicitly** (`GameLocation.cs:2211-2212`) — so it warped, skipping the
  `ccDoorUnlock` check `performAction`'s own case performs. That is the bypass, and it is narrower
  than "the gate never ran for warp tiles".

The fixture reproduces exactly that disagreement — it writes the Action **after** the location loaded,
so `doors` lacks the tile while the live layer has it — and asserts both halves before attachment:
the tile is not a key of `farm.doors` (`doorTableHoldsTarget=false` above), **and**
`farm.getWarpFromDoor(T)` returns a non-null warp targeting `CommunityCenter` — the fact proving the
old fallback would have warped. Without the second assertion the run would not distinguish "the gate
refused" from "nothing was there".

The negative that carries the weight is `after: Farm (78,18)`. A bypass end state is a warp to the
Community Center; the actor never left the Farm, and `actionable` stayed true because the refusal
draws a dialogue that something must clean.

`WarpGreenhouse` is *not* a weaker version of this case — it is untestable. It falls to the
`default:` arm, which needs tokens 1..3, so a single-token action resolves to null; `enter_exit`
then refuses before dispatch (`RequestLocalDoorTransition`, :299-303) and pre- and post-widening
both answer `door_not_available`, with no observable difference.

### The runner lesson, third time

Two live attempts failed on **the runner**, not the product, for the same reason: a request whose
native work resolves synchronously answers with an **immediate terminal** instead of `accepted`.
`move_to_tile` to the tile the actor already stands on returned `succeeded/target_reached` at
once, and `enter_exit` on this tile returned `rejected/door_gate_refused` at once. Both phases
demanded `accepted` and threw on a correct run — the same mistake `dismiss_modal` and `ride_bus`
each produced once. A phase must accept either shape, and only then assert the terminal.

## `enter_mine` — descending a mine LADDER (the second gate for an already-verified action)

```text
fixture  native_mine_enter_ladder_v1   (actor inside UndergroundMine1, a generated ladder in range)
runner   tools/run-stardew-native-local-player-enter-mine-ladder-smoke.mjs
result   passed · reasonCode=mine_entered · 23 s · teardown restored + cleaned
```

The published `enter_mine` gate covers the `Mine` ENTRANCE map. The ladder INSIDE a shaft is a
different tile and a different level computation, so it carries its own gate:

```text
receipt   : succeeded / mine_entered · revision 3
ladder    : mine_entrance_57d092e8be319837 at 10,5     standing: 10,4
before    : UndergroundMine1   level 1
after     : UndergroundMine2   level 2      <- read from a FRESH snapshot, not inferred
evidence  : expected=UndergroundMine2:6,6;actual=UndergroundMine2:4,5;level=2
```

`actual=4,5` rather than the nominal `6,6` is the game choosing the landing tile, the same honest
shape the entrance gate already records. The descent level is derived from the LIVE shaft
(`shaft.mineLevel + 1`), never supplied by the client, and the runner's expectation is derived from
its own observation so it cannot be hard-coded to a level.

### How the fixture establishes its Given, and why that way

It does NOT trust a found ladder. A freshly generated level carries no tile 173 at all
(`doCreateLadderDown` runs only when a stone is broken or a monster is cleared), and the production
finder returns the first 173 in row-major order — so a found-but-not-mine ladder could not be
attributed. Instead the fixture:

1. resolves the shaft through `MineShaft.GetMine(GetLevelName(1))`, the same lookup `Game1.enterMine`
   uses, and reads the arrival tile from the game's own `shaft.mineEntrancePosition(player)`;
2. picks the first of that tile's eight neighbours the game's own `isTileClearForMineObjects` accepts,
   so the choice is the game's definition of clear mine floor, not the Mod's;
3. places the ladder through the game's own generator, `shaft.createLadderDown(x, y)`, then asserts the
   product's `ExecutionManager.TryFindMineLadderTile` returns exactly that tile — a finder that
   disagreed would fail loudly rather than produce a green run about the wrong tile.

Level 1 is deliberate: `MineShaft.adjustLevelChances` zeroes `monsterChance` when `mineLevel == 1`,
so the Given does not depend on surviving monsters. The descent lands in level 2, which does have
them; the postcondition is read within 10 s of the terminal, the same pattern as the live-verified
elevator gate.

### Runner lesson, applied

Both phases accept an IMMEDIATE terminal as well as `accepted`-then-terminal. That rule cost three
other gates a failed attempt each (see the `enter_exit` section above), so this runner was written
with it from the start and its offline tests pin both shapes.

## `talk_to_npc` — walk up to a villager and talk

```text
fixture  native_talk_to_npc_v1   (actor in the Saloon, empty-handed, one tile from Gus)
runner   tools/run-stardew-native-local-player-talk-to-npc-smoke.mjs
result   passed · reasonCode=talk_to_npc_talked · teardown restored + cleaned
```

The action exists because `NPC.checkAction` (NPC.cs:2464) does two things and only one of them was
covered: the GIFTING branch needs an ActiveObject and is what `interact_npc_with_item` mirrors, whose
`slot` and `expectedQualifiedItemId` are REQUIRED arguments. Talking empty-handed had no action, which
is the default thing a player does to a villager. The two intents are orthogonal, so talking is its
own action rather than an optional argument — the protocol has no optional arguments at all.

```text
receipt   : succeeded / talk_to_npc_talked · revision 2
evidence  : location=Saloon;target=npc_relationship_4478..;npc=Gus;tile=0,15;native_handled=true;
            dialogue_up_before=false;dialogue_up_after=true;dialogue_box_after=true;
            menu_open_after=DialogueBox;talked_to_today_before=false;talked_to_today_after=true;
            points_before=0;points_after=20;player_can_move_after=false
negative 1: unknown target  -> rejected / talk_to_npc_target_not_found, actor still actionable
negative 2: repeat while the dialogue is open -> rejected / player_not_actionable
```

Two things are stated rather than hidden. The seam returns a bool, so `native_handled` alone would
prove nothing: the postcondition is the dialogue coming UP (`dialogue_up_after`, `dialogue_box_after`),
with the friendship pair as corroboration. And the actor is deliberately left NOT movable with a
DialogueBox mounted — that is the native end state of talking, reported as
`player_can_move_after=false` and `menu_open_after=DialogueBox`, not smoothed into an idle actor.

### Three runner defects the live gate found, all in the runner rather than the product

1. **The wire field is `npcName`, not `name`.** The record is
   `BridgeNpcRelationshipTarget(string TargetId, int X, int Y, string NpcName, ...)`, so the runner
   read `entry.name` as `undefined` and silently filtered EVERY villager out, reporting
   `no_adjacent_villager` while a target sat on the adjacent tile. Both sibling runners already read
   `target.npcName`. The offline fake carried the same wrong key, so nine green tests proved nothing —
   the same "the fake encodes my assumption" failure this project has now hit three times.
2. **`activeExecution` must be compared LOOSELY.** The Mod serializes with `WhenWritingNull`, so
   "no active execution" arrives as an ABSENT property (`undefined`), and the guard written as
   `after.activeExecution !== null` is TRUE for `undefined` — it failed a correct run. Every
   pre-existing runner uses `!= null` / `== null` for exactly this reason.
3. The failure messages now carry the observed facts. `no_adjacent_villager` alone was not
   actionable; made to print the tile, location, actionable flag and every candidate, it immediately
   showed `targets=?@0,15` — an unnamed target on the right tile, which is what located defect 1.

### Fixture choice, and why it cannot drift with the clock

The Saloon with Gus, reached by a direct native warp. Gus is placed at his own workplace, and the
fixture asserts the placement is durable (`characters.Contains`, the tile matches, and the schedule is
pinned with `followSchedule=false` / `ignoreScheduleToday=true`). The decisive extra fact is that the
declared Given alone is not sufficient: NPC.cs:2748 also needs
`flag4 || endOfRouteMessage || location override`, and the plain location-keyed dialogue is what
supplies it — so the fixture asks the game's own `TryGetDialogue` for the `Saloon` key and refuses to
run without it. That key has no day, season or heart suffix and the `noPreface` retry drops the season
preface, so no weekday, season, story flag, mail, festival or schedule can select or lose the branch.
`talkedToToday` is set explicitly to false, which is what makes the receipt's own pair deterministic
(`talked_to_today false->true`, `points 0->20`) instead of depending on the save's clock.

### Multiplayer classification

`mp-semantic`, and the checker is why: an initial `mp-insensitive` claim copied from the sibling entry
was REFUSED — `mp_sensitivity_classification_drift`, because NPC.cs reads `Game1.multiplayer`,
`IsLocalPlayer` and `IsMultiplayer` in the same body. The semantic effect now recorded is that the
branch is gated on the local player and `movementPause` is 1000 ms in a shared world against 10 ms
solo: neither changes which dialogue is chosen nor whether friendship is granted. The register carries
this as an acknowledged unverified shared-world scope, so promotion beyond Experimental should come
with shared-world evidence or an explicit ruling.

## Phase 2 — nine new actions, all live-verified (2026-10-08)

One shared native-local fixture per family, one runner per action. Each row below is a real gate run whose
receipt the runner asserted; nothing here is a mechanism-level claim.

| action | fixture scenario | result |
| --- | --- | --- |
| `equip_wearable` | `native_equip_wearable_v1` | passed / `wearable_equipped` |
| `unequip_wearable` | `native_unequip_wearable_v1` | passed / `wearable_unequipped` |
| `dismount_transport` | `native_dismount_transport_v1` | passed / `transport_dismounted` |
| `place_owned_object` | `native_world_object_v1` | passed / `owned_object_placed` |
| `remove_placed_item` | `native_world_object_v1` | passed / `placed_item_removed` |
| `break_container_source` | `native_world_object_v1` | passed / `container_source_broken` |
| `use_warp_item` | `native_use_warp_item_v1` | passed / `warp_item_arrived` |
| `pan_ore` | `native_pan_ore_v1` | passed / `ore_panned` |
| `claim_mail_attachment` | `native_claim_mail_attachment_v1` | passed / `mail_claimed` |

### The four product defects these gates found (all fixed)

1. **An unreachable discovery branch.** The world-object scan guarded its loop with
   `if (player.Items[slot] is not StardewValley.Object owned || owned.Stack <= 0) continue;`, and
   `Tool` is NOT a `StardewValley.Object` (both derive from `Item`). Every tool slot was skipped, so the
   removable-object and breakable-container scan below it could never run. Three separate runners
   reported their object Given absent while only placement candidates were published. The item test now
   belongs to the placement branch alone.
2. **An invented precondition.** `RemovesThisObject` began with `if (target.Fragility == 2) return false;`,
   reasoning from `fragility_Indestructable`.
   **CORRECTION, same day, from independent review:** the test that motivated that change WAS wrong, but the
   conclusion drawn from it was too. `fragility == 2` is refused by the native code at `Object.cs:1346-1349` —
   AFTER the twig branch (:1182) and the error-`bigCraftable` branch (:1339-1345), and BEFORE
   `Type == "Crafting"` (:1350). I had read only :1140-1200 and asserted the guard did not exist anywhere.
   Removing it therefore mis-classified every `Type == "Crafting" && Fragility == 2` object as removable, so
   the action swung twelve times and reported an uncertain postcondition instead of a named refusal — a
   regression on real saves (Mountain's brazier, the Slime Hutch's `(BC)56`, the Farm Cave's `(BC)128`). The
   guard is restored IN THE NATIVE POSITION, and the twig stays removable because the native twig branch
   precedes the test, which is why the twig live gate passed and still passes. The twig's own `fragility` is
   reported as 2 at runtime (Object.cs:1184 sets it), so the fixture asserting `IsTwig()` is right.
3. **The mailbox was sought in map data that does not contain it.** `IsMailboxTile` scanned the location's
   Buildings layer for a `Mailbox` action. The repository's own content probe over all 563 maps shows
   `Maps/Farm` declares exactly one action property (`Buildings:Message "Farm.1"` at 8,7) and the only
   `Mailbox` actions anywhere are `TownMailbox N` in the Town variants. The farm mailbox is per-player and
   computed in code: `Farmer.getMailboxPosition()` (public) returns the player's cabin mailbox when they
   live in a cabin, else `Game1.getFarm().GetMainMailboxPosition()`, and `Farm.cs:1473` draws it there. So
   `claim_mail_attachment` could never advertise a target in production. The predicate now asks the game.
4. **The warp-totem fixture refused to arm during the post-load fade.** It tested the native context gate
   immediately, including `Game1.fadeToBlack`, which is true right after a save load. The transient part
   is now awaited on a tick and the "initialized" line moves with the arming; the non-transient part
   (`eventUp`, festival, swimming, bathing clothes, onBridge) still refuses, and now NAMES the blocker and
   its value so a failure says which one it was.

### Two shared-wiring defects, and one harness defect

* Four of the five new snapshot target arrays were never registered on the Host. A new array needs six
  points in `host/src/protocol.ts` (the interface member, BOTH `SNAPSHOT_KEYS` lists, a `validateSnapshot`
  branch, the coarse conjunction, and an `is<X>Fact` predicate), and the predicate's key list must be
  copied from the record in `BridgeProtocolModels.cs` - guessing it makes `hasExactKeys` reject the Mod's
  own payload and the bridge closes with `invalid_snapshot:<field>`, which reads like a transport fault.
* `executeFresh` refuses when the client's cached snapshot is newer than the one being bound. That is a
  transient - the world moving between an observe and its execute is normal - and two runners lost a run
  to it. The harness now also exports `executeFreshAfterReobserve`, which re-observes and re-sends, bounded.
  The existing helper is untouched, so no other runner changed behaviour.
* Two runners demanded DISPATCH evidence (the totem slot, the stack pair, `native_use_started`) from the
  SHARED arrival terminal, which only describes the arrival. Each fact is now asserted on the receipt that
  carries it. Their offline fakes carried the same wrong assumption, which is why the tests stayed green.

### Runner timing, learned again

The second activation in the warp-totem runner was sent while the actor was still finishing the warp, so
admission answered `player_not_actionable` - true, but not the clause under test. The negative phase now
waits for an actionable actor first. The same class of fix as `dismiss_modal`, `ride_bus` and `enter_exit`:
a request whose native work resolves immediately, or whose world is mid-animation, must not be asserted
against the wrong phase.