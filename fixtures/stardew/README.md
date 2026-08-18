# Stardew native-action fixture saves

This directory contains **metadata only**. It must never contain a player save, a
profile configuration, a bridge token, an attachment manifest, or a session
exchange file. The mandatory Farmhand end-to-end procedure is in
[`RUNBOOK.md`](RUNBOOK.md). The isolated single-player Portfolio environment
variables and gate-specific local setup are documented separately in
[`PORTFOLIO_ENVIRONMENT_RUNBOOK.md`](PORTFOLIO_ENVIRONMENT_RUNBOOK.md); that
runbook must not be used to cross the Farmhand/Portfolio topology boundary.

A native action success gate has two independent parts:

1. target-version source/IL and deterministic protocol tests establish the legal
   entrypoint and fail-closed boundaries; and
2. a dedicated, native Stardew fixture save establishes that the actual
   game-thread, Farmhand, animation/tick, inventory, and persistence lifecycle
   produces the advertised receipt and postcondition.

The fixture harness (`tools/prepare-stardew-action-fixture.ps1`) copies an
operator-created save template into the real Stardew save root. It never edits
save XML and it refuses to touch any save whose name does not begin with
`GameBuddyFixture_`.

## Native-local-player action fixture

`tools/run-stardew-native-local-player-move-fixture.ps1` is a deliberately
minimal, single-process harness for existing shared actions. It currently
supports separately allowlisted `move_to_tile`, `travel`, `enter_exit`, `feed_animal`, `collect_animal_product`, `break_rock_source`, `equip_tool`, `till_soil`, `water_crop`, `refill_watering_can`, `plant_seed`, `fertilize_tile`, `harvest_crop`, `pickup_forage`, `pickup_item`, `machine_inspect`, `use_item`, and `clear_debris`; each run exposes only the
capability required by its selected slice (plus separately receipted
prerequisites where a slice needs them). `fertilize_tile` has passed a
native-local target-version mechanics run; `harvest_crop` has also passed after
its runner bounded the native post-terminal stabilization window. `travel` and `enter_exit` are distinct
native actions: `travel` acts on a published `Warp`, while `enter_exit` acts
on a published door target; each requires its own terminal receipt and fresh
location/tile postcondition.
It starts one SMAPI process with one isolated observed physical slot
`GameBuddyFixture_<nativeUniqueId>`, binds only its current native local Player,
and uses the shared `BridgeSession`,
`ExecutionManager`, and `StardewBodyController`. It does not enable Portfolio,
LAN hosting, HostAutomation, Farmhand provisioning, a second player/process, or
UI/input automation. Before launch its companion prepare command transactionally
backs up the one Mod bundle/configuration; after the receipt/fresh-position
check it restores each managed file byte-for-byte and releases its lock.

The runner requires a pre-existing isolated Mods path whose `GameBuddy/config.json`
already contains a valid local bridge scope for that slot's actual local Player.
The fixture config records the target-version loader's separate logical name
`GameBuddyFixture` and exact observed physical slot; it deliberately does not
infer identities or edit native saves. A passed runner reports only its selected action's matching request/execution receipt and
fresh action-specific postcondition for topology `native_local_player_fixture`;
it is not Portfolio or Farmhand publication evidence. The `equip_tool` slice
selects an eligible live `toolSlots` entry from a fresh actionable snapshot,
submits one typed `equip_tool` request, and requires
`succeeded/tool_selected` evidence whose `expected` and `after` values both
equal that selected label, plus a fresh `currentTool` equal to it. This runner
contract has been exercised in the target-version native-local lane; it is not
Portfolio or Farmhand publication evidence.

### Native-local `clear_debris` fixture and live mechanics closure

`native_clear_debris_resource_clump_v1` is separately allowlisted only in the disposable `native_local_player_fixture` lane. Before bridge attachment it uses the reviewed target-version `Farm.addResourceClumpAndRemoveUnderlyingTerrain` placement lifecycle to establish exactly one intact `2×2` `ResourceClump` at Farm `(62,17)`, `parentSheetIndex=752`, health `8`, and one basic Pickaxe. Every footprint tile must be available; an existing parent-`752` clump or unavailable fixed geometry blocks setup. The fixture never invokes `Pickaxe.DoFunction`, changes clump health/removal, collects drops, alters output inventory, or emits a receipt.

