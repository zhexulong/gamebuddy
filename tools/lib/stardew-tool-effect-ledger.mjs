import { createHash } from "node:crypto";
import { methodBody } from "./stardew-source-semantic-kernel.mjs";

export const TOOL_EFFECT_LEDGER_SCHEMA_VERSION = 1;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message, details = {}) {
  const error = new Error(message);
  error.code = "stardew_tool_effect_ledger_evidence_missing";
  error.details = details;
  throw error;
}

function requireMethod(sources, sourceFile, methodName) {
  const source = sources[sourceFile];
  if (typeof source !== "string") fail(`Missing source file ${sourceFile}.`, { sourceFile });
  const body = methodBody(source, methodName);
  if (body === null) fail(`Missing source method ${sourceFile}:${methodName}.`, { sourceFile, methodName });
  return body;
}

function evidence(sources, sourceFile, methodName, fragments) {
  const body = requireMethod(sources, sourceFile, methodName);
  const missingFragments = fragments.filter((fragment) => !body.includes(fragment));
  if (missingFragments.length)
    fail(`Expected target-version effect anchors changed in ${sourceFile}:${methodName}.`, {
      sourceFile,
      methodName,
      missingFragments,
    });
  return Object.freeze({
    sourceFile,
    methodName,
    bodySha256: sha256(body),
    requiredFragments: Object.freeze([...fragments]),
  });
}

function entry(specification) {
  const {
    entryId,
    sourceMethods,
    normalIngress,
    summaryState = "source_effect_summary_partial",
    typedInputs,
    guards,
    writes,
    lifecycle,
    unknownSinks,
    implementationReuse,
    publicProjection,
    evidence = specification.sourceEvidence,
  } = specification;
  if (!Array.isArray(evidence) || evidence.length === 0) fail(`Missing source evidence for ${entryId}.`, { entryId });
  return Object.freeze({
    entryId,
    state: summaryState,
    sourceMethods: Object.freeze(sourceMethods),
    normalPlayerIngress: normalIngress,
    typedInputs: Object.freeze(typedInputs),
    guards: Object.freeze(guards),
    writes: Object.freeze(writes),
    lifecycle,
    unknownSinks: Object.freeze(unknownSinks),
    implementationReuse,
    publicProjection,
    sourceEvidence: Object.freeze([...evidence]),
  });
}

/**
 * Produce bounded, source-anchored effect summaries for tool families.
 * This is intentionally a hand-specified audit schema, not a general C# or
 * whole-program effect inferencer: every material fact needs an exact source
 * anchor, and unresolved virtual/content/event calls remain explicit sinks.
 */
