// The world a frontend run starts in: the one it creates.
//
// WHY A RUN NEEDS ITS OWN WORLD. The Player Host asks the Mod for one world name
// (`host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts`
// `WORLD_CREATION_FARM_NAME`), and Stardew keeps that world in the machine's single save folder. Every run
// therefore entered whatever the previous run had left there - and every run also left a permanent mark in
// it: each run root mints its own companion id, so her Cabin stays bound to that id for good. By
// `D:/gb-modcheck/frontend--r25` the shared world carried seven Cabins bound to r17..r24's companions, the
// Mod's provisioning had no free cabin PAD left to build an eighth on, and the panel answered the eighth
// run's 60 reads with 409 `stardew_player_host_cabin_missing`. That is the product's truthful answer to a
// farm whose cabins are all taken (`dialogue-web/src/components/GameSurface.tsx` tells the player to ask
// Robin for one), and it is a fixture that can no longer measure a launch.
//
// So a run starts from a world it creates: before this run's first launch, every save carrying the world
// name the product asked the Mod for is MOVED into the run root (`fixture-worlds/<slot>`), where it stays
// as evidence. Nothing is deleted, and a save of any other name is not touched - the other lanes'
// `GameBuddyFixture_*` worlds, and any world a player made herself, carry other names.
//
// WHAT A FRESH WORLD MEASURES THAT THE OLD ONE COULD NOT. A world created by the product's own native
// entry pass (`integrations/stardew/WorldCreationBootstrap.cs` `EstablishCompanionCabinLayout` →
// `GameLocation.BuildStartingCabins`) holds exactly one Cabin, whose owner is the engine's own unclaimed
// native slot (`Building.performActionOnConstruction` → `Cabin.CreateFarmhand`). The Mod then releases
// that slot (`CompanionCabinProvisioning` `UnlockedUnclaimedCabin`) and the Host offers the Cabin it freed.
// That is the path a player's first session walks, and it needs no free cabin pad at all.
//
// WHY NOT AN EMPTY CABIN INSTEAD. The world state that would need - a Cabin with no owner - is written by
// the game, and the only product seam that produces one is the Mod's own provisioning. A fixture that
// hand-wrote it into a save would be a second authority for the one fact a launch is measuring.
const {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");

/** The one file a prepared run root writes, so a second driver in the same run moves nothing twice. */
const MARKER = "prepared.json";

/** The file the product's own save index reads (`integrations/stardew/WorldSaveIndex.cs`). */
const SAVE_INFO = "SaveGameInfo";

/** The game's save folder, spelled once; the game resolves it from the user's own profile, not from a config. */
function savesFolder() {
  const appData = process.env.APPDATA;
  if (typeof appData !== "string" || appData.length === 0) return null;
  return path.join(appData, "StardewValley", "Saves");
}

/**
 * The world the product asked the Mod to create, read from the Player Host profile's own staged config.
 *
 * The name is the PRODUCT's, taken from the file the composer wrote (`WorldCreation` in the Mod's
 * `config.json`), so this helper holds no second copy of it. `null` when no bootstrap under this run's data
 * root has staged a world request yet.
 */
function stagedWorldRequest(declaredDataRoot) {
  if (typeof declaredDataRoot !== "string" || declaredDataRoot.length === 0) return null;
  const bootstrapRoot = path.join(declaredDataRoot, "stardew-private-bootstrap");
  let bootstraps;
  try {
    bootstraps = readdirSync(bootstrapRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const requests = [];
  for (const name of bootstraps) {
    const file = path.join(bootstrapRoot, name, "player-host", "Mods", "GameBuddy", "config.json");
    try {
      const request = JSON.parse(readFileSync(file, "utf8"))?.WorldCreation;
      if (request?.Enable !== true || typeof request.FarmName !== "string" || request.FarmName.length === 0) continue;
      requests.push({ file, farmName: request.FarmName, stagedAtMs: statSync(file).mtimeMs });
    } catch {
      /* this bootstrap has staged no readable profile */
    }
  }
  return requests.sort((left, right) => right.stagedAtMs - left.stagedAtMs)[0] ?? null;
}

/**
 * The farm name a save folder carries, or `unreadable`.
 *
 * An unreadable `SaveGameInfo` means the product's own index skips this folder as well
 * (`WorldSaveIndex.ReadAll` reports a slot whose identity cannot be read as unknown), so the folder is not
 * a world either of them can enter and this helper leaves it exactly where it is.
 */
function farmNameOf(directory) {
  try {
    const found = /<farmName>([^<]{0,64})<\/farmName>/u.exec(readFileSync(path.join(directory, SAVE_INFO), "utf8"));
    if (found !== null) return { farmName: found[1], unreadable: null };
    return { farmName: null, unreadable: "farm_name_absent" };
  } catch {
    return { farmName: null, unreadable: "save_info_unreadable" };
  }
}

/** Every save folder in the machine's save root, as `{ slot, directory }`. */
function saveSlots(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ slot: entry.name, directory: path.join(root, entry.name) }));
  } catch {
    return [];
  }
}

