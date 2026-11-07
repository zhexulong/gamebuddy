/**
 * Which native fields the model is never shown, and why that is allowed.
 *
 * The defect this exists for is not one missing field - it is the SHAPE of how fields go missing.
 * `SNAPSHOT_KEYS` (`host/src/protocol.ts:1599`) declares what the Mod publishes. Five projections decide what
 * reaches the model: `snapshot-projection.ts` (the user-turn fact block),
 * `runtime-core.internal.ts` (the `<runtime-environment>` line), `stardew-observation-budget.ts` (the
 * `stardew_observe` payload), `body-program-script.ts` (the plan builder's action set) and
 * `snapshot-hud.ts` (the standing state block re-sent with every turn). When the native layer
 * grows a field, nothing forces any of them to notice.
 *
 * Measured 2026-10-28: `actorDispositionDetail` had been on the wire since the disposition work
 * (`farmhandexecutioncontroller.cs:2401`, `protocol.ts:272-276`), and a `ShippingMenu` owned the screen while the
 * projection said `Actionable: true`. The model read that as "nothing is in the way", announced it was going to
 * pick cauliflowers, and the game clock stayed frozen at 06:00 for 31 minutes.
 *
 * Measured 2026-11-02: the population checked here was a hand-written seventeen-key list, so the six sense-shaped
 * fields that were published and read by no projection (`weather`, `cropTargets`, `npcRelationshipTargets`,
 * `animalProductTargets`, `scytheCropTargets`, `animalDoorTargets`) were invisible to it - the list would have
 * stayed at seventeen forever. The population is now the WIRE SCHEMA's own property set
 * (`protocol/bridge-v1.schema.json` `$defs.snapshot.properties`), so a field added to the Mod is a decision
 * someone has to make here, by name, rather than a fact nobody noticed.
 *
 * This is a static check over source and types, not a render. It answers "does any projection look at this key",
 * which is the question that went unanswered. Whether a read field is RENDERED WELL is each projection's own
 * tests' job - this gate would not have caught a wrong label, and must not pretend to.
 */

/** Keys the projections are expected to read. The gate fails when one of these stops being read. */
export const REQUIRED_PROJECTED_KEYS = Object.freeze([
  "revision",
  "location",
  "tile",
  "stamina",
  "exhausted",
  "health",
  "currentTool",
  "actorDispositionKind",
  "actorDispositionDetail",
  "actorDispositionActionOwned",
  "dayOfMonth",
  "seasonIndex",
  "year",
  "timeOfDay",
  "weather",
  "catalogRevision",
  "capabilities",
  // The current map's live kitchen: the per-turn line answers "is there a stove here" from it, which is what
  // the farmhouse's own form is (it gains its kitchen with its upgrade). Measured 2026-11-05.
  "cookingStationTargets",
]);

/**
 * The reason every world target/entity family is allowed to stay out of the always-on fact block.
 *
 * `snapshot-projection.ts` is bounded to `MAX_GAME_SNAPSHOT_PROJECTION_BYTES` (4 KB) and is attached to EVERY
 * turn, so it carries only the highest-value senses; a single family can be 64 per-tile rows (measured
 * 2026-11-02: `cropTargets` alone is ~5.7 KB, over the whole projection cap, so projecting it would make the
 * projection `invalid` and blind the model entirely). Every one of these families is delivered verbatim, on
 * demand, by a solicited `stardew_observe` - the observation budget spreads the snapshot and shortens only the
 * families it names - and the action that addresses a row reads it from there.
 */
const OBSERVED_FAMILY_REASON =
  "Delivered verbatim, on demand, by a solicited `stardew_observe` (the observation budget copies the field through); not carried by the byte-bounded per-turn fact block.";

/**
 * The array families read by no projection and delivered by a solicited observation.
 *
 * Derived from the wire schema's array properties (`type: "array"`) minus the families a projection reads - see
 * `snapshot-projection-coverage.test.ts`, which fails by naming any schema field missing from this list and this
 * map. Actor-state lists (`professions`, `pendingLevelUps`, `pendingLevelUpChoices`, `activeSpecialOrderKeys`,
 * `inventoryItemFacts`, `chests`) are here for the same reason: they arrive with the observation and change on
 * the game's own schedule, not every turn.
 */
