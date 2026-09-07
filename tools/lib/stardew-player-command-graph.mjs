/**
 * Build the first, conservative layer of the source-derived Player-Reachable
 * Command Path (PRCP) audit graph.
 *
 * This module never defines an Agent action and never injects input. It reads
 * the target-version source reconstruction only to verify that normal-player
 * control routing contains known semantic ingress branches. Every discovered
 * ingress branch begins as a command-path candidate; a later equivalence map
 * must supply its typed bridge route before completeness can pass.
 */

import { extractLiteralOperationSelectors } from "./stardew-gameplay-surface-selector.mjs";
import { classifyIngressReachableCall, classifyWorldDispatcherCall } from "./stardew-player-command-classification.mjs";

// These are source-level rule-boundary candidates, not Agent actions. They only
// become a PRCP after the full branch predicate, target domain, native
// lifecycle, and typed bridge equivalence have been reconstructed.
const PLAYER_COMMAND_BOUNDARY_CANDIDATES = Object.freeze([
  {
    ingressId: "world_action_interaction",
    expression: "currentLocation.CheckPetAnimal",
    candidateId: "animal.check_pet",
    semanticFamily: "animal_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.CheckPetAnimal",
  },
  {
    ingressId: "world_action_interaction",
    expression: "currentLocation.CheckInspectAnimal",
    candidateId: "animal.inspect",
    semanticFamily: "animal_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.CheckInspectAnimal",
  },
  {
    ingressId: "world_action_interaction",
    expression: "receiveActionPress",
    candidateId: "event.action_press",
    semanticFamily: "event_operation",
    nativeRuleBoundaryCandidate: "Event.receiveActionPress",
  },
  {
    ingressId: "world_action_interaction",
    expression: "StardewValley.GameLocation.checkAction",
    candidateId: "world.check_action",
    semanticFamily: "world_interaction",
    nativeRuleBoundaryCandidate: "Game1.tryToCheckAt -> GameLocation.checkAction",
  },
  {
    ingressId: "world_tool_use",
    expression: "currentLocation.checkAction",
    candidateId: "world.check_action",
    semanticFamily: "world_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "player.mount.checkAction",
    candidateId: "mount.check_action",
    semanticFamily: "mount_interaction",
    nativeRuleBoundaryCandidate: "Horse.checkAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "player.ActiveObject.performUseAction",
    candidateId: "item.perform_use_action",
    semanticFamily: "item_use",
    nativeRuleBoundaryCandidate: "Object.performUseAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "Utility.tryToPlaceItem",
    candidateId: "item.try_place",
    semanticFamily: "item_placement",
    nativeRuleBoundaryCandidate: "Utility.tryToPlaceItem",
  },
  {
    ingressId: "world_action_interaction",
    expression: "furniture.rotate",
    candidateId: "furniture.rotate",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "Furniture.rotate",
  },
  {
    ingressId: "world_action_interaction",
    expression: "furniture2.rotate",
    candidateId: "furniture.rotate",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "Furniture.rotate",
  },
  {
    ingressId: "world_action_interaction",
    expression: "furniture3.rotate",
    candidateId: "furniture.rotate",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "Furniture.rotate",
  },
  {
    ingressId: "world_action_interaction",
    expression: "chooseResponse",
    candidateId: "dialogue.choose_response",
    semanticFamily: "dialogue_choice",
    nativeRuleBoundaryCandidate: "Dialogue.chooseResponse",
  },
  {
    ingressId: "world_action_interaction",
    expression: "currentLocation.answerDialogue",
    candidateId: "dialogue.answer_location",
    semanticFamily: "dialogue_choice",
    nativeRuleBoundaryCandidate: "GameLocation.answerDialogue",
  },
  {
    ingressId: "world_action_interaction",
    expression: "currentLocation.currentEvent.answerDialogue",
    candidateId: "event.answer_dialogue",
    semanticFamily: "event_choice",
    nativeRuleBoundaryCandidate: "Event.answerDialogue",
  },
  {
    ingressId: "world_action_interaction",
    expression: "animateSpecialMove",
    candidateId: "weapon.special_move",
    semanticFamily: "combat",
    nativeRuleBoundaryCandidate: "MeleeWeapon.animateSpecialMove",
  },
  {
    ingressId: "world_tool_use",
    expression: "currentLocation.checkAction",
    candidateId: "world.check_action",
    semanticFamily: "world_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction",
  },
  {
    ingressId: "world_tool_use",
    expression: "value2.performUseAction",
    candidateId: "terrain.perform_use_action",
    semanticFamily: "terrain_interaction",
    nativeRuleBoundaryCandidate: "TerrainFeature.performUseAction",
  },
  {
    ingressId: "world_tool_use",
    expression: "currentLocation.leftClick",
    candidateId: "world.left_click",
    semanticFamily: "world_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.leftClick",
  },
  {
    ingressId: "world_tool_use",
    expression: "currentLocation.LowPriorityLeftClick",
    candidateId: "world.low_priority_left_click",
    semanticFamily: "world_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.LowPriorityLeftClick",
  },
  {
    ingressId: "world_tool_use",
    expression: "Utility.tryToPlaceItem",
    candidateId: "item.try_place",
    semanticFamily: "item_placement",
    nativeRuleBoundaryCandidate: "Utility.tryToPlaceItem",
  },
  {
    ingressId: "world_tool_use",
    expression: "player.CurrentTool.DoFunction",
    candidateId: "tool.do_function",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "Tool.DoFunction",
  },
  {
    ingressId: "world_tool_use",
    expression: "player.BeginUsingTool",
    candidateId: "tool.begin_using",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "Farmer.BeginUsingTool",
  },
  {
    ingressId: "world_tool_use",
    expression: "value.performToolAction",
    candidateId: "object.perform_tool_action",
    semanticFamily: "object_tool_interaction",
    nativeRuleBoundaryCandidate: "Object.performToolAction",
  },
  {
    ingressId: "world_tool_use",
    expression: "player.netItemStowed.Set",
    candidateId: "inventory.stow_toggle",
    semanticFamily: "inventory_management",
    nativeRuleBoundaryCandidate: "Farmer.netItemStowed.Set",
  },
  {
    ingressId: "world_tool_use",
    expression: "tool.DoFunction",
    candidateId: "tool.do_function",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "Tool.DoFunction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "building.doAction",
    candidateId: "building.do_action",
    semanticFamily: "building_interaction",
    nativeRuleBoundaryCandidate: "Building.doAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "farmer.checkAction",
    candidateId: "farmer.check_action",
    semanticFamily: "farmer_interaction",
    nativeRuleBoundaryCandidate: "Farmer.checkAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "currentEvent.checkAction",
    candidateId: "festival.check_action",
    semanticFamily: "festival_operation",
    nativeRuleBoundaryCandidate: "Event.checkAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "character.checkAction",
    candidateId: "npc.check_action",
    semanticFamily: "npc_interaction",
    nativeRuleBoundaryCandidate: "NPC.checkAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "resourceClump.performUseAction",
    candidateId: "resource_clump.perform_use_action",
    semanticFamily: "resource_source",
    nativeRuleBoundaryCandidate: "ResourceClump.performUseAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "value.checkForAction",
    candidateId: "object.check_for_action",
    semanticFamily: "object_interaction",
    nativeRuleBoundaryCandidate: "Object.checkForAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "value.performObjectDropInAction",
    candidateId: "object.drop_in",
    semanticFamily: "machine_or_container_load",
    nativeRuleBoundaryCandidate: "Object.performObjectDropInAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "pair.Value.performUseAction",
    candidateId: "terrain.perform_use_action",
    semanticFamily: "terrain_interaction",
    nativeRuleBoundaryCandidate: "TerrainFeature.performUseAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "largeTerrainFeature.performUseAction",
    candidateId: "large_terrain.perform_use_action",
    semanticFamily: "terrain_interaction",
    nativeRuleBoundaryCandidate: "LargeTerrainFeature.performUseAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "performAction",
    candidateId: "map.perform_action",
    semanticFamily: "map_operation",
    nativeRuleBoundaryCandidate: "GameLocation.performAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "checkTileIndexAction",
    candidateId: "map.tile_index_action",
    semanticFamily: "map_operation",
    nativeRuleBoundaryCandidate: "GameLocation.checkTileIndexAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "who.BeginSitting",
    candidateId: "seat.begin_sitting",
    semanticFamily: "furniture_or_seat_interaction",
    nativeRuleBoundaryCandidate: "Farmer.BeginSitting",
  },
  {
    ingressId: "world_action_interaction",
    expression: "item.checkForAction",
    candidateId: "furniture.check_for_action",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "Furniture.checkForAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "item.clicked",
    candidateId: "furniture.clicked",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "Furniture.clicked",
  },
  {
    ingressId: "world_action_interaction",
    expression: "furniture.checkForAction",
    candidateId: "furniture.check_for_action",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "Furniture.checkForAction",
  },
  {
    ingressId: "world_action_interaction",
    expression: "furniture.clicked",
    candidateId: "furniture.clicked",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "Furniture.clicked",
  },
  {
    ingressId: "world_tool_release",
    rootTarget: true,
    candidateId: "tool.end_using",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "Farmer.EndUsingTool",
  },
  {
    ingressId: "inventory_toolbar_selection",
    expression: "player.netItemStowed.Set",
    candidateId: "inventory.stow_toggle",
    semanticFamily: "inventory_management",
    nativeRuleBoundaryCandidate: "Farmer.netItemStowed.Set",
  },
  {
    ingressId: "inventory_toolbar_selection",
    expression: "player.UpdateItemStow",
    candidateId: "inventory.stow_update",
    semanticFamily: "inventory_management",
    nativeRuleBoundaryCandidate: "Farmer.UpdateItemStow",
  },
  {
    ingressId: "world_movement",
    rootTarget: true,
    candidateId: "movement.set_direction",
    semanticFamily: "movement",
    nativeRuleBoundaryCandidate: "Farmer.setMoving",
  },
  {
    ingressId: "menu_semantic_selection",
    rootTarget: true,
    candidateId: "menu.typed_operation",
    semanticFamily: "menu_operation",
    nativeRuleBoundaryCandidate: "IClickableMenu.receive* virtual dispatch",
  },
  {
    ingressId: "event_dialogue_or_choice",
    rootTarget: true,
    candidateId: "event.pointer_or_dialogue_operation",
    semanticFamily: "event_operation",
    nativeRuleBoundaryCandidate: "Event.receiveMouseClick / answerDialogue",
  },
  {
    ingressId: "text_chat_submission",
    rootTarget: true,
    candidateId: "text_chat.typed_submission",
    semanticFamily: "text_or_chat",
    nativeRuleBoundaryCandidate: "TextEntry/ChatBox.receive* virtual dispatch",
  },
  {
    ingressId: "minigame_continuous_control",
    rootTarget: true,
    candidateId: "minigame.typed_control",
    semanticFamily: "minigame",
    nativeRuleBoundaryCandidate: "IMinigame.receive* virtual dispatch",
  },
]);

