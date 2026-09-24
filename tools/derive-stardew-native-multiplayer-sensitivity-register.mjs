import fs from "node:fs";
import path from "node:path";

/**
 * Derive the pinned multiplayer-sensitivity register.
 *
 * Admission is DERIVED from the Mod source (never hand-typed), so the register
 * cannot drift from the implementation. Seam classification is authored here
 * and re-verified against the exact decompiled source by the checker.
 */

// actionId -> [file, signature, sensitivity, semanticEffect?]  (native seams)
// actionId -> ["mod_owned", authority]                      (no native seam)
const TABLE = {
  // ---------------- published ----------------
  // Body movement, emotes and facing are Mod-owned mutations executed through the
  // Mod's own body controller; there is no game method whose multiplayer
  // behaviour could differ, so no native seam exists to classify.
  move_to_tile: ["mod_owned", "StardewBodyController"],
  travel: ["mod_owned", "StardewBodyController"],
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
  till_soil: ["StardewValley.Tools/Hoe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-observational", "Game1.multiplayer.broadcastSprites at Hoe.cs:94/97/105/108 mirrors an already-applied dirt sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); location.makeHoeDirt on the same lines decides the result identically in both modes"],
  dig_artifact_spot: ["StardewValley.Tools/Hoe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-observational", "Game1.multiplayer.broadcastSprites at Hoe.cs:94/97/105/108 mirrors an already-applied dirt sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); location.makeHoeDirt on the same lines decides the result identically in both modes"],
  water_crop: ["StardewValley.Tools/WateringCan.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-observational", "Game1.multiplayer.broadcastSprites at WateringCan.cs:173/202 mirrors an already-applied water sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); the refill/water mutation on the same lines is mode-independent"],
  refill_watering_can: ["StardewValley.Tools/WateringCan.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-observational", "Game1.multiplayer.broadcastSprites at WateringCan.cs:173/202 mirrors an already-applied water sprite (Multiplayer.broadcastSprites adds to location.temporarySprites first, then returns when !Game1.IsMultiplayer); the refill/water mutation on the same lines is mode-independent"],
  chop_tree_source: ["StardewValley.Tools/Axe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  chop_stump: ["StardewValley.Tools/Axe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  break_rock_source: ["StardewValley.Tools/Pickaxe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-observational", "Game1.multiplayer.broadcastSprites at Pickaxe.cs:149/151 mirrors an already-applied break sprite, and Game1.createObjectDebris(..., who.UniqueMultiplayerID, location) at :160/163 uses the id only for getFarmer(id).getStandingPosition() as the debris origin (Game1.cs:10422-10424) while still adding to location.debris; the stone removal at :166-168 is mode-independent"],
  clear_hoedirt: ["StardewValley.Tools/Pickaxe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-observational", "Game1.multiplayer.broadcastSprites at Pickaxe.cs:149/151 mirrors an already-applied break sprite, and Game1.createObjectDebris(..., who.UniqueMultiplayerID, location) at :160/163 uses the id only for getFarmer(id).getStandingPosition() as the debris origin (Game1.cs:10422-10424) while still adding to location.debris; the stone removal at :166-168 is mode-independent"],
  collect_animal_product: ["StardewValley.Tools/MilkPail.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  clear_debris: ["StardewValley/Tool.cs", "public virtual void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  // Outcome fork, not collateral: grantedFriendshipForPet is one NetBool per PET
  // (Pet.cs:70) and friendshipTowardFarmer one NetInt per PET (Pet.cs:73), while only
  // lastPetDay is keyed by UniqueMultiplayerID (:67). Once ANY farmer has petted the
  // pet today, :646 is false for everyone, so this farmer's pet grants 0 friendship.
  // The Mod receipt nonetheless asserts before+12 (:378/:387) — a pre-existing defect.
  pet_animal: ["StardewValley.Characters/Pet.cs", "public override bool checkAction", "mp-semantic", "lastPetDay is keyed by who.UniqueMultiplayerID (Pet.cs:641/643), but the +12 friendship at :646-649 is gated on grantedFriendshipForPet, a single per-pet NetBool (:70) reset daily (:484), and friendshipTowardFarmer is a single per-pet NetInt (:73). If another farmer already petted that pet today, this action still returns handled and emotes but grants 0 friendship, so the friendship delta differs by world mode"],
  pickup_forage: ["StardewValley/Game1.cs", "public static bool tryToCheckAt", "mp-insensitive"],
  enter_exit: ["StardewValley/Farmer.cs", "public void warpFarmer(", "mp-insensitive"],
  // pickup_item hands delivery to native magnetic pickup: the bridge never calls
  // collect or touches the inventory itself.
  pickup_item: ["StardewValley/Debris.cs", "public virtual bool collect(", "mp-insensitive"],
  plant_seed: ["StardewValley/Object.cs", "public virtual bool placementAction", "mp-observational", "IsLocalPlayer only gates the sprinkler/chest auto-harvest hook, after dirt.plant already decided the result"],
  plant_sapling: ["StardewValley/Object.cs", "public virtual bool placementAction", "mp-observational", "IsLocalPlayer only gates the sprinkler/chest auto-harvest hook, after dirt.plant already decided the result"],
  place_crab_pot: ["StardewValley/Object.cs", "public virtual bool placementAction", "mp-observational", "IsLocalPlayer only gates the sprinkler/chest auto-harvest hook, after dirt.plant already decided the result"],
  fertilize_tile: ["StardewValley/Object.cs", "public virtual bool placementAction", "mp-observational", "IsLocalPlayer only gates the sprinkler/chest auto-harvest hook, after dirt.plant already decided the result"],
  place_wood_fence: ["StardewValley/Object.cs", "public override bool canBePlacedHere(GameLocation l, Vector2 tile, CollisionMask collisionM", "mp-insensitive"],
  bait_crab_pot: ["StardewValley/GameLocation.cs", "public virtual bool checkAction", "mp-observational", "IsLocalPlayer only gates pickup sound/animation"],
  machine_inspect: ["StardewValley/GameLocation.cs", "public virtual bool checkAction", "mp-observational", "IsLocalPlayer only gates pickup sound/animation"],
  machine_load: ["StardewValley/GameLocation.cs", "public virtual bool checkAction", "mp-observational", "IsLocalPlayer only gates pickup sound/animation"],
  machine_collect_output: ["StardewValley/GameLocation.cs", "public virtual bool checkAction", "mp-observational", "IsLocalPlayer only gates pickup sound/animation"],
  feed_animal: ["StardewValley/GameLocation.cs", "public virtual bool checkAction", "mp-observational", "IsLocalPlayer only gates pickup sound/animation"],
  harvest_crop: ["StardewValley.TerrainFeatures/HoeDirt.cs", "public override bool performUseAction", "mp-insensitive", "team.RequestLimitedNutDrops is the IslandFarming limited-nut drop; FarmerTeam is populated in single-player too, so the read is mode-neutral"],
  scythe_crop: ["StardewValley.TerrainFeatures/HoeDirt.cs", "public override bool performToolAction", "mp-insensitive", "team.RequestLimitedNutDrops is the IslandFarming limited-nut drop; FarmerTeam is populated in single-player too, so the read is mode-neutral"],
  cut_weeds: ["StardewValley/Object.cs", "public virtual bool performToolAction", "mp-observational", "Game1.multiplayer.broadcastSprites at Object.cs:1129 mirrors the twig sprite; Game1.netWorldState.Value.TreasureTotemsUsed at :1254 belongs to the artifact-spot branch of the same method and only seeds Utility.CreateDaySaveRandom, which is populated in single-player too"],
  use_item: ["StardewValley/Farmer.cs", "public void eatObject(", "mp-observational", "IsLocalPlayer only gates a buff-awareness shortcut"],
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
  craft_item: ["StardewValley/CraftingRecipe.cs", "public virtual Item createItem()", "mp-insensitive", "team.SpecialOrderRuleActive(\"QI_COOKING\") only stamps orderData on a cooking recipe; FarmerTeam is populated in single-player too, so the read is mode-neutral"],
  cook_recipe: ["StardewValley/CraftingRecipe.cs", "public virtual Item createItem()", "mp-insensitive", "team.SpecialOrderRuleActive(\"QI_COOKING\") only stamps orderData on a cooking recipe; FarmerTeam is populated in single-player too, so the read is mode-neutral"],
  collect_crab_pot_output: ["StardewValley/GameLocation.cs", "public virtual bool checkAction", "mp-observational", "IsLocalPlayer only gates pickup sound/animation"],
};

const MP_REJECT_PATTERN =
  /Context\.IsMultiplayer|!Game1\.IsMasterGame|getAllFarmers\(\)\.Count\(\)\s*!=\s*1|Game1\.server\s+is not null/;

// ---- derive admission from the Mod ----
const actionToMethod = new Map();
for (const f of fs.readdirSync("integrations/stardew/Handlers")) {
  if (!f.endsWith(".cs")) continue;
  const t = fs.readFileSync(path.join("integrations/stardew/Handlers", f), "utf8");
  for (const m of t.matchAll(/"([a-z_]+)"\s*=>\s*this\.executions\.(RequestLocal\w+)\(/g)) actionToMethod.set(m[1], m[2]);
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
const NAVIGATION_ADMISSION_ACTIONS = new Set(["navigate_to_destination"]);

const surface = { actions: readCatalog() };
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
      lifecycle: match[1] === "R" || !/FarmhandActionLifecycle\.Experimental/.test(call) ? "published" : "experimental",
    });
  }
  return rows;
}
const lifecycle = new Map(surface.actions.map((a) => [a.actionId, a.lifecycle]));

