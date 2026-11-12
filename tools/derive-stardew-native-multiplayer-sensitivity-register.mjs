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
  chop_tree: [
    "StardewValley.Tools/Axe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
  ],
  chop_stump: [
    "StardewValley.Tools/Axe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
  ],
  break_rock: [
    "StardewValley.Tools/Pickaxe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `Game1.multiplayer.broadcastSprites at ${cite("StardewValley.Tools/Pickaxe.cs", "DoFunction")} mirrors an already-applied break sprite, and Game1.createObjectDebris(..., who.UniqueMultiplayerID, location) in the same method uses the id only for getFarmer(id).getStandingPosition() as the debris origin (${cite("StardewValley/Game1.cs", "getFarmer")}) while still adding to location.debris; the stone removal in the same method is mode-independent`,
  ],
  // A resource clump (stump/log at parentSheetIndex 600/602, boulder at 148/622) is
  // destroyed inside `ResourceClump.performToolAction`, whose own body reads no
  // multiplayer token and which refuses every tool but the one its own index names. The
  // handler's swing is the tool's `DoFunction`, so the Pickaxe ingress below carries this
  // action's only token reads and dominates - the same reading `remove_placed_item`
  // records for the same pair.
  break_resource_clump: [
    "StardewValley.Tools/Pickaxe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `the clump's health and its removal are ResourceClump.performToolAction's, and that body reads no multiplayer token. The token reads on the path are this seam's own break branch (${cite("StardewValley.Tools/Pickaxe.cs", "DoFunction")}): Game1.multiplayer.broadcastSprites mirrors an already-applied break sprite, and Game1.createObjectDebris(..., who.UniqueMultiplayerID, location) uses the id only as the debris origin, so the clump that dies is the same clump in both world modes.`,
  ],
  // One cast: `beginUsing` records the facing and the last user, `DoFunction` spends the
  // stamina, counts the cast and starts the rod's own state machine; the bite, the catch
  // and the landing are the engine's tool tick from there on.
  fish_here: [
    "StardewValley.Tools/FishingRod.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    "DoFunction opens with `who = who ?? lastUser; if (fishCaught || (!who.IsLocalPlayer && (isReeling || isFishing || pullingOutOfWater))) return;`, and this seam has one caller in the product: the Mod's own cast, which passes `Game1.player` (`farmhandexecutioncontroller.fishingactions.cs`, `ExecuteFishHere`, `rod.DoFunction(location, targetX, targetY, 1, Game1.player)`). `Game1.player` IS the local player on any client, so the guard is false on every dispatch this action makes and no branch can differ - the read observes which client is casting, it does not select an outcome. The stamina spend, the cast count and the bite delay the same body applies are mode-independent.",
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
  // Barn/coop stock, not the household pet: `FarmAnimal.pet(who)` is the same native call
  // the player's own click route makes. Its outcome marker (`wasPet`) and its friendship
  // are the ANIMAL's own fields, not a farmer-keyed entry, so the manual branch it takes is
  // decided by the animal's state in both world modes. That the marker is one daily flag per
  // animal is why the handler refuses `farm_animal_already_petted_today` before calling it,
  // instead of reporting a pet the seam would not apply.
  pet_farm_animal: [
    "StardewValley/FarmAnimal.cs",
    "public void pet(Farmer who, bool is_auto_pet = false)",
    "mp-insensitive",
    "pet reads no multiplayer token: it returns early for an animal whose own wasPet flag is already set, spends a held golden cracker through the acting farmer, and otherwise adds friendship and happiness to the animal's own fields. The day marker belongs to the animal rather than to a farmer, so no branch of this body asks which world mode it is running in; a second farmer's pet in the same day is refused by the handler's own admission, not silently zeroed here.",
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
  // The scythe sweep is `MeleeWeapon.DoDamage`, called once per sampled sweep index by the
  // Mod's own `UseNativeMeleeSweep` (`farmhandexecutioncontroller.cs:4721-4732`). One entry
  // covers the whole arc, because DoDamage is the one native method that reaches all three
  // tile occupants the arc can cut - `Object.performToolAction` (weeds),
  // `TerrainFeature.performToolAction` (grass, scythe crops) and
  // `GameLocation.performToolAction` - so a per-occupant seam would be three partial
  // answers instead of one true one.
  sweep_scythe: [
    "StardewValley.Tools/MeleeWeapon.cs",
    "public virtual void DoDamage(GameLocation location, int x, int y, int facingDirection, int power, Farmer who)",
    "mp-observational",
    "DoDamage opens with `if (!who.IsLocalPlayer) { return; }`, and this seam's only caller in the product passes `Game1.player` (the Mod's `UseNativeMeleeSweep`, farmhandexecutioncontroller.cs:4721-4732, called from `ExecuteSweepScythe` with `Game1.player`). `Game1.player` IS the local player on any client, so the guard is false on every dispatch this action makes and no branch can differ - the read observes which client is swinging, it does not select an outcome. The cut itself (damageMonster, the three performToolAction calls and the terrain/object removals they answer) is mode-independent.",
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
  // The blacksmith's counter opens the game's own GeodeMenu through the engine's own action
  // case, and the Mod then drives that menu: `receiveRightClick` moves the geode onto the
  // cursor through the menu's own inventory, `receiveLeftClick` is the smash (the fee, the
  // stack consumption and the animation start), and the menu's own `update` mints the
  // treasure when Clint's animation reaches frame 11 and delivers it. Nothing here
  // re-implements the fee, the drop table or the delivery.
  open_geode: [
    [
      "StardewValley.Menus/GeodeMenu.cs",
      "public override void receiveLeftClick(int x, int y, bool playSound = true)",
      "mp-insensitive",
      "the only shared reads on this path are the golden-coconut branch: Game1.netWorldState.Value.GoldenCoconutCracked and Game1.player.team.goldenCoconutMutex. Both exist in single-player too - a netWorldState and a FarmerTeam are populated there - so what they decide is a WORLD fact (whether this save's golden coconut is already spent), not a difference between the two world modes. The fee, the stack consumption and the animation this click starts are the local player's own.",
    ],
    [
      "StardewValley.Menus/GeodeMenu.cs",
      "public override void update(GameTime time)",
      "mp-insensitive",
      "the treasure is minted from the game's own table and delivered through Game1.player.addItemToInventoryBool; the one shared write is Game1.netWorldState.Value.GoldenCoconutCracked = true for the golden coconut, a world fact that exists in single-player too. Nothing in the body asks which world mode it is running in.",
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
  // NOT mp-insensitive: NPC.cs reads Game1.multiplayer / IsLocalPlayer / IsMultiplayer in the
  // same checkAction body (`movementPause = Game1.IsMultiplayer ? 1000 : 10`), and the register
  // checker refuses an mp-insensitive claim whose exact source reads a decisive token. Talking
  // needs shared-world evidence before it can leave Experimental - unlike its sibling
  // interact_npc_with_item, whose declared seam (receiveGift) reads no such token.
  // The chat egress: the game's own Multiplayer.sendChatMessage. Its body branches on Game1.IsClient /
  // Game1.IsServer and returns without sending when neither holds, so the multiplayer mode decides whether a
  // message leaves the process AT ALL - hence mp-semantic, and hence a success terminal exists only on a real
  // lobby (the farmhand lane). That is also why a green receipt on a single-player fixture would be a false green.
  // FishPond.ClearPond() resets the pond's own state and drops the fish as debris; scanning the method body finds
  // no multiplayer token, so the same call empties the same pond in both world modes - collateral fan-out inside
  // the game's own debris helper is not this action's outcome.
  clear_fish_pond: [
    "StardewValley.Buildings/FishPond.cs",
    "public void ClearPond()",
    "mp-insensitive",
    "ClearPond's body reads no multiplayer token at all: it resets the pond's own net fields (currentOccupants, fishType, the population gate, the cracker flag) and spawns each occupant through Game1.createItemDebris, whose sprite fan-out belongs to the game and not to this outcome; the pond it acts on is the live one either way, so the same call clears the same pond in both world modes.",
  ],
  send_multiplayer_chat: [
    "StardewValley/Multiplayer.cs",
    "public virtual void sendChatMessage(LocalizedContentManager.LanguageCode language, string message, long recipientID)",
    "mp-semantic",
    "the body reads Game1.IsClient (sends through Game1.client) and Game1.IsServer (fans out to the connected farmers), and RETURNS when neither is true - so single-player sends nothing while reporting no error, and the lobby it fans out to is the very fact the action's receipt depends on.",
  ],
  talk_to_npc: [
    "StardewValley/NPC.cs",
    "public virtual bool checkAction(",
    "mp-semantic",
    `the conversation branch is gated on who.IsLocalPlayer, so only the local farmer can trigger it, and the same method sets movementPause = Game1.IsMultiplayer ? 1000 : 10, so the actor stays paused 100x longer after the call in a shared world. Neither changes which dialogue is chosen nor whether conversation friendship is granted; they change who may trigger the branch and how long the pause lasts afterward.`,
  ],
  npc_relationship: ["mod_owned", "Farmer.friendshipData"],
  // ---- the three queue actions (2026-10-13) ----
  // The Mod calls the STRING overload (`GameLocation.cs:16926`), which only resolves the
  // Data/Buildings entry and forwards to the DATA overload (`:16800`) - that overload is the
  // settlement (the placement checks, `Building.CreateInstanceFromId`, `buildings.Add`, the team
  // event), so the seam is cited there: the entry overload's own body carries no game logic to
  // classify. The settlement reads no multiplayer state that decides the outcome; its two
  // decisive-pattern reads are collateral (see observedEffect).
  // The special-orders board accept: the creation write is publicly reachable without the board.
  accept_special_order: [
    "StardewValley/FarmerTeam.cs",
    "public void AddSpecialOrder(string id, int? generationSeed = null, bool forceRepeatable = false)",
    "mp-insensitive",
    "AddSpecialOrder's body reads no multiplayer token at all: it returns when the team already offers the id, resolves the order through SpecialOrder.GetSpecialOrder, warns and returns when the id is unknown, refuses a completed non-repeatable order, and appends to the team's own specialOrders list. FarmerTeam is populated in single-player too, so the same call creates the same order in both world modes.",
  ],
  // The museum donation reward collection: reward list is per-player state derived from donation flags.
  claim_museum_reward: [
    "StardewValley.Locations/LibraryMuseum.cs",
    "public List<Item> getRewardsForPlayer(Farmer player)",
    "mp-insensitive",
    "the reward set is derived from the player's own donation flags and the game's data table; the mail flags and",
    "recipes the grant writes are the same world facts in any session - no multiplayer-decisive token is read.",
  ],
  // Prize-ticket redemption has NO callable native settlement: the game's own path runs through
  // `LibraryMuseum.OnRewardCollected` from the prize menu's callback, and this handler calls it
  // nowhere (`git grep OnRewardCollected integrations/stardew` finds exactly one call site,
  // `museumrewards.cs:139`, which belongs to `claim_museum_reward`). The Mod performs the whole
  // mutation itself on public members: `addItemToInventoryBool(prize)`,
  // `player.Items.ReduceId("(O)PrizeTicket", 1)` and
  // `Game1.stats.Increment("ticketPrizesClaimed")`. So the seam is mod_owned, the same reading
  // `npc_relationship` and `equip_tool` record for a mutation the Mod writes itself.
  redeem_prize_ticket: ["mod_owned", "Game1.stats.ticketPrizesClaimed"],
  // Tailoring craft: the sewing machine's table drives it; a backpack-local exchange.
  tailor_clothing: [
    "StardewValley.Menus/TailoringMenu.cs",
    "public Item CraftItem(Item left_item, Item right_item)",
    "mp-insensitive",
    "the settlement consumes two held items and produces a garment; no multiplayer-decisive token is read.",
  ],
  // Tailoring dye: the colour comes from the dye item's own context tags and Clothing.Dye.
  dye_clothing_with_item: [
    "StardewValley.Menus/TailoringMenu.cs",
    "public bool DyeItems(Clothing clothing, Item dye_object, float dye_strength_override = -1f)",
    "mp-insensitive",
    "the colour comes from the dye item's own context tags; no multiplayer-decisive token is read.",
  ],
  // The chest repaint has NO callable native settlement either: the palette lives in
  // `DiscreteColorPicker.receiveLeftClick` (DiscreteColorPicker.cs:75-79), which this handler
  // never calls (`git grep receiveLeftClick integrations/stardew` finds it only in
  // `NpcDialoguePager.cs`, a different surface, and in this file's own header as a citation).
  // The Mod writes the two statements that handler performs against the chest it means -
  // `chest.playerChoiceColor.Value = <palette colour>` and `chest.resetLidFrame()` - and reads
  // the palette through the public `DiscreteColorPicker.getColorFromSelection`. So the seam is
  // mod_owned, the same reading `npc_relationship` and `equip_tool` record.
  color_placed_object: ["mod_owned", "Chest.playerChoiceColor"],
  build_farm_building: [
    "StardewValley/GameLocation.cs",
    "public bool buildStructure(string typeId, BuildingData data, Vector2 tileLocation, Farmer who, out Building constructed, bool magicalConstruction = false, bool skipSafetyChecks = false)",
    "mp-observational",
    "the settlement's only pattern-decisive reads are presentation and provenance: `Game1.multiplayer.globalChatInfoMessage(...)` posts the game's own 'who built what' lobby notice, and `building.owner.Value = who.UniqueMultiplayerID` records the ACTING farmer's own id, which is the same value in both world modes (the same reading `place_wood_fence` records against `Object.placementAction`). The placement checks (`isBuildable`, the farmers' bounding boxes, `isThereAnythingtoPreventConstruction`), `Building.CreateInstanceFromId`, the terrain removal and `buildings.Add` are mode-independent, and `who.team.SendBuildingConstructedEvent` fires off a FarmerTeam that exists in single-player too.",
  ],
  // The accepted flag is set through the game's own `Quest.accept()` (`Quest.cs:475`,
  // `accepted.Value = true`); the rest of the branch is the Mod's own writes to the public native
  // members the board's accept branch writes (`dailyQuest`/`dayQuestAccepted`/`canBeCancelled`/
  // `daysLeft`, `Farmer.questLog`, `Farmer.acceptedDailyQuest`), and the Mod's admission reads no
  // multiplayer token either. The accepted flag itself is the same write in both world modes.
  accept_daily_quest: ["StardewValley.Quests/Quest.cs", "public virtual void accept()", "mp-insensitive"],
  // The horse naming settlement (`Horse.nameHorse`, `Horse.cs:570`). Its only pattern-decisive
  // read is the lobby notice; the name write is mode-independent (see observedEffect).
  name_entity: [
    "StardewValley.Characters/Horse.cs",
    "public void nameHorse(string name)",
    "mp-observational",
    "the settlement's only pattern-decisive read is presentation: `Game1.multiplayer.globalChatInfoMessage(\"HorseNamed\", Game1.player.Name, name)` announces the rename. The stored name - `base.Name`, `displayName`, and the acting player's own `Game1.player.horseName` - is written the same way in both world modes, and `mutex.ReleaseLock()` only releases the horse's own NetMutex this call already holds, so the name the postcondition reads back cannot differ by world mode.",
  ],
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
  // The cross-day lifecycle, registered as `sleep`. The Mod answers the game-owned Sleep
  // question (`GameLocation.answerDialogue`) exactly as the native input paths do; the
  // outcome fork lives one step further in `startSleep`: single-player calls `doSleep()`
  // directly, while a shared world sets the local native ready flag and installs a
  // ReadyCheckDialog whose confirm callback is the only path to `doSleep()`. The day
  // therefore advances on a different trigger.
  sleep: [
    "StardewValley/GameLocation.cs",
    "private void startSleep()",
    "mp-semantic",
    'Single player calls doSleep() directly, but a shared world instead sets Game1.netReady.SetLocalReady("sleep") ' +
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
  // The level-up card is the game's own modal and closing it is the settlement: an ordinary
  // level through `okButtonClicked` (getLevelPerk then RemoveLevelFromLevelList), a
  // profession through the sequence the menu's mouse handler performs. Both act on the
  // LOCAL farmer's own stats and profession set.
  respond_level_up: [
    [
      "StardewValley.Menus/LevelUpMenu.cs",
      "public void okButtonClicked()",
      "mp-insensitive",
      "okButtonClicked settles the LOCAL player's own level: getLevelPerk writes that player's stats and mail, RemoveLevelFromLevelList drops the menu's own newLevels entry, and the two flags are client-side UI. No shared-world state is read or written.",
    ],
    [
      "StardewValley.Menus/LevelUpMenu.cs",
      "public void getImmediateProfessionPerk(int whichProfession)",
      "mp-insensitive",
      "getImmediateProfessionPerk adds the chosen profession id to the local player's own professions set and applies its immediate stat effects; the body forks on nothing world-mode related. THAT THE FIELD IS A SYNCED NetIntHashSet is a propagation question for a shared world, not a fork in this method, and this action's live evidence so far is single-player only - which `requiredLiveTopology` states.",
    ],
  ],
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
  toggle_animal_door: [
    "StardewValley.Buildings/Building.cs",
    "public virtual void ToggleAnimalDoor(Farmer who)",
    "mp-insensitive",
    "flips the building's own animalDoorOpen NetBool and plays the open/close sound; the body reads no multiplayer token",
  ],

  // The world-object lane: three actions, three natives on objects that occupy world tiles.
  place_owned_object: [
    "StardewValley/Object.cs",
    "public virtual bool placementAction",
    "mp-observational",
    "owner.Value records the ACTING player's own id (who?.UniqueMultiplayerID ?? Game1.player.UniqueMultiplayerID), so it is the same value in both world modes; Game1.multiplayer.broadcastSprites mirrors an already-applied local sprite; the decisive writes are mode-independent (location.objects.Add for a bigCraftable, the tapper branch's tree.tapped.Value = true plus Tree.UpdateTapperProduct which touches only the container's own heldObject, and location.objects[vector] = obj4 for the replace case)",
  ],
  remove_placed_item: [
    "StardewValley.Tools/Pickaxe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    "Game1.multiplayer.broadcastSprites mirrors an already-applied break sprite, and Game1.createObjectDebris(..., who.UniqueMultiplayerID, location) uses the id only for getFarmer(id).getStandingPosition() as the debris origin, while the object removal (performRemoveAction then Objects.Remove) is mode-independent; the action also drives Axe.DoFunction, whose body is mp-insensitive on its own, so this seam dominates",
  ],
  break_container: [
    "StardewValley.Tools/Axe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
    "Game1.multiplayer.broadcastSprites in the break branch mirrors chip sprites for a container the SAME method has already removed from location.objects, so the read is collateral; the removal and the releaseContents drop creation are mode-independent, and the method returns false in every path",
    "the handler calls the TOOL's DoFunction, which delegates: Axe.DoFunction reaches value2.performToolAction(this) then value2.performRemoveAction() (Axe.cs:88-94), and that is where the container is actually removed. The register cites the entry point the Mod calls; the delegation is recorded here so the terminal is still named.",
    "the body reads no multiplayer token, which is this checker's own test for mp-insensitive. The removal itself happens one level deeper: Axe.DoFunction reaches value2.performToolAction(this) and then value2.performRemoveAction() (Axe.cs:88-94), which is where the container leaves the map.",
  ],
  // The furniture-and-decoration lane: four actions on a piece that ALREADY stands in
  // the room. `location.furniture` is a collection with no key, so a tile plus the opaque
  // id selects the piece; each action then calls the piece's own native method.
  //
  // The game's own furniture pickup is `GameLocation.removeQueuedFurniture`
  // (GameLocation.cs:8074-8101) - `protected`, and driven by the click queue - so the Mod
  // performs the same three public steps on the same piece: the native
  // `performRemoveAction`, the removal from `location.furniture`, then the backpack. The
  // native removal is the seam cited; the other two are calls on that same piece.
  move_placed_furniture: [
    "StardewValley.Objects/Furniture.cs",
    "public override void performRemoveAction()",
    "mp-insensitive",
    "performRemoveAction reads no multiplayer token: it removes the piece's own lights, clears a fireplace's on-state, drops its own light glow and clears the sitting-farmer list the piece owns. The collection removal and the backpack write that complete the pickup are calls on the same piece, in the order the game's own protected removeQueuedFurniture performs them, so the piece leaves the room and lands in the pack identically in both world modes.",
  ],
  // The turn is the piece's own `rotate()` (Furniture.cs:1153-1162) plus the bookkeeping
  // half `updateRotation()`; the occupancy question is `Furniture.canBePlacedHere`, which
  // the handler asks AFTER the turn and reverts on a refusal.
  rotate_furniture: [
    "StardewValley.Objects/Furniture.cs",
    "public virtual void rotate()",
    "mp-insensitive",
    "rotate steps the piece's own currentRotation by the cycle its own rotations field declares and then re-derives every derived field through updateRotation(); neither body reads a multiplayer token. The occupancy probe the handler gates the turn on (Furniture.canBePlacedHere) answers from the location's own furniture, objects and blocking layer, so a turn is refused for the same reason in both world modes.",
  ],
  // A fence is taken down inside `Fence.performToolAction`, reached from the swinging
  // tool's `DoFunction`; `Fence.IsValidRemovalTool` is the data-driven gate on which tool
  // may swing, and a GATE is Axe-or-Pickaxe only (Fence.cs:447-454). The Pickaxe ingress
  // carries this action's only token reads, so it dominates - the same reading
  // `remove_placed_item` records for the same pair.
  remove_fence: [
    "StardewValley.Tools/Pickaxe.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-observational",
    `the fence is removed by Fence.performToolAction, reached from this swing or the Axe's. The token reads on the path are the collateral pair ${cite("StardewValley.Tools/Pickaxe.cs", "DoFunction")} carries for its own break branch: Game1.multiplayer.broadcastSprites mirrors an already-applied sprite, and Game1.createObjectDebris(..., who.UniqueMultiplayerID, location) takes the id only as the debris origin. Fence.performToolAction reads the same pair for the same purpose (its chip spray and its debris origin), while the removal, the held-object drop and the objects.Remove are mode-independent.`,
  ],
  // The tank's own deposit path. `localDepositedItem` and the category capacity are the
  // tank's own fields, and the deposit runs under the tank's own NetMutex.
  put_item_in_fish_tank: [
    "StardewValley.Objects/FishTankFurniture.cs",
    "public override bool checkForAction(Farmer who, bool justCheckingForActivity = false)",
    "mp-insensitive",
    "checkForAction consumes one of the acting farmer's stack into the tank's own heldItems under the tank's own NetMutex and updates the tank's own category capacity; no multiplayer token is read. The mutex is a NetMutex, which exists and is uncontended in single-player too, so the lock is a propagation detail rather than a fork in this method.",
  ],
  // The pedestal's own drop-in, the same NetMutex shape as the fish tank: a locked
  // pedestal and an untrashable item are refused, a held item is dropped through
  // DropObject, and the copy otherwise lands in `heldObject`.
  place_item_on_pedestal: [
    "StardewValley.Objects/ItemPedestal.cs",
    "public override bool performObjectDropInAction(Item dropInItem, bool probe, Farmer who, bool returnFalseIfItemConsumed = false)",
    "mp-insensitive",
    "performObjectDropInAction reads no multiplayer token: it refuses a locked pedestal and an untrashable item, drops a held item through DropObject, and otherwise takes the item's copy into heldObject under the pedestal's own itemModifyMutex and re-derives the pedestal's match flag. That mutex exists in single-player too, so the lock is a propagation detail rather than a fork in this method.",
  ],
  use_warp_item: [
    "StardewValley/Object.cs",
    "public virtual bool performUseAction(GameLocation location)",
    "mp-observational",
    "the body reads a multiplayer token (Game1.multiplayer / IsMultiplayer) for presentation or broadcast only; the outcome is decided by this actor's own item and state, so the effect is observation, not shared-world authority",
  ],
  pan_ore: [
    "StardewValley.Tools/Pan.cs",
    "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)",
    "mp-insensitive",
    "reads the location's own orePanPoint and the acting farmer's stats; the body reads no multiplayer token",
  ],
  claim_mail_attachment: [
    "StardewValley/GameLocation.cs",
    "public void mailbox()",
    "mp-insensitive",
    "drains the LOCAL player's own mailbox queue and opens that player's letter viewer; the body reads no multiplayer token",
  ],
  equip_wearable: [
    "StardewValley/Farmer.cs",
    "public TItem Equip<TItem>(TItem newItem, NetRef<TItem> slot) where TItem : Item",
    "mp-insensitive",
    "writes only this actor's own NetRef body slots and calls this actor's onEquip/onUnequip; the body reads no multiplayer token",
    "the registered name is the method the handler calls (Farmer.Equip); the generic parameter is omitted from the citation because the checker matches on the identifier before the parameter list",
  ],
  unequip_wearable: [
    "StardewValley/Farmer.cs",
    "public TItem Equip<TItem>(TItem newItem, NetRef<TItem> slot) where TItem : Item",
    "mp-insensitive",
    "the null-item form of the same method: it moves the actor's own item out of its own NetRef slot; the body reads no multiplayer token",
    "the same seam as equip_wearable, called with a null item; the generic parameter is omitted for the same reason",
  ],
  dismount_transport: [
    "StardewValley.Characters/Horse.cs",
    "public void dismount(bool from_demolish = false)",
    "mp-insensitive",
    "the body reads no multiplayer token, which is the checker's own test for this class; what IS shared is the per-horse NetMutex it releases (Horse.cs:510), which serialises cross-player mounts on the same horse. That lock is not a read in this body, so the classification stays mp-insensitive while the shared-world consequence is recorded here for the next reader.",
  ],
  // The building-chest pair. Both drive the terminal public method the native click path ends in
  // (GameLocation.performAction's BuildingChest case -> Building.PerformBuildingChestAction), and
  // both branches act on the building's OWN chest plus the LOCAL player's inventory. The method
  // reads no multiplayer token: the Load branch reads who.ActiveObject and the chest's own data,
  // and the Collect branch delegates to Utility.CollectSingleItemOrShowChestMenu, which reads
  // Game1.player's inventory. Its refusals are the game's own red messages.
  load_building_chest: [
    "StardewValley.Buildings/Building.cs",
    "public bool PerformBuildingChestAction(string name, Farmer who)",
    "mp-insensitive",
    "consumes a RequiredCount quantum of the held item into the building's own chest and plays the chest's sound; the body reads no multiplayer token",
  ],
  collect_building_chest_output: [
    "StardewValley.Buildings/Building.cs",
    "public bool PerformBuildingChestAction(string name, Farmer who)",
    "mp-insensitive",
    "delegates to Utility.CollectSingleItemOrShowChestMenu, which moves the chest's single stack into the local player's inventory; the body reads no multiplayer token",
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
  // The ladder is the mine's own exit check, not a second warp: the whole switch sits
  // inside `if (who.IsLocalPlayer)`, and the Mod's dispatch passes `Game1.player`, so the
  // guard is true on every dispatch - see the observedEffect.
  use_mine_ladder: [
    [
      "StardewValley.Locations/MineShaft.cs",
      "public override bool checkAction(Location tileLocation, xTile.Dimensions.Rectangle viewport, Farmer who)",
      "mp-observational",
      "the whole switch sits inside `if (who.IsLocalPlayer)`, and this seam has one caller in the product: the Mod's own ladder dispatch, which passes `Game1.player` (`farmhandexecutioncontroller.transportactions.cs`, `ExecuteUseMineLadder`, `shaft.checkAction(ladder, Game1.viewport, Game1.player)`). `Game1.player` IS the local player on any client, so the guard is true on every dispatch this action makes and no branch can differ - the read observes which client is driving, it does not select an outcome.",
    ],
    [
      "StardewValley/GameLocation.cs",
      "public virtual bool answerDialogue(Response answer)",
      "mp-insensitive",
      "settles the very question this action opened, for the local player only",
    ],
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
  if (seam === null || seam === undefined) throw new Error(`action needs an explicit seam entry: ${actionId}`);

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
