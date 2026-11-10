#!/usr/bin/env node
// Discovery-channel audit for the Stardew action surface.
//
// An action is not usable just because it is registered: the Agent must also be
// able to (1) see the action as a tool and (2) name a real target for it. The
// second leg is a four-hop chain owned by four different layers:
//
//   1. Mod wire        - integrations/stardew/src/Core/Models/BridgeProtocolModels.cs
//                        declares IReadOnlyList<BridgeXTarget>? XTargets
//   2. Host projection - host/src/protocol.ts validates and types the field
//   3. Envelope schema - protocol/bridge-v1.schema.json admits the field under
//                        $defs/snapshot (additionalProperties:false, so a
//                        missing entry makes the field unshippable)
//   4. Agent contract  - host/src/game-tools.ts names the field in the tool
//                        description so the Agent knows where to read it
//
// Two more hops were added when the missing channels stopped being about targets:
//
//   5. Content tables   - every `Game1.*Data` cache the Mod's own C# touches must be askable through
//                        `look_up({ subject: "data", table })`, or carry a stated reason here. The
//                        population is scanned out of the Mod's sources (and, when the decompiled tree is
//                        present, out of `Game1.cs` too, so a table a future game version adds is a finding).
//   6. Building state   - the `Building` members an action depends on, and the channel that carries each to
//                        the Agent. This is where the owner's question is answered in code: a coop under
//                        construction, with no chest, no fish pond and no obelisk, is published as a row
//                        only by `farmBuildingTargets` - and that family is capped, so the cap must drop
//                        finished buildings before the one being built.
//
// Any hole in the chain is silent: the game state exists, the Mod sends it, and
// the Agent still cannot act. This tool reports per-action holes rather than a
// single pass/fail, and exits non-zero when a target-bearing action has one.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SURFACE = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const MODELS = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const PROTOCOL = "host/src/protocol.ts";
const SCHEMA = "protocol/bridge-v1.schema.json";
const TOOLS = "host/src/game-tools.ts";
const MOD_SOURCE_ROOT = "integrations/stardew";
const CONTENT_QUERY_FILE = "ContentDataQuery.cs";
const TILE_AREA_QUERY_FILE = "TileAreaQuery.cs";

/**
 * The snapshot field each action's opaque target is published under.
 *
 * This is the observation contract, declared once here rather than scraped from
 * tool prose: if the prose is wrong the audit must still catch it, which is
 * exactly how the craft_item/cook_recipe `recipeTargets` drift was found.
 */
