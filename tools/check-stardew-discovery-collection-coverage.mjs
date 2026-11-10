#!/usr/bin/env node
/**
 * Discovery-collection gate: every `Discover*` function must read the per-location collections its
 * published entities are stored in.
 *
 * WHY
 *
 * Measured twice, and both times the same shape: the world held the entity, the Mod could act on it,
 * and no discovery published it because the discovery never opened the collection it lives in.
 *
 *   1. `break_rock` (`round30`): mine stones are `StardewValley.Object` in `location.objects`, but
 *      `DiscoverRockSourceTargets` only walked `location.terrainFeatures`. Inside a `MineShaft` every
 *      node lives in the object layer, so no rock was published and the action had no legal target.
 *   2. `place_owned_object` (`round31`): furniture lives in `location.furniture`, and a grep for that
 *      field across this integration found one COMMENT. A house's bed, sofa and rug were invisible
 *      while `place_owned_object` could add to the same collection through the native placement path.
 *
 * Neither defect was a bug in one function: it is a defect CLASS - "this discovery publishes some of
 * the world's entities and not the ones stored in a collection it never reads" - and both instances
 * were found by a human reading the source, months apart, after a live run had already gone wrong.
 * This gate asks the class question of every discovery at once.
 *
 * THE POPULATION, derived from the source
 *
 * This gate answers a FAMILY-SPECIFIC question: does this `Discover*` read the collection its own
 * published entities live in? The complementary question - which replicated location collections exist
 * at all, and which of them NOTHING reads - is owned by the observation-gap sections of
 * `integrations/stardew/action-development/src/analysis/stardew-action-inventory-reconciliation.mjs`,
 * which derives that population from the decompiled `GameLocation` instead of declaring it. The two
 * live in one report each because they measure different things over the same files; the C# reader
 * they share is `stardew-mod-csharp-source.mjs`, so neither has its own scan.
 *
 * A discovery is any method returning `IReadOnlyList<Bridge<...>>` whose name starts with `Discover`,
 * in any `.cs` file under `integrations/stardew` (tests, `bin` and `obj` are not source). That is a
 * directory scan plus the return-type declaration the Mod already owns - not a list of names - so a
 * discovery added tomorrow is in the population by existing, and one deleted tomorrow leaves its
 * declaration stale. The `Bridge*Target` suffix is not required: `DiscoverDoorTargets`,
 * `DiscoverSoilTiles`, `DiscoverLanternSlots`, `DiscoverChestStates` and their kin publish world
 * addresses under other suffixes, and excluding them would be a hand-maintained exception list.
 * Measured at this commit: 78 functions over 23 files, 51 of which read at least one collection
 * directly, 23 declare that their family spans no location collection, and 4 read one through a
 * named helper.
 *
 * Reads are collected from the function BODY, after comments and string literals are removed, as
 * `<receiver>.collection` (also `receiver?.collection`). Comment immunity is the point: the
 * furniture defect survived because `location.furniture` appeared once in a comment, and a grep
 * counted it. A commented-out scan is not a scan, and this gate says so.
 *
 * THE DECLARATION, and why it has to be written down
 *
 * The Mod's source can say which collections a discovery READS. Nothing in this repository can say
 * which collections it MUST read, because that is a fact about the game world: stones are
 * `Object`s in `objects`, bushes are `LargeTerrainFeature`s in `largeTerrainFeatures`, furniture is
 * `Furniture` in `furniture`. Derived from the Mod alone, the required set could never contain a
 * collection the Mod never mentions - which is exactly the furniture case - so the requirement is
 * declared once, in `DISCOVERY_COLLECTIONS` below, with the engine-side home of each family named.
 *
 * The table is a TOTAL map onto the derived population, not a list of the interesting rows: a
 * discovery with no row is `undeclared_discovery` (declare its universe or say why it has none), and
 * a row with no discovery is `stale_discovery_declaration`. A row may also name `via` helpers - the
 * methods where a family's enumeration actually lives (`DiscoverChestStates` builds its rows from
 * `OrderedStorageContainers`) - and the gate resolves those bodies and requires them to be declared
 * AND called, so a delegation claim cannot outlive the call it describes. Nothing is followed
 * automatically: a family that hides its scan behind an unnamed helper fails, because a transitive
 * closure over every helper a body touches would pull in the occupancy predicates and turn
 * "does this read `furniture`?" into "does anything up the stack".
 *
 * THE KNOWN GAP RATCHET
 *
 * A gate that is red at HEAD cannot run in CI, and a gate that runs nowhere is indistinguishable
 * from a green one. So a declaration this gate cannot satisfy without changing Mod behaviour is
 * recorded in `KNOWN_DISCOVERY_GAPS` with the measurement that establishes it, printed on every run
 * under `known gap`, and counted. The ratchet only tightens: an entry whose collection IS read now
 * is `stale_known_gap` until someone deletes it and moves the requirement into the row. Measured at
 * this commit: NO entries. The list's only member was `DiscoverBushTargets` / `largeTerrainFeatures`,
 * closed on 2026-11-04 by making the discovery and `TryGetHarvestableBush` read
 * `location.largeTerrainFeatures` - where a bush actually lives - so the row's requirement is now
 * satisfied rather than recorded.
 *
 * red-proof: inject  deleting the `location.objects` scan from `DiscoverRockSourceTargets` in a copy of
 *                    the real sources -> `discovery_collection_missing: DiscoverRockSourceTargets does
 *                    not read location.objects`, exit 1 (tools/check-stardew-discovery-collection-coverage.test.mjs)
 * red-proof: inject  the same deletion against the real worktree, with the file restored afterwards ->
 *                    the run prints that line and exits 1; restored, it prints `green` and exits 0
 *                    (measured 2026-11-04, pasted in the lane report)
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOD_ROOT,
  methodBody,
  parseDiscoveries,
  collectionsRead as readCollections,
  readModSources,
} from "../integrations/stardew/action-development/src/analysis/stardew-mod-csharp-source.mjs";

/**
 * The C# reader itself lives in the analysis layer: the action-inventory reconciliation's
 * observation-gap sections ask the same questions of the same files, and a second reader would be
 * two answers to one question. Re-exported here so this gate's callers and its falsifier suite keep
 * one import site.
 */