export function deriveStardewToolEffectLedger(sources) {
  const sourceEvidence = Object.freeze({
    hoe: evidence(sources, "StardewValley/Tools/Hoe.cs", "DoFunction", [
      "tilesAffected(vector, power, who)",
      "location.makeHoeDirt(item)",
      "location.checkForBuriedItem",
      "Game1.stats.DirtHoed++",
    ]),
    axe: evidence(sources, "StardewValley/Tools/Axe.cs", "DoFunction", [
      "location.performToolAction(this, num, num2)",
      "value.performToolAction(this, 0, tile)",
      "largeFeature.performToolAction(this, 0, tile)",
      "value2.performToolAction(this)",
      "location.Objects.Remove(key)",
    ]),
    pickaxe: evidence(sources, "StardewValley/Tools/Pickaxe.cs", "DoFunction", [
      "location.performToolAction(this, num, num2)",
      "value.IsBreakableStone()",
      "value.minutesUntilReady.Value -=",
      "location.OnStoneDestroyed(value.ItemId, num, num2",
      "location.Objects.Remove(new Vector2(num, num2))",
      'value.Name.Contains("Boulder")',
    ]),
    wateringCan: evidence(sources, "StardewValley/Tools/WateringCan.cs", "DoFunction", [
      "Game1.currentLocation.CanRefillWateringCanOnTile",
      "WaterLeft = waterCanMax",
      "WaterLeft > 0 || who.hasWateringCanEnchantment",
      "value.performToolAction(this, 0, item)",
      "value2.performToolAction(this)",
      "location.performToolAction(this",
      "WaterLeft -= power + 1",
    ]),
    panBegin: evidence(sources, "StardewValley/Tools/Pan.cs", "beginUsing", [
      "location.orePanPoint",
      "Utility.distance",
      "who.FarmerSprite.animateOnce(303",
      "who.forceCanMove()",
    ]),
    panCommit: evidence(sources, "StardewValley/Tools/Pan.cs", "DoFunction", [
      "who.addItemsByMenuIfNecessary(getPanItems(location, who))",
      "location.orePanPoint.Value = Point.Zero",
      "location.performOrePanTenMinuteUpdate",
      "finish()",
    ]),
    panFinish: evidence(sources, "StardewValley/Tools/Pan.cs", "doFinish", [
      "lastUser.CanMove = true",
      "lastUser.UsingTool = false",
      "lastUser.canReleaseTool = true",
    ]),
    fishingBegin: evidence(sources, "StardewValley/Tools/FishingRod.cs", "beginUsing", [
      "isTimingCast = true",
      "who.UsingTool = true",
      "who.canMove = false",
      "who.canReleaseTool = false",
      "setTimingCastAnimation(who)",
    ]),
    fishingDo: evidence(sources, "StardewValley/Tools/FishingRod.cs", "DoFunction", [
      "location.canFishHere() && location.isTileFishable",
      "isFishing = true",
      "timeUntilFishingBite = calculateTimeUntilFishingBite",
      "who.UsingTool = true",
      "who.canMove = false",
    ]),
    toolEnd: evidence(sources, "StardewValley/Tool.cs", "endUsing", [
      "this is FishingRod fishingRod && who.IsLocalPlayer",
      "DoFunction(who.currentLocation, (int)who.lastClick.X",
    ]),
    meleeSpecial: evidence(sources, "StardewValley/Tools/MeleeWeapon.cs", "animateSpecialMove", [
      "specialCooldown() <= 0",
      "animateSpecialMoveEvent.Fire()",
    ]),
    meleeDamage: evidence(sources, "StardewValley/Tools/MeleeWeapon.cs", "DoDamage", [
      "if (!who.IsLocalPlayer)",
      "location.damageMonster(areaOfEffect",
      "location.projectiles.RemoveWhere",
      "value.performToolAction(this, 0, item)",
      "location.performToolAction(this, (int)item.X, (int)item.Y)",
    ]),
    normalToolIngress: evidence(sources, "StardewValley/Game1.cs", "pressUseToolButton", [
      "player.CurrentTool != null",
      "player.BeginUsingTool()",
    ]),
    beginToolDispatch: evidence(sources, "StardewValley/Farmer.cs", "performBeginUsingTool", [
      "CurrentTool != null",
      "CurrentTool.beginUsing(base.currentLocation, (int)lastClick.X, (int)lastClick.Y, this)",
    ]),
  });
  const ordinaryToolIngress = Object.freeze([sourceEvidence.normalToolIngress, sourceEvidence.beginToolDispatch]);

  return Object.freeze({
    schemaVersion: TOOL_EFFECT_LEDGER_SCHEMA_VERSION,
    state: "source_effect_summary_partial",
    nonRuntimeNotice:
      "This source-anchored ledger does not create, merge, publish, authorize, execute, or validate a GameBuddy action. It is not a substitute for typed bridge equivalence, contract tests, native AI-Farmhand live receipts, or policy publication.",
    scope: Object.freeze({
      included: Object.freeze(["Hoe", "Axe", "Pickaxe", "WateringCan", "Pan", "FishingRod", "MeleeWeapon"]),
      excluded: Object.freeze([
        "raw input/UI dispatch",
        "arbitrary virtual target effects",
        "content-driven reward enumeration",
        "save/network/event completion proof",
      ]),
      method:
        "Only explicitly anchored target-version facts are summarized. Dispatches outside the anchored method body remain unknown sinks rather than inferred effects.",
    }),
    entries: Object.freeze([
      entry({
        entryId: "tool.hoe.apply_to_affected_tiles",
        sourceMethods: ["Hoe.DoFunction"],
        normalIngress: "source-proved: Game1.pressUseToolButton → Tool.DoFunction → Hoe.DoFunction",
        typedInputs: ["equipped Hoe", "live target tile", "tool power", "native Farmer/Farmhand"],
        guards: [
          "tile set is computed by native tilesAffected",
          "terrain/object branches run before Diggable branch",
          "Diggable tile has mine/occupancy/passability conditions",
        ],
        writes: [
          "may delegate terrain/object tool effects",
          "may remove terrain/object after their own true return",
          "may create HoeDirt",
          "may produce buried-item effects",
          "increments DirtHoed statistic",
        ],
        lifecycle:
          "synchronous tool callback over a possibly multi-tile set; target-specific delegated effects are unresolved here.",
        unknownSinks: [
          "TerrainFeature.performToolAction",
          "Object.performToolAction",
          "GameLocation.makeHoeDirt/checkForBuriedItem internals",
          "content/item drops",
        ],
        implementationReuse:
          "candidate shared target-tool-dispatch loop with Axe/Pickaxe/MeleeWeapon; semantic equivalence unproven because order, target types and commits differ.",
        publicProjection: "not_inferred; current till_soil remains a narrow public projection, not generic hoe use.",
        sourceEvidence: Object.freeze([...ordinaryToolIngress, sourceEvidence.hoe]),
      }),
      entry({
        entryId: "tool.axe.apply_to_tile_targets",
        sourceMethods: ["Axe.DoFunction"],
        normalIngress: "source-proved: Game1.pressUseToolButton → Tool.DoFunction → Axe.DoFunction",
        typedInputs: ["equipped Axe", "one live tile", "tool power/upgrade", "native Farmer/Farmhand"],
        guards: ["TreeStump building tile returns early", "target may be location, terrain, large terrain or object"],
        writes: [
          "stamina may decrease",
          "delegates location/terrain/large-terrain/object tool action",
          "may remove terrain/large terrain/object",
          "may create crafting debris",
        ],
        lifecycle:
          "synchronous callback; temporary upgrade additionalPower is applied then reverted around target processing.",
        unknownSinks: [
          "GameLocation.performToolAction",
          "TerrainFeature/LargeTerrainFeature/Object.performToolAction",
          "target-specific drops and authority",
        ],
        implementationReuse:
          "candidate common tile-tool dispatcher with Hoe/Pickaxe, but distinct target precedence/removal and stamina semantics prevent kernel equivalence claim.",
        publicProjection: "not_inferred; no generic axe action or resource action follows from this summary.",
        sourceEvidence: Object.freeze([...ordinaryToolIngress, sourceEvidence.axe]),
      }),
      entry({
        entryId: "tool.pickaxe.apply_to_tile_targets",
        sourceMethods: ["Pickaxe.DoFunction"],
        normalIngress: "source-proved: Game1.pressUseToolButton → Tool.DoFunction → Pickaxe.DoFunction",
        typedInputs: ["equipped Pickaxe", "live tile/object", "tool power/upgrade", "native Farmer/Farmhand"],
        guards: [
          "location tool action can terminate early",
          "breakable stone has durability branch",
          "boulder has upgrade and repeated-hit state conditions",
        ],
        writes: [
          "stamina may decrease",
          "may delegate location/terrain/object tool effects",
          "may decrement stone durability",
          "may call OnStoneDestroyed",
          "may remove a destroyed stone/object",
          "may mutate per-tool boulder hit state",
        ],
        lifecycle:
          "one callback can be partial progress rather than a terminal resource collection; boulder completion spans multiple calls.",
        unknownSinks: [
          "GameLocation.performToolAction",
          "Object.OnStoneDestroyed/drop internals",
          "TerrainFeature.performToolAction",
          "random debris/reward branches",
        ],
        implementationReuse:
          "candidate shared tool dispatch loop only; partial durability and multi-hit boulder state force distinct resource-transition families.",
        publicProjection:
          "not_inferred; source does not justify one break_resource action or a success receipt before target-specific completion is observed.",
        sourceEvidence: Object.freeze([...ordinaryToolIngress, sourceEvidence.pickaxe]),
      }),
      entry({
        entryId: "tool.watering_can.refill",
        sourceMethods: ["WateringCan.DoFunction"],
        normalIngress: "source-proved: Game1.pressUseToolButton → Tool.DoFunction → WateringCan.DoFunction",
        typedInputs: ["equipped Watering Can", "live refillable tile", "native Farmer/Farmhand"],
        guards: ["GameLocation.CanRefillWateringCanOnTile"],
        writes: ["sets waterLeft to waterCanMax", "plays native sound/animation side effects"],
        lifecycle: "synchronous refill branch, mutually exclusive with application branch.",
        unknownSinks: ["CanRefillWateringCanOnTile target semantics"],
        implementationReuse:
          "same method as water application but a distinct mutually exclusive native branch and target domain.",
        publicProjection: "not_inferred; must not be folded into water_crop.",
        sourceEvidence: Object.freeze([...ordinaryToolIngress, sourceEvidence.wateringCan]),
      }),
      entry({
        entryId: "tool.watering_can.apply_to_affected_tiles",
        sourceMethods: ["WateringCan.DoFunction"],
        normalIngress: "source-proved: Game1.pressUseToolButton → Tool.DoFunction → WateringCan.DoFunction",
        typedInputs: [
          "equipped Watering Can",
          "native multi-tile affected set",
          "water/enchantment",
          "native Farmer/Farmhand",
        ],
        guards: ["water available or watering-can enchantment", "native tilesAffected determines affected set"],
        writes: [
          "may delegate terrain/object/location tool effects per tile",
          "decrements waterLeft unless bottomless",
          "may consume stamina",
          "emits native animation effects",
        ],
        lifecycle: "synchronous loop; one invocation can affect multiple heterogeneous targets.",
        unknownSinks: [
          "TerrainFeature/Object/GameLocation.performToolAction",
          "target-specific watered/effect semantics",
          "multi-target receipt projection",
        ],
        implementationReuse:
          "implementation loop resembles other tools but resource consumption and multi-target water semantics are distinct.",
        publicProjection:
          "not_inferred; water_crop is a deliberate narrow single live-crop projection, not a generic can action.",
        sourceEvidence: Object.freeze([...ordinaryToolIngress, sourceEvidence.wateringCan]),
      }),
      entry({
        entryId: "tool.pan.collect_ore_pan_point",
        sourceMethods: ["Pan.beginUsing", "Pan.DoFunction", "Pan.doFinish"],
        normalIngress:
          "source-proved: Game1.pressUseToolButton → Farmer.BeginUsingTool → Pan.beginUsing; delayed native completion invokes DoFunction/finish event",
        typedInputs: ["equipped Pan", "live orePanPoint within reach", "native Farmer/Farmhand"],
        guards: ["ore pan point exists and is within reach/intersects bounds"],
        writes: [
          "native item delivery via addItemsByMenuIfNecessary",
          "clears orePanPoint",
          "may seed future ore-pan point",
          "finish event restores movement/tool state",
        ],
        lifecycle:
          "temporal animation/event lifecycle; beginUsing validates and animates, DoFunction commits, finish event releases actor.",
        unknownSinks: [
          "getPanItems RNG/content/enchantment branches",
          "addItemsByMenuIfNecessary capacity behavior",
          "finish-event/network timing",
        ],
        implementationReuse:
          "no cross-tool semantic kernel asserted; delayed completion and randomized multi-item result are defining semantics.",
        publicProjection:
          "not_inferred; any future collection action requires temporal receipt and exact inventory/point evidence.",
        sourceEvidence: Object.freeze([
          ...ordinaryToolIngress,
          sourceEvidence.panBegin,
          sourceEvidence.panCommit,
          sourceEvidence.panFinish,
        ]),
      }),
      entry({
        entryId: "tool.fishing_rod.cast_and_begin_wait",
        sourceMethods: ["FishingRod.beginUsing", "Tool.endUsing", "FishingRod.DoFunction"],
        normalIngress:
          "source-proved: Game1.pressUseToolButton → Farmer.BeginUsingTool → FishingRod.beginUsing; tool release → Tool.endUsing → FishingRod.DoFunction",
        typedInputs: ["equipped FishingRod", "cast direction/timing", "live fishable tile", "native Farmer/Farmhand"],
        guards: ["beginUsing has stamina guard", "DoFunction requires fishable location/tile for fishing state"],
        writes: [
          "sets timing-cast/tool-lock state",
          "sets isFishing and timeUntilFishingBite",
          "locks movement while fishing begins",
          "may consume stamina",
        ],
        lifecycle:
          "multi-phase temporal protocol: timing cast → release/cast → bite/wait → later nibble/reel/catch paths; this summary ends at begin-wait.",
        unknownSinks: [
          "input timing/release path",
          "fish selection/RNG/content",
          "minigame/reeling/catch completion",
          "bait/tackle consumption",
          "network/event timing",
        ],
        implementationReuse:
          "no generic tool-use equivalence: Tool.endUsing is a polymorphic lifecycle boundary and fishing owns a multi-phase state machine.",
        publicProjection:
          "not_inferred; neither cast nor catch is exposed by this ledger, and generic Tool.endUsing remains prohibited.",
        sourceEvidence: Object.freeze([
          ...ordinaryToolIngress,
          sourceEvidence.fishingBegin,
          sourceEvidence.toolEnd,
          sourceEvidence.fishingDo,
        ]),
      }),
      entry({
        entryId: "tool.melee_weapon.special_move",
        sourceMethods: ["MeleeWeapon.animateSpecialMove", "MeleeWeapon.DoDamage"],
        normalIngress:
          "source boundary candidate only; this ledger does not reconstruct a normal-player special-move or ordinary DoDamage ingress",
        typedInputs: [
          "equipped MeleeWeapon",
          "weapon type/cooldown",
          "native Farmer/Farmhand",
          "nearby combat/terrain targets",
        ],
        guards: [
          "special move excludes some scythe/defense states",
          "specialCooldown must be non-positive",
          "DoDamage returns for non-local player",
        ],
        writes: [
          "fires native special-move event",
          "DoDamage may damage monsters, destroy projectiles, and delegate terrain/object/location tool effects",
        ],
        lifecycle:
          "event/animation-driven; weapon type selects distinct special behavior and ordinary swings have a separate unproven ingress analysis.",
        unknownSinks: [
          "special event handler/type-specific behavior",
          "damageMonster combat/RNG/death effects",
          "terrain/object/location tool dispatch",
          "ordinary attack ingress",
        ],
        implementationReuse:
          "shared DoDamage target loop is implementation reuse only; weapon type, cooldown, event timing and combat outcomes prevent public equivalence.",
        publicProjection:
          "not_inferred; do not expose generic attack or raw DoDamage. A future typed combat action needs an independently source-proved ingress and live authority proof.",
        sourceEvidence: Object.freeze([sourceEvidence.meleeSpecial, sourceEvidence.meleeDamage]),
      }),
    ]),
    reuseHypotheses: Object.freeze([
      Object.freeze({
        hypothesisId: "tile_tool_target_dispatch",
        members: Object.freeze([
          "tool.hoe.apply_to_affected_tiles",
          "tool.axe.apply_to_tile_targets",
          "tool.pickaxe.apply_to_tile_targets",
          "tool.watering_can.apply_to_affected_tiles",
          "tool.melee_weapon.special_move",
        ]),
        conclusion: "implementation_reuse_candidate_only",
        rejectionRisk:
          "The order, target types, mutation/removal conditions, resources and terminal states differ; public API equivalence is unproven.",
      }),
      Object.freeze({
        hypothesisId: "temporal_tool_commit",
        members: Object.freeze([
          "tool.pan.collect_ore_pan_point",
          "tool.fishing_rod.cast_and_begin_wait",
          "tool.melee_weapon.special_move",
        ]),
        conclusion: "lifecycle_shape_similarity_only",
        rejectionRisk:
          "Native animation/event phases have different authority, cancellation and terminal evidence; no shared action/kernel follows.",
      }),
    ]),
    requiredNextProofs: Object.freeze([
      "Expand each unknown virtual/content/event sink into a bounded source or runtime evidence slice before treating its write set as complete.",
      "Compare a proposed public action contract independently; this ledger deliberately never maps one source summary to a public action.",
      "For every materialized action, prove typed bridge equivalence and complete contract, target-version native AI-Farmhand live receipt/postcondition, and publication gates.",
    ]),
  });
}