// These branch definitions are source-discovered command boundaries. A branch
// remains a candidate until a typed bridge proves it preserves every relevant
// native precondition and result; it never becomes a generic `checkAction`
// escape hatch.
const GAME1_PRESS_USE_TOOL_BUTTON_BRANCHES = Object.freeze([
  {
    candidateId: "object.fragile_crafting_break_at_tool_tile",
    ingressId: "world_tool_use",
    semanticFamily: "object_tool_interaction",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> Object.performToolAction / Object.performRemoveAction",
    requiredFragments: [
      "player.CurrentTool == null && player.ActiveObject == null",
      'ItemRegistry.Create<Tool>("(T)Pickaxe")',
      "value.performToolAction(tool)",
      "value.performRemoveAction()",
      "currentLocation.Objects.Remove(key)",
    ],
    branchAnchorFragment: "value.performToolAction(tool)",
  },
  {
    candidateId: "terrain_feature.use_at_grab_tile",
    ingressId: "world_tool_use",
    semanticFamily: "terrain_interaction",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> TerrainFeature.performUseAction",
    requiredFragments: [
      "Utility.canGrabSomethingFromHere",
      "currentLocation.terrainFeatures.TryGetValue(tile, out var value2)",
      "value2.performUseAction(tile)",
    ],
    branchAnchorFragment: "value2.performUseAction(tile)",
  },
  {
    candidateId: "world.left_click_at_tool_position",
    ingressId: "world_tool_use",
    semanticFamily: "world_interaction",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> GameLocation.leftClick",
    requiredFragments: ["currentLocation.leftClick((int)position.X, (int)position.Y, player)"],
    branchAnchorFragment: "currentLocation.leftClick((int)position.X, (int)position.Y, player)",
  },
  {
    candidateId: "inventory.stow_active_item",
    ingressId: "world_tool_use",
    semanticFamily: "inventory_management",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> Farmer.netItemStowed.Set(true)",
    requiredFragments: [
      "options.allowStowing",
      "CanPlayerStowItem(GetPlacementGrabTile())",
      "player.netItemStowed.Set(newValue: true)",
    ],
    branchAnchorFragment: "player.netItemStowed.Set(newValue: true)",
  },
  {
    candidateId: "item.place_at_valid_target",
    ingressId: "world_tool_use",
    semanticFamily: "item_placement",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> Utility.tryToPlaceItem",
    requiredFragments: [
      "player.ActiveObject != null",
      "Utility.GetNearbyValidPlacementPosition",
      "Utility.tryToPlaceItem(currentLocation, player.ActiveObject",
    ],
    branchAnchorFragment: "Utility.tryToPlaceItem(currentLocation, player.ActiveObject",
  },
  {
    candidateId: "world.low_priority_left_click_at_tool_position",
    ingressId: "world_tool_use",
    semanticFamily: "world_interaction",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> GameLocation.LowPriorityLeftClick",
    requiredFragments: ["currentLocation.LowPriorityLeftClick((int)position.X, (int)position.Y, player)"],
    branchAnchorFragment: "currentLocation.LowPriorityLeftClick((int)position.X, (int)position.Y, player)",
  },
  {
    candidateId: "inventory.unstow_active_item",
    ingressId: "world_tool_use",
    semanticFamily: "inventory_management",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> Farmer.netItemStowed.Set(false)",
    requiredFragments: [
      "options.allowStowing",
      "player.netItemStowed.Value",
      "player.netItemStowed.Set(newValue: false)",
    ],
    branchAnchorFragment: "player.netItemStowed.Set(newValue: false)",
  },
  {
    candidateId: "tool.continue_using_at_position",
    ingressId: "world_tool_use",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> Tool.DoFunction",
    requiredFragments: ["player.UsingTool", "player.CurrentTool.DoFunction(player.currentLocation"],
    branchAnchorFragment: "player.CurrentTool.DoFunction(player.currentLocation",
  },
  {
    candidateId: "tool.begin_using_at_position",
    ingressId: "world_tool_use",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "Game1.pressUseToolButton -> Farmer.BeginUsingTool",
    requiredFragments: ["player.ActiveObject == null", "player.CurrentTool != null", "player.BeginUsingTool()"],
    branchAnchorFragment: "player.BeginUsingTool()",
  },
]);