export {
  codeOnly,
  methodBody,
  parseDiscoveries,
  readModSources,
} from "../integrations/stardew/action-development/src/analysis/stardew-mod-csharp-source.mjs";

/**
 * The game's per-location entity collections a discovery can publish from.
 *
 * `GameLocation` in the target version holds exactly these places an entity can stand: `objects`
 * (`OverlaidDictionary` of `Object`), `terrainFeatures` (`HoeDirt`, `Tree`, `FruitTree`, `Grass`),
 * `furniture` (`Furniture`), `resourceClumps` (`ResourceClump`), `largeTerrainFeatures`
 * (`LargeTerrainFeature`: `Bush`, `Tent`), `characters` (`NPC`), `debris` (`Debris`), `buildings`
 * (`Building`), and `animals` on an `AnimalHouse` (`FarmAnimal`). The names are the engine's field
 * names, so the gate's vocabulary is the one the Mod's code and the decompiled source share
 * (`ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/GameLocation.cs`).
 *
 * Decorative collections are deliberately absent: `warps`, `doors`, `mapSeats`, `projectiles`,
 * `critters`, `temporarySprites` hold no entity an action can address, and a gate that asked about
 * them would report holes nobody could close.
 */
export const LOCATION_COLLECTIONS = Object.freeze([
  "objects",
  "terrainFeatures",
  "furniture",
  "resourceClumps",
  "largeTerrainFeatures",
  "characters",
  "debris",
  "buildings",
  "animals",
]);

/**
 * What each discovery family MUST read, keyed by the function's own name.
 *
 * `mustRead` is the collection the engine stores that family's published entity in - or, for a
 * placement family that publishes an EMPTY tile, the collections that decide the tile is free, since
 * a predicate that stops consulting the object layer starts publishing occupied tiles. `why` is
 * required on a row with no `mustRead` and says what the family publishes instead of a location
 * entity; it is where the human judgement lives, and the gate refuses an empty one.
 *
 * `via` names the helper methods that hold the family's enumeration, so the read is still checked
 * rather than waved through: the gate resolves each named body and requires `mustRead` to be
 * satisfied across the chain.
 */