The production runner accepts only that fixed tuple and the finite approaches `(61,17)`, `(64,17)`, and `(62,19)`; it does not scan or drift across the Farm. It independently equips the Pickaxe and submits one fresh typed `clear_debris` request for every hit. The target-version serial gate retained a matching request/execution receipt for each hit: seven `partially_succeeded/debris_hit` receipts with health `8→1`, then the eighth request's `succeeded/debris_cleared` receipt with `health_before=1`, `health_after=0`, and `clump_removed=true`. A fresh snapshot omitted the exact opaque target (`debrisTargets=0`); profile transaction restore, backup/lock and working-save removal, and process absence were verified. This is shared native-local mechanics evidence only—not Farmhand, Portfolio, publication, release, or persistence/reopen evidence. Drops and later `pickup_item` are separate lifecycles.

### Native-local `refill_watering_can` fixture

`native_refill_watering_can_v1` is independently allowlisted in the disposable native-local lane. Before bridge attachment, its fixture provides exactly one ordinary Watering Can below its native maximum, then marks the current FarmHouse Back-layer tile with `WaterSource` and verifies target-version `CanRefillWateringCanOnTile` accepts it. This audited in-memory change is limited to the disposable working save; it does not call `WateringCan.DoFunction`, refill the can, emit a receipt, or modify the read-only template.

Its profile reuses only `move_to_tile` and `equip_tool`, then adds `refill_watering_can`; it does not enable `travel`. The production request binds a fresh opaque legal-source target and same equipped can slot. Its only success condition is the native `DoFunction` result on that exact can changing `water_before < water_max` to `water_after == water_max`, followed by a fresh same-slot/same-item can fact.

The target-version native-local gate passed in FarmHouse for opaque target `watering_can_refill_cad28f88543b9ef7` at `(9,9)`: `equip_tool` selected the `(T)WateringCan` in slot `4`; `refill_watering_can` then returned same-execution `succeeded/watering_can_refilled` with `water_before=39;water_after=40;water_max=40`; a fresh snapshot confirmed the same slot at `40/40`. This is shared native-local mechanics evidence only—not Farmhand, Portfolio, publication, or persistence/reopen evidence.

**Target-version local run — 2026-08:** one SMAPI process loaded observed slot
`GameBuddyFixture_445094166` without LAN, Farmhand, a second process or UI/input.
The first adjacent candidate `(9,8)` was correctly rejected as `no_native_path`;
the next fresh candidate `(10,9)` completed as `succeeded/target_reached`, with
same-execution native evidence `tile=10,9;target=10,9;arrival=exact;path=stardew_native`
and fresh revision `4` at `FarmHouse (10,9)`. The transaction then reported
`restored` and removed its backup. This is a local-player mechanics closure for
`move_to_tile`, not a Portfolio gate, aggregate milestone, or Farmhand result.

## Creating an event-free single-player template

A single-player action template must be created separately from every existing
Farmhand/Host fixture and must meet the **stable-start contract** below. This
prevents an unrelated native cutscene from turning into a false action failure:

- it is created by target-version Stardew's own new-game lifecycle, with
  `skipIntro: true`, not by XML editing or cloning a personal/Farmhand save;
- its first native load starts with no active menu or event, and its action
  route `FarmHouse → Farm` is observed to settle with `CanMove == true` and
  `Game1.eventUp == false` before any bridge action is sent;
- a template is read-only after it is captured; each action run gets a
  disposable working copy, and fixture setup may establish only explicit
  preconditions.

The one-shot native bootstrap is deliberately bridge-closed until the game
writes its observed save/world/local-player binding. With an isolated Mods
profile and no existing save of that logical name, run:

```powershell
powershell -NoProfile -File tools/run-stardew-native-local-player-move-fixture.ps1 `
  -GamePath "D:\Steam\steamapps\common\Stardew Valley" `
  -ModsPath "$env:LOCALAPPDATA\GameBuddy\stardew-profiles\native-local-stable" `
  -FixtureRoot "$env:LOCALAPPDATA\GameBuddy\stardew-fixtures" `
  -SaveName GameBuddyFixtureStable `
  -Action till_soil -BootstrapNativeSave