// Concrete override bodies below the dynamic `CurrentTool` dispatch. They are
// still only source-derived candidates: the target/phase predicates and the
// bridge-equivalence proof remain outstanding. This list deliberately avoids
// treating the abstract `Tool.DoFunction` call as one command.
const TOOL_OVERRIDE_BRANCHES = Object.freeze([
  {
    candidateId: "hoe.till_diggable_tile",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.Hoe",
    sourceMethod: "DoFunction",
    semanticFamily: "soil_preparation",
    nativeRuleBoundaryCandidate: "Hoe.DoFunction -> GameLocation.makeHoeDirt / checkForBuriedItem",
    requiredFragments: ["location.makeHoeDirt(item)", "location.checkForBuriedItem"],
    branchAnchorFragment: "location.checkForBuriedItem",
  },
  {
    candidateId: "axe.tool_action_at_tile",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.Axe",
    sourceMethod: "DoFunction",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "Axe.DoFunction -> GameLocation.performToolAction",
    requiredFragments: ["location.performToolAction(this, num, num2)"],
    branchAnchorFragment: "location.performToolAction(this, num, num2)",
    allowMethodScope: true,
  },
  {
    candidateId: "axe.terrain_feature_tool_action",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.Axe",
    sourceMethod: "DoFunction",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "Axe.DoFunction -> TerrainFeature.performToolAction",
    requiredFragments: [
      "location.terrainFeatures.TryGetValue(tile, out var value)",
      "value.performToolAction(this, 0, tile)",
    ],
    branchAnchorFragment: "value.performToolAction(this, 0, tile)",
  },
  {
    candidateId: "pickaxe.break_stone_source",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.Pickaxe",
    sourceMethod: "DoFunction",
    semanticFamily: "resource_source",
    nativeRuleBoundaryCandidate: "Pickaxe.DoFunction -> Object.IsBreakableStone / OnStoneDestroyed",
    requiredFragments: ["value.IsBreakableStone()", "location.OnStoneDestroyed(value.ItemId, num, num2"],
    branchAnchorFragment: "location.OnStoneDestroyed(value.ItemId, num, num2",
  },
  {
    candidateId: "watering_can.refill_at_water_source",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.WateringCan",
    sourceMethod: "DoFunction",
    semanticFamily: "tool_use",
    nativeRuleBoundaryCandidate: "WateringCan.DoFunction -> CanRefillWateringCanOnTile",
    requiredFragments: ["Game1.currentLocation.CanRefillWateringCanOnTile", "WaterLeft = waterCanMax"],
    branchAnchorFragment: "WaterLeft = waterCanMax",
  },
  {
    candidateId: "watering_can.apply_to_tiles",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.WateringCan",
    sourceMethod: "DoFunction",
    semanticFamily: "crop_care",
    nativeRuleBoundaryCandidate: "WateringCan.DoFunction -> TerrainFeature/Object/GameLocation.performToolAction",
    requiredFragments: [
      "WaterLeft > 0 || who.hasWateringCanEnchantment",
      "value.performToolAction(this, 0, item)",
      "location.performToolAction(this, (int)item.X, (int)item.Y)",
    ],
    branchAnchorFragment: "location.performToolAction(this, (int)item.X, (int)item.Y)",
  },
  {
    candidateId: "pan.collect_ore_pan_point",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.Pan",
    sourceMethod: "DoFunction",
    semanticFamily: "resource_collection",
    nativeRuleBoundaryCandidate: "Pan.DoFunction -> getPanItems / native inventory delivery",
    requiredFragments: [
      "who.addItemsByMenuIfNecessary(getPanItems(location, who))",
      "location.orePanPoint.Value = Point.Zero",
    ],
    branchAnchorFragment: "who.addItemsByMenuIfNecessary(getPanItems(location, who))",
    allowMethodScope: true,
  },
  {
    candidateId: "fishing_rod.begin_fishing_at_fishable_tile",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.FishingRod",
    sourceMethod: "DoFunction",
    semanticFamily: "fishing",
    nativeRuleBoundaryCandidate: "FishingRod.DoFunction -> GameLocation.canFishHere / isTileFishable",
    requiredFragments: [
      "location.canFishHere() && location.isTileFishable(tileX, tileY)",
      "isFishing = true",
      "timeUntilFishingBite = calculateTimeUntilFishingBite",
    ],
    branchAnchorFragment: "isFishing = true",
  },
]);

const TOOL_BEGIN_USING_BRANCHES = Object.freeze([
  {
    candidateId: "fishing_rod.begin_cast_timing",
    ingressId: "world_tool_use",
    sourceType: "StardewValley.Tools.FishingRod",
    sourceMethod: "beginUsing",
    semanticFamily: "fishing",
    nativeRuleBoundaryCandidate: "FishingRod.beginUsing -> timing-cast native phase",
    requiredFragments: [
      "isTimingCast = true",
      "who.UsingTool = true",
      "who.canReleaseTool = false",
      "setTimingCastAnimation(who)",
    ],
    branchAnchorFragment: "isTimingCast = true",
    allowMethodScope: true,
  },
]);

const TOOL_END_USING_BRANCHES = Object.freeze([
  {
    candidateId: "fishing_rod.cast_on_tool_release",
    ingressId: "world_tool_release",
    sourceType: "StardewValley.Tool",
    sourceMethod: "endUsing",
    semanticFamily: "fishing",
    nativeRuleBoundaryCandidate: "Tool.endUsing -> FishingRod.DoFunction cast",
    requiredFragments: [
      "this is FishingRod fishingRod",
      "who.IsLocalPlayer",
      "!fishingRod.hit",
      "DoFunction(who.currentLocation",
    ],
    branchAnchorFragment: "DoFunction(who.currentLocation",
  },
]);

const GAME_LOCATION_CHECK_ACTION_BRANCHES = Object.freeze([
  // Each entry is a source-derived branch boundary below the ordinary-player
  // `tryToCheckAt -> checkAction` path. These are deliberately *not* bridge
  // routes or actions; each still needs a target domain, full lifecycle, and
  // typed equivalence proof before it can become a canonical PRCP.
  {
    candidateId: "animal.pet_nearby",
    ingressId: "world_action_interaction",
    semanticFamily: "animal_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> GameLocation.CheckPetAnimal",
    requiredFragments: [
      "!objects.ContainsKey(new Vector2(tileLocation.X, tileLocation.Y))",
      "CheckPetAnimal(rectangle, who)",
    ],
    branchAnchorFragment: "CheckPetAnimal(rectangle, who)",
    sourceVariant: "primary_action",
  },
  {
    candidateId: "building.action_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "building_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Building.doAction",
    contextFragments: ["foreach (Building building in buildings)"],
    requiredFragments: ["building.doAction"],
    branchAnchorFragment: "building.doAction(tile, who)",
  },
  {
    candidateId: "seat.stop_sitting",
    ingressId: "world_action_interaction",
    semanticFamily: "furniture_or_seat_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Farmer.StopSitting",
    requiredFragments: ["who.IsSitting()", "who.StopSitting()", "return true;"],
    branchAnchorFragment: "who.StopSitting()",
  },
  {
    candidateId: "farmhand.action_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "farmer_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Farmer.checkAction",
    contextFragments: ["foreach (Farmer farmer in farmers)"],
    requiredFragments: ["farmer.checkAction(who, this)"],
    branchAnchorFragment: "farmer.checkAction(who, this)",
  },
  {
    candidateId: "festival.action_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "festival_operation",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Event.checkAction",
    requiredFragments: [
      "currentEvent != null && currentEvent.isFestival",
      "currentEvent.checkAction(tileLocation, viewport, who)",
    ],
    branchAnchorFragment: "currentEvent.checkAction(tileLocation, viewport, who)",
  },
  {
    candidateId: "npc.action_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "npc_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> NPC.checkAction",
    contextFragments: ["foreach (NPC character in characters)"],
    requiredFragments: ["character.checkAction(who, this)"],
    branchAnchorFragment: "character.checkAction(who, this)",
  },
  {
    candidateId: "resource_clump.use_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "resource_source",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> ResourceClump.performUseAction",
    contextFragments: ["foreach (ResourceClump resourceClump in resourceClumps)"],
    requiredFragments: ["resourceClump.performUseAction"],
    branchAnchorFragment: "resourceClump.performUseAction",
  },
  {
    candidateId: "object.auto_remove_obstruction",
    ingressId: "world_action_interaction",
    semanticFamily: "object_tool_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> temporary Tool.DoFunction / Object.performToolAction",
    requiredFragments: [
      "vector == who.Tile",
      'ItemRegistry.Create<Tool>("(T)Pickaxe")',
      "value.performToolAction(tool)",
      "Game1.currentLocation.Objects.Remove(vector)",
    ],
  },
  {
    candidateId: "object.check_for_action_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "object_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Object.checkForAction",
    requiredFragments: [
      'value.Type == "Crafting" || value.Type == "interactive"',
      "who.ActiveObject == null && value.checkForAction(who)",
    ],
    branchAnchorFragment: "who.ActiveObject == null && value.checkForAction(who)",
  },
  {
    candidateId: "object.drop_in_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "machine_or_container_load",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Object.performObjectDropInAction",
    requiredFragments: [
      "value.performObjectDropInAction(who.CurrentItem, probe: true, who)",
      "value.performObjectDropInAction(who.CurrentItem, probe: false, who, returnFalseIfItemConsumed: true)",
      "who.reduceActiveItemByOne()",
    ],
    branchAnchorFragment:
      "value.performObjectDropInAction(who.CurrentItem, probe: false, who, returnFalseIfItemConsumed: true)",
  },
  {
    candidateId: "forage.pickup_spawned_object",
    ingressId: "world_action_interaction",
    semanticFamily: "forage_pickup",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> native forage inventory delivery/removal",
    requiredFragments: [
      "value.isSpawnedObject.Value || isErrorItem",
      "value.isForage()",
      "who.couldInventoryAcceptThisItem(value)",
      "who.addItemToInventoryBool(value.getOne())",
      "objects.Remove(vector)",
    ],
    branchAnchorFragment: "who.addItemToInventoryBool(value.getOne())",
  },
  {
    candidateId: "mount.interact",
    ingressId: "world_action_interaction",
    semanticFamily: "mount_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Horse.checkAction",
    requiredFragments: ["who.isRidingHorse()", "who.mount.checkAction(who, this)", "return true;"],
  },
  {
    candidateId: "terrain_feature.use_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "terrain_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> TerrainFeature.performUseAction",
    contextFragments: ["foreach (KeyValuePair<Vector2, TerrainFeature> pair in terrainFeatures.Pairs)"],
    requiredFragments: ["pair.Value.performUseAction(pair.Key)", "Game1.haltAfterCheck = false"],
    branchAnchorFragment: "pair.Value.performUseAction(pair.Key)",
  },
  {
    candidateId: "large_terrain_feature.use_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "terrain_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> LargeTerrainFeature.performUseAction",
    contextFragments: ["foreach (LargeTerrainFeature largeTerrainFeature in largeTerrainFeatures)"],
    requiredFragments: ["largeTerrainFeature.performUseAction", "Game1.haltAfterCheck = false"],
    branchAnchorFragment: "largeTerrainFeature.performUseAction",
  },
  {
    candidateId: "map.action_property",
    ingressId: "world_action_interaction",
    semanticFamily: "map_operation",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> GameLocation.performAction(map Action property)",
    requiredFragments: ["value4 != null", "return performAction(value4, who, tileLocation)"],
    branchAnchorFragment: "return performAction(value4, who, tileLocation)",
  },
  {
    candidateId: "map.tile_index_action",
    ingressId: "world_action_interaction",
    semanticFamily: "map_operation",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> GameLocation.checkTileIndexAction",
    requiredFragments: ["checkTileIndexAction(tile.TileIndex)", "return true;"],
    branchAnchorFragment: "checkTileIndexAction(tile.TileIndex)",
  },
  {
    candidateId: "map_seat.begin_sitting",
    ingressId: "world_action_interaction",
    semanticFamily: "furniture_or_seat_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Farmer.BeginSitting(MapSeat)",
    contextFragments: ["foreach (MapSeat mapSeat in mapSeats)"],
    requiredFragments: ["mapSeat.OccupiesTile", "who.BeginSitting(mapSeat)"],
  },
  {
    candidateId: "furniture.click_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Furniture.clicked",
    requiredFragments: ["return item.clicked(who)"],
    branchAnchorFragment: "return item.clicked(who)",
  },
  {
    candidateId: "furniture.drop_in_at_tile",
    ingressId: "world_action_interaction",
    semanticFamily: "furniture_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> Furniture.performObjectDropInAction",
    requiredFragments: ["flag3", "item.performObjectDropInAction(who.ActiveObject, probe: false, who)"],
    branchAnchorFragment: "item.performObjectDropInAction(who.ActiveObject, probe: false, who)",
  },
  {
    candidateId: "animal.inspect_nearby",
    ingressId: "world_action_interaction",
    semanticFamily: "animal_interaction",
    nativeRuleBoundaryCandidate: "GameLocation.checkAction -> GameLocation.CheckInspectAnimal",
    requiredFragments: [
      "Game1.didPlayerJustRightClick(ignoreNonMouseHeldInput: true)",
      "animals.Length > 0",
      "CheckInspectAnimal(rectangle, who)",
    ],
    branchAnchorFragment: "CheckInspectAnimal(rectangle, who)",
    sourceVariant: "right_click_inspection",
  },
]);