export const DISCOVERY_COLLECTIONS = Object.freeze({
  // The actor's own body: equipment, pack and held tool. No location entity is published here.
  DiscoverWearableTargets: { mustRead: [], why: "publishes the actor's own `player.equipment` slots" },
  DiscoverToolSlots: { mustRead: [], why: "publishes the actor's own pack slots" },
  DiscoverInventoryItemFacts: { mustRead: [], why: "publishes the actor's own pack contents" },
  DiscoverFoodTargets: { mustRead: [], why: "publishes edible stacks in the actor's own pack" },
  DiscoverWateringCanFacts: { mustRead: [], why: "publishes the watering cans in the actor's own pack" },
  DiscoverCookingRecipeTargets: {
    mustRead: [],
    why: "recipes come from the `Data/CookingRecipes` content table plus the actor's pack",
  },
  DiscoverCraftingRecipeTargets: {
    mustRead: [],
    why: "recipes come from the `Data/CraftingRecipes` content table plus the actor's pack",
  },
  DiscoverTailoringTargets: {
    mustRead: [],
    why: "publishes (garment, material) pairs from the actor's pack against the tailoring recipe table",
  },
  DiscoverWarpItemTargets: { mustRead: [], why: "publishes the warp totems in the actor's own pack" },
  DiscoverLanternSlots: { mustRead: [], why: "publishes the actor's own held tool lights (slot state)" },
  // The shortage's supply half: a `Data/Shops` row joined to the seed stacks in the actor's own pack. No location
  // entity is published - the rows name a shop id and what the menu charges, not a tile to walk to.
  DiscoverSeedSupplyTargets: {
    mustRead: [],
    why: "joins the actor's own pack (the seeds held) to `Data/Shops` stock, and the shop's own hours query",
  },

  // Buildings.
  DiscoverAnimalDoorTargets: { mustRead: ["buildings"] },
  DiscoverBuildFarmBuildingTargets: { mustRead: ["buildings"] },
  DiscoverBuildingChestTargets: { mustRead: ["buildings"] },
  DiscoverSiloTargets: { mustRead: ["buildings"] },
  DiscoverPetBowlTargets: { mustRead: ["buildings"] },
  DiscoverObeliskTargets: { mustRead: ["buildings"] },
  DiscoverFishPondTargets: { mustRead: ["buildings"] },
  DiscoverDoorTargets: { mustRead: ["buildings"] },
  DiscoverShippingBinTargets: {
    mustRead: ["buildings"],
    via: ["ResolveShippingBin", "FindShippingBinBuilding"],
  },

  // Animals, which live in `animals` on an `AnimalHouse` and in no other collection.
  DiscoverFarmAnimalPetTargets: { mustRead: ["animals"] },

  // Placed objects (`Object` rows in the object layer), including the many subclasses that live there.
  DiscoverColorTargets: { mustRead: ["objects"] },
  DiscoverCookingStationTargets: { mustRead: ["objects"] },
  DiscoverMachineTargets: { mustRead: ["objects"] },
  DiscoverWeedTargets: { mustRead: ["objects"] },
  DiscoverCaskTargets: { mustRead: ["objects"] },
  DiscoverMannequinTargets: { mustRead: ["objects"] },
  DiscoverSignTargets: { mustRead: ["objects"] },
  DiscoverForageTargets: { mustRead: ["objects"] },
  DiscoverPedestalTargets: { mustRead: ["objects"] },
  DiscoverFenceGateTargets: { mustRead: ["objects"] },
  DiscoverFeedTroughTargets: { mustRead: ["objects"] },
  DiscoverSoilTiles: { mustRead: ["objects"], via: ["IsTillableTile"] },
  DiscoverRockSourceTargets: { mustRead: ["objects"] },
  DiscoverWoodFenceResultTargets: { mustRead: ["objects"] },
  DiscoverCrabPotResultTargets: { mustRead: ["objects"] },
  DiscoverBaitCrabPotResultTargets: { mustRead: ["objects"] },
  DiscoverBaitCrabPotTargets: { mustRead: ["objects"] },
  DiscoverCrabPotCollectTargets: { mustRead: ["objects"] },
  DiscoverClearHoeDirtTargets: { mustRead: ["objects", "terrainFeatures"] },
  DiscoverArtifactSpotTargets: { mustRead: ["objects", "terrainFeatures"] },
  DiscoverArtifactSpotResultTargets: { mustRead: ["objects", "terrainFeatures"] },
  DiscoverSeedTargets: { mustRead: ["objects", "terrainFeatures"] },
  DiscoverFertilizerTargets: { mustRead: ["objects", "terrainFeatures"] },
  // Both collections, one lane: `place_owned_object`/`remove_placed_item`/`break_container` act on
  // what is standing there, and the object layer and the furniture collection are the two places the
  // native placement path puts a placed thing (`Game1.cs:7033-7046`).
  DiscoverWorldObjectTargets: { mustRead: ["objects", "furniture"] },
  DiscoverTreeSaplingTargets: { mustRead: ["objects", "terrainFeatures"], via: ["CanPlantWildTreeSeedAt"] },
  DiscoverWoodFenceTargets: { mustRead: ["objects"], via: ["IsLegalEmptyFarmFenceTile"] },

  // Terrain features.
  DiscoverWateringWhereabouts: { mustRead: ["terrainFeatures"] },
  DiscoverHarvestWhereabouts: { mustRead: ["terrainFeatures"] },
  DiscoverTreeChopSourceTargets: { mustRead: ["terrainFeatures"] },
  DiscoverTreeChopResultTargets: { mustRead: ["terrainFeatures"] },
  DiscoverTreeStumpTargets: { mustRead: ["terrainFeatures"] },
  DiscoverGrassTargets: { mustRead: ["terrainFeatures"] },
  DiscoverScytheCropTargets: { mustRead: ["terrainFeatures"] },
  DiscoverHarvestTargets: { mustRead: ["terrainFeatures"] },
  DiscoverCropTargets: { mustRead: ["terrainFeatures"] },
  DiscoverFruitTreeTargets: { mustRead: ["terrainFeatures"] },
  DiscoverShakeTreeTargets: { mustRead: ["terrainFeatures"] },
  // A wild bush is `Bush : LargeTerrainFeature` and the game inserts it into
  // `location.largeTerrainFeatures`, never into `terrainFeatures` (GameLocation.cs:17403-17421).
  // `location.terrainFeatures` is read as well, because a world can hold a bush there and one bush must not
  // be published twice; the published collection is the one a saved game actually carries.
  DiscoverBushTargets: { mustRead: ["largeTerrainFeatures"] },

  // Resource clumps (the large boulders and hollow logs `clear_debris` breaks).
  DiscoverDebrisTargets: { mustRead: ["resourceClumps"] },

  // Characters and animals.
  DiscoverNpcRelationshipTargets: { mustRead: ["characters"] },
  DiscoverPetTargets: { mustRead: ["characters"] },
  DiscoverHorseTargets: { mustRead: ["characters"] },
  DiscoverShopTargets: { mustRead: ["characters"] },
  DiscoverAnimalProductTargets: { mustRead: ["animals"] },
  // The farm animals themselves, read from the same `location.animals` collection the produce family walks - a barn's
  // stock lives there, not in `characters` (that is the household Pet's collection, which `pet_animal` publishes).
  DiscoverFarmAnimalPetTargets: { mustRead: ["animals"] },
  DiscoverVillagerWhereabouts: {
    mustRead: [],
    why: "enumerates villagers through the game's own villager index (`Utility.ForEachVillager`), which spans every location's `characters` instead of reading one location's collection",
  },

  // Containers: the chest rows come from the object layer through the storage-container helpers.
  DiscoverChestStates: {
    mustRead: ["objects"],
    via: ["OrderedStorageContainers", "DiscoverStorageContainers", "LocationStorageContainers"],
  },

  // Debris: the items an object drops when it breaks, which the game floats in `location.debris`.
  DiscoverItemTargets: { mustRead: ["debris"] },

  // Map-anchored and content-table families: the address is a tile selector or a data row, not a
  // member of an entity collection.
  DiscoverRefillWateringCanTargets: { mustRead: [], why: "publishes water tiles chosen by map properties" },
  DiscoverRaftTargets: { mustRead: [], why: "publishes water tiles chosen by map properties" },
  DiscoverMailboxTargets: {
    mustRead: [],
    why: "a mailbox is a `Buildings`-layer tile with a `Mailbox` property; the game stores no mailbox entity in a location collection",
  },
  DiscoverMinecartTargets: {
    mustRead: [],
    why: "publishes `Buildings`-layer tiles whose `Action` is `MinecartTransport`; the networks are content data",
  },
  DiscoverMineEntranceTargets: {
    mustRead: [],
    why: "publishes `Buildings`-layer tiles whose `Action` is `Mine`/`MineLadder`",
  },
  DiscoverMineElevatorFloors: { mustRead: [], why: "publishes floor numbers from `MineShaft.lowestLevelReached`" },
  DiscoverPanSites: {
    mustRead: [],
    why: "publishes the location's single `orePanPoint` (a `NetPoint`), not a member of a collection",
  },
  DiscoverSlimeHutchTroughTargets: {
    mustRead: [],
    why: "the trough is a fixed column of the `SlimeHutch`'s own `waterSpots`, a landmark rather than a collection member",
  },
  DiscoverCrabPotTargets: {
    mustRead: [],
    why: "publishes EMPTY farm tiles for a pot to be placed in; occupancy is the game's own `CrabPot.IsValidCrabPotLocationTile`, and no collection member is published",
  },
  DiscoverMuseumRewardTargets: {
    mustRead: [],
    why: "publishes the museum's collectable rewards, read from `LibraryMuseum`'s own donated-piece inventory, not from a location collection",
  },
  DiscoverDailyQuestTargets: {
    mustRead: [],
    why: "publishes the single `Game1.questOfTheDay` reference, not a member of a location collection",
  },
  DiscoverSpecialOrderTargets: {
    mustRead: [],
    why: "publishes `Game1.player.team.availableSpecialOrders`, which is team state rather than a location collection",
  },
});