```

This prints the observed physical slot only after real `SaveLoaded` and the
fixture bootstrap has disarmed. It does **not** execute an action and is not
success evidence. After the process is closed, copy that complete native save
directory into a directory outside the repository, for example:

```text
%LOCALAPPDATA%\GameBuddy\stardew-fixtures\templates\GameBuddyFixture_AnimalProduct_1_6_15\
```

The directory must contain exactly the usual Stardew save files named after the
save directory (for example `GameBuddyFixture_AnimalProduct_1_6_15`) and
`SaveGameInfo`. Do not hand-author or patch these files. Record the expected
preconditions in a non-secret metadata file beside the template; use
`animal-product.fixture.example.json` as the shape reference.

The dedicated template may contain test animals, tools, and a Farmhand cabin.
It must not reuse a personal/daily save or any production player profile. Its Host fixture
profile must use the same `HostAutomation.SaveName` as the template/save directory; the
formal attachment regression otherwise loads a different world. Copying the template alone
does not configure HostAutomation or create a Farmhand binding.

## Creating a fixture from an existing native save (bootstrap only)

When a completely new save would make the required native preconditions expensive to
establish, the harness can make a **read-only source clone** into a new fixture template:

```powershell
powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 `
  -FixtureRoot "$env:LOCALAPPDATA\GameBuddy\stardew-fixtures" `
  -TemplateName GameBuddyFixture_AnimalProduct_1_6_15 `
  -SaveName GameBuddyFixture_AnimalProduct_1_6_15 `
  -InitializeFromSaveName A_445094166
```

This mode refuses a running game, never overwrites a template, copies only a source under
the explicit Stardew save root, and renames only source-named file entries (for example,
`A_445094166` to `GameBuddyFixture_AnimalProduct_1_6_15`). It never parses or edits XML.
The source save remains untouched.

This is only a bootstrap convenience, **not** immediate success evidence. Before the clone
may be used as a fixture template, a dedicated Host profile must load the new name through
target-version `SaveGame.Load` and complete a real native `Saving/Saved` cycle. That
validates that Stardew accepts the renamed native save. Only then may later working copies
be restored and used for action success gates.

## Restore and cleanup

```powershell
# Copies a template to %APPDATA%\StardewValley\Saves\GameBuddyFixture_AnimalProduct_1_6_15
powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 `
  -FixtureRoot "$env:LOCALAPPDATA\GameBuddy\stardew-fixtures" `
  -TemplateName GameBuddyFixture_AnimalProduct_1_6_15 `
  -SaveName GameBuddyFixture_AnimalProduct_1_6_15

# Removes only that prefixed working save after all processes are stopped.
powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 `
  -FixtureRoot "$env:LOCALAPPDATA\GameBuddy\stardew-fixtures" `
  -TemplateName GameBuddyFixture_AnimalProduct_1_6_15 `
  -SaveName GameBuddyFixture_AnimalProduct_1_6_15 -Cleanup