const PLAYER_INGRESS_ROOTS = Object.freeze([
  {
    ingressId: "world_action_interaction",
    inputState: "actionButtonPressed",
    targetMethod: "StardewValley.Game1.pressActionButton",
    requiredFragments: ["actionButtonPressed", "pressActionButton(currentKBState, currentMouseState, currentPadState)"],
  },
  {
    ingressId: "world_tool_use",
    inputState: "useToolButtonPressed",
    targetMethod: "StardewValley.Game1.pressUseToolButton",
    requiredFragments: ["useToolButtonPressed", "pressUseToolButton()"],
  },
  {
    ingressId: "world_tool_release",
    inputState: "useToolButtonReleased",
    targetMethod: "StardewValley.Farmer.EndUsingTool",
    requiredFragments: ["useToolButtonReleased", "player.EndUsingTool()"],
  },
  {
    ingressId: "inventory_toolbar_selection",
    inputState: "switchToolButtonPressed",
    targetMethod: "StardewValley.Game1.pressSwitchToolButton",
    requiredFragments: ["switchToolButtonPressed", "pressSwitchToolButton()"],
  },
  {
    ingressId: "world_movement",
    inputState: "move*Held/move*Released",
    targetMethod: "StardewValley.Farmer.setMoving",
    requiredFragments: ["moveUpHeld", "moveRightHeld", "moveDownHeld", "moveLeftHeld", "player.setMoving"],
  },
  {
    ingressId: "menu_semantic_selection",
    inputState: "active menu pointer/key/gamepad selection",
    targetMethod: "StardewValley.Menus.IClickableMenu.receive*",
    sourceMethod: "updateActiveMenu",
    // ILSpy renames this local between builds (active_menu / childMenu), so
    // use stable selector fragments rather than a decompiler-local name.
    requiredFragments: [
      "receiveLeftClick(getMouseX(), getMouseY())",
      "receiveRightClick(getMouseX(), getMouseY())",
      "receiveKeyPress(",
    ],
  },
  {
    ingressId: "event_dialogue_or_choice",
    inputState: "action/use-tool while event or dialogue active",
    targetMethod: "StardewValley.Event.receiveMouseClick / dialogue answer",
    requiredFragments: [
      "CurrentEvent?.receiveMouseClick",
      "pressActionButton(currentKBState, currentMouseState, currentPadState)",
    ],
  },
  {
    ingressId: "text_chat_submission",
    inputState: "active text entry/chat keyboard or gamepad submission",
    targetMethod: "StardewValley.TextEntry.receive* / ChatBox.receive*",
    sourceMethod: "updateTextEntry",
    requiredFragments: ["textEntry.receiveKeyPress", "textEntry.receiveGamePadButton"],
  },
  {
    ingressId: "minigame_continuous_control",
    inputState: "current minigame key/button/pointer control",
    targetMethod: "StardewValley.Minigames.IMinigame.receive*",
    sourceMethod: "_update",
    // The decompiler can rename the GameTime parameter, therefore use two
    // stable method-call anchors rather than its local variable name.
    requiredFragments: ["currentMinigame.receiveKeyPress", "currentMinigame.tick("],
  },
]);

function methodBody(source, methodName) {
  // Declaration prefixes prevent a call-site like `if (pressActionButton()) {`
  // from being mistaken for the method body when both occur in Game1.cs.
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

function matchingDelimiter(source, openOffset, openCharacter, closeCharacter) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openOffset; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === openCharacter) depth += 1;
    else if (character === closeCharacter && --depth === 0) return index;
  }
  return -1;
}

/**
 * Return the source range for the innermost `if (...) { ... }` that owns a
 * fragment in its condition/body. This rejects a list of fragment matches
 * merely scattered across unrelated sibling branches.
 */
