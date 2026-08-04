# Stardew native-action fixture saves

This directory contains **metadata only**. It must never contain a player save, a
profile configuration, a bridge token, an attachment manifest, or a session
exchange file. The mandatory end-to-end procedure is in
[`RUNBOOK.md`](RUNBOOK.md).

A native action success gate has two independent parts:

1. target-version source/IL and deterministic protocol tests establish the legal
   entrypoint and fail-closed boundaries; and
2. a dedicated, native Stardew fixture save establishes that the actual
   game-thread, Farmhand, animation/tick, inventory, and persistence lifecycle
   produces the advertised receipt and postcondition.

The fixture harness (`tools/prepare-stardew-action-fixture.ps1`) copies a
operator-created save template into the real Stardew save root. It never edits
save XML and it refuses to touch any save whose name does not begin with
`GameBuddyFixture_`.

## Creating a template (one-time, operator-controlled)

Create the world using the target-version game, save it normally, close the
game, then copy the complete native save directory into a directory outside the
repository, for example:

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
from the production snapshot, executes the production action, verifies the
receipt/postcondition, and cleans up the working copy. The template or
initializer itself is never success evidence.

`native_feed_animal_v1` is separately allowlisted for the same disposable
working-save boundary. Before formal attachment it uses target-version
`DebugCommands.SetupBigFarm`, retains/revalidates the existing Cabin binding,
and uses native Farmhand backpack/inventory APIs to provide Hay only. It must
not prefill a trough. The production `feed_animal` action independently
discovered an empty nearby trough and proved native placement plus one-Hay
consumption (`succeeded/hay_placed_in_trough`, Hay `2→1`, and the filled trough
target removed); it cannot claim that an animal has eaten or is full.

`native_water_crop_v1` is separately allowlisted for the same disposable
working-save boundary. It uses only target-version `DebugCommands.SetupBigFarm` followed by target-version `SpreadSeeds 472`
to create native, unwatered growing crops, retains/revalidates the existing
Cabin binding, and uses normal Farmhand backpack/inventory APIs only to ensure
the bound Farmhand owns a nonempty Watering Can. It never invokes the debug
`Water` command or writes a `HoeDirt` water state. The production `water_crop` action
must independently discover a nearby unwatered crop and prove its native
`WateringCan.DoFunction` postcondition. The fixture gate did so at Farm `(38,18)`:
`(T)WateringCan` water changed `40→39`, the exact `HoeDirt` changed from
unwatered to watered, the receipt was `succeeded/crop_watered`, and that target
was absent from the following production snapshot. `water_crop` is therefore
published; the initializer remains fixture-only and is never evidence by itself.

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
save. Before formal attachment it may use only the target-version fixture setup
to establish and select a native machine; it must not invoke `checkForAction`,
open a machine menu, load or collect a machine, mutate machine state, or issue a
production receipt. The published `machine_inspect` action independently
discovers a nearby `machineTargets` entry and rereads the same native Object.
Its formal gate returned `succeeded/machine_inspected`, and the receipt's
machine, held-input, output-ready, and processing facts matched the next live
snapshot for the same opaque target. The initializer remains fixture-only and
is never evidence by itself.

`native_pickup_forage_v1` is separately allowlisted for the same disposable
working-save boundary. Before formal attachment it may use target-version
`dropObject` only to place one `isForage` Object at a bounded, walkable Farm
tile; it must not invoke `GameLocation.checkAction`, remove the object, add
inventory, or issue a receipt. Production must independently rediscover the
opaque forage target and call target-version `GameLocation.checkAction`. Its
formal gate returned `succeeded/forage_picked_up` for `(O)399` at Farm
`(25,34)`, proved the native object was removed and the Farmhand inventory
increased `0→1`, and observed the same target disappear from the next snapshot.
The initializer remains fixture-only and is never evidence by itself.

`native_use_item_v1` is separately allowlisted for the same disposable working-save boundary. The production `use_item` action is published after its independent native gate. Before formal attachment it confirms the retained Cabin owner is the configured Farmhand and uses the target-version `Farmer.addItemToInventory` API to supply ordinary `(O)216` Bread. It never calls `Farmer.eatHeldObject`, changes stamina/health directly, decrements the stack, or issues a receipt; production must independently discover the food slot and complete native eating animation plus the exact stack `-1` postcondition.

`native_harvest_crop_v1` is separately allowlisted for the same disposable working-save boundary. It first runs target-version `SetupBigFarm`, then re-seeds the native crop plot with in-season Summer Tomato Seeds through target-version `SpreadSeeds 480` and advances them with target-version `GrowCrops 11`; this compensates for SetupBigFarm's random Spring seeds being killed by the Summer season check. It retains/revalidates the existing Cabin/binding and selects only a ready ordinary `Grab` crop with inventory capacity. It never calls `HoeDirt.performUseAction`, `Crop.harvest`, destroys a crop, adds harvest inventory, or issues a receipt; production must independently discover the crop and prove the native harvest/inventory/regrow-or-removal postcondition.

`native_pickup_item_v1` is separately allowlisted for the same disposable working-save boundary. Before formal attachment it creates one target-version OBJECT `Debris` through `Game1.createItemDebris` at a bounded Farm tile and verifies the live `OBJECT` debris/chunk/item facts. It may bind the fixture-only dropped-by identity to the retained Farmhand only as a short attachment handoff guard. Target-version `Debris.updateChunks` starts magnetic pickup after roughly 600 ms and owns `Debris.collect`; published `pickup_item` therefore uses the native body controller only to approach the exact live chunk and waits for target-version automatic magnetic delivery. It never directly calls `Debris.collect`, removes a chunk, adds inventory, or issues fixture-produced success evidence. Its formal gate returned `succeeded/item_picked_up` for Farm `(21,29)` `(O)388`, proving the same opaque chunk was removed with `native_auto_collect=true` and the Farmhand inventory changed `0→1`; the subsequent snapshot confirmed target disappearance. Direct transient-state edits, attachment-after injection, or fixture-produced success evidence remain forbidden.

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