export const TARGET_FIELD = Object.freeze({
  pickup_forage: "ForageTargets",
  pickup_item: "ItemTargets",
  water_crop: "CropTargets",
  plant_seed: "SeedTargets",
  fertilize_tile: "FertilizerTargets",
  machine_inspect: "MachineTargets",
  machine_load: "MachineTargets",
  machine_collect_output: "MachineTargets",
  collect_animal_product: "AnimalProductTargets",
  // The farm animals themselves (`location.animals`), which is a different subject from the household Pet's
  // `PetTargets`: `pet_animal` pets the cat/dog through `Pet.checkAction`, `pet_farm_animal` pets the barn/coop stock
  // through `FarmAnimal.pet`.
  pet_farm_animal: "FarmAnimalPetTargets",
  feed_animal: "FeedTroughTargets",
  use_item: "FoodTargets",
  harvest_crop: "HarvestTargets",
  place_wood_fence: "WoodFenceTargets",
  place_crab_pot: "CrabPotTargets",
  bait_crab_pot: "BaitCrabPotTargets",
  chop_tree: "TreeChopSourceTargets",
  break_rock: "RockSourceTargets",
  clear_hoedirt: "ClearHoeDirtTargets",
  dig_artifact_spot: "ArtifactSpotTargets",
  refill_watering_can: "RefillWateringCanTargets",
  clear_debris: "DebrisTargets",
  // The same ResourceClump rows: this action reads the clump's own parentSheetIndex to decide which tool it
  // demands, so its target is the clump entity exactly as clear_debris's is.
  break_resource_clump: "DebrisTargets",
  npc_relationship: "NpcRelationshipTargets",
  interact_npc_with_item: "NpcRelationshipTargets",
  // talk_to_npc names the villager through the same published family target list
  // (see farmhandexecutioncontroller.npcactions.cs); only this declaration was
  // missing, so the audit could not verify its discovery leg at all.
  talk_to_npc: "NpcRelationshipTargets",
  // Both wearable actions name the actor's OWN body slots through the same published list
  // (WearableTargets). dismount_transport publishes no target list: its subject is the actor's own
  // mount, so it has no discovery leg to declare here (the same reason advance_day has none).
  // The chest repaint names the chest through ColorTargets, whose entries carry the tile AND the colour the
  // chest currently has (so a caller can see whether a repaint would move anything).
  color_placed_object: "ColorTargets",
  equip_wearable: "WearableTargets",
  unequip_wearable: "WearableTargets",
  pet_animal: "PetTargets",
  water_pet_bowl: "PetBowlTargets",
  water_slime_hutch_trough: "SlimeHutchTroughTargets",
  // The container pair names a container ENTITY through the one `chests` family: each row is the container and
  // its whole contents, and both actions take `chestId` + `expectedQualifiedItemId` straight out of it. The two
  // rows here used to name `ChestStoreTargets` / `ChestRetrieveTargets`, which were collected because the
  // actions could not yet name a container.
  chest_store: "Chests",
  chest_retrieve: "Chests",
  chop_stump: "TreeStumpTargets",
  plant_sapling: "TreeSaplingTargets",
  cut_weeds: "WeedTargets",
  scythe_crop: "ScytheCropTargets",
  craft_item: "CraftingRecipeTargets",
  cook_recipe: "CookingRecipeTargets",
  collect_crab_pot_output: "CrabPotCollectTargets",
  ship_item: "ShippingBinTargets",
  // Loop-closure wave (2026-10-04): the 14 lane actions each advertise a
  // target/destination field in the Mod snapshot (and the corresponding Host
  // union + schema entry).
  harvest_bush: "BushTargets",
  harvest_fruit_tree: "FruitTreeTargets",
  shake_tree: "ShakeTreeTargets",
  take_pedestal_item: "PedestalTargets",
  toggle_fence_gate: "FenceGateTargets",
  clear_cask: "CaskTargets",
  dress_mannequin: "MannequinTargets",
  set_sign_display: "SignTargets",
  deposit_silo_hay: "SiloTargets",
  toggle_tool_light: "LanternSlots",
  use_raft: "RaftTargets",
  mount_transport: "HorseTargets",
  enter_mine: "MineEntranceTargets",
  // The way OUT of a mine level reads the SAME family: `MineShaft.checkAction` opens the exit ladder's
  // `ExitMine` question from a tile in the same `Buildings` layer, and `DiscoverMineEntranceTargets`
  // publishes both ladder kinds under one opaque id family (`mine_entrance_<16 hex>`), because a caller
  // cannot tell the kinds apart. Declared here rather than adding a snapshot field the action never reads.
  use_mine_ladder: "MineEntranceTargets",
  // `fish_here` names one water tile through the engine's own castable answer (`canFishHere` + `isTileFishable`),
  // published as `waterTargets`; the id each row carries is the address the handler recomputes for that tile before
  // it casts, so a stale row is refused by name rather than cast at.
  fish_here: "WaterTargets",
  // Added by the minecart lane after this table was written; the audit caught the
  // omission rather than letting the action ship with an unverified discovery leg.
  ride_minecart: "MinecartTargets",
  // cut_grass targets the TerrainFeature `Grass`, whose discovery field is
  // `grassTargets` — distinct from the Object-layer `cut_weeds`/`weedTargets`.
  cut_grass: "GrassTargets",
  // Actions added by the neighbouring lanes after this table was written. Their
  // snapshot fields already existed (`MineElevatorFloorTargets`, `ShopTargets`,
  // `ObeliskTargets`, `AnimalDoorTargets`) and `withdraw_silo_hay` shares the
  // `SiloTargets` list that `deposit_silo_hay` reads; only this declaration was
  // missing, so the audit could not verify their discovery leg at all. Declared
  // here rather than left out, so the remaining hops are checked for real.
  select_mine_elevator_floor: "MineElevatorFloorTargets",
  withdraw_silo_hay: "SiloTargets",
  use_obelisk: "ObeliskTargets",
  toggle_animal_door: "AnimalDoorTargets",
  // build_farm_building names its site AND reads back the buildings already standing through the
  // lane's one `farmBuildingTargets` array.
  build_farm_building: "FarmBuildingTargets",

  // The world-object lane. All three read the lane's single projection, so all three
  // discover their target through `worldObjectTargets`.
  place_owned_object: "WorldObjectTargets",
  remove_placed_item: "WorldObjectTargets",
  // The furniture pickup names a piece through the same lane projection: `DiscoverWorldObjectTargets`
  // publishes `placed_furniture` rows with `slot: -1`, because no tool lifts one - the pickup is the
  // action that does.
  move_placed_furniture: "WorldObjectTargets",
  // The furniture-and-decoration wave names its target through the same array: the rotation and the
  // fence removal act on a `placed_furniture` row, and the tank and pedestal name the piece that holds
  // the item. Same projection, four more consumers.
  rotate_furniture: "WorldObjectTargets",
  remove_fence: "WorldObjectTargets",
  put_item_in_fish_tank: "WorldObjectTargets",
  place_item_on_pedestal: "WorldObjectTargets",
  break_container: "WorldObjectTargets",
  shop_purchase: "ShopTargets",
  // The building-chest pair. Both name a chest a BUILDING declares in its own data
  // (Data/Buildings -> BuildingData.Chests), published as `buildingChestTargets`.
  load_building_chest: "BuildingChestTargets",
  collect_building_chest_output: "BuildingChestTargets",
  // The three newest discovery channels. Without these the audit reports the field as undeclared and
  // cannot verify the payload against the frozen schema at all.
  pan_ore: "PanSites",
  use_warp_item: "WarpItemTargets",
  claim_mail_attachment: "MailboxTargets",
  // The queue/museum/tailoring wave. The Mod publishes every one of these lists
  // (BridgeProtocolModels.cs) and the Host validates every field, but this table had
  // no row, so the audit bailed at `undeclared_target_field` without ever checking
  // the Mod/Host/schema legs. `build_farm_building` already had its row and was the
  // one that reached `missing_envelope_schema_field`.
  clear_fish_pond: "FishPondTargets",
  // `open_geode` takes no tile: its whole address is a backpack slot and the item id that slot must hold, which is
  // exactly what `inventoryItemFacts` rows carry (`BridgeInventoryItemFact(slot, qualifiedItemId, name, stack)`). The
  // counter it cracks at is the location's own, so there is no entity family to name here.
  open_geode: "InventoryItemFacts",
  accept_daily_quest: "DailyQuestTargets",
  accept_special_order: "SpecialOrderTargets",
  claim_museum_reward: "MuseumRewardTargets",
  // Both tailoring acts read the one sewing-machine projection.
  tailor_clothing: "TailoringTargets",
  dye_clothing_with_item: "TailoringTargets",
});