function enclosingConditionalBlockRange(source, offset) {
  // Do not choose merely the last textual `if` before an offset: sibling
  // branches can occur later in the same containing block. Select the
  // innermost conditional whose body actually encloses the target offset.
  const conditional = /\bif\s*\(/g;
  const candidates = [];
  const prefix = source.slice(0, offset + 1);
  let match;
  while ((match = conditional.exec(prefix))) {
    const openParenthesis = source.indexOf("(", match.index);
    const closeParenthesis = matchingDelimiter(source, openParenthesis, "(", ")");
    if (closeParenthesis < 0) continue;
    const nextToken = source.slice(closeParenthesis + 1).search(/\S/);
    if (nextToken < 0) continue;
    const statementStart = closeParenthesis + 1 + nextToken;
    if (source[statementStart] === "{") {
      const closeBrace = matchingDelimiter(source, statementStart, "{", "}");
      if (closeBrace >= offset) candidates.push({ start: match.index, end: closeBrace });
    } else {
      // Target source normally uses braces, but accept a decompiler/test
      // single-statement branch without treating it as an unknown omission.
      const statementEnd = source.indexOf(";", statementStart);
      if (statementEnd >= offset) candidates.push({ start: match.index, end: statementEnd });
    }
  }
  return candidates.sort((left, right) => left.end - left.start - (right.end - right.start))[0] ?? null;
}

function enclosingStatementBlockRange(source, offset) {
  const stack = [];
  let quote = null;
  let escaped = false;
  for (let index = 0; index <= offset; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") stack.push(index);
    else if (character === "}") stack.pop();
  }
  const start = stack.at(-1);
  if (start === undefined) return null;
  const end = matchingDelimiter(source, start, "{", "}");
  return end < 0 ? null : { start, end };
}

function enclosingBlockRanges(source, offset) {
  const ranges = [];
  const statement = enclosingStatementBlockRange(source, offset);
  if (statement) ranges.push(statement);
  const conditional = /\bif\s*\(/g;
  let match;
  while ((match = conditional.exec(source.slice(0, offset + 1))) !== null) {
    const open = source.indexOf("(", match.index);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close < 0) continue;
    const whitespace = source.slice(close + 1).search(/\S/);
    if (whitespace < 0) continue;
    const start = close + 1 + whitespace;
    const end = source[start] === "{" ? matchingDelimiter(source, start, "{", "}") : source.indexOf(";", start);
    // The native call can be part of an `if` condition (for example
    // `TryGetValue(...) && performToolAction(...)`), not only its body.
    if (end >= offset && offset >= match.index) ranges.push({ start: match.index, end });
  }
  return ranges
    .filter((range) => range.end >= offset)
    .sort((left, right) => left.end - left.start - (right.end - right.start));
}

function positionOfAll(source, fragment) {
  const positions = [];
  let start = 0;
  while (true) {
    const index = source.indexOf(fragment, start);
    if (index < 0) return positions;
    positions.push(index);
    start = index + fragment.length;
  }
}

const NON_CALL_IDENTIFIERS = new Set([
  "if",
  "for",
  "foreach",
  "while",
  "switch",
  "catch",
  "using",
  "lock",
  "return",
  "new",
  "typeof",
  "nameof",
  "default",
  "base",
  "this",
]);

function callsFromMethodBody(body) {
  if (!body) return [];
  const calls = new Map();
  const pattern = /\b((?:[A-Za-z_]\w*\s*\.\s*)*[A-Za-z_]\w*)\s*(?:<[^;{}()\r\n]+>)?\s*\(/g;
  for (const match of body.matchAll(pattern)) {
    const expression = match[1].replace(/\s+/g, "");
    const leaf = expression.split(".").at(-1);
    if (NON_CALL_IDENTIFIERS.has(leaf)) continue;
    if (!calls.has(expression)) calls.set(expression, { expression, leaf, sourceOffset: match.index });
  }
  return [...calls.values()].sort((left, right) => left.expression.localeCompare(right.expression));
}

/**
 * Find a matching method across the temporary target-version source tree.
 * The source type may use a namespace-shaped path such as
 * StardewValley.GameLocation; callers must still treat dynamic overrides as
 * unresolved until their branch targets are reconstructed.
 */
function sourceForType(sourceIndex, typeName) {
  if (!sourceIndex || typeof sourceIndex !== "object") return null;
  const normalize = (candidateType, value) =>
    typeof value === "string"
      ? { typeName: candidateType, source: value, sourceFile: `${candidateType.replaceAll(".", "/")}.cs` }
      : value && typeof value.source === "string"
        ? {
            typeName: candidateType,
            source: value.source,
            sourceFile: value.sourceFile ?? `${candidateType.replaceAll(".", "/")}.cs`,
          }
        : null;
  const exact = normalize(typeName, sourceIndex[typeName]);
  if (exact) return exact;
  const shortType = typeName.split(".").at(-1);
  const candidates = Object.entries(sourceIndex)
    .map(([candidateType, value]) => normalize(candidateType, value))
    .filter((candidate) => candidate && candidate.typeName.split(".").at(-1) === shortType)
    .sort((left, right) => left.typeName.localeCompare(right.typeName));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Expand the shared GameLocation.checkAction boundary after the control router
 * has reached it through either action-button targeting or tool-use targeting.
 * A synthetic tryToCheckAt edge is explicit provenance, not a collapsed route.
 */
function reachableSecondHopEdges(gameLocationSource, rootDispatchEdges, ingress, options) {
  if (!gameLocationSource) return [];
  const edges = [];
  const actionRoot = ingress.ingressRoots.find(
    (root) => root.ingressId === "world_action_interaction" && root.classification !== "unknown",
  );
  const toolRoot = ingress.ingressRoots.find(
    (root) => root.ingressId === "world_tool_use" && root.classification !== "unknown",
  );
  const actionReachesCheck =
    actionRoot &&
    rootDispatchEdges.some((edge) => edge.ingressId === actionRoot.ingressId && edge.to === "tryToCheckAt");
  const toolReachesCheck =
    toolRoot &&
    rootDispatchEdges.some(
      (edge) => edge.ingressId === toolRoot.ingressId && edge.to === "currentLocation.checkAction",
    );
  if (actionReachesCheck) {
    edges.push({
      edgeId: "StardewValley.Game1.tryToCheckAt->StardewValley.GameLocation.checkAction",
      from: "StardewValley.Game1.tryToCheckAt",
      to: "StardewValley.GameLocation.checkAction",
      sourceType: "StardewValley.Game1",
      sourceFile: options.sourceFile ?? "StardewValley/Game1.cs",
      sourceMethod: "tryToCheckAt",
      ingressId: actionRoot.ingressId,
      classification: "candidate_dispatch_edge",
      reason: "second_hop_source_anchor",
    });
  }
  for (const root of [actionRoot, toolRoot].filter(Boolean)) {
    const reachesCheck = root.ingressId === "world_action_interaction" ? actionReachesCheck : toolReachesCheck;
    if (!reachesCheck) continue;
    edges.push(
      ...extractDirectCallEdges(gameLocationSource.source, "checkAction", {
        sourceType: gameLocationSource.typeName,
        sourceFile: gameLocationSource.sourceFile,
        ingressId: root.ingressId,
      }).map((edge) => ({ ...edge, reason: "second_hop_from_game_location_check_action" })),
    );
  }
  return edges;
}

/**
 * Read source-specific rule branches only after proving the normal control
 * router reaches GameLocation.checkAction. A branch candidate retains every
 * source fragment and offset; it is not inferred from the candidate name.
 */
function sourceBranchCandidates({
  source,
  sourceType,
  sourceFile,
  sourceMethod,
  definitions,
  ingressId,
  sourceEdgeIds,
  reason,
}) {
  const body = methodBody(source, sourceMethod);
  if (body === null) return [];
  return definitions
    .map((definition) => {
      const positions = Object.fromEntries(
        definition.requiredFragments.map((fragment) => [fragment, positionOfAll(body, fragment).slice(0, 8)]),
      );
      if (Object.values(positions).some((offsets) => offsets.length === 0)) return null;
      const anchorFragment = definition.branchAnchorFragment ?? definition.requiredFragments[0];
      const candidateOffsets = positionOfAll(body, anchorFragment).slice(0, 8);
      const evidence = candidateOffsets
        .map((primaryOffset) => {
          const nonTerminalFragments = definition.requiredFragments;
          const ranges = enclosingBlockRanges(body, primaryOffset);
          const smallestContainingAll = ranges.find((branchRange) =>
            nonTerminalFragments.every((fragment) =>
              (positions[fragment] ?? []).some((offset) => offset >= branchRange.start && offset <= branchRange.end),
            ),
          );
          // In compact source a placement call can sit in an outer object branch
          // preceded by a target-resolution helper. The helper is still part of
          // the same path only when the common outer scope proves every fragment;
          // sibling-only fragments remain rejected because no shared scope exists.
          if (smallestContainingAll) return smallestContainingAll;
          // Some leaf tool overrides contain unrelated early guards followed by a
          // linear native transition (for example Axe's location action and Pan
          // delivery). A definition must explicitly opt in, and its anchor must
          // not itself belong to a conditional; this never merges sibling branches.
          if (definition.allowMethodScope && !enclosingConditionalBlockRange(body, primaryOffset))
            return { start: 0, end: body.length };
          // A fully linear leaf body can retain method-scope provenance without a
          // special opt-in because it has no sibling conditional branches.
          return /\bif\s*\(/.test(body) ? null : { start: 0, end: body.length };
        })
        .find(Boolean);
      if (!evidence) return null;
      return {
        ...definition,
        sourceEdgeIds,
        sourceEvidence: {
          sourceType,
          sourceFile,
          sourceMethod,
          branchKind: "source_fragment_conjunction",
          requiredFragments: definition.requiredFragments,
          contextFragments: [],
          anchorPositions: positions,
          branchRange: evidence,
        },
        status: "boundary_candidate",
        route: null,
        reason,
      };
    })
    .filter(Boolean);
}

export function game1PressUseToolButtonBranchCandidates(game1Source, rootDispatchEdges, ingress, options = {}) {
  const root = ingress.ingressRoots.find(
    (item) => item.ingressId === "world_tool_use" && item.classification !== "unknown",
  );
  if (
    !root ||
    !rootDispatchEdges.some((edge) => edge.ingressId === root.ingressId && edge.from.endsWith(".pressUseToolButton"))
  )
    return [];
  return sourceBranchCandidates({
    source: game1Source,
    sourceType: options.sourceType ?? "StardewValley.Game1",
    sourceFile: options.sourceFile ?? "StardewValley/Game1.cs",
    sourceMethod: "pressUseToolButton",
    definitions: GAME1_PRESS_USE_TOOL_BUTTON_BRANCHES,
    ingressId: root.ingressId,
    sourceEdgeIds: rootDispatchEdges
      .filter((edge) => edge.ingressId === root.ingressId && edge.from.endsWith(".pressUseToolButton"))
      .map((edge) => edge.edgeId),
    reason: "target_domain_and_bridge_equivalence_not_yet_reconstructed",
  });
}

export function toolOverrideBranchCandidates(sourceIndex, rootDispatchEdges, ingress) {
  const root = ingress.ingressRoots.find(
    (item) => item.ingressId === "world_tool_use" && item.classification !== "unknown",
  );
  const toolDispatchEdges = rootDispatchEdges.filter(
    (edge) =>
      edge.ingressId === "world_tool_use" && (edge.to.includes("BeginUsingTool") || edge.to.includes("DoFunction")),
  );
  if (!root || toolDispatchEdges.length === 0) return [];
  return TOOL_OVERRIDE_BRANCHES.flatMap((definition) => {
    const source = sourceForType(sourceIndex, definition.sourceType);
    if (!source) return [];
    return sourceBranchCandidates({
      source: source.source,
      sourceType: source.typeName,
      sourceFile: source.sourceFile,
      sourceMethod: definition.sourceMethod,
      definitions: [definition],
      ingressId: definition.ingressId,
      sourceEdgeIds: toolDispatchEdges.map((edge) => edge.edgeId),
      reason: "dynamic_tool_target_domain_phase_and_bridge_equivalence_not_yet_reconstructed",
    });
  });
}

export function toolBeginUsingBranchCandidates(sourceIndex, beginEdges, ingress) {
  const root = ingress.ingressRoots.find(
    (item) => item.ingressId === "world_tool_use" && item.classification !== "unknown",
  );
  if (!root || !beginEdges.some((edge) => edge.ingressId === root.ingressId && edge.to.includes("beginUsing")))
    return [];
  const source = sourceForType(sourceIndex, "StardewValley.Tools.FishingRod");
  if (!source) return [];
  return sourceBranchCandidates({
    source: source.source,
    sourceType: source.typeName,
    sourceFile: source.sourceFile,
    sourceMethod: "beginUsing",
    definitions: TOOL_BEGIN_USING_BRANCHES,
    ingressId: root.ingressId,
    sourceEdgeIds: beginEdges
      .filter((edge) => edge.ingressId === root.ingressId && edge.to.includes("beginUsing"))
      .map((edge) => edge.edgeId),
    reason: "fishing_phase_target_domain_and_bridge_equivalence_not_yet_reconstructed",
  });
}

export function toolEndUsingBranchCandidates(sourceIndex, releaseEdges, ingress) {
  const root = ingress.ingressRoots.find(
    (item) => item.ingressId === "world_tool_release" && item.classification !== "unknown",
  );
  if (!root || !releaseEdges.some((edge) => edge.ingressId === root.ingressId && edge.to.includes("endUsing")))
    return [];
  const source = sourceForType(sourceIndex, "StardewValley.Tool");
  if (!source) return [];
  return sourceBranchCandidates({
    source: source.source,
    sourceType: source.typeName,
    sourceFile: source.sourceFile,
    sourceMethod: "endUsing",
    definitions: TOOL_END_USING_BRANCHES,
    ingressId: root.ingressId,
    sourceEdgeIds: releaseEdges
      .filter((edge) => edge.ingressId === root.ingressId && edge.to.includes("endUsing"))
      .map((edge) => edge.edgeId),
    reason: "tool_release_phase_target_domain_and_bridge_equivalence_not_yet_reconstructed",
  });
}

export function gameLocationCheckActionBranchCandidates(gameLocationSource, rootDispatchEdges, ingress) {
  if (!gameLocationSource) return [];
  const actionRoot = ingress.ingressRoots.find(
    (root) => root.ingressId === "world_action_interaction" && root.classification !== "unknown",
  );
  const actionReachesCheck =
    actionRoot &&
    rootDispatchEdges.some((edge) => edge.ingressId === actionRoot.ingressId && edge.to === "tryToCheckAt");
  if (!actionReachesCheck) return [];
  const body = methodBody(gameLocationSource.source, "checkAction");
  if (body === null) return [];
  return GAME_LOCATION_CHECK_ACTION_BRANCHES.map((definition) => {
    const positions = Object.fromEntries(
      definition.requiredFragments.map((fragment) => [fragment, positionOfAll(body, fragment).slice(0, 8)]),
    );
    const contextPositions = Object.fromEntries(
      (definition.contextFragments ?? []).map((fragment) => [fragment, positionOfAll(body, fragment).slice(0, 8)]),
    );
    if (
      Object.values(positions).some((offsets) => offsets.length === 0) ||
      Object.values(contextPositions).some((offsets) => offsets.length === 0)
    )
      return null;
    const anchorFragment = definition.branchAnchorFragment ?? definition.requiredFragments[0];
    const candidateOffsets = positionOfAll(body, anchorFragment).slice(0, 8);
    const evidence = candidateOffsets
      .map((primaryOffset) => {
        // A source branch may be represented by an outer condition plus a
        // nested short-circuit/return expression. Pick the smallest enclosing
        // range that proves the whole conjunction, never arbitrary sibling
        // fragments elsewhere in checkAction.
        const terminalFragments = definition.terminalFragments
          ? definition.terminalFragments.filter((fragment) => Array.isArray(positions[fragment]))
          : [];
        const nonTerminalFragments = definition.requiredFragments.filter(
          (fragment) => !terminalFragments.includes(fragment),
        );
        return (
          enclosingBlockRanges(body, primaryOffset).find((branchRange) => {
            if (
              nonTerminalFragments.some(
                (fragment) =>
                  !(positions[fragment] ?? []).some(
                    (offset) => offset >= branchRange.start && offset <= branchRange.end,
                  ),
              )
            )
              return false;
            if (
              terminalFragments.some(
                (fragment) =>
                  !positions[fragment].some((offset) => offset >= branchRange.start && offset <= body.length),
              )
            )
              return false;
            // A loop declaration is outside its nested `if` body; retain explicit
            // context evidence without weakening the branch-local conjunction.
            if (Object.values(contextPositions).some((offsets) => !offsets.some((offset) => offset <= branchRange.end)))
              return false;
            return true;
          }) ?? null
        );
      })
      .find(Boolean);
    if (!evidence) return null;
    const branchRange = evidence;
    return {
      ...definition,
      candidateId: definition.sourceVariant
        ? `${definition.candidateId}.${definition.sourceVariant}`
        : definition.candidateId,
      sourceEdgeIds: ["StardewValley.Game1.tryToCheckAt->StardewValley.GameLocation.checkAction"],
      sourceEvidence: {
        sourceType: gameLocationSource.typeName,
        sourceFile: gameLocationSource.sourceFile,
        sourceMethod: "checkAction",
        branchKind: "source_fragment_conjunction",
        requiredFragments: definition.requiredFragments,
        contextFragments: definition.contextFragments ?? [],
        anchorPositions: positions,
        branchRange,
      },
      status: "boundary_candidate",
      route: null,
      reason: "live_target_identity_and_bridge_equivalence_not_yet_reconstructed",
    };
  }).filter(Boolean);
}

/**
 * Extract direct call edges from a single reconstructed method. This is not a
 * whole-program call graph: unresolved virtual/external calls deliberately
 * remain candidate edges for later classification.
 */
/**
 * Expand literal map Action selectors below an already source-proved
 * `checkAction -> performAction` branch. These are command candidates, not
 * generic dispatcher routes: each carries the exact target-version selector
 * and stays pending until a finite typed route proves equivalent.
 */
export function gameLocationPerformActionSelectorCandidates(gameLocationSource, sourceBranchCandidates = []) {
  if (
    !gameLocationSource ||
    !sourceBranchCandidates.some((candidate) => candidate.candidateId === "map.action_property")
  )
    return [];
  const selectors = extractLiteralOperationSelectors(gameLocationSource.source, "performAction");
  return selectors.map((entry) => ({
    candidateId: `map.action_property.${entry.selectorKind}.${entry.selectorVariable ?? "literal"}.${entry.selector}`,
    ingressId: "world_action_interaction",
    semanticFamily: "map_operation",
    nativeRuleBoundaryCandidate: `GameLocation.performAction selector ${entry.selector}`,
    selector: entry.selector,
    selectorKind: entry.selectorKind,
    selectorVariable: entry.selectorVariable ?? null,
    sourceEdgeIds: ["StardewValley.Game1.tryToCheckAt->StardewValley.GameLocation.checkAction"],
    sourceEvidence: {
      sourceType: gameLocationSource.typeName,
      sourceFile: gameLocationSource.sourceFile,
      sourceMethod: "performAction",
      branchKind: "literal_operation_selector",
      parentCandidateId: "map.action_property",
      requiredFragments: [`${entry.selectorKind}:${entry.selector}`],
      anchorPositions: { [`${entry.selectorKind}:${entry.selector}`]: [] },
      selector: entry.selector,
      selectorKind: entry.selectorKind,
      selectorVariable: entry.selectorVariable ?? null,
    },
    status: "boundary_candidate",
    route: null,
    reason: "map_action_selector_requires_content_domain_and_typed_bridge_equivalence",
  }));
}

export function extractDirectCallEdges(
  source,
  methodName,
  {
    sourceType = "StardewValley.Game1",
    sourceFile = "StardewValley/Game1.cs",
    ingressId = null,
    dispatcherClassification = false,
  } = {},
) {
  const body = methodBody(source, methodName);
  if (body === null) return [];
  return callsFromMethodBody(body).map((call) => {
    const auditClassification = dispatcherClassification
      ? classifyWorldDispatcherCall(methodName, call.expression)
      : classifyIngressReachableCall(call.expression);
    return {
      edgeId: `${sourceType}.${methodName}->${call.expression}`,
      from: `${sourceType}.${methodName}`,
      to: call.expression,
      sourceType,
      sourceFile,
      sourceMethod: methodName,
      sourceOffset: call.sourceOffset,
      ...(ingressId ? { ingressId } : {}),
      classification: auditClassification?.classification ?? "candidate_dispatch_edge",
      ...(auditClassification ? { reason: auditClassification.reason } : {}),
    };
  });
}

/**
 * Return source-derived root edges from the exact target Game1 control router.
 * Absence is unknown, never evidence that a player cannot issue that command.
 */
export function extractPlayerIngressRoots(
  game1Source,
  { sourceFile = "StardewValley/Game1.cs", sourceType = "StardewValley.Game1" } = {},
) {
  const rootBodies = new Map();
  for (const definition of PLAYER_INGRESS_ROOTS) {
    const sourceMethod = definition.sourceMethod ?? "UpdateControlInput";
    rootBodies.set(sourceMethod, methodBody(game1Source, sourceMethod));
  }
  const controlBody = rootBodies.get("UpdateControlInput");
  if (controlBody === null) {
    return {
      rootMethod: `${sourceType}.UpdateControlInput`,
      state: "unknown",
      sourceFile,
      errors: ["Game1.UpdateControlInput could not be located in the target-version source reconstruction."],
      ingressRoots: [],
    };
  }

  const ingressRoots = PLAYER_INGRESS_ROOTS.map((definition) => {
    const sourceMethod = definition.sourceMethod ?? "UpdateControlInput";
    const body = rootBodies.get(sourceMethod) ?? "";
    const missingFragments = definition.requiredFragments.filter((fragment) => !body.includes(fragment));
    const anchorPositions = Object.fromEntries(
      definition.requiredFragments.map((fragment) => [fragment, positionOfAll(body, fragment).slice(0, 8)]),
    );
    return {
      ingressId: definition.ingressId,
      inputState: definition.inputState,
      targetMethod: definition.targetMethod,
      sourceType,
      sourceFile,
      sourceMethod,
      requiredFragments: definition.requiredFragments,
      anchorPositions,
      classification: missingFragments.length === 0 ? "command_path_candidate" : "unknown",
      ...(missingFragments.length ? { missingFragments } : {}),
      // No PRCP is claimed until the candidate's target branches and native
      // rule boundary have been reconstructed and mapped to a typed route.
      prcpId: null,
      route: null,
    };
  });

  return {
    rootMethod: `${sourceType}.UpdateControlInput`,
    state: ingressRoots.some((root) => root.classification === "unknown") ? "incomplete" : "extracted",
    sourceFile,
    errors: [],
    ingressRoots,
  };
}

/** Create a normalized graph envelope used by the completeness gate. */
export function buildPlayerCommandGraph(game1Source, options = {}) {
  const ingress = extractPlayerIngressRoots(game1Source, options);
  const gameLocationSource = sourceForType(options.sourceIndex, "StardewValley.GameLocation");
  const farmerSource = sourceForType(options.sourceIndex, "StardewValley.Farmer");
  const unknownIngressRoots = ingress.ingressRoots.filter((root) => root.classification === "unknown");
  const rootEdges = ingress.ingressRoots.map((root) => ({
    edgeId: `${root.sourceType}.${root.sourceMethod}/${root.ingressId}->${root.targetMethod}`,
    from: `${root.sourceType}.${root.sourceMethod}:${root.ingressId}`,
    to: root.targetMethod,
    sourceFile: root.sourceFile,
    sourceMethod: root.sourceMethod,
    sourceAnchor: root.requiredFragments.at(-1),
    ingressId: root.ingressId,
    // A root itself is a control-router anchor, not yet a native dispatch.
    classification: root.classification === "unknown" ? "unknown" : "supporting_path",
    ...(root.classification === "unknown"
      ? { reason: "ingress_source_anchor_missing" }
      : { reason: "normal_player_control_router_anchor" }),
  }));
  const rootDispatchEdges = ingress.ingressRoots.flatMap((root) => {
    const match = root.targetMethod.match(/^StardewValley\.Game1\.(\w+)$/);
    return match && root.classification !== "unknown"
      ? extractDirectCallEdges(game1Source, match[1], {
          sourceFile: ingress.sourceFile,
          ingressId: root.ingressId,
          dispatcherClassification: ["pressActionButton", "pressUseToolButton"].includes(match[1]),
        })
      : [];
  });
  const worldCheckActionEdges = reachableSecondHopEdges(gameLocationSource, rootDispatchEdges, ingress, options);
  const releaseLifecycleEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "world_tool_release" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, root.sourceMethod, {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) => edge.to === "player.EndUsingTool"),
    );
  const toolReleaseSecondHopEdges =
    farmerSource && releaseLifecycleEdges.length > 0
      ? extractDirectCallEdges(farmerSource.source, "performEndUsingTool", {
          sourceType: farmerSource.typeName,
          sourceFile: farmerSource.sourceFile,
          ingressId: "world_tool_release",
        })
          .filter((edge) => edge.to.includes("endUsing"))
          .map((edge) => ({
            ...edge,
            edgeId: `${farmerSource.typeName}.performEndUsingTool->StardewValley.Tool.endUsing`,
            to: "StardewValley.Tool.endUsing",
            reason: "source_proved_tool_release_second_hop",
          }))
      : [];
  const toolBeginSecondHopEdges =
    farmerSource &&
    rootDispatchEdges.some((edge) => edge.ingressId === "world_tool_use" && edge.to.includes("BeginUsingTool"))
      ? extractDirectCallEdges(farmerSource.source, "performBeginUsingTool", {
          sourceType: farmerSource.typeName,
          sourceFile: farmerSource.sourceFile,
          ingressId: "world_tool_use",
        })
          .filter((edge) => edge.to.includes("beginUsing"))
          .map((edge) => ({
            ...edge,
            edgeId: `${farmerSource.typeName}.performBeginUsingTool->StardewValley.Tool.beginUsing`,
            to: "StardewValley.Tool.beginUsing",
            reason: "source_proved_tool_begin_second_hop",
          }))
      : [];
  const textDispatchEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "text_chat_submission" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, root.sourceMethod, {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) => /(?:textEntry|chatBox)\.(?:receive|release|leftClickHeld|gamePadButtonHeld)/.test(edge.to)),
    );
  const minigameDispatchEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "minigame_continuous_control" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, root.sourceMethod, {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) => /currentMinigame\.(?:receive|tick|forceQuit)|currentMinigame\?\.receive/.test(edge.to)),
    );
  const menuDispatchEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "menu_semantic_selection" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, root.sourceMethod, {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) =>
        /(?:childMenu|active_menu|chatBox)\.(?:receive|release|leftClickHeld|gamePadButtonHeld)|CurrentEvent\.receiveMouseClick/.test(
          edge.to,
        ),
      ),
    );
  const eventDispatchEdges = ingress.ingressRoots
    .filter((root) => root.ingressId === "event_dialogue_or_choice" && root.classification !== "unknown")
    .flatMap((root) =>
      extractDirectCallEdges(game1Source, "updateActiveMenu", {
        sourceFile: ingress.sourceFile,
        ingressId: root.ingressId,
      }).filter((edge) =>
        /CurrentEvent\.(?:receiveMouseClick|skipEvent)|childMenu\.receive|chatBox\.receive/.test(edge.to),
      ),
    );
  const allCandidateEdges = [
    ...rootEdges,
    ...rootDispatchEdges,
    ...worldCheckActionEdges,
    ...toolBeginSecondHopEdges,
    ...releaseLifecycleEdges,
    ...toolReleaseSecondHopEdges,
    ...menuDispatchEdges,
    ...eventDispatchEdges,
    ...textDispatchEdges,
    ...minigameDispatchEdges,
  ];
  const seenEdgeIds = new Set();
  const reachableEdges = allCandidateEdges.filter(
    (edge) => !seenEdgeIds.has(edge.edgeId) && seenEdgeIds.add(edge.edgeId),
  );
  const supportingPaths = reachableEdges
    .filter((edge) => edge.classification === "supporting_path")
    .map((edge) => ({
      edgeId: edge.edgeId,
      parentCommandPathId: null,
      ingressId: edge.ingressId ?? null,
      reason: edge.reason,
      state: "parent_command_path_pending",
    }));
  const nonGameplayPaths = reachableEdges
    .filter((edge) => edge.classification === "non_gameplay_path")
    .map((edge) => ({ edgeId: edge.edgeId, ingressId: edge.ingressId ?? null, reason: edge.reason }));
  const toolUseBranchCandidates = game1PressUseToolButtonBranchCandidates(game1Source, rootDispatchEdges, ingress, {
    sourceFile: ingress.sourceFile,
  });
  const toolOverrideCandidates = toolOverrideBranchCandidates(options.sourceIndex, rootDispatchEdges, ingress);
  const toolBeginCandidates = toolBeginUsingBranchCandidates(options.sourceIndex, toolBeginSecondHopEdges, ingress);
  const toolReleaseCandidates = toolEndUsingBranchCandidates(options.sourceIndex, toolReleaseSecondHopEdges, ingress);
  const sourceBranchCandidates = gameLocationCheckActionBranchCandidates(
    gameLocationSource,
    rootDispatchEdges,
    ingress,
  );
  const mapActionSelectorCandidates = gameLocationPerformActionSelectorCandidates(
    gameLocationSource,
    sourceBranchCandidates,
  );
  const candidatePairs = PLAYER_COMMAND_BOUNDARY_CANDIDATES.filter((candidate) => {
    if (candidate.rootTarget)
      return ingress.ingressRoots.some(
        (root) => root.ingressId === candidate.ingressId && root.classification === "command_path_candidate",
      );
    return reachableEdges.some((edge) => edge.ingressId === candidate.ingressId && edge.to === candidate.expression);
  }).map((candidate) => {
    const sourceEdges = candidate.rootTarget
      ? rootEdges.filter((edge) => edge.ingressId === candidate.ingressId)
      : reachableEdges.filter((edge) => edge.ingressId === candidate.ingressId && edge.to === candidate.expression);
    const sourceEdgeIds = sourceEdges.map((edge) => edge.edgeId).sort();
    if (sourceEdgeIds.length === 0) return null;
    const primarySourceEdge = sourceEdges[0];
    return [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      {
        ...candidate,
        // The same semantic family may be reached from distinct normal-player
        // ingresses. Preserve ingress in the candidate identity rather than
        // silently merging those paths into one generic action name.
        candidateId: `${candidate.ingressId}.${candidate.candidateId}`,
        sourceEdgeIds,
        sourceEvidence: {
          sourceType: primarySourceEdge.sourceType ?? "StardewValley.Game1",
          sourceFile: primarySourceEdge.sourceFile,
          sourceMethod: primarySourceEdge.sourceMethod,
          branchKind: candidate.rootTarget ? "ingress_root" : "direct_dispatch_call",
          requiredFragments: [candidate.rootTarget ? candidate.nativeRuleBoundaryCandidate : candidate.expression],
          anchorPositions: Object.fromEntries(
            sourceEdges.map((edge) => [edge.edgeId, Number.isInteger(edge.sourceOffset) ? [edge.sourceOffset] : []]),
          ),
        },
        status: "boundary_candidate",
        route: null,
        reason: "branch_predicate_target_domain_and_bridge_equivalence_not_yet_reconstructed",
      },
    ];
  });
  const candidatePairsWithBranches = [
    ...candidatePairs.filter(Boolean),
    ...toolUseBranchCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...toolOverrideCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...toolBeginCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...toolReleaseCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...sourceBranchCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
    ...mapActionSelectorCandidates.map((candidate) => [
      `${candidate.ingressId}/${candidate.candidateId}/${candidate.nativeRuleBoundaryCandidate}`,
      candidate,
    ]),
  ];
  const commandPathCandidates = [...new Map(candidatePairsWithBranches).values()].sort((left, right) =>
    `${left.ingressId}/${left.candidateId}/${left.nativeRuleBoundaryCandidate}`.localeCompare(
      `${right.ingressId}/${right.candidateId}/${right.nativeRuleBoundaryCandidate}`,
    ),
  );

  const pendingByIngress = ingress.ingressRoots
    .filter((root) => root.classification === "command_path_candidate")
    .map((root) => ({
      ingressId: root.ingressId,
      targetMethod: root.targetMethod,
      candidateEdgeCount: reachableEdges.filter(
        (edge) =>
          edge.classification === "candidate_dispatch_edge" &&
          (edge.ingressId === root.ingressId || edge.from.includes(`:${root.ingressId}`)),
      ).length,
      commandBoundaryCandidateCount: commandPathCandidates.filter((candidate) => candidate.ingressId === root.ingressId)
        .length,
      reason: "native_dispatch_and_rule_boundary_not_yet_reconstructed",
    }));
  return {
    schemaVersion: 1,
    state: ingress.state === "unknown" ? "unknown" : "partial",
    rootMethod: ingress.rootMethod,
    sourceFile: ingress.sourceFile,
    errors: ingress.errors,
    ingressRoots: ingress.ingressRoots,
    reachableEdges,
    commandPaths: [],
    commandPathCandidates,
    supportingPaths,
    nonGameplayPaths,
    unknownReachableEdges: unknownIngressRoots.map((root) => ({
      ingressId: root.ingressId,
      reason: "ingress_source_anchor_missing",
      missingFragments: root.missingFragments,
    })),
    pendingCommandCandidates: pendingByIngress,
    note: "Ingress roots and first-hop Game1 dispatch edges are source evidence only. They are not input-injection routes and do not expose UI callbacks as actions.",
  };
}
