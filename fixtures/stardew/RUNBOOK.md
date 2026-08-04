# Stardew native Game Action runbook

This runbook is the required procedure for promoting a Stardew Game Action that
changes the world, inventory, relationships, or player state. It separates
**fixture preconditions** from the **production action proof**: a fixture can
make a target available, but it is never evidence that an action succeeded.

It applies to the formal, independent AI Farmhand topology only. Do not replace
any step with UI automation, a single-player simulation, save-XML editing, a
hand-written receipt, or an in-memory `Farmer`.

## Promotion standard

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
- Native templates and working names must both match `GameBuddyFixture_*`.
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

## Inputs to record before a run

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

## Phase A — preflight and restore

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

## Phase B — fixture readiness barrier and formal attachment

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
   native save/reload and the live AI Farmhand state. For example,
   `native_feed_animal_v1` supplies Hay but does not fill a trough;
   `native_plant_seed_v1` supplies only season-valid seed and uses target-version
   `RemoveDirt`/`SpreadDirt` for empty ground HoeDirt, never crop creation; the
   production snapshot must still discover its target itself. `native_till_soil_v1`
   may supply only a Hoe and bare legal diggable ground after target-version
   `SetupBigFarm`/`RemoveDirt`; it must not call `Hoe.DoFunction` or create
   `HoeDirt`.

## Phase C — production action proof

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
   | `collect_animal_product` | `succeeded/animal_product_collected`; native tool animation done; exact animal `currentProduce` cleared; expected inventory delta; target gone |
   | `feed_animal` | `succeeded/hay_placed_in_trough`; exact trough contains Hay; same Farmhand Hay total decreases by one; target gone |
   | `water_crop` | `succeeded/crop_watered`; exact live `HoeDirt` changes from unwatered to watered; Watering Can charge decreases by one; target gone |
   | `fertilize_tile` | `succeeded/fertilizer_applied`; exact live ground `HoeDirt.fertilizer` changes from none to the requested fertilizer; Farmhand inventory decreases by one; target gone |
   | `plant_seed` | `succeeded/seed_planted`; exact live ground `HoeDirt` gains a native crop; same Farmhand seed inventory decreases by one; target gone |
   | `till_soil` | `succeeded/soil_tilled`; exact previously bare live diggable tile gains native `HoeDirt`; target no longer appears as bare soil. Passed fixture proof: Farm `(37,18)`, `before=none`, `after=HoeDirt`, `soilTiles 9→8` |
   | future action | Exact reviewed native postcondition(s), not UI/menu/callback evidence |

5. If the runner reports `blocked`, record the reason and stop. If it reports
   `uncertain`, `rejected`, timeout, stale target, or incomplete evidence,
   investigate and rerun from a freshly restored fixture. Do not retry the same
   request ID or convert it into success.
6. Add a native save/reload check for persistent state whenever the action's
   contract requires it. Do not claim a persistence audit if processes must be
   force-stopped before saving.

## Phase D — promotion and regression

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
   pnpm check:stardew-action-surface
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
   `collect_resource`, `npc_relationship`, and other unverified slices remain experimental. `collect_resource` must not report `resource_collected`: a native Tree stump hit may remove the tree and create uncorrelated RESOURCE Debris, so `resource_drop_pending` is an uncertain boundary until native Farmhand inventory collection is proven.
   `native_use_item_v1` may only supply ordinary `(O)216` Bread through target-version `Farmer.addItemToInventory`; published `use_item` production must still provide the native animation and stack receipt. It must not invoke `Farmer.eatHeldObject` or manufacture item-use evidence. `native_pickup_item_v1` may keep its fixture-only dropped-by identity only as a short attachment handoff guard. Target-version `Debris.updateChunks` begins magnetic pickup after roughly 600 ms and owns `Debris.collect`, so published `pickup_item` does not issue a synthetic click-style collect call: its bounded production action guides the Farmhand to the live opaque chunk and waits for native magnetic collection. Its formal gate returned `succeeded/item_picked_up` for Farm `(21,29)` `(O)388`, proving `native_auto_collect=true`, exact chunk removal, Farmhand inventory `0→1`, and target disappearance. Fixture setup is never action evidence.

## Phase E — teardown

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
