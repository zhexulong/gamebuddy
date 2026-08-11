/**
 * Semantic selectors for the direct Stardew gameplay-surface audit.
 *
 * This file does not enumerate the game's content or grant a runtime
 * capability. The inspector discovers members from the supplied game
 * installation; these selectors only classify known native entrypoint shapes
 * and deliberately leave broad dispatchers as `needs_expansion`.
 */

// These are native gameplay entrypoint shapes, not a hand-maintained list of
// the game's actions. The inspector scans every decompiled source file and
// leaves any selected member without an exact semantic rule as needs_expansion.
const GAMEPLAY_METHOD_PATTERNS = Object.freeze([
  /^(?:DoFunction|beginUsing|checkAction|performAction|performToolAction|performUseAction|placementAction|performRemoveAction)$/,
  /^(?:collect|updateChunks|eatHeldObject|warpFarmer|harvest|performTreeFall|pet|feed|catchFish|shipItem)$/,
  /^(?:addItemToInventory|removeItemFromInventory)$/,
  /^(?:purchase|purchaseItem|sell|sellItem|buy|buyItem|craft|craftItem|cook|cookItem)$/,
  /^(?:donate|donateItem|completeQuest|answerDialogue|answerDialogueAction)$/,
  /^(?:startEvent|startSleep|startCasting|startMinigameEndFunction|newDay|newDayAfterFade)$/,
  /^(?:tryToPurchase)$/,
]);

// These are transport/UI callbacks. They are important evidence that a menu
// or minigame exists, but each callback is not a distinct player gameplay
// operation. The inspector aggregates them into one finite surface node per
// menu/minigame type instead of counting every click/key handler as an action.
const UI_INPUT_METHODS = new Set([
  "receiveLeftClick",
  "receiveRightClick",
  "receiveKeyPress",
  "receiveGamePadButton",
  "performHoverAction",
  "exitThisMenu",
  "readyToClose",
]);

export function isUiInputMethod(methodName) {
  return UI_INPUT_METHODS.has(methodName);
}

const DISPATCHER_METHODS = new Set([
  "checkAction",
  "performAction",
  "performToolAction",
  "performUseAction",
  "placementAction",
]);

const TOOL_RULES = Object.freeze({
  "StardewValley.Tools.Axe": ["chop_tree_source", "clear_resource_clump", "break_container_source"],
  "StardewValley.Tools.Pickaxe": ["break_rock_source", "clear_resource_clump", "break_container_source"],
  "StardewValley.Tools.Hoe": ["till_soil", "dig_artifact_spot", "clear_farm_tile"],
  "StardewValley.Tools.WateringCan": ["water_crop", "refill_watering_can"],
  "StardewValley.Tools.Pan": ["pan_ore"],
  "StardewValley.Tools.Wand": ["use_warp_item"],
  "StardewValley.Tools.FishingRod": ["fish"],
  "StardewValley.Tools.MeleeWeapon": ["melee_attack", "weapon_special"],
  "StardewValley.Tools.Slingshot": ["ranged_attack"],
  "StardewValley.Tools.MilkPail": ["collect_animal_product"],
  "StardewValley.Tools.Shears": ["collect_animal_product"],
});

/** Exposes only the source-classification vocabulary; it never grants an action. */
export function knownToolBasisIds(typeName) {
  return TOOL_RULES[typeName] ? [...TOOL_RULES[typeName]] : [];
}

export function isGameplayMethod(methodName) {
  return !isUiInputMethod(methodName) && GAMEPLAY_METHOD_PATTERNS.some((pattern) => pattern.test(methodName));
}

export function isMenuType(typeName) {
  return typeName.startsWith("StardewValley.Menus.");
}

export function isMinigameType(typeName) {
  return typeName.startsWith("StardewValley.Minigames.");
}

export function hasUiInputMethods(methodNames) {
  return methodNames.some(isUiInputMethod);
}