/**
 * Declarations this gate cannot satisfy without changing Mod behaviour. Each entry is a measured
 * defect, not an accepted one: it is printed on every run, and it fails as `stale_known_gap` the
 * moment the collection IS read, so it cannot outlive the fix.
 *
 * Empty: the bush gap this list was created for is closed in the Mod, and its requirement is satisfied
 * by `DiscoverBushTargets`'s own row above. The mechanism stays because the next measured gap belongs
 * here rather than in a loosened declaration.
 */
export const KNOWN_DISCOVERY_GAPS = Object.freeze([]);

/** A scan that found less than this measured nothing, and must not read as green. */
export const MINIMUM_DISCOVERY_FUNCTIONS = 60;
export const MINIMUM_DIRECT_READ_FUNCTIONS = 30;
export const MINIMUM_COLLECTIONS = 6;

/**
 * The per-location collections a body reads, e.g. `location.objects`. The scan itself is shared with
 * the action-inventory reconciliation's observation-gap sections; the default universe here is this
 * gate's entity vocabulary.
 */
export function collectionsRead(body, collections = LOCATION_COLLECTIONS) {
  return readCollections(body, collections);
}

function isCalled(name, bodies) {
  const pattern = new RegExp(`\\b${name}\\s*(?:<[^<>]{0,80}>)?\\s*\\(`, "u");
  return bodies.some((body) => pattern.test(body));
}