/**
 * Make this run the owner of every world the product asked for, and answer what was moved.
 *
 * `kind` is one of `moved` (this call prepared the run's world), `already_owned` (a driver earlier in the
 * same run prepared it) or `refused` (a named reason; nothing was moved and the run is not measuring what
 * it says it measures). The reading carries the population it examined, so an empty move prints
 * `examined N` beside it and a first run - where there is nothing to move yet - cannot be mistaken for a
 * helper that failed to look.
 */
function prepareOwnWorld({ declaredDataRoot, runRoot, policy = "own" }) {
  if (typeof runRoot !== "string" || runRoot.length === 0) return { kind: "refused", reason: "run_root_unknown" };
  const root = savesFolder();
  if (root === null) return { kind: "refused", reason: "appdata_absent" };
  const worldRoot = path.join(runRoot, "fixture-worlds");
  const markerFile = path.join(worldRoot, MARKER);
  if (existsSync(markerFile)) {
    try {
      return { kind: "already_owned", ...JSON.parse(readFileSync(markerFile, "utf8")) };
    } catch {
      return { kind: "refused", reason: "fixture_world_marker_unreadable", markerFile };
    }
  }
  const request = stagedWorldRequest(declaredDataRoot);
  if (request === null)
    return {
      kind: "refused",
      reason: "no_staged_world_request",
      detail: `no bootstrap under ${String(declaredDataRoot)} has staged a WorldCreation request, so this run's world name is unknown and nothing may be moved on a guess`,
      savesRoot: root,
      examined: saveSlots(root).length,
    };

  const slots = saveSlots(root);
  /*
   * `policy: "existing"` is the ordinary second session: the run enters the world the product already has,
   * standing on the operator's statement that it can host her (a Cabin unbound, or bound to this run's
   * companion). Nothing is moved, and a world that does not exist is a refusal rather than a silent creation -
   * a run that asked to measure a world an earlier run made must not create its own and call it the same thing.
   */
  if (policy === "existing") {
    const existing = slots
      .map(({ slot, directory }) => ({ slot, ...farmNameOf(directory) }))
      .filter((entry) => entry.farmName === request.farmName);
    if (existing.length === 0)
      return {
        kind: "refused",
        reason: "no_existing_world",
        detail: `this run was asked to enter the world the product already has ('${request.farmName}'), and no save of that name is in ${root}`,
        farmName: request.farmName,
        savesRoot: root,
        examined: slots.length,
      };
    return { kind: "kept", farmName: request.farmName, savesRoot: root, examined: slots.length, kept: existing.map(({ slot, farmName }) => ({ slot, farmName })) };
  }

  const moved = [];
  const kept = [];
  const unreadable = [];
  for (const { slot, directory } of slots) {
    const identity = farmNameOf(directory);
    if (identity.farmName === null) {
      unreadable.push({ slot, reason: identity.unreadable });
      continue;
    }
    if (identity.farmName !== request.farmName) {
      kept.push({ slot, farmName: identity.farmName });
      continue;
    }
    // Copy first, delete second, and verify the copy before deleting anything: the run root is on another
    // volume from the save folder on this machine, so a move is two steps and the order is what makes a
    // failure leave the save where it was.
    const target = path.join(worldRoot, slot);
    try {
      mkdirSync(worldRoot, { recursive: true });
      cpSync(directory, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    } catch (error) {
      return {
        kind: "refused",
        reason: `fixture_world_copy_failed:${String(error?.message ?? error).slice(0, 160)}`,
        farmName: request.farmName,
        source: directory,
        target,
        moved,
      };
    }
    if (!existsSync(path.join(target, SAVE_INFO)))
      return { kind: "refused", reason: "fixture_world_copy_incomplete", farmName: request.farmName, source: directory, target, moved };
    // A save the game still holds open cannot be deleted on Windows, and a world the game's own list can
    // still see is a world this run has NOT made its own - the check below is what names that, so a failed
    // delete leaves the copy in the run root and the source where it was.
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* read back below */
    }
    moved.push({ slot, movedTo: target });
  }

  const remaining = saveSlots(root)
    .map(({ slot, directory }) => ({ slot, ...farmNameOf(directory) }))
    .filter((entry) => entry.farmName === request.farmName);
  const reading = {
    farmName: request.farmName,
    requestFile: path.join(request.file),
    savesRoot: root,
    examined: slots.length,
    moved,
    kept,
    unreadable,
    remaining,
  };
  if (remaining.length > 0)
    return { kind: "refused", reason: "fixture_world_still_visible", ...reading };
  try {
    mkdirSync(worldRoot, { recursive: true });
    writeFileSync(markerFile, JSON.stringify({ ...reading, atMs: Date.now() }, null, 1), "utf8");
  } catch (error) {
    return { kind: "refused", reason: `fixture_world_marker_unwritable:${String(error?.message ?? error).slice(0, 160)}`, ...reading };
  }
  return { kind: "moved", ...reading };
}

