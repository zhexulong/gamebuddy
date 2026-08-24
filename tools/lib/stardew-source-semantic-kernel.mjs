import { createHash } from "node:crypto";

const PROTOTYPE_ID = "stardew_1_6_15_soil_tile_semantic_kernels_v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFailure(message, details = {}) {
  const error = new Error(message);
  error.code = "source_semantic_kernel_evidence_missing";
  error.details = details;
  throw error;
}

/**
 * Return one named method body from decompiled C#. It is deliberately small:
 * this prototype uses fixed, version-locked anchors and fails closed if the
 * expected method shape is not present. It is not a general C# parser.
 */
export function methodBody(source, methodName) {
  if (typeof source !== "string") return null;
  const declaration = new RegExp(
    String.raw`(?:^|\n)\s*(?:public|private|protected|internal)\s+(?:(?:static|virtual|override|sealed|async)\s+)*(?:[\w<>,.?\[\]]+\s+)+${methodName}\s*\([^;{}]*\)\s*\{`,
    "g",
  );
  const match = declaration.exec(source);
  if (!match) return null;
  const openBrace = match.index + match[0].length - 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(openBrace + 1, index);
  }
  return null;
}

function requireMethod(sources, sourceFile, methodName) {
  const source = sources[sourceFile];
  if (typeof source !== "string") sourceFailure(`Missing source file ${sourceFile}.`, { sourceFile });
  const body = methodBody(source, methodName);
  if (body === null) sourceFailure(`Missing required method ${sourceFile}:${methodName}.`, { sourceFile, methodName });
  return body;
}

function requireFragments(body, sourceFile, methodName, fragments) {
  const missingFragments = fragments.filter((fragment) => !body.includes(fragment));
  if (missingFragments.length) {
    sourceFailure(`Source evidence changed for ${sourceFile}:${methodName}.`, {
      sourceFile,
      methodName,
      missingFragments,
    });
  }
  return Object.freeze({
    sourceFile,
    methodName,
    bodySha256: sha256(body),
    requiredFragments: Object.freeze([...fragments]),
  });
}

/**
 * Derive a bounded semantic factorization from exact target-version source.
 *
 * This is intentionally not an action registry and never grants a bridge
 * capability. It demonstrates the source-first claim on one closed domain:
 * a soil tile. The returned source anchors prove the factorization and cause
 * a fail-closed result if the target source drifts.
 */