/** Actions that carry a target but whose target is not a snapshot list. */
const NON_SNAPSHOT_TARGET_ACTIONS = Object.freeze([
  "navigate_to_destination", // destination selector, resolved by the Mod
  "travel", // source tile of a native warp
  "enter_exit", // tile of a door/warp
  "move_to_tile", // raw coordinates
  "till_soil",
  "equip_tool",
  "express_emote",
  "face_direction",
  "advance_day", // no arguments at all: the actor's own bed is the target
]);

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

/**
 * The engine content caches the Agent cannot ask about, and why not.
 *
 * <p>
 * Two kinds only, because they are the only two honest answers: the fact reaches the Agent some other way (an action
 * already publishes the row that carries it), or the table is engine bookkeeping no action chooses from. A third
 * kind - "nobody got round to it" - is what this table exists to make impossible; it is a finding, not a reason.
 * </p>
 * <p>
 * An entry EXPIRES: a reason naming a cache the Mod no longer references, or one a `look_up data` table now covers, is
 * `stale_content_table_reason`. The list may not silently outlive the tables it excuses.
 * </p>
 */
export const CONTENT_TABLE_REASONS = Object.freeze({
  "Game1.characterData": {
    kind: "published_by_action",
    reason:
      "`Data/Characters` describes the villagers the world already identifies by name; `npcRelationshipTargets` publishes the row an action chooses from (name, tile, relationship) and a handler reads the definition through `DataLoader` when the native call needs it",
  },
  "Game1.fruitTreeData": {
    kind: "published_by_action",
    reason:
      "a fruit tree's own growth state is published from `terrainFeatures` as `fruitTreeTargets`; the definition is read through `DataLoader` when an action needs it",
  },
  "Game1.pantsData": {
    kind: "published_by_action",
    reason:
      "the worn pants are published as the actor's equipped wearable (`wearableTargets`), which is what `unequip_wearable` names",
  },
  "Game1.shirtData": {
    kind: "published_by_action",
    reason:
      "the worn shirt is published as the actor's equipped wearable (`wearableTargets`), which is what `unequip_wearable` names",
  },
  "Game1.petData": {
    kind: "published_by_action",
    reason:
      "the household pet is published from the world as `petTargets` (tile, pet type, whether it was petted); the definition is read through `DataLoader`",
  },
  "Game1.floorPathData": {
    kind: "engine_bookkeeping",
    reason:
      "`Data/FloorsAndPaths` is the indoor walkability map the native pathfinder reads; `navigate_to_destination` drives that pathfinder and the path itself is the action's result, not a row",
  },
  "Game1.jukeboxTrackData": {
    kind: "engine_bookkeeping",
    reason: "`Data/JukeboxTracks` is the jukebox catalogue; no action plays a jukebox track",
  },
  "Game1.locationContextData": {
    kind: "engine_bookkeeping",
    reason:
      "`Data/LocationContexts` is the fish/forage/artifact table the ENGINE consults per location; no action chooses a target from it, and the definitions are read through `DataLoader` when a native call needs them",
  },
  "Game1.weaponData": {
    kind: "engine_bookkeeping",
    reason:
      "`Data/Weapons` (damage, knockback); the surface publishes no combat action, so no row is chosen from this table",
  },
});

/** The two kinds a content-table reason may be. */
export const CONTENT_TABLE_REASON_KINDS = Object.freeze(["published_by_action", "engine_bookkeeping"]);