/**
 * THE SAVE SLOT THIS RUN'S WORLD OCCUPIES, read from the save folder itself - the identity a SMAPI line can be
 * joined to.
 *
 * WHY NOT THE FARM NAME, which is what the driver used to claim. The product stages ONE world request carrying a
 * farm name (`WorldCreation.FarmName`, `integrations/stardew/WorldCreationBootstrap.cs:296`) and the game then
 * names the save FOLDER after it plus the unique id it mints when it writes the save (`SaveGame.cs:448`: the
 * filtered farm name, one underscore, digits - the rule `integrations/stardew/WorldCreationDecision.cs:145-151`
 * restates). SMAPI echoes that folder and only that folder: `Context: loaded save 'GameBuddyFarm_455317305'`.
 * The farm name therefore never equals the string a save line carries, and comparing the two made this run's own
 * save line ANOTHER RUN'S: measured 2026-11-26, `SMAPI-latest.txt` flipped to `contested` with
 * `this_run=1 other_run=1 unattributable=95`, the chain's rung 4 read `save loaded - not reached`, and the
 * reader's own reason line said so in as many words - "the SMAPI log names another game's save
 * (\"GameBuddyFarm_455317305\"), not this run's (\"GameBuddy Farm\")" (`D:\gb-runs\roundw-out\w-game-launch.txt`,
 * `.tmp/lane-roundw.md` §5.4).
 *
 * So the join is the SLOT, and it is not guessed from the name's shape: it is read from the save's own
 * `SaveGameInfo` `<farmName>` - the file the product's own save index reads (`integrations/stardew/
 * WorldSaveIndex.cs:49`) - and matched against the farm name this run's product staged. The farm name is display
 * text; the slot is the fact.
 *
 * RE-READ, NOT REMEMBERED. A world the game CREATES during this launch has no slot until the game has written one
 * (`prepareOwnWorld` moves the previous run's saves out of the way precisely so this happens), so the caller asks
 * again on every launch tick and claims what appeared. `claimed` is the caller's live list and is appended to in
 * place, so an identity learned once stays known for the rest of the run.
 *
 * The states are distinct on purpose: `absent` (no save folder on this machine), `unreadable` (a folder that
 * listed nothing - not "no world") and `unknown` (no farm name to look for) are three different answers, and none
 * of them is "this run owns nothing". `announce` puts that answer into `lines` on the caller's FIRST ask, so a
 * run whose slot cannot be read says so once instead of on every tick.
 */
