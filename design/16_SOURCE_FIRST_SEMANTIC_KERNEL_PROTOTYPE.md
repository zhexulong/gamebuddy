# 16 Source-First Semantic Kernel Prototype: Soil Tile

> **Status:** bounded methodology prototype; **not** a runtime action registry, policy change, publication claim, or substitute for action-level live evidence.
>
> **Target:** locally attested Stardew Valley `1.6.15` build `24356`, `Stardew Valley.dll` SHA-256 `7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee`.
>
> **Purpose:** test the hypothesis that the target-version source semantics—not a manually named player-intent list—can factor several existing action labels into a smaller set of reusable game-semantic kernels.

## 1. Question and result

The hypothesis tested here is:

```text
If several normal-player paths share a bounded effectful source subgraph,
including the same typed target transition and commit ownership,
then that subgraph is a reusable semantic-kernel candidate.
```

The soil-tile slice answers **yes, but only once**:

```text
Current published action labels in this slice: 5
  till_soil, plant_seed, fertilize_tile, water_crop, harvest_crop

Source-derived candidate kernels: 4
  soil.till
  soil.apply_input[inputKind = seed | fertilizer]
  soil.hydrate
  soil.harvest_grab
```

The source proves that `plant_seed` and `fertilize_tile` share one closed **agricultural-input** transition kernel. It does **not** prove that all soil operations are interchangeable, or that a public generic `place_item` / `interact` API is safe.

This is the desired kind of reduction: it arises from a reusable native semantic transition, not from collapsing unrelated player-facing names.

## 2. Exact source-first derivation

The reproducible inspection command is:

```powershell
pnpm derive:stardew-soil-kernel -- --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH --out .tmp-stardew-soil-kernel.json
node --test tools/stardew-source-semantic-kernel.test.mjs
```

The tool re-decompiles the exact local assembly and fails closed unless all anchors below occur in the expected target-version methods. It emits metadata and hashes only; it does not commit proprietary source, launch Stardew, load a save, touch a UI, or call a Game Action.

| Layer | Target-version source | Source fact used in this prototype |
|---|---|---|
| Normal tool / active-object ingress | `Game1.pressUseToolButton` | Dispatches the equipped tool through `CurrentTool.DoFunction`, and active-object placement through `Utility.tryToPlaceItem`. |
| Till | `Tools/Hoe.DoFunction` | Computes affected tiles; for a valid tile it calls `GameLocation.makeHoeDirt` and the native buried-item lifecycle. |
| Input wrapper | `Utility.tryToPlaceItem` | Calls `item.placementAction` then decrements the active item only if that action succeeded. |
| Input dispatch | `Object.placementAction` | Its exact closed branch `Category == -74 || Category == -19` resolves the target `HoeDirt`, checks `canPlantThisSeedHere`, then calls `HoeDirt.plant`. |
| Shared input transition | `TerrainFeatures/HoeDirt.plant` | The `isFertilizer` discriminant either applies fertilizer after `CanApplyFertilizer`, or resolves/validates a seed and creates `Crop`. |
| Hydrate | `Tools/WateringCan.DoFunction` → `HoeDirt.performToolAction` | Watering Can checks water/enchantment and invokes the terrain feature; the `WateringCan` branch sets `HoeDirt.state = 1`. |
| Grab harvest | `HoeDirt.performUseAction` → `Crop.harvest` | Ready grab-harvest calls `Crop.harvest`; native logic performs capacity-dependent first-item delivery, possible additional `Debris`, native crop state effects, then `destroyCrop` where appropriate. |

## 3. The derived factorization

### 3.1 `soil.till`

```text
typed inputs:
  live diggable tile + equipped Hoe

source path:
  Game1.pressUseToolButton
  → Hoe.DoFunction
  → GameLocation.makeHoeDirt

commit:
  target tile obtains HoeDirt
```

This is distinct from the others because it **creates the target state** consumed by agricultural input. Its native path also includes tool stamina, multi-tile tool power, terrain/object interaction and buried-item behavior. A future more general tool kernel must not erase these semantics.

### 3.2 `soil.apply_input[inputKind = seed | fertilizer]`

```text
typed inputs:
  live HoeDirt tile
  + owned active agricultural object
  + inputKind ∈ { seed, fertilizer }

source path:
  Game1.pressUseToolButton
  → Utility.tryToPlaceItem
  → Object.placementAction
  → HoeDirt.plant(itemId, farmer, isFertilizer)

shared commit wrapper:
  placement succeeds → exactly one active item is consumed
```