const UNPROJECTED_OBSERVED_FAMILIES = Object.freeze([
  "forageTargets",
  "itemTargets",
  "harvestTargets",
  "fertilizerTargets",
  "woodFenceTargets",
  "woodFenceResultTargets",
  "crabPotTargets",
  "crabPotResultTargets",
  "crabPotCollectTargets",
  "baitCrabPotTargets",
  "baitCrabPotResultTargets",
  "debrisTargets",
  "rockSourceTargets",
  "clearHoeDirtTargets",
  "artifactSpotTargets",
  "artifactSpotResultTargets",
  "treeChopSourceTargets",
  "treeChopResultTargets",
  "machineTargets",
  "wateringCanFacts",
  "refillWateringCanTargets",
  "harvestWhereabouts",
  "npcRelationshipTargets",
  "animalProductTargets",
  "farmAnimalPetTargets",
  "feedTroughTargets",
  "inventoryItemFacts",
  "foodTargets",
  "treeStumpTargets",
  "weedTargets",
  "grassTargets",
  "caskTargets",
  "mannequinTargets",
  "signTargets",
  "siloTargets",
  "lanternSlots",
  "scytheCropTargets",
  "chests",
  "shippingBinTargets",
  "minecartTargets",
  "bushTargets",
  "fruitTreeTargets",
  "shakeTreeTargets",
  "pedestalTargets",
  "fenceGateTargets",
  "raftTargets",
  "horseTargets",
  "mineEntranceTargets",
  "fixedInteractionPoints",
  "mineElevatorFloorTargets",
  "obeliskTargets",
  "animalDoorTargets",
  "buildingChestTargets",
  "worldObjectTargets",
  "wearableTargets",
  "warpItemTargets",
  "panSites",
  "mailboxTargets",
  "shopTargets",
  "fishPondTargets",
  "farmBuildingTargets",
  "dailyQuestTargets",
  "specialOrderTargets",
  "activeSpecialOrderKeys",
  "pendingLevelUps",
  "pendingLevelUpChoices",
  "professions",
  "museumRewardTargets",
  "tailoringTargets",
  "colorTargets",
]);

/**
 * Keys deliberately withheld from the always-on fact block, each with the reason it is withheld.
 *
 * A reason here is not decoration: it is the record that someone looked. An entry that no longer has a reason is
 * the same as an unread field - the gate cannot tell the difference, and neither can the next reader. Every
 * non-family entry below was measured 2026-11-02 against `farmhandexecutioncontroller.cs`.
 */
const WITHHELD_SCALAR_KEYS: Readonly<Record<string, string>> = Object.freeze({
  acceptedDailyQuest:
    "A planning flag the daily-quest actions read from the latest observation; a boolean that changes once a day is not a per-turn fact. Delivered by `stardew_observe`.",
  activeExecution:
    "The Mod's own execution state, which the Host already owns from action receipts; publishing it into the fact block would restate execution state the Host tracks. Delivered by `stardew_observe` and program status.",
  artifactSpotFarmSourceCount:
    "A count used only while planning artifact-spot digs, paired with the family it counts. Delivered by `stardew_observe`.",
  fixedInteractionPointsOmitted:
    "A count used only while reading the map's fixed interaction points, paired with the family it counts: it says the list was truncated, and it would be a second spelling of `fixedInteractionPoints.length` in a per-turn fact block that already has to stay under 4 KB. Delivered by `stardew_observe`.",
  soilTilesOmitted:
    "The number of soil tiles the Mod's bound left out of `soilTiles`, paired with the family it counts. The per-turn fact block reports the published count (`soilTilesCount`), and without the omission beside it a 64-row neighbourhood would read as a complete patch that happens to be 64 tiles - which is how a truncated list became a defect once already. Delivered by `stardew_observe`.",
  currentToolSlotItem:
    "The qualified item id in the current tool slot; `currentTool` and `toolSlots[].label` already publish the tool identity, which the environment line renders as a tool word, so this would be a second spelling of a fact already in the prompt.",
});

/**
 * Keys no projection reads, each with the reason that is acceptable.
 *
 * A reason here is not decoration: it is the record that someone looked. An entry that no longer has a reason is
 * the same as an unread field - the gate cannot tell the difference, and neither can the next reader.
 */
export const WITHHELD_SNAPSHOT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  ...WITHHELD_SCALAR_KEYS,
  ...Object.fromEntries(UNPROJECTED_OBSERVED_FAMILIES.map((key) => [key, OBSERVED_FAMILY_REASON])),
});

/**
 * The five projections, each read as source text.
 *
 * Sources, not objects, because the question is "does this layer reference the key at all" - and importing the
 * projections would only answer it for the paths this test happens to construct.
 */
export const PROJECTION_SOURCES = Object.freeze([
  "host/src/snapshot-projection.ts",
  "host/src/runtime-core.internal.ts",
  "host/src/stardew-observation-budget.ts",
  "host/src/body-program-script.ts",
  "host/src/snapshot-hud.ts",
]);

/** Whether a projection source mentions a snapshot key in a field-position read. */
export function projectionReads(source: string, key: string): boolean {
  // A key is READ when it appears as `.key`, as `"key"` in a destructure, or as `snapshot.key`. A bare mention in
  // a comment is not a read, and the pattern requires a preceding dot or quote to say so.
  const patterns = [
    new RegExp(`\\.${key}\\b`),
    new RegExp(`["']${key}["']`),
    // A destructure binding is a read too: `const { actorDispositionDetail } = snapshot` names the key with no
    // dot and no quotes, and that is how the projections actually take most fields.
    new RegExp(`\\{[^}]*\\b${key}\\b[^}]*\\}\\s*=`),
  ];
  // Strip comments first: this file's own prose names keys it does not read, and a gate that counts its own
  // documentation as a read is the "check that reads the wrong thing" failure this repo keeps paying for.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  return patterns.some((pattern) => pattern.test(code));
}
