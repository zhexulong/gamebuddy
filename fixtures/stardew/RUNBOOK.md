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
   shared mechanics evidence.
14. `native_tree_first_hit_v1` has met this lane's target-version live mechanics
   closure. Before bridge attachment, fixture setup uses target-version native
   world/inventory APIs only in the disposable Farm working save to place one
   mature ordinary tree (`health=10`, non-moss, untapped) with a legal approach
   tile and supply exactly one Axe. It does not invoke Axe/`tree_first_hit`,
   damage the tree, create a terminal state, or emit a receipt. Its exact
   legacy allowlist is `move_to_tile`, `travel`, `equip_tool`,
   `tree_first_hit`. The production runner separately receipts travel and
   movement, equips `(T)Axe` in slot `4`, then targets the fresh opaque
   `tree_shake_source_af99b95b5acdd092` at Farm `(64,17)`. The same execution
   returned `succeeded/tree_first_hit` with native evidence `before=10`,
   `after=9`, and `delta=-1`; the following fresh snapshot retained the same
   tree source with health `9`. This is only
   `native_local_player_fixture` shared mechanics evidence, never Portfolio or
   Farmhand publication evidence.
15. `native_feed_animal_v1` is a native-local-only disposable-working-save
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
23. The runner must restore the exact profile transaction. Then remove the
   working save through `prepare-stardew-action-fixture.ps1 -Cleanup`; verify
   no backup, lock, SMAPI/Stardew process, or working save remains.
Current native-local validation record: `move_to_tile`, `till_soil`,
`equip_tool`, `travel`, `enter_exit`, `plant_seed`, `fertilize_tile`,
`harvest_crop`, `pickup_forage`, `pickup_item`, `machine_inspect`, `use_item`, `tree_first_hit`, `chop_tree_source`, `clear_debris`, `clear_hoedirt`, `refill_watering_can`, `feed_animal`, `break_rock_source`, `collect_animal_product`, `pet_animal`, and `npc_relationship` have met this lane's live
receipt-plus-fresh-postcondition standard. `water_crop` has also met this lane's live
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
`equip_tool` ran on the event-free
`GameBuddyFixtureStable_445936768` disposable copy: a fresh snapshot selected
`(T)Hoe` in slot `1`; its same-execution receipt was
`succeeded/tool_selected` with `expected=(T)Hoe;after=(T)Hoe`; and its fresh
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

## Farmhand lane inputs

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
