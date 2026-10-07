import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Derive the pinned multiplayer-sensitivity register.
 *
 * Admission is DERIVED from the Mod source (never hand-typed), so the register
 * cannot drift from the implementation. Seam classification is authored here
 * and re-verified against the exact decompiled source by the checker.
 *
 * Evidence cites code as `Member[<method-body-hash>]`, computed by `cite()` from the
 * same tree the checker reads. Line numbers are never cited: they drift whenever the
 * tree is re-decompiled (the 2026-09-26 regeneration invalidated every citation at
 * once), while a normalised method body hash only changes with the cited code.
 */
const SOURCE_ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley";

/** Brace-balanced method body extraction that skips strings and comments. */
function extractMethodBody(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  let depth = 0;
  let started = false;
  let inString = false;
  let inChar = false;
  let inLine = false;
  let inBlock = false;
  for (let i = start; i < text.length; i += 1) {
    const character = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (character === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (character === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (character === "\\") i += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (inChar) {
      if (character === "\\") i += 1;
      else if (character === "'") inChar = false;
      continue;
    }
    if (character === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "'") {
      inChar = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
      started = true;
    } else if (character === "}") {
      depth -= 1;
      if (started && depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * `Member[<hash>]` anchor for the method named `member` in `file`.
 *
 * The signature fragment ``member(` is enough to locate the declaration; whitespace
 * is normalised before hashing so reformatting alone does not invalidate an anchor.
 */
function cite(file, member) {
  let text;
  try {
    text = fs.readFileSync(path.join(SOURCE_ROOT, file), "utf8");
  } catch {
    return `${member}[source-unavailable]`;
  }
  const declaration = [...text.matchAll(new RegExp(`[^\\n]*\\b${member}\\s*\\([^;]*\\)\\s*\\n?\\s*\\{`, "g"))].find(
    (match) => !match[0].trimStart().startsWith("//"),
  );
  if (!declaration) return `${member}[declaration-not-found]`;
  const body = extractMethodBody(text, declaration[0].trim());
  if (!body) return `${member}[body-not-found]`;
  const normalized = body
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const hash = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  return `${member}[${hash}]`;
}

// actionId -> [file, signature, sensitivity, semanticEffect?]  (native seams)
// actionId -> ["mod_owned", authority]                      (no native seam)
const TABLE = {
  // ---------------- published ----------------
  // Body movement, emotes and facing are Mod-owned mutations executed through the
  // Mod's own body controller; there is no game method whose multiplayer
  // behaviour could differ, so no native seam exists to classify.
  move_to_tile: ["mod_owned", "StardewBodyController"],
  travel: ["mod_owned", "StardewBodyController"],
  // The minecart ride's native seam is `GameLocation.MinecartWarp`, which is a
  // thin wrapper over the same `Game1.warpFarmer` machinery `enter_exit` uses:
  // it reads no multiplayer token, and the destination's TargetLocation/
  // TargetTile come from the game's own Data/Minecarts, so the ride and its
  // landing tile are identical in both world modes.
  ride_minecart: [
    "StardewValley/GameLocation.cs",
    "public void MinecartWarp(MinecartDestinationData destination)",
    "mp-insensitive",
    "MinecartWarp only calls Game1.player.Halt(), sets freezePause, and calls Game1.warpFarmer(name, x, y, direction); the destination and its target tile come from the game's own Data/Minecarts and the warp machinery is the one enter_exit already classifies as mode-neutral",
  ],
  navigate_to_destination: ["mod_owned", "StardewBodyController"],
  face_direction: ["mod_owned", "StardewBodyController"],
  express_emote: ["mod_owned", "Farmer.doEmote"],
  equip_tool: ["mod_owned", "Farmer.CurrentToolIndex"],
  // Hoe/WateringCan/Pickaxe DoFunction read only Game1.multiplayer.broadcastSprites
  // and (Pickaxe) createObjectDebris(...who.UniqueMultiplayerID...). broadcastSprites
  // mirrors an already-applied local sprite (Multiplayer.cs adds to
  // location.temporarySprites first, then returns when !Game1.IsMultiplayer), and the
  // debris id is used only for getFarmer(id).getStandingPosition() as the origin; the
  // terrain/object mutation on the same lines is mode-independent. Collateral, not outcome.
  till_soil: [
    "StardewValley.Tools/Hoe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/Hoe.cs", "DoFunction")} mirrors an already-applied dirt sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); location.makeHoeDirt in the same method decides the result identically in both modes`,
  ],
  dig_artifact_spot: [
    "StardewValley.Tools/Hoe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/Hoe.cs", "DoFunction")} mirrors an already-applied dirt sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); location.makeHoeDirt in the same method decides the result identically in both modes`,
  ],
  water_crop: [
    "StardewValley.Tools/WateringCan.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/WateringCan.cs", "DoFunction")} mirrors an already-applied water sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); the refill/water mutation in the same method is mode-independent`,
  ],
  refill_watering_can: [
    "StardewValley.Tools/WateringCan.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/WateringCan.cs", "DoFunction")} mirrors an already-applied water sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); the refill/water mutation in the same method is mode-independent`,
  ],
  chop_tree_source: [
    "StardewValley.Tools/Axe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
  ],
  chop_stump: [
    "StardewValley.Tools/Axe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
  ],
  break_rock_source: [
    "StardewValley.Tools/Pickaxe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/Pickaxe.cs", "DoFunction")} mirrors an already-applied break sprite, and Game1.createObjectDebris(..., who.UniqueMultiplayerID, location) in the same method uses the id only for getFarmer(id).getStandingPosition() as the debris origin (${cite("StardewValley/Game1.cs", "getFarmer")}) while still adding to location.debris; the stone removal in the same method is mode-independent`,
  ],
  clear_hoedirt: [
    "StardewValley.Tools/Pickaxe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/Pickaxe.cs", "DoFunction")} mirrors an already-applied break sprite, and Game1.createObjectDebris(..., who.UniqueMultiplayerID, location) in the same method uses the id only for getFarmer(id).getStandingPosition() as the debris origin (${cite("StardewValley/Game1.cs", "getFarmer")}) while still adding to location.debris; the stone removal in the same method is mode-independent`,
  ],
  collect_animal_product: [
    [
      "StardewValley.Tools/MilkPail.cs",
      "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
      "mp-insensitive",
    ],
    [
      "StardewValley.Tools/Shears.cs",
      "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
      "mp-insensitive",
    ],
  ],
  clear_debris: [
    "StardewValley/Tool.cs",
    "public virtual void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
  ],
  // Outcome fork, not collateral: grantedFriendshipForPet is one NetBool per PET
  // (Pet.cs:70) and friendshipTowardFarmer one NetInt per PET (Pet.cs:73), while only
  // lastPetDay is keyed by UniqueMultiplayerID (:67). Once ANY farmer has petted the
  // pet today, :646 is false for everyone, so this farmer's pet grants 0 friendship.
  // The Mod receipt nonetheless asserts before+12 (:378/:387) — a pre-existing defect.
  pet_animal: [
    "StardewValley.Characters/Pet.cs",
    "public override bool checkAction",
    "mp-semantic",
    `lastPetDay is keyed by who.UniqueMultiplayerID, but the +12 friendship in the same method is gated on grantedFriendshipForPet, a single per-pet NetBool reset daily, and friendshipTowardFarmer is a single per-pet NetInt. If another farmer already petted that pet today, this action still returns handled and emotes but grants 0 friendship, so the friendship delta differs by world mode (${cite("StardewValley.Characters/Pet.cs", "checkAction")})`,
  ],
  pickup_forage: ["StardewValley/Game1.cs", "public static bool tryToCheckAt", "mp-insensitive"],
  enter_exit: ["StardewValley/Farmer.cs", "public void warpFarmer(", "mp-insensitive"],
  // pickup_item hands delivery to native magnetic pickup: the bridge never calls
  // collect or touches the inventory itself.
  pickup_item: ["StardewValley/Debris.cs", "public virtual bool collect(", "mp-insensitive"],
  plant_seed: [
    "StardewValley/Object.cs",
    "public virtual bool placementAction",
    "mp-observational",
    "IsLocalPlayer only gates the sprinkler/chest auto-harvest hook, after dirt.plant already decided the result",
  ],
  plant_sapling: [
    "StardewValley/Object.cs",
    "public virtual bool placementAction",
    "mp-observational",
    "IsLocalPlayer only gates the sprinkler/chest auto-harvest hook, after dirt.plant already decided the result",
  ],
  place_crab_pot: [
    "StardewValley/Object.cs",
    "public virtual bool placementAction",
    "mp-observational",
    "IsLocalPlayer only gates the sprinkler/chest auto-harvest hook, after dirt.plant already decided the result",
  ],
  fertilize_tile: [
    "StardewValley/Object.cs",
    "public virtual bool placementAction",
    "mp-observational",
    "IsLocalPlayer only gates the sprinkler/chest auto-harvest hook, after dirt.plant already decided the result",
  ],
  // canBePlacedHere is only the Mod's pre-check (farmingconstructionactions.cs:360);
  // the mutation is Object.placementAction, reached from
  // PlaceQualifiedWoodFenceNative (farmhandexecutioncontroller.cs:2528-2532).
  place_wood_fence: [
    "StardewValley/Object.cs",
    "public virtual bool placementAction",
    "mp-observational",
    `owner.Value records the ACTING player's own id (${cite("StardewValley/Object.cs", "placementAction")} who?.UniqueMultiplayerID ?? Game1.player.UniqueMultiplayerID), so it is the same value in both world modes; location.removeLightSource((int)Game1.player.UniqueMultiplayerID) only drops a key from location.sharedLights (${cite("StardewValley/GameLocation.cs", "removeLightSource")}); Game1.multiplayer.broadcastSprites mirrors an already-applied local sprite (${cite("StardewValley/Multiplayer.cs", "broadcastSprites")} adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer). The IsLocalPlayer read in the seed branch is unreachable for this source: IsFenceItem() returns from the closed Fence branch, and the decisive write location.objects.Add(vector, new Fence(...)) is mode-independent`,
  ],
  bait_crab_pot: [
    "StardewValley/GameLocation.cs",
    "public virtual bool checkAction",
    "mp-observational",
    "IsLocalPlayer only gates pickup sound/animation",
  ],
  // machine_inspect is declared read-only in FarmhandActionDefinitions
  // (`EmbodiedActorResource, "read"`) and its handler performs no native call at all:
  // it reads the machine's state and mints a receipt from it. Recording a native seam
  // here asserted an invocation that does not exist (the checker's seam-call axis
  // catches exactly this). The observation surface is the Mod's own, like the other
  // read-only actions.
  machine_inspect: ["mod_owned", "RequestLocalInspectMachine"],
  machine_load: [
    "StardewValley/GameLocation.cs",
    "public virtual bool checkAction",
    "mp-observational",
    "IsLocalPlayer only gates pickup sound/animation",
  ],
  machine_collect_output: [
    "StardewValley/GameLocation.cs",
    "public virtual bool checkAction",
    "mp-observational",
    "IsLocalPlayer only gates pickup sound/animation",
  ],
  feed_animal: [
    "StardewValley/GameLocation.cs",
    "public virtual bool checkAction",
    "mp-observational",
    "IsLocalPlayer only gates pickup sound/animation",
  ],
  harvest_crop: [
    "StardewValley.TerrainFeatures/HoeDirt.cs",
    "public override bool performUseAction",
    "mp-insensitive",
    "team.RequestLimitedNutDrops is the IslandFarming limited-nut drop; FarmerTeam is populated in single-player too, so the read is mode-neutral",
  ],
  scythe_crop: [
    "StardewValley.TerrainFeatures/HoeDirt.cs",
    "public override bool performToolAction",
    "mp-insensitive",
    "team.RequestLimitedNutDrops is the IslandFarming limited-nut drop; FarmerTeam is populated in single-player too, so the read is mode-neutral",
  ],
  cut_grass: [
    "StardewValley.TerrainFeatures/Grass.cs",
    "public override bool performToolAction",
    "mp-observational",
    `Grass.performToolAction mirrors the same broadcast sprites as Object.performToolAction (both Swipe herb animation and cut sprites go through Game1.multiplayer.broadcastSprites, which needs no master credit for local effects); the hay/rare-drop outcome rides on GameLocation.StoreHayInAnySilo (hay into whichever silo, mode-neutral) and the debris scatter, so nothing here reads per-player shared state`,
  ],
  cut_weeds: [
    "StardewValley/Object.cs",
    "public virtual bool performToolAction",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley/Object.cs", "performToolAction")} mirrors the twig sprite; Game1.netWorldState.Value.TreasureTotemsUsed belongs to the artifact-spot branch of the same method and only seeds Utility.CreateDaySaveRandom, which is populated in single-player too`,
  ],
  use_item: [
    "StardewValley/Farmer.cs",
    "public void eatObject(",
    "mp-observational",
    "IsLocalPlayer only gates a buff-awareness shortcut",
  ],
  // Shipping has two seams: the write itself, and the container resolution that
  // decides WHERE the write lands.
  ship_item: [
    ["StardewValley/Farm.cs", "public void shipItem(Item i, Farmer who)", "mp-insensitive"],
    [
      "StardewValley/Farm.cs",
      "public IInventory getShippingBin(Farmer who)",
      "mp-semantic",
      "getShippingBin(who) returns who.personalShippingBin instead of the shared bin when Game1.player.team.useSeparateWallets is set, so the settlement target depends on the world's wallet mode",
    ],
  ],
  // The bus is driven through two native entry points: the ticket-machine
  // interaction that raises the game's own question, and the dispatcher that
  // consumes the answer. Neither is re-implemented by the Mod (see
  // farmhandexecutioncontroller.busactions.cs), so both seams are recorded.
  // shop_purchase opens the game's own ShopMenu and dispatches the purchase through its
  // public click handler. Both act on the LOCAL player's inventory and purse, and the
  // stock it reads comes from shared content data that the action never writes.
  shop_purchase: [
    [
      "StardewValley/Utility.cs",
      "public static bool TryOpenShopMenu(string shopId, string ownerName, bool playOpenSound = true)",
      "mp-insensitive",
      "Resolves the named owner, evaluates the shop's owner game-state query, and assigns Game1.activeClickableMenu for the local player; the stock it reads comes from shared Data/Shops content the action never writes.",
    ],
    [
      "StardewValley.Menus/ShopMenu.cs",
      "public override void receiveLeftClick(int x, int y, bool playSound = true)",
      "mp-insensitive",
      "Charges the local player and inserts the good into the local inventory; the only shared effect is the per-player stock decrement the native client already synchronises, identical to a real player click.",
    ],
    [
      "StardewValley.Menus/InventoryMenu.cs",
      "public Item leftClick(int x, int y, Item toPlace, bool playSound = true)",
      "mp-insensitive",
      "Places the held item into the LOCAL player inventory slots.",
    ],
  ],
  ride_bus: [
    [
      "StardewValley.Locations/BusStop.cs",
      "public override bool checkAction(Location tileLocation, xTile.Dimensions.Rectangle viewport, Farmer who)",
      "mp-insensitive",
      "checkAction's ticket branch is decided by the local player's mail flags, whether the local player rides a horse, and the local passenger list; the shared canDriveYourselfToday write lives in a different BusStop method, so this seam itself reads no multiplayer-scoped state",
    ],
    [
      "StardewValley.Locations/BusStop.cs",
      "public override bool answerDialogue(Response answer)",
      "mp-semantic",
      "answerDialogue deducts Game1.player.Money and arms forceWarpTimer/PathFindController for the local player, but it also clears the shared Game1.netWorldState canDriveYourselfToday flag and reads Desert.warpedToDesert, so the verdict is world-mode dependent, not local-only",
    ],
  ],
  // collect_crab_pot_output uses the native CrabPot.checkAction path; the read of
  // crabPot.owner.Value is the Mod's own admission guard and the native branch that
  // gates on who.IsLocalPlayer only controls the pickup sound/animation.

  // ---------------- experimental ----------------
  chest_store: ["StardewValley.Objects/Chest.cs", "public virtual Item addItem", "mp-insensitive"],
  chest_retrieve: [
    "StardewValley.Objects/Chest.cs",
    "public IInventory GetItemsForPlayer(long id)",
    "mp-semantic",
    "the container is resolved per player: GlobalInventoryId returns a team-shared inventory, and a MiniShippingBin chest returns that player's own separate-wallet inventory; the Mod calls the no-arg overload, which resolves Game1.player.UniqueMultiplayerID, so the target container depends on who is asking",
  ],
  interact_npc_with_item: ["StardewValley/NPC.cs", "public virtual void receiveGift(", "mp-insensitive"],
  npc_relationship: ["mod_owned", "Farmer.friendshipData"],
  // ---------------- read-only / no native mutation ----------------
  inspect_world_map: ["mod_owned", "WorldMap"],
  find_destination: ["mod_owned", "DerivedDestinationSet"],
  observe_scene: ["mod_owned", "SceneObservation"],
  craft_item: [
    "StardewValley/CraftingRecipe.cs",
    "public virtual Item createItem()",
    "mp-insensitive",
    'team.SpecialOrderRuleActive("QI_COOKING") only stamps orderData on a cooking recipe; FarmerTeam is populated in single-player too, so the read is mode-neutral',
  ],
  cook_recipe: [
    "StardewValley/CraftingRecipe.cs",
    "public virtual Item createItem()",
    "mp-insensitive",
    'team.SpecialOrderRuleActive("QI_COOKING") only stamps orderData on a cooking recipe; FarmerTeam is populated in single-player too, so the read is mode-neutral',
  ],
  collect_crab_pot_output: [
    "StardewValley/GameLocation.cs",
    "public virtual bool checkAction",
    "mp-observational",
    "IsLocalPlayer only gates pickup sound/animation",
  ],
  // The built-in Pet Bowl is a Building, not a location object, so the watering
  // write lands in `PetBowl.performToolAction` reached through
  // `WateringCan.DoFunction` -> `location.performToolAction`. The handler calls the
  // same `WateringCan.DoFunction` entry `water_crop` does; the bowl's `watered`
  // NetBool is set identically in both world modes, and the only multiplayer read
  // on the path is the already-classified broadcastSprites collateral.
  water_pet_bowl: [
    "StardewValley.Tools/WateringCan.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/WateringCan.cs", "DoFunction")} mirrors an already-applied water sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); the bowl's watered write reached through PetBowl.performToolAction is mode-independent`,
  ],
  // The Slime Hutch trough override; same watering ingress and same mode-neutral
  // trough write.
  water_slime_hutch_trough: [
    "StardewValley.Tools/WateringCan.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/WateringCan.cs", "DoFunction")} mirrors an already-applied water sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); the trough write reached through SlimeHutch.performToolAction is mode-independent`,
  ],
  // The cross-day lifecycle. The Mod answers the game-owned Sleep question
  // (`GameLocation.answerDialogue`) exactly as the native input paths do; the
  // outcome fork lives one step further in `startSleep`: single-player calls
  // `doSleep()` directly, while a shared world sets the local native ready flag and
  // installs a ReadyCheckDialog whose confirm callback is the only path to
  // `doSleep()`. The day therefore advances on a different trigger.
  advance_day: [
    "StardewValley/GameLocation.cs",
    "private void startSleep()",
    "mp-semantic",
    "Single player calls doSleep() directly, but a shared world instead sets Game1.netReady.SetLocalReady(\"sleep\") " +
      "and installs a ReadyCheckDialog whose confirm callback is the only path to doSleep(); the day advances on a " +
      "different trigger, after the barrier every required player satisfies. A Farmhand client cannot roll the date itself " +
      "(dayOfMonth/stats.DaysPlayed advance only when Game1.IsMasterGame), so a single-player pass cannot stand in for it.",
  ],
  // WIA §4.2 modal-handling family (in-flight lane): dismiss_modal closes the
  // informational DialogueBox through the public closeDialogue seam
  // (Game1.exitActiveMenu + dialogueUp=false); the modal's presence and
  // dismissal are pure client-side world state, and the receipt never touches
  // a server or net-field.
  answer_dialogue: [
    "StardewValley/GameLocation.cs",
    "public virtual bool answerDialogue(Response answer)",
    "mp-insensitive",
    "answerDialogue dispatches to afterQuestion/answerDialogueAction on the local location and starts the DialogueBox outro (beginOutro); the question modal and its responses are client-side UI state with no multiplayer read or write on the path, and the Mod never touches a net field for the receipt",
  ],
  dismiss_modal: [
    "StardewValley.Menus/DialogueBox.cs",
    "public void closeDialogue()",
    "mp-insensitive",
    "closeDialogue calls Game1.exitActiveMenu (menu = null) and Game1.dialogueUp = false; both are client-side UI state " +
      "with no multiplayer read or write on the path",
  ],
  // Loop-closure wave (2026-10-04): 14 actions integrated from the
  // plants/facility/transport lanes. Each seam mirrors the lane's native entry;
  // the classification follows the same rules as their existing families.

  // Loop-closure wave (2026-10-04): 14 actions integrated from the
  // plants/facility/transport lanes. Each seam mirrors the lane's native entry;
  // the classification follows the same rules as their existing families.
  harvest_bush: [
    "StardewValley.TerrainFeatures/Bush.cs",
    "public void shake(Vector2 tileLocation, bool doEvenIfStillShaking)",
    "mp-insensitive",
    "shakes fruit into debris on the shared location; the body reads no multiplayer token",
  ],
  harvest_fruit_tree: [
    "StardewValley.TerrainFeatures/FruitTree.cs",
    "public virtual void shake(Vector2 tileLocation, bool doEvenIfStillShaking)",
    "mp-insensitive",
    "drops fruit debris on the shared location; the body reads no multiplayer token",
  ],
  shake_tree: [
    "StardewValley.TerrainFeatures/Tree.cs",
    "public void shake(Vector2 tileLocation, bool doEvenIfStillShaking)",
    "mp-observational",
    "seed drop is gated on Game1.IsMultiplayer || ForagingLevel >= 1, so the drop behaviour itself depends on the world mode",
  ],
  take_pedestal_item: [
    "StardewValley.Objects/ItemPedestal.cs",
    "public bool DropObject(Farmer who)",
    "mp-insensitive",
    "moves heldObject into the player inventory under itemModifyMutex; the body reads no multiplayer token",
  ],
  toggle_fence_gate: [
    "StardewValley/Fence.cs",
    "public virtual void toggleGate(bool open, bool is_toggling_counterpart = false, Farmer who = null)",
    "mp-insensitive",
    "flips gatePosition on the shared fence; the body reads no multiplayer token",
  ],
  clear_cask: [
    "StardewValley.Objects/Cask.cs",
    "public override bool performToolAction(Tool t)",
    "mp-insensitive",
    "splits heldObject into debris on the shared location; the body reads no multiplayer token",
  ],
  dress_mannequin: [
    "StardewValley.Objects/Mannequin.cs",
    "public override bool performObjectDropInAction(Item dropInItem, bool probe, Farmer who, bool returnFalseIfItemConsumed = false)",
    "mp-insensitive",
    "swaps outfit items on the shared mannequin object; the body reads no multiplayer token",
  ],
  set_sign_display: [
    "StardewValley.Objects/Sign.cs",
    "public override bool checkForAction(Farmer who, bool justCheckingForActivity = false)",
    "mp-insensitive",
    "sets displayItem on the shared sign; the body reads no multiplayer token",
  ],
  deposit_silo_hay: [
    "StardewValley/GameLocation.cs",
    "public int tryToAddHay(int num)",
    "mp-insensitive",
    "writes piecesOfHay on the shared farm; the body reads no multiplayer token",
  ],
  withdraw_silo_hay: [
    "StardewValley/GameLocation.cs",
    "public static Object GetHayFromAnySilo(GameLocation currentLocation)",
    "mp-insensitive",
    "decrements piecesOfHay on the shared farm and mints the hay object without inserting it; the body reads no multiplayer token",
  ],
  use_obelisk: [
    "StardewValley.Buildings/Building.cs",
    "public static void PerformObeliskWarp(string destination, int warp_x, int warp_y, bool force_dismount, Farmer who)",
    "mp-insensitive",
    "warps the local player to a fixed destination via obeliskWarpForReal, which also force-dismounts; warping is per-actor and the body reads no multiplayer token",
  ],
  toggle_tool_light: [
    "StardewValley.Tools/Lantern.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
    "flips the local lantern light source and removes/readds it; on is a per-tool local bool and the body reads no multiplayer token",
  ],
  use_raft: [
    "StardewValley.Tools/Raft.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
    "sets the local Farmer.isRafting flag; the flag is per-actor local state, no shared write",
  ],
  mount_transport: [
    "StardewValley.Characters/Horse.cs",
    "public override bool checkAction(Farmer who, GameLocation l)",
    "mp-observational",
    "rides/dismounts one shared Horse under the horse mutex; the mutex serialises cross-player mounts on the same horse",
  ],
  enter_mine: [
    "StardewValley/Game1.cs",
    "public static void enterMine(int whatLevel, int? forceLayout = null)",
    "mp-insensitive",
    "warps the local player into the shared MineShaft; warping is per-actor and the body reads no multiplayer token",
  ],
  // The elevator's terminal is the same public seam as enter_mine: it sets the
  // per-actor Farmer.ridingMineElevator flag and then calls Game1.enterMine(floor).
  // Floor 0 diverges to Game1.warpFarmer("Mine", 17, 4) — also per-actor. The floor
  // SET is derived from the shared mine_lowestLevelReached, which is read-only here:
  // this action never writes mine progress, it only consumes what it advertises.
  select_mine_elevator_floor: [
    "StardewValley/Game1.cs",
    "public static void enterMine(int whatLevel, int? forceLayout = null)",
    "mp-insensitive",
    "sets the per-actor Farmer.ridingMineElevator flag then warps the local player into a generated mine level (or, for floor 0, to the mine entrance); the body reads shared mine progress but writes no multiplayer token",
  ],
};

const MP_REJECT_PATTERN =
  /Context\.IsMultiplayer|!Game1\.IsMasterGame|getAllFarmers\(\)\.Count\(\)\s*!=\s*1|Game1\.server\s+is not null/;

// ---- derive admission from the Mod ----
const actionToMethod = new Map();
for (const f of fs.readdirSync("integrations/stardew/Handlers")) {
  if (!f.endsWith(".cs")) continue;
  const t = fs.readFileSync(path.join("integrations/stardew/Handlers", f), "utf8");
  for (const m of t.matchAll(/"([a-z_]+)"\s*=>\s*this\.executions\.(RequestLocal\w+)\(/g))
    actionToMethod.set(m[1], m[2]);
}
const methodBody = new Map();
for (const f of fs.readdirSync("integrations/stardew")) {
  if (!/^farmhandexecutioncontroller\..*\.cs$/.test(f)) continue;
  const t = fs.readFileSync(path.join("integrations/stardew", f), "utf8");
  const starts = [...t.matchAll(/public LocalExecutionReceipt (RequestLocal\w+)\(/g)];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i].index;
    const e = i + 1 < starts.length ? starts[i + 1].index : t.length;
    methodBody.set(starts[i][1], t.slice(s, e));
  }
}

// Actions routed through the read pipelines / navigation admission rather than a
// RequestLocal* handler. Derived from the same sources the checker uses.
const READ_PIPELINE_ACTIONS = new Set(["inspect_world_map", "find_destination", "observe_scene"]);
const _NAVIGATION_ADMISSION_ACTIONS = new Set(["navigate_to_destination"]);

const surface = { actions: readCatalog() };

// Registration lifecycle, read from the same source span the action id came from.
// `FarmhandActionLifecycle.LiveVerified` must be distinguished from `Published`:
// "not Experimental" is not enough, because it silently reported a live-verified
// action as published.
function parseRegistrationLifecycle(prefix, call) {
  if (prefix === "R") return "published";
  if (/FarmhandActionLifecycle\.LiveVerified/.test(call)) return "live_verified";
  if (/FarmhandActionLifecycle\.Experimental/.test(call)) return "experimental";
  return "published";
}

function readCatalog() {
  // The Mod's FarmhandActionCatalog is the authority for which actions exist and
  // their lifecycle (memory #1704). Parsed from source with paren matching so
  // multi-line registrations are not missed, never hand-typed.
  const text = fs.readFileSync("integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs", "utf8");
  const rows = [];
  for (const match of text.matchAll(/\b([ER])\("([a-z_]+)",\s*"([a-z_]+)"/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const call = text.slice(match.index, end + 1);
    rows.push({
      actionId: match[2],
      lifecycle: parseRegistrationLifecycle(match[1], call),
    });
  }
  return rows;
}
const lifecycle = new Map(surface.actions.map((a) => [a.actionId, a.lifecycle]));

const actions = [];
for (const entry of surface.actions) {
  const actionId = entry.actionId;
  const registered = actionToMethod.has(actionId);
  const admission = registered ? (methodBody.get(actionToMethod.get(actionId)) ?? "") : "";
  const head = admission.split("\n").slice(0, 45).join("\n");
  const rejects = registered && MP_REJECT_PATTERN.test(head);
  const admissionEntry = READ_PIPELINE_ACTIONS.has(actionId)
    ? { verdict: "read_only" }
    : rejects
      ? { verdict: "rejects_multiplayer", reasonCode: "native_local_player_required" }
      : { verdict: "admits_multiplayer" };
  const seam = TABLE[actionId];
  // Must be an explicit entry. `undefined` (missing key) and `null` (an explicit
  // "no seam" opt-out) both fail closed: a registered action with no declared seam
  // would otherwise be classified `mp-insensitive`/`single_player_native_companion`
  // by default, which is exactly the silently-unchecked state this gate exists to
  // prevent. Measured: `TABLE[actionId]` returned `undefined` for the three actions
  // added after the table was last touched, the `=== null` guard was vacuous, and
  // the script died later at `seam[0]` instead of naming the missing entry.
  if (seam === null || seam === undefined)
    throw new Error(`action needs an explicit seam entry: ${actionId}`);

  // A seam entry is either one tuple or a list of tuples.
  const seamList = seam[0] === "mod_owned" || typeof seam[0] === "string" ? [seam] : seam;
  const seams = seamList.map((entry) =>
    entry[0] === "mod_owned"
      ? { kind: "mod_owned", authority: entry[1], sensitivity: "mp-insensitive" }
      : {
          kind: "native",
          file: entry[0],
          signature: entry[1],
          sensitivity: entry[2],
          // The fourth element carries the justification, whose field name depends
          // on the classification: a semantic effect, an observed collateral effect,
          // or a mode-neutral reason for reading a mode-neutral token.
          ...(entry[3]
            ? entry[2] === "mp-semantic"
              ? { semanticEffect: entry[3] }
              : entry[2] === "mp-observational"
                ? { observedEffect: entry[3] }
                : { modeNeutralReason: entry[3] }
            : {}),
        },
  );
  const derivedSensitivity = seams.some((s) => s.sensitivity === "mp-semantic")
    ? "mp-semantic"
    : seams.some((s) => s.sensitivity === "mp-observational")
      ? "mp-observational"
      : "mp-insensitive";
  const requiredLiveTopology =
    derivedSensitivity === "mp-semantic" ? "shared_world_multiplayer" : "single_player_native_companion";

  actions.push({
    actionId,
    lifecycle: lifecycle.get(actionId),
    seams,
    admission: admissionEntry,
    requiredLiveTopology,
  });
}

// Derived, never hand-typed: an action whose admission rejects a shared world while
// no native seam reads outcome-affecting multiplayer state.
const OVER_RESTRICTED = actions
  .filter((a) => a.admission.verdict === "rejects_multiplayer" && a.requiredLiveTopology !== "shared_world_multiplayer")
  .map((a) => a.actionId);

// Derived, never hand-typed: admission now admits a shared world, but an mp-semantic
// native seam means the outcome can still differ there, and no shared-world live
// evidence exists yet. A `live_verified` lifecycle IS that evidence (design/10
// 3.1.1: reaching live_verified requires the requiredLiveTopology run to have
// passed), and a published action has completed the whole ladder, so neither can
// be unverified; only experimental actions remain pinned. When the last one
// lands, the pin goes stale and the gate rejects it.
const UNVERIFIED_SCOPE = actions
  .filter(
    (a) =>
      a.admission.verdict === "admits_multiplayer" &&
      a.requiredLiveTopology === "shared_world_multiplayer" &&
      !(a.lifecycle === "live_verified" || a.lifecycle === "published"),
  )
  .map((a) => a.actionId);

const register = {
  schemaVersion: 1,
  artifactKind: "stardew_native_multiplayer_sensitivity",
  note:
    "Multiplayer scope is DERIVED from the exact decompiled game source plus the Mod's own admission guards. " +
    "The pinned statement (not the authored memory) is what the checker trusts.",
  // Scope-level acknowledgements, one per systemic gap rather than one per action.
  // Both lists are DERIVED, so a pin appears only while its defect is real and is
  // rejected as stale the moment the defect stops deriving -- a pin cannot outlive
  // its fix, and cannot be hand-typed into existence.
  //
  // `over_restriction` (empty as of the scope-bound actor resolver landing): GameBuddy
  // is a companion that joins the player's world, so multiplayer IS the product
  // topology; an admission that rejects a shared world with no native justification
  // is a gap, not a design choice.
  // `unverified_scope`: admission is correct, but the native seam reads
  // outcome-affecting multiplayer state (`Game1.player.team.useSeparateWallets`),
  // so a single-player pass cannot stand in for a shared-world one.
  scopeAcknowledgements: [
    ...(OVER_RESTRICTED.length > 0
      ? [
          {
            defect: "over_restriction",
            actions: OVER_RESTRICTED,
            reason:
              "Admission rejects a shared world (native_local_player_required or an equivalent guard) even though the native seam " +
              "carries no outcome-affecting multiplayer state. The correct guard is the scope-bound actor resolver " +
              "`ExecutionManager.TryGetBoundActor` (farmhandexecutioncontroller.cs), which validates " +
              "`actor.UniqueMultiplayerID == executionScope.PlayerId` and fails closed with `execution_scope_mismatch`. On the AI " +
              "Farmhand's own client Game1.player IS that Farmhand, so the resolver admits the real product topology instead of " +
              "refusing it.",
            owner: "stardew-integration",
          },
        ]
      : []),
    // The pin is emitted only while at least one mp-semantic action is still
    // unproven. Once every mp-semantic action has reached live_verified (its
    // required shared-world run IS the evidence), the pin is removed rather
    // than kept as an empty acknowledgement: an empty `actions` array is a
    // stale pin, and the gate rejects it.
    ...(UNVERIFIED_SCOPE.length > 0
      ? [
          {
            defect: "unverified_scope",
            actions: UNVERIFIED_SCOPE,
            reason:
              "Admission admits a shared world, but the native seam reads outcome-affecting multiplayer state, so the transaction " +
              "outcome can differ there and a single-player pass cannot stand in for a shared-world one. For `ship_item` the settlement " +
              "container is chosen by `Farm.getShippingBin(who)` from `Game1.player.team.useSeparateWallets`, so the destination bin " +
              "differs between single-player and a shared world. For `chest_retrieve` the container is resolved by " +
              "`Chest.GetItemsForPlayer(long id)`: a chest with a GlobalInventoryId returns the team-shared inventory and a " +
              "MiniShippingBin returns that player's own separate-wallet inventory, and the Mod calls the no-arg overload that resolves " +
              "`Game1.player.UniqueMultiplayerID`. For `pet_animal` the +12 friendship is gated on the single per-pet " +
              "`grantedFriendshipForPet` flag rather than the acting farmer's `lastPetDay` entry, so a second farmer's pet in the same " +
              "day grants 0 friendship while the Mod receipt asserts before+12. These actions are pinned here only until their own " +
              "shared-world live run lands; that run is the evidence, so reaching `live_verified` retires the pin.",
            owner: "stardew-integration",
          },
        ]
      : []),
    // Mechanism pins name mechanisms, not actions. The `sleep` mechanism still
    // forks on world mode, but its shared-world branch is now exercised: the
    // `advance_day` action (mp-semantic, live_verified) drives the native
    // `answerDialogue(Response)` -> `startSleep()` path and lets the native
    // `ReadyCheckDialog('sleep')` barrier declare only the Farmhand's own local
    // ready while it waits for every required player. A two-process Host-LAN +
    // AI-Farmhand run reached `day_advanced` with ready 2/2.
    //
    // What the pin still withholds is any claim the Mod pushes the day itself:
    // gameplay-capability-expansion.md 3.2 still forbids Mod-initiated
    // `doSleep`/`doPassOut`/auto-return and any call that marks ANOTHER player
    // ready. The pin therefore records the residual, genuinely unowned fork
    // (a barrier that never completes must be reported, never forced) rather
    // than pretending no shared-world evidence exists.
    {
      defect: "unverified_mechanism_scope",
      mechanisms: ["sleep"],
      reason:
        "The sleep mechanism forks on world mode. Its shared-world branch is covered by the live_verified `advance_day` run above " +
        "(native answerDialogue -> startSleep -> ReadyCheckDialog('sleep'), ready 2/2, day_advanced), so no shared-world evidence is " +
        "missing. What remains unowned by the Mod, and must stay that way, is forcing the transition: gameplay-capability-expansion.md " +
        "3.2 forbids Mod-initiated doSleep/doPassOut/auto-return, and the Farmhand may only declare its OWN local ready. A ready barrier " +
        "that never completes is reported as requires_other_player rather than forced. If a future capability claims Mod-initiated sleep " +
        "or cross-player ready, this pin must be removed and fresh shared-world evidence produced for that stronger claim.",
      owner: "stardew-integration",
    },
  ],
  // Axis 3 -- mechanisms. Sleeping, the cross-day handshake, passing out and the
  // day rollover are not Mod actions, so an action-only register is structurally
  // blind to their forks. Each fork cites a real method body and the predicate it
  // rests on; the validator re-reads the exact source and rejects a stale citation.
  // A mechanism with any outcome fork requires shared-world live evidence.
  mechanisms: [
    {
      id: "sleep",
      summary:
        "Going to bed and advancing the day are different state machines per world mode; a single-player sleep cannot " +
        "stand in for a shared-world one.",
      forks: [
        {
          file: "StardewValley/GameLocation.cs",
          signature: "private void startSleep()",
          predicate: "if (Game1.IsMultiplayer)",
          forkClass: "outcome_fork",
          reason:
            'Shared world branches to Game1.netReady.SetLocalReady("sleep", true) plus a ReadyCheckDialog whose confirm ' +
            "callback is the only path to doSleep(); single-player calls doSleep() directly. The day therefore advances on a " +
            "different trigger and after a different set of conditions.",
        },
        {
          file: "StardewValley/Game1.cs",
          signature: "public static void PassOutNewDay()",
          predicate: "if (!IsMultiplayer)",
          forkClass: "outcome_fork",
          reason:
            "Single-player passes out straight into NewDay(0f); a shared world instead sets player.passedOut, swaps in a " +
            'non-cancelable ReadyCheckDialog("sleep") and advances only via that dialog\'s confirm callback.',
        },
        {
          file: "StardewValley/Game1.cs",
          signature: "private static IEnumerator<int> _newDayAfterFade()",
          predicate: "if (IsMasterGame)",
          forkClass: "outcome_fork",
          reason:
            "dayOfMonth and stats.DaysPlayed advance only on the master game, so a Farmhand client cannot roll the date " +
            "itself; it must wait on newDaySync barriers instead.",
        },
        {
          file: "StardewValley/NewDaySynchronizer.cs",
          signature: "public void start()",
          predicate: "if (Game1.IsMasterGame)",
          forkClass: "outcome_fork",
          reason:
            "The master broadcasts message 30 to every other farmer and returns; a client spins in while (!ServerReady) " +
            "processing messages until the server signals, so the cross-day handshake is a barrier in a shared world only.",
        },
      ],
    },
  ],
  declaredActionIds: actions.map((a) => a.actionId),
  actions,
};

fs.writeFileSync(
  "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json",
  `${JSON.stringify(register, null, 2)}\n`,
);
console.log("wrote", actions.length, "actions");
console.log("rejects-MP:", actions.filter((a) => a.admission.verdict === "rejects_multiplayer").length);
console.log("read-only:", actions.filter((a) => a.admission.verdict === "read_only").length);
console.log("mp-semantic:", actions.filter((a) => a.requiredLiveTopology === "shared_world_multiplayer").length);