const NON_GAMEPLAY_MENU_TYPES = new Set([
  "StardewValley.Menus.AboutMenu",
  "StardewValley.Menus.AdvancedGameOptions",
  "StardewValley.Menus.AnimationPreviewTool",
  "StardewValley.Menus.LoadGameMenu",
  "StardewValley.Menus.OptionsPage",
  "StardewValley.Menus.ProfileMenu",
  "StardewValley.Menus.TitleMenu",
]);

/**
 * Collapse UI callbacks into one finite surface candidate. A click/key method
 * is evidence of a UI boundary, not a gameplay action by itself. The actual
 * operation choices must be expanded from native menu state/content later.
 */
export function classifyUiSurface(typeName, methodNames) {
  if (!hasUiInputMethods(methodNames)) return null;
  if (isMinigameType(typeName)) {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "finite_minigame_surface" };
  }
  if (isMenuType(typeName) && !NON_GAMEPLAY_MENU_TYPES.has(typeName)) {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "finite_menu_surface" };
  }
  return { mappingStatus: "not_surface", basisPrimitiveIds: [], semanticKind: "supporting_ui_surface" };
}

const NON_GAMEPLAY_NAMESPACE_PREFIXES = Object.freeze([
  "StardewValley.Audio",
  "StardewValley.ContentManifest",
  "StardewValley.Force",
  "StardewValley.Ionic",
  "StardewValley.LWJGL",
  "StardewValley.Netcode",
  "StardewValley.Sickhead",
]);

export function isGameplayType(typeName) {
  // Scan all target-game source files, but exclude engine/serialization
  // infrastructure which cannot itself be a player-reachable operation. New
  // location/menu/object classes remain visible without an allowlist entry.
  return (typeName === "StardewValley" || typeName.startsWith("StardewValley."))
    && !NON_GAMEPLAY_NAMESPACE_PREFIXES.some((prefix) => typeName === prefix || typeName.startsWith(`${prefix}.`));
}