/**
 * The whole gate: parse the discoveries, resolve each one's declared universe, and report every
 * place the declaration and the source disagree. Pure over `sources`, so the test can inject the
 * violating variants instead of editing the Mod.
 */
export function checkDiscoveryCollectionCoverage({
  sources,
  collections = LOCATION_COLLECTIONS,
  declarations = DISCOVERY_COLLECTIONS,
  knownGaps = KNOWN_DISCOVERY_GAPS,
  minimumFunctions = MINIMUM_DISCOVERY_FUNCTIONS,
  minimumDirectReads = MINIMUM_DIRECT_READ_FUNCTIONS,
  minimumCollections = MINIMUM_COLLECTIONS,
} = {}) {
  const sourceList = sources ?? readModSources();
  const discoveries = parseDiscoveries(sourceList);
  const known = new Set(collections);
  const findings = [];
  const report = (code, detail, extra = {}) => findings.push({ code, detail, ...extra });

  if (collections.length < minimumCollections)
    report(
      "collection_population_too_small",
      `declared ${collections.length} collection(s); the gate needs at least ${minimumCollections}`,
    );
  if (discoveries.length < minimumFunctions)
    report(
      "discovery_population_too_small",
      `found ${discoveries.length} Discover* function(s) in ${MOD_ROOT}; the gate needs at least ${minimumFunctions}`,
    );

  const rows = [];
  const seen = new Set();
  const readBy = new Map(collections.map((collection) => [collection, 0]));
  const requiredBy = new Map(collections.map((collection) => [collection, 0]));

  for (const discovery of discoveries) {
    if (seen.has(discovery.name))
      report("duplicate_discovery", `${discovery.name} is declared more than once; one name, one universe`, {
        discovery: discovery.name,
      });
    seen.add(discovery.name);

    const declaration = declarations[discovery.name];
    const direct = collectionsRead(discovery.body, collections);
    const via = declaration?.via ?? [];
    const viaReads = new Set();
    let caller = discovery.body;
    for (const helper of via) {
      const body = methodBody(sourceList, helper);
      if (body === null) {
        report(
          "discovery_helper_not_declared",
          `${discovery.name} declares helper ${helper}, which no method in ${MOD_ROOT} declares`,
          {
            discovery: discovery.name,
            helper,
          },
        );
        continue;
      }
      if (!isCalled(helper, [caller])) {
        report(
          "discovery_helper_not_called",
          `${discovery.name} declares helper ${helper}, which nothing in its resolved chain calls`,
          {
            discovery: discovery.name,
            helper,
          },
        );
        continue;
      }
      // Only a helper the chain actually reaches contributes its reads: an uncalled helper is a
      // broken delegation claim, and accepting its reads would let the claim cover for the discovery.
      for (const collection of collectionsRead(body, collections)) viaReads.add(collection);
      caller = body;
    }
    const reads = new Set([...direct, ...viaReads]);
    for (const collection of reads) readBy.set(collection, (readBy.get(collection) ?? 0) + 1);

    if (declaration === undefined) {
      report(
        "undeclared_discovery",
        `${discovery.name} (${discovery.path}) has no row in DISCOVERY_COLLECTIONS; declare the location collections its published entities live in, or record why it publishes none`,
        { discovery: discovery.name },
      );
      rows.push({
        name: discovery.name,
        path: discovery.path,
        direct: [...direct],
        via: [...viaReads],
        required: null,
        missing: [],
        knownGaps: [],
      });
      continue;
    }

    const required = declaration.mustRead ?? [];
    for (const collection of required) {
      if (known.has(collection)) requiredBy.set(collection, (requiredBy.get(collection) ?? 0) + 1);
      else
        report(
          "unknown_collection",
          `${discovery.name} requires \`${collection}\`, which is not a declared location collection`,
          {
            discovery: discovery.name,
            collection,
          },
        );
    }
    if (required.length === 0 && !declaration.why)
      report(
        "undeclared_universe_reason",
        `${discovery.name} declares no required collection and no reason; say what it publishes instead`,
        {
          discovery: discovery.name,
        },
      );

    const missing = required.filter((collection) => known.has(collection) && !reads.has(collection));
    const knownForThis = new Set(
      knownGaps.filter((gap) => gap.discovery === discovery.name).map((gap) => gap.collection),
    );
    const gaps = [];
    for (const collection of missing) {
      if (knownForThis.has(collection)) {
        gaps.push(collection);
        continue;
      }
      report(
        "discovery_collection_missing",
        `${discovery.name} (${discovery.path}) does not read \`location.${collection}\`${via.length > 0 ? ` nor does its declared helper chain (${via.join(" -> ")})` : ""}, and that is the collection its published entities live in`,
        { discovery: discovery.name, collection },
      );
    }
    rows.push({
      name: discovery.name,
      path: discovery.path,
      direct: [...direct],
      via: [...viaReads],
      required,
      missing,
      knownGaps: gaps,
    });
  }

  for (const name of Object.keys(declarations))
    if (!seen.has(name))
      report(
        "stale_discovery_declaration",
        `DISCOVERY_COLLECTIONS declares ${name}, which no Discover* method in ${MOD_ROOT} matches`,
        {
          discovery: name,
        },
      );

  const gapRecords = [];
  for (const gap of knownGaps) {
    if (!gap.why)
      report("unknown_known_gap", `the known gap for ${gap.discovery} carries no measurement`, {
        discovery: gap.discovery,
      });
    if (!declarations[gap.discovery])
      report("unknown_known_gap", `the known gap names ${gap.discovery}, which has no declaration row`, {
        discovery: gap.discovery,
      });
    if (!known.has(gap.collection))
      report(
        "unknown_known_gap",
        `the known gap for ${gap.discovery} names \`${gap.collection}\`, which is not a declared location collection`,
        {
          discovery: gap.discovery,
          collection: gap.collection,
        },
      );
    const row = rows.find((candidate) => candidate.name === gap.discovery);
    if (row !== undefined && [...row.direct, ...row.via].includes(gap.collection))
      report(
        "stale_known_gap",
        `${gap.discovery} now reads \`location.${gap.collection}\`; delete its KNOWN_DISCOVERY_GAPS entry and require the collection in its row`,
        { discovery: gap.discovery, collection: gap.collection },
      );
    gapRecords.push({ discovery: gap.discovery, collection: gap.collection });
  }

  for (const collection of collections) {
    const read = readBy.get(collection) ?? 0;
    const required = requiredBy.get(collection) ?? 0;
    if (read === 0 && required === 0)
      report(
        "collection_never_read",
        `\`location.${collection}\` is declared a location collection but no discovery reads it and no declaration requires it; either a family is invisible or the collection does not belong here`,
        { collection },
      );
  }

  const directReadFunctions = rows.filter((row) => row.direct.length > 0).length;
  if (rows.length > 0 && directReadFunctions < minimumDirectReads)
    report(
      "read_population_too_small",
      `only ${directReadFunctions} of ${rows.length} discoveries read a collection directly; the gate needs at least ${minimumDirectReads} so it cannot pass by measuring nothing`,
    );

  return Object.freeze({
    schema: "gamebuddy-stardew-discovery-collection-coverage/v1",
    discoveryCount: rows.length,
    directReadCount: directReadFunctions,
    viaOnlyCount: rows.filter((row) => row.direct.length === 0 && row.via.length > 0).length,
    declaredWithoutCollection: rows.filter((row) => row.required !== null && row.required.length === 0).length,
    collections: collections.map((collection) => ({
      collection,
      readBy: readBy.get(collection) ?? 0,
      requiredBy: requiredBy.get(collection) ?? 0,
    })),
    rows,
    knownGaps: gapRecords,
    knownGapCount: gapRecords.length,
    findings,
    ok: findings.length === 0,
  });
}

