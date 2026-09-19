# 18 Tool-Family Source Effect-Summary Ledger

> **Status:** first Stage-B source slice for the whole-game atlas. Static evidence only; no public action, bridge capability, contract/live/publish gate, or policy is changed.
>
> **Target:** Stardew Valley `1.6.15.24356`, `Stardew Valley.dll` SHA-256 `7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee`.

## 1. Purpose

The whole-game atlas has 207 source command-boundary entries. This ledger does **not** turn them into 207 actions. It performs the first effect-summary batch for the seven tool families with the clearest normal-player entry paths:

```text
Hoe
Axe
Pickaxe
WateringCan
Pan
FishingRod
MeleeWeapon
```

For each selected source path, the exact-DLL derivation records only source-anchored:

```text
typed inputs
native guards
observed writes/delegated effects
lifecycle owner
unknown sinks
implementation-reuse hypothesis
public projection: not_inferred
```

An unknown virtual dispatch, event, content/RNG branch or lifecycle callback is deliberately recorded as an unknown sink. It is not erased from the write set.

## 2. Reproducible derivation

```powershell
pnpm derive:stardew-tool-effect-ledger -- `
  --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH `
  --out .tmp-stardew-tool-effect-ledger.json

node --test tools/stardew-tool-effect-ledger.test.mjs
```

The command checks the installed DLL file version and hash, temporarily decompiles that exact binary, demands target-version source anchors, emits a redacted JSON report and removes temporary source. A changed anchor fails closed.

It never launches Stardew, loads/saves, interacts with a window/UI, sends input, invokes `Tool.DoFunction`, creates a Game Action, changes policy or contacts the Mod bridge.

## 3. Result: eight bounded source summaries

| Entry | Native result boundary observed | Why it is not a public generic action |
|---|---|---|
| `tool.hoe.apply_to_affected_tiles` | Native multi-tile set can delegate terrain/object work, create HoeDirt and invoke buried-item behavior. | Target dispatch plus buried-item/content effects remain unresolved; `till_soil` stays the narrow projection. |
| `tool.axe.apply_to_tile_targets` | Location, terrain, large terrain and object precedence; may remove targets or create crafting debris. | Target class, removal and drop semantics differ materially. |
| `tool.pickaxe.apply_to_tile_targets` | Native location dispatch, partial breakable-stone durability, terminal `OnStoneDestroyed`, multi-hit boulder state. | One call may be partial progress; no `break_resource` success can be honestly generic. |
| `tool.watering_can.refill` | Refillable target sets `WaterLeft` to max. | It is a distinct mutually exclusive branch from applying water; never fold it into `water_crop`. |
| `tool.watering_can.apply_to_affected_tiles` | Affected tile set delegates terrain/object/location actions and consumes water/stamina. | It can affect heterogeneous multiple targets; `water_crop` deliberately remains one live unwatered crop projection. |
| `tool.pan.collect_ore_pan_point` | Animation/event lifecycle delivers native generated items, clears point, later restores movement/tool state. | Randomized results and temporal/capacity semantics demand a separate receipt/lifecycle contract. |
| `tool.fishing_rod.cast_and_begin_wait` | Timing cast plus tool release enters fishable-tile waiting state with bite timer and movement lock. | Fishing is a multi-phase state machine; cast and catch are not generic `use_tool` results. |
| `tool.melee_weapon.special_move` | Special event and damage path can damage monsters, remove projectiles and delegate world target effects. | This batch records only a source boundary candidate, not a reconstructed normal-player special/ordinary-swing ingress; weapon type/cooldown/event timing rule out a generic attack/`DoDamage` bridge. |

## 4. What source reuse means here

The ledger finds two **hypotheses**, neither a public action nor a proven kernel:

```text
tile_tool_target_dispatch
  Hoe, Axe, Pickaxe, Watering Can, MeleeWeapon

temporal_tool_commit
  Pan, Fishing Rod, MeleeWeapon
```

The first says several methods iterate tiles and invoke native target dispatch. It does **not** say their effects are equal:

```text
order differs
+ target domains differ
+ removal conditions differ
+ stamina/water/durability rules differ
+ partial versus terminal states differ
+ authoritative evidence differs
```

The second says several tools include an event/animation phase. It likewise does **not** establish shared cancellation, authority or terminal evidence.

Thus this Stage-B result reinforces the current design decision:

```text
implementation code can reuse a source-proved kernel/helper;
public interfaces stay separate unless their full semantic contracts are equal.
```

In particular, source reuse never changes the separate `plant_seed` and `fertilize_tile` interfaces, and it does not create `use_tool`, `interact`, `attack`, `break_resource`, or `perform_action` escape hatches.

## 5. Evidence boundary and next proofs

The ledger gives implementation and test-planning evidence only. Before a source summary can support any materialized Game Action, it needs:

```text
1. expansion of every relevant unknown sink into a bounded source/runtime slice;
2. typed Farmhand bridge equivalence or a demonstrated stricter substitute;
3. action-specific contract tests for target, policy, stale revision,
   deadline, cancellation and idempotency;
4. target-version native AI-Farmhand live evidence with authoritative receipt
   and action-specific postcondition;
5. published capability/policy evidence.
```

The next source batch should be `Utility.tryToPlaceItem`, `Object.placementAction`, `Object.performObjectDropInAction`, and `Object.checkForAction`. It will show where implementation helpers can be shared among placement/machine/container behavior while preserving distinct interfaces such as seed planting, fertilizing, animal feeding, loading a machine and placing a world object.