const actions = [];
for (const entry of surface.actions) {
  const actionId = entry.actionId;
  const registered = actionToMethod.has(actionId);
  const admission = registered ? methodBody.get(actionToMethod.get(actionId)) ?? "" : "";
  const head = admission.split("\n").slice(0, 45).join("\n");
  const rejects = registered && MP_REJECT_PATTERN.test(head);
  const admissionEntry = READ_PIPELINE_ACTIONS.has(actionId)
    ? { verdict: "read_only" }
    : rejects
      ? { verdict: "rejects_multiplayer", reasonCode: "native_local_player_required" }
      : { verdict: "admits_multiplayer" };
  const seam = TABLE[actionId];
  if (seam === null) throw new Error("action needs an explicit seam entry: " + actionId);

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
  const requiredLiveTopology = derivedSensitivity === "mp-semantic" ? "shared_world_multiplayer" : "single_player_native_companion";

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
// evidence exists yet. When one lands, the pin goes stale and the gate rejects it.
const UNVERIFIED_SCOPE = actions
  .filter((a) => a.admission.verdict === "admits_multiplayer" && a.requiredLiveTopology === "shared_world_multiplayer")
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
        "`Game1.player.UniqueMultiplayerID`. No shared-world live evidence exists yet for either.",
      owner: "stardew-integration",
    },
  ],
  declaredActionIds: actions.map((a) => a.actionId),
  actions,
};

fs.writeFileSync("integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json", JSON.stringify(register, null, 2) + "\n");
console.log("wrote", actions.length, "actions");
console.log("rejects-MP:", actions.filter((a) => a.admission.verdict === "rejects_multiplayer").length);
console.log("read-only:", actions.filter((a) => a.admission.verdict === "read_only").length);
console.log("mp-semantic:", actions.filter((a) => a.requiredLiveTopology === "shared_world_multiplayer").length);