The two variants are a **closed source-discriminated union**:

| `inputKind` | Native discriminant | Native terminal state |
|---|---|---|
| `seed` | `Object.Category == -74` | A `Crop` is created only after seed resolution and the location/season/planting rules pass. The target source additionally contains a conditional special-sprinkler branch which can apply fertilizer from that sprinkler's own locked chest inventory; it is a native side effect, not a second Farmhand inventory consumption. |
| `fertilizer` | `Object.Category == -19` | `HoeDirt.fertilizer` changes only after `CanApplyFertilizer` passes. |

Therefore `plant_seed` and `fertilize_tile` are not two independent primitive implementations in the game. They are two parameter families of one source-owned agricultural-input kernel.

That does **not** yet authorize replacing two GameBuddy actions with an `apply_input` public action. A public merge is permitted only if it preserves:

```text
closed inputKind enum
+ variant-specific live target predicates
+ variant-specific evidence/postconditions
+ variant-specific rejection/cancellation semantics
+ existing policy and capability publication boundaries
```

It must never accept an arbitrary `Object`, arbitrary `placementAction`, or a raw location/tile dispatcher.

### 3.3 `soil.hydrate`

```text
typed inputs:
  live HoeDirt/crop tile + equipped Watering Can with water/enchantment

source path:
  Game1.pressUseToolButton
  → WateringCan.DoFunction
  → HoeDirt.performToolAction

commit:
  HoeDirt state becomes watered
```

Although this shares the broad tool ingress with tilling, it has a different tool dispatcher, resource rule and effect domain. It remains a separate kernel.

### 3.4 `soil.harvest_grab`

```text
typed inputs:
  live ready ordinary crop with Grab harvest method + inventory capacity

source path:
  GameLocation.checkAction
  → HoeDirt.performUseAction
  → Crop.harvest
  → HoeDirt.destroyCrop (when native rules require it)

commit:
  first item enters inventory when accepted; additional output may become Debris;
  crop/regrow state progresses under native rules
```

This remains separate: it has a different ingress, readiness predicate, capacity branch, deterministic/RNG yield effects, possible debris, crop destruction/regrow transition and receipt evidence shape.

## 4. Composition is also source-derived

The normal gameplay sequence is not a single kernel:

```text
soil.till
→ soil.apply_input[inputKind=seed]
→ soil.hydrate
→ native day progression + fresh observation
→ soil.harvest_grab
```

`native day progression + fresh observation` is a boundary, not an action that the soil kernel may synthesize. This preserves the existing rule that no Farmhand primitive may skip native day/save/multiplayer lifecycle.

## 5. Verification consequence

The correct reusable test unit becomes:

```text
semantic kernel × source-proved parameter family × risk/lifecycle branch
```

For the shared `soil.apply_input` kernel this yields, at minimum:

| Proof | Required before any API merge/publish claim |
|---|---|
| Source proof | Exact re-derivation confirms shared wrapper, category union, `HoeDirt.plant` discriminant and consumption ordering. |
| Bridge equivalence | Each bridge route preserves normal-player target, range, ownership, item-slot and native guard behavior or proves a stricter substitute. |
| Contract tests | Closed `seed | fertilizer` union; wrong category/slot/stale target/revision/deadline/idempotency fail closed; receipts remain variant-specific. |
| Live proof: seed | Native AI Farmhand plants an eligible seed with exact crop creation and exact inventory delta. |
| Live proof: fertilizer | Native AI Farmhand applies an eligible fertilizer with exact fertilizer field and exact inventory delta. |
| Regression | A source-anchor change invalidates the derived report; a changed variant cannot inherit the other variant's live proof. |

Thus the prototype reduces duplicate API/kernel reasoning while retaining two discriminated real-game validation obligations. It does **not** use source reuse to convert a fertilizer live proof into a seed live proof, or vice versa.

## 6. Limits and next decision

This artifact establishes only a methodology result for one bounded domain. It does not establish a globally minimal action set and does not change `design/12_STARDEW_PRIMITIVE_ACTION_BASIS.md`, the catalog, policy, bridge schemas, or registry.

The next safe step is a **compatibility decision**, not implementation:

```text
Can a versioned public `apply_soil_input` schema preserve every existing
plant_seed/fertilize_tile authority, capability and receipt guarantee,
while aliases/migration remain fail-closed?
```

If the answer is no, the source-derived kernel remains an internal verification/factorization unit while the two public actions remain separate projections. That is still a successful result: public API granularity and native implementation-kernel granularity need not be identical.