export function classifyGameplayMember(typeName, methodName) {
  if (!isGameplayMethod(methodName) || !isGameplayType(typeName)) return null;

  if (typeName === "StardewValley.Debris" && ["collect", "updateChunks"].includes(methodName)) {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["pickup_item"], semanticKind: "native_lifecycle" };
  }
  if (typeName === "StardewValley.Farmer" && methodName === "eatHeldObject") {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["use_item"], semanticKind: "native_lifecycle" };
  }
  if (methodName === "warpFarmer") {
    return { mappingStatus: "not_surface", basisPrimitiveIds: [], semanticKind: "supporting_native_transition" };
  }
  if ((typeName === "StardewValley.Crop" || typeName === "StardewValley.TerrainFeatures.Crop") && methodName === "harvest") {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["harvest_crop"], semanticKind: "native_lifecycle" };
  }
  if (typeName === "StardewValley.FarmAnimal" && methodName === "pet") {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["pet_animal"], semanticKind: "native_lifecycle" };
  }
  if ((typeName === "StardewValley.Event" || typeName === "StardewValley.GameLocation") && ["answerDialogue", "answerDialogueAction"].includes(methodName)) {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["select_dialogue_response"], semanticKind: "native_lifecycle" };
  }
  if (typeName === "StardewValley.Farmer" && methodName === "completeQuest") {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["submit_quest"], semanticKind: "native_lifecycle" };
  }
  if ((typeName === "StardewValley.Farm" || typeName === "StardewValley.Buildings.ShippingBin") && methodName === "shipItem") {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["ship_item"], semanticKind: "native_lifecycle" };
  }
  if (typeName === "StardewValley.Menus.MuseumMenu" && methodName === "donate") {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["donate_museum_item"], semanticKind: "native_lifecycle" };
  }
  if (typeName === "StardewValley.Game1" && ["newDay", "newDayAfterFade"].includes(methodName)) {
    return { mappingStatus: "not_surface", basisPrimitiveIds: [], semanticKind: "supporting_native_transition" };
  }
  if ((typeName === "StardewValley.Game1" || typeName === "StardewValley.GameLocation") && ["startEvent", "startSleep"].includes(methodName)) {
    return { mappingStatus: "not_surface", basisPrimitiveIds: [], semanticKind: "supporting_native_transition" };
  }
  if (typeName === "StardewValley.Crop" && methodName === "newDay") {
    return { mappingStatus: "not_surface", basisPrimitiveIds: [], semanticKind: "supporting_native_transition" };
  }
  if (typeName === "StardewValley.TerrainFeatures.Tree" && ["performToolAction", "performTreeFall"].includes(methodName)) {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["chop_tree_source"], semanticKind: "native_lifecycle" };
  }
  if (typeName === "StardewValley.TerrainFeatures.ResourceClump" && methodName === "performToolAction") {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["clear_resource_clump"], semanticKind: "native_lifecycle" };
  }
  if (typeName === "StardewValley.TerrainFeatures.HoeDirt" && methodName === "performUseAction") {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "native_dispatcher" };
  }
  if (DISPATCHER_METHODS.has(methodName)) {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "native_dispatcher" };
  }
  if (TOOL_RULES[typeName] && ["DoFunction", "beginUsing"].includes(methodName)) {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "tool_dispatcher" };
  }
  if (typeName === "StardewValley.Objects.CrabPot") {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "content_target_dispatch" };
  }
  if (typeName === "StardewValley.Menus.ShopMenu" || typeName.startsWith("StardewValley.Menus.")) {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "finite_menu_operation" };
  }
  if (typeName === "StardewValley.Event") {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "finite_content_operation" };
  }

  if (["answerDialogue", "answerDialogueAction"].includes(methodName)) {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "native_dialogue_dispatch" };
  }
  if (typeName === "StardewValley.Object" && ["placementAction", "performRemoveAction"].includes(methodName)) {
    return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "item_target_dispatch" };
  }
  if (typeName === "StardewValley.Farmer" && ["addItemToInventory", "removeItemFromInventory"].includes(methodName)) {
    return { mappingStatus: "not_surface", basisPrimitiveIds: [], semanticKind: "supporting_inventory_transition" };
  }
  if (typeName === "StardewValley.Debris" && ["collect", "updateChunks"].includes(methodName)) {
    return { mappingStatus: "mapped", basisPrimitiveIds: ["pickup_item"], semanticKind: "native_lifecycle" };
  }
  return { mappingStatus: "needs_expansion", basisPrimitiveIds: [], semanticKind: "native_gameplay_method" };
}

const CONTENT_LOCALE_SUFFIX = /\.(?:de-DE|es-ES|fr-FR|hu-HU|it-IT|ja-JP|ko-KR|pt-BR|ru-RU|tr-TR|zh-CN)(?=\.xnb$)/i;
const CONTENT_DATA_FAMILIES = new Set([
  "Achievements",
  "AdditionalFarms",
  "BigCraftables",
  "Blueprints",
  "Buildings",
  "Bundles",
  "Characters",
  "CookingRecipes",
  "CraftingRecipes",
  "Crops",
  "FarmAnimals",
  "Fences",
  "Fish",
  "FishPondData",
  "FloorsAndPaths",
  "FruitTrees",
  "Furniture",
  "GiantCrops",
  "HomeRenovations",
  "Locations",
  "Machines",
  "Mail",
  "Mannequins",
  "Minecarts",
  "MonsterSlayerQuests",
  "Monsters",
  "MuseumRewards",
  "NPCGiftTastes",
  "Objects",
  "Pets",
  "Powers",
  "Quests",
  "Recipes",
  "Shops",
  "SpecialOrders",
  "TailoringRecipes",
  "Tools",
  "TriggerActions",
  "Trinkets",
  "Weapons",
  "WildTrees",
  "WorldMap",
]);

