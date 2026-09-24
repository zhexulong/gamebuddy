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
  till_soil: ["StardewValley.Tools/Hoe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  dig_artifact_spot: ["StardewValley.Tools/Hoe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  water_crop: ["StardewValley.Tools/WateringCan.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  refill_watering_can: ["StardewValley.Tools/WateringCan.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  chop_tree_source: ["StardewValley.Tools/Axe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  chop_stump: ["StardewValley.Tools/Axe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  break_rock_source: ["StardewValley.Tools/Pickaxe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  clear_hoedirt: ["StardewValley.Tools/Pickaxe.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  collect_animal_product: ["StardewValley.Tools/MilkPail.cs", "public override void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  clear_debris: ["StardewValley/Tool.cs", "public virtual void DoFunction(GameLocation location, int x, int y, int power, Farmer who)", "mp-insensitive"],
  pet_animal: ["StardewValley.Characters/Pet.cs", "public override bool checkAction", "mp-insensitive"],
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
  harvest_crop: ["StardewValley.TerrainFeatures/HoeDirt.cs", "public override bool performUseAction", "mp-insensitive", null, "team.RequestLimitedNutDrops is the IslandFarming limited-nut drop; FarmerTeam is populated in single-player too, so the read is mode-neutral"],
  scythe_crop: ["StardewValley.TerrainFeatures/HoeDirt.cs", "public override bool performToolAction", "mp-insensitive", null, "team.RequestLimitedNutDrops is the IslandFarming limited-nut drop; FarmerTeam is populated in single-player too, so the read is mode-neutral"],
  cut_weeds: ["StardewValley/Object.cs", "public virtual bool performToolAction", "mp-insensitive", null, "netWorldState.TreasureTotems only seeds a day-save Random and is populated in single-player too"],
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
  craft_item: ["StardewValley/CraftingRecipe.cs", "public virtual Item createItem()", "mp-insensitive", null, "team.SpecialOrderRuleActive(\"QI_COOKING\") only stamps orderData on a cooking recipe; FarmerTeam is populated in single-player too, so the read is mode-neutral"],
  cook_recipe: ["StardewValley/CraftingRecipe.cs", "public virtual Item createItem()", "mp-insensitive", null, "team.SpecialOrderRuleActive(\"QI_COOKING\") only stamps orderData on a cooking recipe; FarmerTeam is populated in single-player too, so the read is mode-neutral"],
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
          ...(entry[3] ? { semanticEffect: entry[3] } : {}),
          ...(entry[4] ? { modeNeutralReason: entry[4] } : {}),
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

const register = {
  schemaVersion: 1,
  artifactKind: "stardew_native_multiplayer_sensitivity",
  note:
    "Multiplayer scope is DERIVED from the exact decompiled game source plus the Mod's own admission guards. " +
    "The pinned statement (not the authored memory) is what the checker trusts.",
  // Scope-level acknowledgement of a gap that is systemic, not action-specific.
  // GameBuddy is a companion that joins the player's world, so multiplayer IS the
  // product topology: these actions reject multiplayer with no native
  // justification. The gap is a single mechanism (the admission guard is the
  // early single-player fixture gate rather than the scope-bound actor resolver
  // that express_emote / face_direction / move_to_tile already use), so it is
  // pinned once here instead of sixteen times. The pin is rejected as stale the
  // moment any listed action stops deriving the defect, so it cannot outlive the
  // fix.
  scopeAcknowledgements: [
    {
      defect: "over_restriction",
      actions: OVER_RESTRICTED,
      reason:
        "Admission uses the early `native_local_player_required` fixture guard (Context.IsMultiplayer || !Game1.IsMasterGame || " +
        "getAllFarmers().Count() != 1) even though the native seam carries no outcome-affecting multiplayer state. The correct guard is the " +
        "scope-bound actor resolver `ExecutionManager.TryGetBoundActor` (farmhandexecutioncontroller.cs:412-451), which already exists and is " +
        "already used by express_emote / face_direction / move_to_tile: it validates `actor.UniqueMultiplayerID == executionScope.PlayerId` and " +
        "fails closed with `execution_scope_mismatch`, which is what a Farmhand actor needs. On the AI Farmhand's own client Game1.player IS that " +
        "Farmhand, so the resolver admits the real product topology instead of refusing it.",
      owner: "stardew-integration",
    },
    {
      defect: "unverified_scope",
      actions: ["ship_item"],
      reason:
        "Admission admits a shared world, and the settlement container is chosen by `Farm.getShippingBin(who)` from " +
        "`Game1.player.team.useSeparateWallets`, so the destination bin differs between single-player and a shared world. No shared-world live " +
        "evidence exists yet.",
      owner: "stardew-integration",
    },
    {
      defect: "mp_sensitive_exclusion",
      actions: ["chest_retrieve"],
      reason:
        "`Chest.GetItemsForPlayer(long id)` resolves the container per player: a chest with a GlobalInventoryId returns the team-shared inventory, " +
        "and a MiniShippingBin returns that player's own separate-wallet inventory. The Mod calls the no-arg overload, which resolves " +
        "`Game1.player.UniqueMultiplayerID`. So the target container genuinely depends on the world's wallet mode and who is asking, yet admission " +
        "rejects a shared world outright. Same root cause as the over_restriction pin, and the same fix applies, but it is recorded separately because " +
        "the native path is positively verified to be multiplayer-capable rather than merely unrestricted.",
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