function ownWorldSlots({ farmName, claimed = [], announce = false, savesRoot = savesFolder() }) {
  const notRead = (state, reason) => ({
    state,
    reason,
    examined: null,
    slots: [],
    added: [],
    unreadable: [],
    lines: announce
      ? [
          `rung4_join: the run's own save slot is unknown - ${reason}; a save line is joined to a SLOT, so nothing is claimed until one can be read`,
        ]
      : [],
    farmName: typeof farmName === "string" ? farmName : null,
    savesRoot: typeof savesRoot === "string" ? savesRoot : null,
  });
  if (typeof farmName !== "string" || farmName.length === 0)
    return notRead("unknown", "the product staged no farm name for this run, so no save folder can be bound to it");
  if (typeof savesRoot !== "string" || savesRoot.length === 0)
    return notRead("absent", "this machine has no APPDATA, so its save folder is unknown");
  if (!existsSync(savesRoot)) return notRead("absent", `${savesRoot} does not exist, so this run has written no save there`);
  const slots = saveSlots(savesRoot);
  if (slots.length === 0)
    return notRead("unreadable", `${savesRoot} listed no save folder, and a listing that examined nothing is not "no world here"`);

  const own = [];
  const unreadable = [];
  for (const { slot, directory } of slots) {
    const identity = farmNameOf(directory);
    if (identity.farmName === null) {
      unreadable.push({ slot, reason: identity.unreadable });
      continue;
    }
    if (identity.farmName === farmName) own.push(slot);
  }
  const added = own.filter((slot) => !claimed.includes(slot));
  // Appended in place: the caller's list is the one the log reader compares against on every refresh.
  for (const slot of added) claimed.push(slot);
  return {
    state: "read",
    reason: null,
    examined: slots.length,
    slots: own,
    added,
    unreadable,
    farmName,
    savesRoot,
    lines: added.map(
      (slot) =>
        `own_world_slot: '${slot}' is this run's world - the save's own SaveGameInfo names farm name '${farmName}', and \`Context: loaded save '<slot>'\` carries that folder name, never the farm name (${String(slots.length)} save folder(s) examined under ${savesRoot})`,
    ),
  };
}

/** One line for the run's log: what the run did about its world, and on what population. */
function describeOwnWorld(reading) {
  const kept = Array.isArray(reading?.kept) ? reading.kept.map((entry) => `${entry.slot}(${entry.farmName})`) : [];
  const moved = Array.isArray(reading?.moved) ? reading.moved.map((entry) => entry.slot) : [];
  const unreadable = Array.isArray(reading?.unreadable) ? reading.unreadable.map((entry) => `${entry.slot}(${entry.reason})`) : [];
  if (reading?.kind === "refused")
    return `FIXTURE WORLD NOT PREPARED: ${String(reading.reason)} — ${String(reading.detail ?? "")} (examined ${String(reading.examined ?? "nothing")} save folder(s) under ${String(reading.savesRoot ?? "no save root")})`;
  if (reading?.kind === "already_owned")
    return `the world this run creates was already claimed by an earlier driver in this run: '${String(reading.farmName)}' (moved ${String(moved.length)}: ${moved.join(", ") || "none"}; examined ${String(reading.examined ?? "?")})`;
  if (reading?.kind === "kept")
    return `this run enters the world the product already has: '${String(reading.farmName)}' in ${String(reading.savesRoot)} (${moved.join(", ") || "none"}; examined ${String(reading.examined)} save folder(s), nothing moved)`;
  return [
    `this run starts from its own world: '${String(reading.farmName)}'`,
    `${String(moved.length)} save(s) of that name moved into the run root (${moved.join(", ") || "none — nothing to move yet"})`,
    `${String(kept.length)} save(s) of other names kept where they are (${kept.join(", ") || "none"})`,
    unreadable.length === 0 ? "no save folder was unreadable" : `${String(unreadable.length)} unreadable and left alone (${unreadable.join(", ")})`,
    `examined ${String(reading.examined)} save folder(s) under ${String(reading.savesRoot)}`,
  ].join("; ");
}

module.exports = { prepareOwnWorld, describeOwnWorld, ownWorldSlots, savesFolder };