```

Before an action runner is invoked, it must read the live snapshot and assert
that the manifest's required target facts exist. The file harness only makes
the initial world available; it never calls the action under test and never
writes receipt, inventory, relationship, production, or completion fields.

## Native template requirements

### `collect_crab_pot_output` fixture provenance contract (fixture-needed only)

`crab-pot-output.fixture.example.json` is a checked-in, metadata-only provenance
contract for the future `collect_crab_pot_output` ready-CrabPot fixture. It is
bounded to Stardew `1.6.15.24356` and the approved assembly/content hashes, and
requires the native placement → bait → day transition (`CrabPot.DayUpdate`) →
`Saving/Saved` → reload lifecycle. It forbids save/XML or readiness/output/bait/
owner/inventory mutation, UI/input/raw-dispatcher ingress, collection ingress,
and fixture-produced receipts or success evidence. Production must rediscover a
fresh opaque target; no opaque target ID is recorded here.

The checked-in example is explicitly `save.provisioningState=unprovisioned` and
`templatePayloadSha256=null` and `provisioningAttestation=null`: it makes no
claim that a native template exists or has been validated. Validate only with:

```text
node tools/check-crab-pot-output-fixture-contract.mjs --contract fixtures/stardew/crab-pot-output.fixture.example.json
```

A passing result is explicitly `state=fixture_needed`,
`contractKind=provenance_contract_only`, `liveClosure=none`, and
`templateValidated=false`. A future provisioned artifact must replace the null values with a real
canonical native-template SHA-256 and a nonempty native save/reload attestation
reference; that does not publish or execute an action. This contract does not
implement or prove the typed action, Host/Mod protocol, registry publication,
smoke runner, game launch, template provisioning, or any live closure.

The harness itself deliberately **does not edit** buildings, animals, produce,
inventory tools, receipts, or action postconditions. It also never uses
`skipSafetyChecks`, loose placement, direct `Items` mutation, non-animal-map
injection, or save-XML patching.

A narrowly scoped fixture initializer may establish *preconditions* only when
all of the following are true: it runs on the game thread before formal
Farmhand attachment; the working save name starts with `GameBuddyFixture_`;
the configured scenario is explicitly allowlisted; and it invokes only the
locked target-version native setup/inventory APIs. For
`collect_animal_product`, `native_animal_product_v2` calls the target-version
`DebugCommands.SetupBigFarm` in a disposable working fixture, preserves and
revalidates the pre-existing Cabin/binding, then uses the native Farmhand
backpack and inventory APIs to supply only the compatible fixture tool. It
never calls the production bridge action or writes a receipt/postcondition.
The resulting save is driven through a real native save before attachment.

This exception is intentionally not a general world editor. The earlier
`Farm.buildStructure` and `SpawnCoopsAndBarns` routes remain rejected: their
random-tile placement depends on map buildability facts absent from the
baseline clone. Any new scenario needs its own target-version source review,
allowlist entry, live precondition assertions, and proof that the production
adapter—not the initializer—caused every success postcondition.

For `collect_animal_product`, each run restores the template, performs the
allowlisted native precondition setup, formally attaches, rediscovers a target
from the production snapshot, executes the production action, and requires the
same execution's terminal receipt plus a fresh reread showing both the selected
animal-product target absent and the aggregate inventory stack for its exact
`qualifiedProduceItemId` increased by at least the published `produceStack`.
The bounded `inventoryItemFacts` snapshot field is published only with the
`collect_animal_product` capability for that independent reread. The template
or initializer itself is never success evidence.

`native_feed_animal_v1` is separately allowlisted **only** for the
`native_local_player_fixture` disposable working-save lane. Before bridge
attachment it may use target-version `DebugCommands.SetupBigFarm` only to
establish native AnimalHouse / entry / empty-trough preconditions, then use the
current native local Player's inventory API to provide Hay. It must not retain
or infer a Cabin/Farmhand binding, prefill a trough, invoke `checkAction`,
consume Hay, create a receipt, or claim an action result. After attachment, the
runner independently discovers a fresh opaque nearby trough target, carries its
own typed navigation/entry receipts where needed, and requires its own
same-request `succeeded/hay_placed_in_trough` receipt, Hay `N→N-1`, filled
trough / target disappearance, and a fresh postcondition observation.

The target-version disposable run passed from the source-pinned first
`SetupBigFarm` Deluxe Barn `AnimalHouse`. A fresh snapshot selected opaque
`feed_trough_6b8d0c86fd28f075` at `(8,3)` using Hay slot `5`; production alone
returned `succeeded/hay_placed_in_trough` with `native_handled=true`,
`trough_filled=true`, and Hay `2→1`. The next fresh snapshot reduced eligible
trough targets from `2→1` and omitted that exact target. The pre-bridge fixture
only established the AnimalHouse, empty trough, and Hay—it did not feed. This
is shared `native_local_player_fixture` mechanics evidence only, not Farmhand,
Portfolio, release, publication, save/reopen, or animal-satiation evidence.

### Native-local `break_rock_source` prerequisite and live mechanics closure

`native_break_rock_source_v1` is separately allowlisted only in the
`native_local_player_fixture` disposable working-save lane. Before bridge
attachment it supplies exactly one basic Pickaxe and places exactly one nearby,
ordinary one-hit `(O)2` `IsBreakableStone()` source (`MinutesUntilReady=1`) in
Farm. It does not invoke `Pickaxe.DoFunction`, damage/remove the rock, collect
drops, modify resulting inventory, or emit a receipt/postcondition.

The runner independently receipts travel, movement, and `equip_tool`, then
rediscovers a fresh opaque `rockSourceTargets` entry and submits the exact
revision-bound `break_rock_source(slot,x,y,expectedTargetId)` request. The
single target-version run equipped `(T)Pickaxe` in slot `4`, targeted
`rock_source_d070382fe9bc99dd` at Farm `(64,17)`, and received
same-execution `succeeded/rock_source_broken` evidence:
`tool=pickaxe`, `qualified_item_id=(O)2`, `durability_before=1`,
`durability_after=removed`, and `removed=true`. The following fresh snapshot
changed eligible targets `1→0` and omitted that exact opaque target. Drops and
pickup are intentionally separate actions. This is shared native-local
mechanics evidence only, not Farmhand, Portfolio, publication, release, or
save/reopen evidence.

### Native-local `plant_seed` prerequisite and live mechanics closure

`native_plant_seed_v1` is separately allowlisted only in the
`native_local_player_fixture` disposable working-save lane. Before bridge
attachment it may add ordinary in-season Spring seed `(O)472` through the
current local Player's native inventory API and run target-version
`RemoveDirt → SpreadDirt`
to establish empty native `HoeDirt`; production revalidates plantability after
the Farmer reaches Farm. It must not call `plant_seed`,
`placementAction`, inventory reduction, create a crop, write terminal state, or
emit a receipt/postcondition.

The native-local smoke rediscoveres a published `seedTargets` entry and its
seed slot from a fresh actionable snapshot, independently receipts travel and
movement prerequisites, submits the revision-bound typed `plant_seed` schema
request, and requires that action's own same-execution `succeeded/seed_planted`
receipt with native crop/inventory evidence plus a fresh snapshot where the
opaque seed target disappeared. It passed in the target-version native-local
lane at Farm `(62,18)`: same-execution `succeeded/seed_planted` evidence matched
the fresh opaque target, `item=(O)472`, `crop=472`, and seed inventory `2→1`;
the target then disappeared from the next production snapshot. It is neither
Farmhand nor Portfolio publication evidence.

### Native-local `water_crop` prerequisite and live mechanics closure

`native_water_crop_v1` is separately allowlisted **only** in the
`native_local_player_fixture` disposable working-save lane. Before bridge
attachment it supplies the current native local Player with a nonempty native
Watering Can and uses target-version `SpreadDirt` followed by `SpreadSeeds 472`
to establish an unwatered growing crop. `SpreadSeeds` populates only existing
`HoeDirt`, while the event-free template starts without dirt. It never calls
`DebugCommands.SetupBigFarm`, does not create or retain a Cabin/Farmhand
binding, never calls debug `Water`, never writes `HoeDirt` water state, never
invokes the production action, and never emits a receipt.

The native-local runner must rediscover a fresh published opaque crop target
with its exact revision, separately receipt movement/travel/equipment
prerequisites, then require `water_crop`'s own `succeeded/crop_watered`
evidence and a fresh target-specific postcondition. This lane passed a
single-process target-version run at Farm `(62,18)`: independent
`equip_tool`, `travel`, and movement receipts preceded water_crop's own
`succeeded/crop_watered` receipt; its native evidence recorded
`before_watered=False`, `after_watered=True`, and Watering Can water `40→39`.
The precise opaque target was absent from the following production snapshot.
This is native-local shared-action mechanics evidence only, neither Farmhand
evidence nor a Portfolio capability row.

### Native-local `fertilize_tile` and `harvest_crop` availability

`native_fertilize_tile_v1` is available only in the isolated
`native_local_player_fixture` lane. Before bridge attachment it supplies `(O)368`
Basic Fertilizer and creates eligible empty native `HoeDirt` using target-version
`RemoveDirt → SpreadDirt`; it does not apply fertilizer, call `placementAction`,
or emit a receipt. Its legacy allowlist is exactly `move_to_tile`, `travel`, and
`fertilize_tile`.

`native_harvest_crop_v1` is separately available only in that same lane. Before
attachment it creates a ready ordinary non-forage `Grab` crop through target-version
soil/seed/growth setup and verifies inventory capacity; it does not harvest, remove
the crop, or alter harvest output inventory. Its legacy allowlist is exactly
`move_to_tile`, `travel`, and `harvest_crop`. `fertilize_tile` has native-local
live mechanics evidence: Farm `(62,18)`, same-execution
`succeeded/fertilizer_applied`, native `(O)368` value `none→(O)368`, inventory
`2→1`, and a fresh snapshot without the target. `harvest_crop` has native-local
live mechanics evidence after a bounded post-terminal stabilization wait: Farm
`(70,17)`, same-execution `succeeded/crop_harvested`, native non-regrowing crop
removal, inventory `0→1`, and a fresh actionable snapshot without the opaque
harvest target. The bounded wait applies only after a successful terminal; all
pre-request actionability checks remain fail-closed. All such evidence is only
`native_local_player_fixture` evidence, never Portfolio or Farmhand evidence.

### Farmhand `water_crop` history (Farmhand lane only)

The following is historical `native_ai_farmhand_multiplayer` evidence and must
not be reused by the native-local lane: `native_water_crop_v1` used
`DebugCommands.SetupBigFarm` plus `SpreadSeeds 472`, retained/revalidated its
existing Cabin binding, and supplied the bound Farmhand a native Watering Can.
The formal Farmhand fixture gate at Farm `(38,18)` recorded `(T)WateringCan`
water `40→39`, exact `HoeDirt` unwatered-to-watered state,
`succeeded/crop_watered`, and target disappearance from the next production
snapshot. The initializer remains fixture-only; this history does not make the
native-local scenario passed.

`native_plant_seed_v1` is likewise limited to a disposable working save. It runs
`SetupBigFarm`, retains and revalidates the existing Cabin/binding, supplies the
bound Farmhand only with ordinary `(O)479` Melon Seeds through the native
inventory API, then uses target-version debug `RemoveDirt` followed by
`SpreadDirt` to establish legal, empty ground `HoeDirt`. It must not create a
crop, call `Object.placementAction`, or issue a receipt. The production
`plant_seed` action must independently discover the nearby empty target and
prove target-version `placementAction → HoeDirt.plant` created the crop and
consumed precisely one seed.

`native_till_soil_v1` is limited to the same disposable working-save boundary. Before attachment it runs target-version `SetupBigFarm` then `RemoveDirt`, retains/revalidates the existing Cabin/binding, and uses the native Farmhand inventory API only to provide a Hoe. It must not invoke `Hoe.DoFunction`, create `HoeDirt`, or emit a receipt. The production `till_soil` action must independently discover nearby diggable ground and prove the exact native `HoeDirt` postcondition. Its formal gate passed after attachment/reconnect/restart nonce rotation: from a fresh Farm snapshot the production runner equipped the live Hoe, moved adjacent to a rediscovered bare target `(37,18)`, and received `succeeded/soil_tilled` with `before=none;after=HoeDirt`; the exact bare target disappeared from the next snapshot (`soilTiles 9→8`).

`native_fertilize_tile_v1` is likewise limited to a disposable working save.
It runs `SetupBigFarm`, retains and revalidates the existing Cabin/binding, and
uses the target-version Farmhand backpack/inventory API only to supply `(O)368`
Basic Fertilizer after confirming a native ground `HoeDirt` can accept it. It
must not write `HoeDirt.fertilizer`, invoke `placementAction`, or issue any
production receipt. The production `fertilize_tile` action must independently
rediscover a nearby live target and prove both the exact native fertilizer value
and a one-item inventory decrease before this initializer can support any
success claim. The formal fixture gate did so at Farm `(38,28)`: production
`placementAction` returned `succeeded/fertilizer_applied`, the exact fertilizer
changed `none→(O)368`, Farmhand Basic Fertilizer changed `2→1`, and the opaque
target was absent from the next production snapshot. `fertilize_tile` is
therefore published; the initializer remains fixture-only and is never evidence
by itself.

`native_machine_inspect_v1` is separately allowlisted for a disposable working
save. Before attachment it places one adjacent empty `(BC)12` machine in the
current FarmHouse through target-version `dropObject`; its exact legacy
allowlist is `move_to_tile`, `machine_inspect`. It must not invoke
`checkForAction`, open a machine menu, load or collect a machine, mutate machine
state, or issue a production receipt. Production independently discovers a
nearby `machineTargets` entry and rereads the same native Object. Its
native-local gate returned `succeeded/machine_inspected` for `(BC)12` at
FarmHouse `(8,10)`, and the receipt's machine, held-input, output-ready, and
processing facts matched the next live snapshot for the same opaque target. The
initializer remains fixture-only and is never evidence by itself.

`native_pickup_forage_v1` is separately allowlisted for the native-local
single-process disposable working-save boundary. Before bridge attachment it
may derive a bounded Farm search from the current native local Player's
FarmHouse-to-Farm warp and use target-version `dropObject` only to place one
`isForage`/`IsSpawnedObject` Object; it must not invoke `GameLocation.checkAction`,
remove the object, add inventory, or issue a receipt. Production independently
rediscovered opaque forage target `forage_…` and entered the reviewed
`Game1.tryToCheckAt` path. Its native-local gate returned
`succeeded/forage_picked_up` for `(O)399` at Farm `(63,17)`, proved the native
object was removed and the local Player inventory increased `0→1`, and observed
that opaque target disappear from the next actionable snapshot. This is only
`native_local_player_fixture` shared mechanics evidence, never Portfolio or
Farmhand evidence. The initializer remains fixture-only and is never evidence
by itself.

`native_use_item_v1` is separately allowlisted for the same disposable working-save boundary. Before attachment it supplies the current native local Player ordinary `(O)216` Bread through target-version `Farmer.addItemToInventory`; its exact legacy allowlist is `use_item`. It never calls `Farmer.eatHeldObject`, changes stamina/health directly, decrements the stack, or issues a receipt. Production independently discovers the food slot, completes native eating animation, returns `succeeded/item_used`, and proves the exact stack `-1` postcondition. The native-local gate also binds invariant-culture stamina/health evidence to fresh before/after snapshots; it is neither Farmhand nor Portfolio evidence.

`native_harvest_crop_v1` is separately allowlisted for the same disposable working-save boundary. It first runs target-version `SetupBigFarm`, then re-seeds the native crop plot with in-season Summer Tomato Seeds through target-version `SpreadSeeds 480` and advances them with target-version `GrowCrops 11`; this compensates for SetupBigFarm's random Spring seeds being killed by the Summer season check. It retains/revalidates the existing Cabin/binding and selects only a ready ordinary `Grab` crop with inventory capacity. It never calls `HoeDirt.performUseAction`, `Crop.harvest`, destroys a crop, adds harvest inventory, or issues a receipt; production must independently discover the crop and prove the native harvest/inventory/regrow-or-removal postcondition.

`native_pickup_item_v1` is separately allowlisted for the same disposable working-save boundary. Before attachment it creates one target-version OBJECT `Debris` through `Game1.createItemDebris` at a bounded Farm tile and verifies the live `OBJECT` debris/chunk/item facts; its exact legacy allowlist is `move_to_tile`, `travel`, `pickup_item`. It never directly calls `Debris.collect`, removes a chunk, adds inventory, or issues fixture-produced success evidence. Target-version `Debris.updateChunks` owns magnetic collection, so production uses the typed body controller only to approach the exact live opaque chunk and waits for native automatic delivery. Its native-local gate returned `succeeded/item_picked_up` for `(O)388` at Farm `(64,17)`, proving `native_auto_collect=true`, exact chunk removal, local Player inventory `0→1`, and opaque target disappearance in the fresh snapshot. Direct transient-state edits, attachment-after injection, or fixture-produced success evidence remain forbidden.

## Formal fixture-success sequence

1. Stop any Stardew/SMAPI process and restore the dedicated working save with the
   harness.
2. Start the existing formal Host-first attachment regression with `SaveName`
   equal to the fixture name and the dedicated Host/AI Mod profiles. HostAutomation
   must load that same native save and retain its normal attachment/client-exit
   saving evidence.
3. Keep the final authenticated AI client only after the regression passes.
   The action runner must rediscover the target from the production snapshot;
   fixture metadata is an assertion contract, not an execution input.
4. Require the action-specific production receipt and a fresh snapshot matching
   every stated postcondition. For persistent changes, add a native save/reload
   audit before cleanup.
5. Stop game processes, remove the working `GameBuddyFixture_*` directory with
   the harness, and restore any temporarily changed profile configuration.

An operator must create the first native template through the target-version game.
The repository intentionally contains no save payload and cannot claim a success
fixture gate until such a template is provisioned and the above sequence passes.