export function deriveSoilTileSemanticKernels(sources) {
  const hoe = requireMethod(sources, "StardewValley/Tools/Hoe.cs", "DoFunction");
  const wateringCan = requireMethod(sources, "StardewValley/Tools/WateringCan.cs", "DoFunction");
  const hoeDirtUse = requireMethod(sources, "StardewValley/TerrainFeatures/HoeDirt.cs", "performUseAction");
  const hoeDirtPlant = requireMethod(sources, "StardewValley/TerrainFeatures/HoeDirt.cs", "plant");
  const hoeDirtTool = requireMethod(sources, "StardewValley/TerrainFeatures/HoeDirt.cs", "performToolAction");
  const objectPlacement = requireMethod(sources, "StardewValley/Object.cs", "placementAction");
  const utilityPlacement = requireMethod(sources, "StardewValley/Utility.cs", "tryToPlaceItem");
  const cropHarvest = requireMethod(sources, "StardewValley/Crop.cs", "harvest");
  const game1ToolInput = requireMethod(sources, "StardewValley/Game1.cs", "pressUseToolButton");

  const evidence = Object.freeze({
    playerToolIngress: requireFragments(game1ToolInput, "StardewValley/Game1.cs", "pressUseToolButton", [
      "player.CurrentTool.DoFunction",
      "Utility.tryToPlaceItem(currentLocation, player.ActiveObject",
    ]),
    till: requireFragments(hoe, "StardewValley/Tools/Hoe.cs", "DoFunction", [
      "tilesAffected(vector, power, who)",
      "location.makeHoeDirt(item)",
      "location.checkForBuriedItem",
    ]),
    inputDispatch: requireFragments(objectPlacement, "StardewValley/Object.cs", "placementAction", [
      "base.Category == -74 || base.Category == -19",
      "dirt.canPlantThisSeedHere(text4, who.ActiveObject.Category == -19)",
      "dirt.plant(text4, who, who.ActiveObject.Category == -19)",
      "item2.Category == -19 && dirt.plant(item2.ItemId, who, isFertilizer: true)",
    ]),
    inputCommit: requireFragments(utilityPlacement, "StardewValley/Utility.cs", "tryToPlaceItem", [
      "item.placementAction(location, x, y, Game1.player)",
      "Game1.player.reduceActiveItemByOne()",
    ]),
    inputVariants: requireFragments(hoeDirtPlant, "StardewValley/TerrainFeatures/HoeDirt.cs", "plant", [
      "if (isFertilizer)",
      "CanApplyFertilizer(itemId)",
      "fertilizer.Value = ItemRegistry.QualifyItemId(itemId) ?? itemId",
      "Crop.ResolveSeedId(itemId, location)",
      "who.currentLocation.CheckItemPlantRules",
      "who.currentLocation.CanPlantSeedsHere",
      "crop = new Crop(itemId, point.X, point.Y, Location)",
    ]),
    hydrate: requireFragments(wateringCan, "StardewValley/Tools/WateringCan.cs", "DoFunction", [
      "CanRefillWateringCanOnTile",
      "WaterLeft > 0 || who.hasWateringCanEnchantment",
      "value.performToolAction(this, 0, item)",
    ]),
    hydrateTargetCommit: requireFragments(
      hoeDirtTool,
      "StardewValley/TerrainFeatures/HoeDirt.cs",
      "performToolAction",
      ["if (t is WateringCan)", "state.Value = 1"],
    ),
    harvestDispatch: requireFragments(hoeDirtUse, "StardewValley/TerrainFeatures/HoeDirt.cs", "performUseAction", [
      "HarvestMethod.Grab",
      "crop.harvest((int)tileLocation.X, (int)tileLocation.Y, this)",
      "destroyCrop(showAnimation: false)",
    ]),
    harvestCommit: requireFragments(cropHarvest, "StardewValley/Crop.cs", "harvest", [
      "currentPhase.Value >= phaseDays.Count - 1",
      "Game1.player.addItemToInventoryBool(item.getOne())",
      "Game1.createItemDebris(item.getOne()",
    ]),
  });

  return Object.freeze({
    schemaVersion: 1,
    prototypeId: PROTOTYPE_ID,
    state: "source_derived_candidate",
    nonRuntimeNotice:
      "This source-derived factorization does not add, merge, publish, authorize, or materialize a GameBuddy action. Each candidate still requires bridge-equivalence, action-level contract, target-version live evidence, and publish evidence.",
    domain: Object.freeze({
      actor: "native Farmer/Farmhand",
      target: "one live HoeDirt-capable tile",
      excluded: Object.freeze([
        "UI/menu input",
        "raw dispatcher invocation",
        "arbitrary item placement",
        "day progression",
        "direct state mutation",
      ]),
    }),
    sourceEvidence: evidence,
    semanticKernels: Object.freeze([
      Object.freeze({
        kernelId: "soil.till",
        sourcePath: Object.freeze(["Game1.pressUseToolButton", "Hoe.DoFunction", "GameLocation.makeHoeDirt"]),
        typedInputs: Object.freeze(["live diggable tile", "equipped Hoe"]),
        commit: "A HoeDirt terrain feature is created for an affected valid tile.",
        evidence: Object.freeze(["sourceEvidence.playerToolIngress", "sourceEvidence.till"]),
        existingProjection: Object.freeze(["till_soil"]),
        factorizationDecision: "distinct_kernel",
        whyNotMerged: "Its initiator is tool use and its commit creates the soil target that later kernels consume.",
      }),
      Object.freeze({
        kernelId: "soil.apply_input",
        sourcePath: Object.freeze([
          "Game1.pressUseToolButton",
          "Utility.tryToPlaceItem",
          "Object.placementAction",
          "HoeDirt.plant",
        ]),
        typedInputs: Object.freeze([
          "live HoeDirt tile",
          "owned active agricultural Object",
          "inputKind: seed | fertilizer",
        ]),
        commit:
          "The same source transition dispatches a closed input union to HoeDirt.plant, then decrements the consumed active item only after placementAction succeeds.",
        evidence: Object.freeze([
          "sourceEvidence.playerToolIngress",
          "sourceEvidence.inputDispatch",
          "sourceEvidence.inputCommit",
          "sourceEvidence.inputVariants",
        ]),
        variants: Object.freeze([
          Object.freeze({
            inputKind: "seed",
            sourceDiscriminant: "Object.Category == -74",
            postcondition:
              "HoeDirt.crop is created after season/location/seed rules pass; exactly one active seed is consumed. The source also contains a conditional special-sprinkler side effect which may apply fertilizer from its own locked chest inventory; this is not an extra Farmhand inventory consumption.",
          }),
          Object.freeze({
            inputKind: "fertilizer",
            sourceDiscriminant: "Object.Category == -19",
            postcondition:
              "HoeDirt.fertilizer is assigned only when CanApplyFertilizer passes; exactly one active fertilizer is consumed.",
          }),
        ]),
        existingProjection: Object.freeze(["plant_seed", "fertilize_tile"]),
        factorizationDecision: "one_parameterized_kernel_candidate",
        reason:
          "The exact same human ingress, Utility consumption wrapper, Object category branch, target predicate call shape, and HoeDirt.plant transition own both variants. Their differing commits are a closed source discriminated union, not two unrelated implementations.",
        publicContractConstraint:
          "A future unified public schema must retain inputKind-specific preconditions, receipt evidence, and terminal states; it must not accept arbitrary placeable objects or expose Object.placementAction.",
      }),
      Object.freeze({
        kernelId: "soil.hydrate",
        sourcePath: Object.freeze(["Game1.pressUseToolButton", "WateringCan.DoFunction", "HoeDirt.performToolAction"]),
        typedInputs: Object.freeze(["live HoeDirt/crop tile", "equipped WateringCan with water or enchantment"]),
        commit: "HoeDirt state is set to watered by the WateringCan target branch.",
        evidence: Object.freeze([
          "sourceEvidence.playerToolIngress",
          "sourceEvidence.hydrate",
          "sourceEvidence.hydrateTargetCommit",
        ]),
        existingProjection: Object.freeze(["water_crop"]),
        factorizationDecision: "distinct_kernel",
        whyNotMerged:
          "Although it shares tool ingress, it uses a distinct tool dispatcher and commits water state rather than a crop/fertilizer input transition.",
      }),
      Object.freeze({
        kernelId: "soil.harvest_grab",
        sourcePath: Object.freeze([
          "GameLocation.checkAction",
          "HoeDirt.performUseAction",
          "Crop.harvest",
          "HoeDirt.destroyCrop",
        ]),
        typedInputs: Object.freeze(["live ready ordinary grab-harvest crop", "inventory capacity"]),
        commit:
          "Crop.harvest delivers the first harvest item to inventory when possible, may create additional debris, and HoeDirt destroys/non-regrows according to native crop rules.",
        evidence: Object.freeze(["sourceEvidence.harvestDispatch", "sourceEvidence.harvestCommit"]),
        existingProjection: Object.freeze(["harvest_crop"]),
        factorizationDecision: "distinct_kernel",
        whyNotMerged:
          "It uses interaction rather than item-placement/tool dispatch and has a distinct readiness, delivery, RNG/extra-debris, regrow, and destruction lifecycle.",
      }),
    ]),
    compositeCandidates: Object.freeze([
      Object.freeze({
        compositeId: "grow_one_crop_to_harvestable_state",
        orderedKernels: Object.freeze([
          "soil.till",
          "soil.apply_input[inputKind=seed]",
          "soil.hydrate",
          "native_day_progression_and_fresh_observation",
          "soil.harvest_grab",
        ]),
        nonKernelBoundary:
          "Native day progression is neither a soil primitive nor a synthetic time advance; it remains a coordination/lifecycle boundary.",
      }),
    ]),
    factorization: Object.freeze({
      existingPublishedActionCountInDomain: 5,
      sourceDerivedKernelCount: 4,
      projections: Object.freeze({
        till_soil: "soil.till",
        plant_seed: "soil.apply_input[inputKind=seed]",
        fertilize_tile: "soil.apply_input[inputKind=fertilizer]",
        water_crop: "soil.hydrate",
        harvest_crop: "soil.harvest_grab",
      }),
      conclusion:
        "The pinned source proves one reusable, closed agricultural-input kernel with two typed variants. It does not prove that every soil lifecycle belongs to one generic action.",
    }),
    requiredNextProofs: Object.freeze([
      "Prove each GameBuddy bridge route preserves the normal-player guards or supplies a stricter source-backed substitute.",
      "Decide whether an API migration from plant_seed/fertilize_tile to apply_soil_input preserves action policy, capability publication, receipt compatibility, and per-variant evidence without widening authority.",
      "Run target-version native AI-Farmhand live closure for each non-equivalent kernel and for each inputKind branch of soil.apply_input before any publication claim.",
      "Prove the composite day/fresh-observation boundary independently; a source-derived primitive kernel never permits direct day advancement.",
    ]),
  });
}