export function contentAssetIsGameplayRelevant(assetPath) {
  const normalized = assetPath.replaceAll("\\", "/");
  const dataFamily = normalized.match(/^Data\/([^./]+)(?:\.[^.]+)?\.xnb$/i)?.[1];
  return Boolean(
    (dataFamily && CONTENT_DATA_FAMILIES.has(dataFamily))
      || /^Data\/Events\//i.test(normalized)
      || /^Maps\//i.test(normalized)
      || /^Minigames\//i.test(normalized)
      || /^Characters\/(?:Dialogue|schedules)\//i.test(normalized),
  );
}

/** Collapse localized XNB aliases to one logical target-game content node. */
export function logicalContentAssetPath(assetPath) {
  const normalized = assetPath.replaceAll("\\", "/");
  return normalized.replace(CONTENT_LOCALE_SUFFIX, "");
}

export function contentAssetMappingStatus(assetPath) {
  if (!contentAssetIsGameplayRelevant(assetPath)) return { mappingStatus: "not_relevant" };
  const normalized = logicalContentAssetPath(assetPath);
  const base = normalized.split("/").at(-1) ?? normalized;
  const extension = base.split(".").at(-1)?.toLowerCase();
  if (extension !== "xnb") return { mappingStatus: "needs_expansion", semanticKind: "content_operation" };
  if (/^Data\/Events\//i.test(normalized)) return { mappingStatus: "needs_expansion", semanticKind: "event_content" };
  if (/^Data\/([^./]+)(?:\.[^.]+)?\.xnb$/i.test(normalized)) return { mappingStatus: "needs_expansion", semanticKind: "data_driven_operation" };
  if (/^Maps\//i.test(normalized)) return { mappingStatus: "needs_expansion", semanticKind: "map_properties_and_dispatch" };
  if (/^Minigames\//i.test(normalized)) return { mappingStatus: "needs_expansion", semanticKind: "minigame_content" };
  if (/^Characters\/Dialogue\//i.test(normalized)) return { mappingStatus: "needs_expansion", semanticKind: "social_content" };
  if (/^Characters\/schedules\//i.test(normalized)) return { mappingStatus: "needs_expansion", semanticKind: "social_schedule_content" };
  return { mappingStatus: "needs_expansion", semanticKind: "content_operation" };
}

/**
 * Extract literal operation selectors from a decompiled method body. This is
 * intentionally syntactic: a selector is a discovered game operation that
 * still requires semantic expansion, never an action grant.
 */
export function logicalContentOperationFamily(assetPath) {
  const normalized = logicalContentAssetPath(assetPath);
  if (/^Data\/Events\//i.test(normalized)) return "Data/Events";
  if (/^Data\/Festivals\//i.test(normalized)) return "Data/Festivals";
  if (/^Data\/TV\//i.test(normalized)) return "Data/TV";
  if (/^Data\/([^/]+)\.xnb$/i.test(normalized)) return `Data/${normalized.match(/^Data\/([^/]+)\.xnb$/i)[1]}`;
  if (/^Maps\//i.test(normalized)) return "Maps";
  if (/^Minigames\//i.test(normalized)) return "Minigames";
  if (/^Characters\/Dialogue\//i.test(normalized)) return "Characters/Dialogue";
  if (/^Characters\/schedules\//i.test(normalized)) return "Characters/schedules";
  return normalized.split("/").slice(0, 2).join("/");
}

/**
 * Map one logical Content asset to the native data table/key domain that must
 * be expanded. This is still source-derived metadata, not a copy of the
 * asset's contents and not a runtime capability grant.
 */
export function contentOperationDomain(assetPath) {
  const normalized = logicalContentAssetPath(assetPath);
  const family = logicalContentOperationFamily(normalized);
  if (/^Data\/Events\//i.test(normalized)) return { domainKind: "event_map", keyDomain: normalized.slice("Data/Events/".length).replace(/\.xnb$/i, "") };
  if (/^Data\/Festivals\//i.test(normalized)) return { domainKind: "festival_map", keyDomain: normalized.slice("Data/Festivals/".length).replace(/\.xnb$/i, "") };
  if (/^Data\/TV\//i.test(normalized)) return { domainKind: "tv_channel_map", keyDomain: normalized.slice("Data/TV/".length).replace(/\.xnb$/i, "") };
  if (/^Data\/([^/]+)\.xnb$/i.test(normalized)) return { domainKind: "data_table", keyDomain: normalized.slice("Data/".length, -4) };
  if (family === "Maps") return { domainKind: "map_asset", keyDomain: normalized.slice("Maps/".length).replace(/\.xnb$/i, "") };
  if (family === "Minigames") return { domainKind: "minigame_asset", keyDomain: normalized.slice("Minigames/".length).replace(/\.xnb$/i, "") };
  if (family === "Characters/Dialogue") return { domainKind: "dialogue_asset", keyDomain: normalized.slice("Characters/Dialogue/".length).replace(/\.xnb$/i, "") };
  if (family === "Characters/schedules") return { domainKind: "schedule_asset", keyDomain: normalized.slice("Characters/schedules/".length).replace(/\.xnb$/i, "") };
  return { domainKind: "content_asset", keyDomain: normalized };
}

// DataLoader exposes the target game's real data tables. These selectors only
// decide which loaded tables represent player-reachable semantic surfaces; the
// table keys/counts still come from the target game at inspection time.
const GAMEPLAY_DATA_TABLES = new Map([
  ["BigCraftables", "placeable_item_content"],
  ["Buildings", "building_content"],
  ["Bundles", "bundle_content"],
  ["Characters", "npc_content"],
  ["CookingRecipes", "cooking_recipe_content"],
  ["CraftingRecipes", "crafting_recipe_content"],
  ["Crops", "crop_content"],
  ["FarmAnimals", "animal_content"],
  ["Fences", "fence_content"],
  ["Fish", "fish_content"],
  ["FishPondData", "fish_pond_content"],
  ["FloorsAndPaths", "floor_path_content"],
  ["FruitTrees", "fruit_tree_content"],
  ["GiantCrops", "giant_crop_content"],
  ["HomeRenovations", "home_renovation_content"],
  ["IncomingPhoneCalls", "phone_content"],
  ["Locations", "location_content"],
  ["Machines", "machine_content"],
  ["Mail", "mail_content"],
  ["Monsters", "monster_content"],
  ["MonsterSlayerQuests", "monster_quest_content"],
  ["MuseumRewards", "museum_reward_content"],
  ["NpcGiftTastes", "social_content"],
  ["Objects", "item_content"],
  ["PassiveFestivals", "festival_content"],
  ["Pets", "pet_content"],
  ["Quests", "quest_content"],
  ["Shops", "shop_content"],
  ["SpecialOrders", "special_order_content"],
  ["TailoringRecipes", "tailoring_recipe_content"],
  ["Tools", "tool_content"],
  ["TriggerActions", "world_trigger_content"],
  ["Trinkets", "trinket_content"],
  ["Weapons", "weapon_content"],
  ["WildTrees", "wild_tree_content"],
  ["Festivals_FestivalDates", "festival_calendar_content"],
  ["Tv_CookingChannel", "tv_content"],
  ["Tv_TipChannel", "tv_content"],
]);

export function dataLoaderAssetPath(methodName) {
  const specialPaths = {
    Festivals_FestivalDates: "Data/Festivals/FestivalDates.xnb",
    Tv_CookingChannel: "Data/TV/CookingChannel.xnb",
    Tv_TipChannel: "Data/TV/TipChannel.xnb",
  };
  return specialPaths[methodName] ?? `Data/${methodName}.xnb`;
}

export function classifyDataLoaderTable(methodName) {
  const semanticKind = GAMEPLAY_DATA_TABLES.get(methodName);
  if (!semanticKind) {
    return {
      mappingStatus: "not_surface",
      semanticKind: "supporting_content_data",
    };
  }
  return {
    mappingStatus: "needs_expansion",
    semanticKind,
    contentOperationFamily: logicalContentOperationFamily(dataLoaderAssetPath(methodName)),
    contentOperationDomain: contentOperationDomain(dataLoaderAssetPath(methodName)),
  };
}