/**
 * The `Building` members an action depends on, and the channel that carries each to the Agent.
 *
 * <p>
 * The owner's question lives in the second row: a coop under construction, with no chest, no fish pond and no obelisk,
 * reaches the Agent only through `doorTargets` (no radius bound, `farmhandexecutioncontroller.cs:2814/2823`, skipping
 * `!HasIndoors()`), and `doorTargets` carries a warp, not a countdown. So the countdown has exactly one channel -
 * `farmBuildingTargets` `built` rows - and that family is capped at `BuildFarmBuildingTargetLimit`. A cap that drops the
 * last building in `location.buildings` order can drop the one being built, which is why the Mod orders the countdown
 * first and why this audit goes red if that ordering disappears.
 * </p>
 */
export const BUILDING_STATE_CHANNELS = Object.freeze([
  { member: "buildingType", family: "FarmBuildingTargets", field: "buildingType" },
  { member: "daysOfConstructionLeft", family: "FarmBuildingTargets", field: "daysOfConstructionLeft" },
  // The boolean itself is not a fact the Agent acts on: the building's human door IS the fact, and it is published
  // exactly when `HasIndoors()` is true, which is the same test the discovery makes.
  { member: "HasIndoors()", family: "DoorTargets", field: null, source: "HasIndoors()" },
  { member: "humanDoor", family: "DoorTargets", field: null, source: "getPointForHumanDoor()" },
  { member: "animalDoor", family: "AnimalDoorTargets", field: null, source: "animalDoor" },
]);

/** Every `Game1.<name>Data` cache the Mod's own C# names. */
const CONTENT_TABLE_REFERENCE = /Game1\.(\w+Data)\b/gu;

/** Every content cache `Game1.cs` declares (`public static IDictionary<string, X> nameData;`). */
const ENGINE_CONTENT_TABLE = /public static IDictionary<[^>]*>\s+(\w+Data);/gu;

/**
 * The Mod's own sources, minus the test project and the build outputs.
 *
 * The population of the content-table hop is scanned out of these, never listed by hand: a cache the Mod starts
 * touching is a table the Agent must be able to ask about, and nothing in this file has to change for it to count.
 */
export function loadModSources({ root = ROOT, directory = MOD_SOURCE_ROOT } = {}) {
  const sources = [];
  const stack = [path.join(root, directory)];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (["tests", "bin", "obj", "action-development"].includes(entry.name)) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.name.endsWith(".cs")) continue;
      sources.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        source: readFileSync(absolute, "utf8"),
      });
    }
  }
  return sources;
}

/**
 * The tables `look_up({ subject: "data" })` exposes, parsed from the Mod's own registry.
 *
 * The registry is the one place a table is declared: its engine asset and the cache property it is the parsed form
 * of. Parsing it here rather than keeping a list is what makes "the Agent can ask this table" a measurement instead of
 * a promise - and a formatting change that hides an entry fails CLOSED (every table then reads as unreachable).
 */
export function contentTableRegistry(query) {
  const tables = [];
  const marks = [...query.matchAll(/\["([A-Za-z]+)"\]\s*=/gu)];
  for (let index = 0; index < marks.length; index += 1) {
    const start = marks[index].index;
    const end = index + 1 < marks.length ? marks[index + 1].index : query.length;
    const block = query.slice(start, end);
    const asset = block.match(/"(Data\/[^"]+)"/u);
    const cache = block.match(/"(Game1\.\w+Data|DataLoader\.\w+)"/u);
    if (asset !== null && cache !== null) tables.push({ table: marks[index][1], asset: asset[1], cache: cache[1] });
  }
  return tables;
}

/**
 * The facts a tile-area row publishes, and the Mod function that owns each one.
 *
 * <p>
 * The declaration lives where the projection lives (`TileAreaQuery.PublishedFacts`), because that is the code that
 * computes them; this hop only asks whether it still answers for the wire. The population is the schema's own
 * `tileAreaRow` properties, so a field added to the wire and not to the table is a finding, and a table entry the wire no
 * longer carries is a finding too - which is what keeps this from being a hand-maintained list that can only drift.
 * </p>
 * <p>
 * The `SharedWith` column is the part with teeth: a fact whose owner is shared with ANOTHER publication must be
 * computed by that publication's own body. `tillable` names `DiscoverSoilTiles` because the companion plans from BOTH
 * lists, and two spellings of "this tile can be hoed" is how the answer in one channel and the answer in the other
 * become two different answers about the same tile.
 * </p>
 */