function main() {
  const report = checkDiscoveryCollectionCoverage();
  const gapsByDiscovery = new Map(
    report.rows.filter((row) => row.knownGaps.length > 0).map((row) => [row.name, row.knownGaps]),
  );
  process.stdout.write(
    `discovery collection coverage: ${report.discoveryCount} Discover* functions, ${report.collections.length} location collections\n`,
  );
  process.stdout.write(
    `  read directly: ${report.directReadCount}   through a named helper: ${report.viaOnlyCount}   declared as spanning no collection: ${report.declaredWithoutCollection}\n`,
  );
  if (report.knownGapCount > 0)
    process.stdout.write(
      `  known gaps: ${report.knownGapCount} (recorded debt; each must be deleted when its fix lands)\n`,
    );
  for (const [name, gaps] of gapsByDiscovery)
    for (const collection of gaps)
      process.stdout.write(
        `  known gap: ${name} does not read \`location.${collection}\` (recorded in KNOWN_DISCOVERY_GAPS)\n`,
      );
  for (const finding of report.findings) process.stderr.write(`${finding.code}: ${finding.detail}\n`);
  process.stdout.write(
    report.ok
      ? "  green: every discovery reads the collections its published entities live in\n"
      : `  ${report.findings.length} finding(s)\n`,
  );
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