export function tileAreaFactOwners(query) {
  const block = query.match(/PublishedFacts\s*=\s*\[?\s*\{([\s\S]*?)\n\s*\};/u)?.[1];
  if (typeof block !== "string") return [];
  return [...block.matchAll(/\(\s*"([a-z_]+)"\s*,\s*"([A-Za-z.]+)"\s*,\s*(?:null|"([A-Za-z.]+)")\s*\)/gu)].map(
    (match) => ({ fact: match[1], owner: match[2], sharedWith: match[3] ?? null }),
  );
}

/**
 * The frozen tool-area facts, checked against the wire and against the functions they name.
 *
 * <p>
 * A declaration entry is only a claim; the two things that make it a measurement are that the owner symbol EXISTS in
 * the Mod's own sources, and that a shared owner is what the other publication actually calls. Both are read off source
 * text, so a rename that leaves the prose behind is caught here and not by the next live run.
 * </p>
 */
export function tileAreaFacts(query, schema, modSources) {
  const declared = tileAreaFactOwners(query);
  const properties = Object.keys(schema.$defs?.tileAreaRow?.properties ?? {});
  const rows = properties.map((fact) => {
    const entries = declared.filter((entry) => entry.fact === fact);
    const entry = entries[0];
    const memberOf = (symbol) => (symbol === null || symbol === undefined ? null : symbol.split(".").pop());
    // The DECLARATION, not the first call site: `DiscoverSoilTiles` is called from `CreateBridgeSnapshot` before its own
    // body appears, and slicing from a call site reads the calling method's body instead of the owner's. A declared
    // member is preceded by its return type, which is what distinguishes the two.
    const bodyOf = (symbol) => {
      const member = memberOf(symbol);
      if (member === null) return null;
      const declaration = new RegExp(`(?:[A-Za-z_][\\w<>.,?\\[\\]]*\\s+)${member}\\s*\\(`, "u");
      for (const source of modSources ?? []) {
        const match = declaration.exec(source.source);
        if (match === null) continue;
        const open = source.source.indexOf("{", match.index + match[0].length);
        return open < 0 ? null : source.source.slice(open, balancedEnd(source.source, open, "{", "}") + 1);
      }
      return null;
    };
    const ownerBody = entry === undefined ? null : bodyOf(entry.owner);
    const sharedBody = entry === undefined ? null : bodyOf(entry.sharedWith);
    return {
      fact,
      declared: entries.length === 1,
      owner: entry?.owner ?? null,
      duplicated: entries.length > 1,
      ownerDefined: ownerBody !== null,
      sharedWith: entry?.sharedWith ?? null,
      sharedCallsOwner:
        entry?.sharedWith === null || entry?.sharedWith === undefined
          ? null
          : sharedBody !== null && sharedBody.includes(`${memberOf(entry.owner)}(`),
    };
  });
  const orphans = declared.filter((entry) => !properties.includes(entry.fact)).map((entry) => entry.fact);
  return { measured: modSources !== null, population: properties, declared, rows, orphans };
}

function balancedEnd(source, start, open, close) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

function lower(name) {
  return name[0].toLowerCase() + name.slice(1);
}
export function auditDiscoveryChannels({
  surface = JSON.parse(read(SURFACE)),
  models = read(MODELS),
  protocol = read(PROTOCOL),
  schema = JSON.parse(read(SCHEMA)),
  schemaText = read(SCHEMA),
  gameTools = read(TOOLS),
  // Null means "not measured". A caller injecting a synthetic action surface must not be handed gaps about the real
  // Mod's content tables; the CLI and the committed-tree test pass the real sources, which is where these hops live.
  modSources = null,
  engine = null,
} = {}) {
  const modFields = new Set(
    [...models.matchAll(/IReadOnlyList<Bridge\w+>\??\s+(\w+)\b/g)].map((m) => m[1].toLowerCase()),
  );
  const schemaProps = new Set(Object.keys(schema.$defs?.snapshot?.properties ?? {}).map((k) => k.toLowerCase()));

  // Agent-facing tools: earlier the Host gated each tool with an `isVisible("<action>")`
  // marker, which this audit sliced on. Since 36608fa every Game Action tool is a
  // constant mount (`makeGameActionTool` with an `action: "<id>"` field) and
  // per-action authority is decided at execution, so the visible set is the set of
  // mounted tool ids. A mount counts only when its `action` id is immediately
  // followed by its `toArgs` projector, matching the promotion checker.
  const toolVisible = new Set(
    [...gameTools.matchAll(/makeGameActionTool\(\{[\s\S]*?\n\s*action: "([a-z0-9_]+)",\s*(?:\n\s*)?toArgs:/g)].map(
      (m) => m[1],
    ),
  );
  // Loop-mounted families (e.g. the facility actions built with a
  // for (const action of [...] as const) header) repeat the id through the loop
  // variable rather than a string literal next to the mount; expand them.
  for (const loop of gameTools.matchAll(
    /for \(const action of (\[[a-z0-9_"\s,]+\]) as const\) \{[\s\S]*?makeGameActionTool\(\{/g,
  )) {
    for (const id of [...loop[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])) {
      toolVisible.add(id);
    }
  }

  // The snapshot list each tool description actually tells the Agent to read.
  //
  // Slice on the makeGameActionTool markers rather than requiring tools.push to
  // follow immediately: a few actions (pet_animal, interact_npc_with_item, ...)
  // run a descriptor-completeness guard and a schema build before pushing, so a
  // pattern anchored on tools.push would silently skip them and report a
  // "does not name its field" gap that is not real.
  const describedFields = new Map();
  const chunks = gameTools.split(/makeGameActionTool\(\{/).slice(1);
  for (const chunk of chunks) {
    const visible = chunk.match(/\n\s*action: "([a-z0-9_]+)",/);
    if (!visible) continue;
    const desc = chunk.match(/description:\s*\n?\s*"([\s\S]*?)",\s*\n\s*parameters:/);
    const text = desc ? desc[1] : "";
    // The field names a description may legitimately name. The shape set has to cover every form the Mod
    // publishes: most discovery arrays end in Targets or Slots, and the ore-pan channel is "PanSites" —
    // which the original two patterns could never match, so pan_ore was reported as naming no field even
    // though its description names panSites verbatim. Extend the SHAPE rather than rename the wire field to
    // suit the checker.
    const named = [
      ...text.matchAll(/\b([a-zA-Z]+Targets)\b/g),
      ...text.matchAll(/\b([a-zA-Z]+Slots)\b/g),
      ...text.matchAll(/\b([a-zA-Z]+Sites)\b/g),
      ...text.matchAll(/\b([a-zA-Z]+Facts)\b/g),
      // Entity-shaped families name the THING rather than a list of addresses: `chests` is a container and its
      // contents, because a container is perceived whole instead of being flattened into one row per
      // (container, item) pair. The set is extended rather than the wire field renamed to end in `Targets`, for
      // the same reason `PanSites` was: a name chosen to satisfy a checker is a second spelling of one fact.
      ...text.matchAll(/\b(chests)\b/g),
    ].map((x) => x[1]);
    describedFields.set(visible[1], [...new Set(named)]);
  }
  // Loop-mounted families mount several tools from one for-of header; the
  // description names the snapshot field through a per-action literal table
  // (labels / targetKey) rather than a literal in the description string. The
  // promotion checker and toolVisible already expand these; do the same here so
  // the discovery audit does not false-positive the loop family tools.
  const loopChunks = gameTools.split(/for \(const action of (\[[a-z0-9_"\s,]+\]) as const\)/).slice(1);
  for (let i = 0; i + 1 < loopChunks.length; i += 2) {
    const header = loopChunks[i];
    const body = loopChunks[i + 1] ?? "";
    const ids = [...(header?.matchAll(/"([a-z0-9_]+)"/g) ?? [])].map((m) => m[1]);
    const targets = [...body.matchAll(/\b([a-zA-Z]+Targets)\b/g)].map((m) => m[1]);
    if (ids.length === 0) continue;
    ids.forEach((id, idx) => {
      if (targets[idx]) {
        const existing = describedFields.get(id) ?? [];
        describedFields.set(id, [...new Set([...existing, targets[idx]])]);
      }
    });
  }

  const rows = [];
  for (const action of surface.actions) {
    const args = Object.keys(action.argumentSchema ?? {});
    const needsTarget = args.includes("expectedTargetId");
    const field =
      TARGET_FIELD[action.actionId] ??
      (NON_SNAPSHOT_TARGET_ACTIONS.includes(action.actionId) ? null : needsTarget ? undefined : null);

    rows.push({
      actionId: action.actionId,
      lifecycle: action.lifecycle,
      kind: action.kind,
      needsTarget,
      field,
      toolVisible: toolVisible.has(action.actionId),
      inMod: field ? modFields.has(field.toLowerCase()) : null,
      inProtocol: field ? protocol.includes(lower(field)) || protocol.includes(field) : null,
      inSchema: field ? schemaProps.has(field.toLowerCase()) : null,
      describedAs: describedFields.get(action.actionId) ?? [],
      declared: action.actionId in TARGET_FIELD || NON_SNAPSHOT_TARGET_ACTIONS.includes(action.actionId),
    });
  }

  const gaps = [];
  for (const row of rows) {
    if (row.kind === "read_only") continue;
    if (!row.toolVisible) gaps.push({ ...row, gap: "no_agent_tool" });
    if (row.field === undefined) gaps.push({ ...row, gap: "undeclared_target_field" });
    else if (row.field) {
      if (!row.inMod) gaps.push({ ...row, gap: "missing_mod_wire_field" });
      if (!row.inProtocol) gaps.push({ ...row, gap: "missing_host_protocol_field" });
      if (!row.inSchema) gaps.push({ ...row, gap: "missing_envelope_schema_field" });
      const real = row.describedAs.filter((n) => n.toLowerCase() === row.field.toLowerCase());
      const wrong = row.describedAs.filter((n) => n.toLowerCase() !== row.field.toLowerCase());
      // A description legitimately names several snapshot fields (e.g.
      // toolSlots AND the target list): only the absence of the target field
      // itself is a gap. Naming a different field instead of the target one
      // (real empty, wrong non-empty) is the real misdirection.
      if (real.length === 0 && wrong.length > 0)
        gaps.push({ ...row, gap: `tool_names_wrong_field:${wrong.join(",")}` });
      else if (real.length === 0) gaps.push({ ...row, gap: "tool_does_not_name_target_field" });
    }
  }

  // ---- hop 5: the game's own content tables ---------------------------------
  //
  // The population is scanned out of the Mod's own C#, never listed here: a cache the Mod starts touching is a table
  // the Agent must be able to ask about, and a table a future game version adds shows up the moment a handler reads it.
  // When the decompiled tree is available the ENGINE's own `Game1.*Data` declarations join the population, so a table
  // the game has that we neither expose nor explain is a finding rather than a silence.
  const querySource =
    modSources === null ? undefined : modSources.find((entry) => entry.path.endsWith(CONTENT_QUERY_FILE));
  const registry = querySource === undefined ? [] : contentTableRegistry(querySource.source);
  const coveredByCache = new Map(registry.map((entry) => [entry.cache, entry.table]));
  const referenced = new Set();
  for (const entry of modSources ?? [])
    for (const match of entry.source.matchAll(CONTENT_TABLE_REFERENCE)) referenced.add(`Game1.${match[1]}`);
  const enginePopulation =
    engine === null
      ? [...referenced]
      : [...new Set([...engine.matchAll(ENGINE_CONTENT_TABLE)].map((match) => `Game1.${match[1]}`))];
  const contentRows = enginePopulation.sort().map((cache) => {
    const reason = CONTENT_TABLE_REASONS[cache];
    return {
      cache,
      referencedByMod: referenced.has(cache),
      table: coveredByCache.get(cache) ?? null,
      reasonKind: reason === undefined ? null : reason.kind,
    };
  });
  if (querySource === undefined && modSources !== null)
    gaps.push({ subject: CONTENT_QUERY_FILE, gap: "content_data_query_missing" });
  for (const row of contentRows) {
    if (row.table !== null) continue;
    if (row.reasonKind === null)
      gaps.push({
        subject: row.cache,
        gap: `content_table_unreachable:${row.cache}`,
      });
    else if (!CONTENT_TABLE_REASON_KINDS.includes(row.reasonKind))
      gaps.push({ subject: row.cache, gap: `content_table_reason_invalid:${row.cache}` });
  }
  if (modSources !== null)
    for (const cache of Object.keys(CONTENT_TABLE_REASONS))
      if (!contentRows.some((row) => row.cache === cache))
        gaps.push({ subject: cache, gap: `stale_content_table_reason:${cache}` });
  if (engine !== null)
    for (const cache of referenced)
      if (!enginePopulation.includes(cache)) gaps.push({ subject: cache, gap: `content_table_not_in_engine:${cache}` });

  // ---- hop 6: the building state an action depends on ------------------------
  //
  // `daysOfConstructionLeft` is the owner's question: a coop being built, with no chest, no pond and no obelisk, has
  // exactly one channel - the `built` rows of `farmBuildingTargets` - and that family is capped. The cap must therefore
  // drop finished buildings before the one under construction, which is a source fact this hop measures.
  const constructionFirst =
    modSources !== null &&
    modSources.some((entry) => /OrderByDescending\([^;]*daysOfConstructionLeft\.Value\s*>\s*0\)/u.test(entry.source));
  const buildingRows = BUILDING_STATE_CHANNELS.map((entry) => ({
    member: entry.member,
    family: entry.family,
    field: entry.field,
    inMod: modFields.has(entry.family.toLowerCase()),
    inProtocol: entry.field === null ? true : protocol.includes(entry.field),
    inSchema: entry.field === null ? true : schemaText.includes(entry.field),
    reader: (modSources ?? []).some((source) => source.source.includes(entry.source ?? entry.member)),
  }));
  for (const row of buildingRows) {
    if (modSources === null) break;
    if (!row.inMod) gaps.push({ subject: row.member, gap: `building_member_unpublished:${row.member}:${row.family}` });
    if (!row.inProtocol) gaps.push({ subject: row.member, gap: `building_member_not_on_wire:${row.member}` });
    if (!row.inSchema) gaps.push({ subject: row.member, gap: `building_member_not_in_schema:${row.member}` });
    if (!row.reader) gaps.push({ subject: row.member, gap: `building_member_unread:${row.member}` });
  }
  if (modSources !== null && !constructionFirst)
    gaps.push({
      subject: "daysOfConstructionLeft",
      gap: "building_construction_cap_can_drop_the_building:daysOfConstructionLeft",
    });

  // ---- hop 7: the facts one tile-area row publishes ---------------------------
  //
  // The rectangle query answers a fact per tile, and every one of them has to name the function that computes it. The
  // population is the wire's own row definition, so a field the Mod starts publishing without an owner stops the audit;
  // the checks read the Mod's sources, so an owner that was renamed or a shared fact that stopped being shared is a
  // finding rather than a comment nobody re-read.
  const tileAreaSource = (modSources ?? []).find((entry) => entry.path.endsWith(TILE_AREA_QUERY_FILE));
  const tileArea =
    modSources === null
      ? { measured: false, population: [], declared: [], rows: [], orphans: [] }
      : tileAreaFacts(tileAreaSource?.source ?? "", schema, modSources);
  if (modSources !== null) {
    if (tileArea.population.length === 0) gaps.push({ subject: "tileAreaRow", gap: "tile_area_rows_unread" });
    if (tileAreaSource === undefined) gaps.push({ subject: TILE_AREA_QUERY_FILE, gap: "tile_area_query_missing" });
    for (const row of tileArea.rows) {
      if (row.duplicated) gaps.push({ subject: row.fact, gap: `tile_area_fact_duplicated:${row.fact}` });
      else if (!row.declared) gaps.push({ subject: row.fact, gap: `tile_area_fact_unowned:${row.fact}` });
      if (row.declared && !row.ownerDefined)
        gaps.push({ subject: row.fact, gap: `tile_area_fact_owner_missing:${row.fact}:${row.owner}` });
      if (row.sharedCallsOwner === false)
        gaps.push({
          subject: row.fact,
          gap: `tile_area_fact_two_spellings:${row.fact}:${row.sharedWith ?? "none"}`,
        });
    }
    for (const fact of tileArea.orphans) gaps.push({ subject: fact, gap: `tile_area_fact_unpublished:${fact}` });
  }

  return Object.freeze({
    schema: "gamebuddy-stardew-discovery-channel-audit/v1",
    actionCount: rows.length,
    targetBearingCount: rows.filter((r) => r.needsTarget).length,
    rows,
    contentTables: Object.freeze({
      measured: modSources !== null,
      examined: contentRows.length,
      addressable: contentRows.filter((row) => row.table !== null).length,
      withReason: contentRows.filter((row) => row.table === null && row.reasonKind !== null).length,
      enginePopulationMeasured: engine !== null,
      rows: contentRows,
      registry,
    }),
    buildingState: Object.freeze({
      measured: modSources !== null,
      examined: buildingRows.length,
      carried: buildingRows.filter((row) => row.inMod && row.reader).length,
      constructionFirst,
      rows: buildingRows,
    }),
    tileArea: Object.freeze({
      measured: tileArea.measured,
      examined: tileArea.rows.length,
      owned: tileArea.rows.filter((row) => row.declared && row.ownerDefined).length,
      shared: tileArea.rows.filter((row) => row.sharedCallsOwner === true).length,
      rows: tileArea.rows,
    }),
    gaps,
    ok: gaps.length === 0,
  });
}

/**
 * The engine's own content-table declarations, when the decompiled tree is present.
 *
 * `ref/` is gitignored, so a fresh checkout has no tree and cannot measure the engine side. That is reported as
 * `not measured` rather than as a pass: the Mod-referenced population is still measured, it is simply a smaller
 * population, and the summary line says which one was used.
 */
function readEngineGame1() {
  for (const relative of [
    "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/Game1.cs",
    "ref/external/StardewValleyDecompiled/Game1.cs",
  ]) {
    try {
      return readFileSync(path.join(ROOT, relative), "utf8");
    } catch {
      continue;
    }
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const engine = readEngineGame1();
  const report = auditDiscoveryChannels({ modSources: loadModSources(), ...(engine === null ? {} : { engine }) });
  const byGap = new Map();
  for (const gap of report.gaps) {
    const list = byGap.get(gap.gap) ?? [];
    list.push(gap.subject ?? gap.actionId);
    byGap.set(gap.gap, list);
  }
  process.stdout.write(
    `discovery channels: ${report.actionCount} actions, ${report.targetBearingCount} target-bearing\n`,
  );
  const tables = report.contentTables;
  process.stdout.write(
    `  content tables      examined ${tables.examined}, addressable ${tables.addressable}, with a reason ${tables.withReason}${
      tables.enginePopulationMeasured
        ? " (engine population)"
        : " (Mod-referenced population; ref/ absent, engine side not measured)"
    }\n`,
  );
  const building = report.buildingState;
  process.stdout.write(
    `  building state      examined ${building.examined}, carried ${building.carried}, construction-first cap ${building.constructionFirst ? "yes" : "NO"}: ${building.rows
      .map((row) => `${row.member}->${row.family}${row.field === null ? "" : `.${row.field}`}`)
      .join(", ")}\n`,
  );
  for (const [gap, actions] of [...byGap].sort())
    process.stdout.write(`  [${gap}] ${actions.length}: ${actions.join(", ")}\n`);
  const tileArea = report.tileArea;
  if (tileArea.measured)
    process.stdout.write(
      `  tile-area facts     examined ${tileArea.examined}, owned ${tileArea.owned}, shared ${tileArea.shared}: ${tileArea.rows
        .map((row) => `${row.fact}->${row.owner ?? "none"}`)
        .join(", ")}\n`,
    );
  process.stdout.write(
    report.ok ? "  all target-bearing actions have a complete discovery chain\n" : `  ${report.gaps.length} gap(s)\n`,
  );
  process.exitCode = report.ok ? 0 : 1;
}
