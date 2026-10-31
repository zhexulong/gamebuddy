#!/usr/bin/env node
/**
 * State-coverage gate: the states the ENGINE changes under the Mod's feet, and whether the
 * companion can see them.
 *
 * THE DEFECT CLASS. `farmhandexecutioncontroller.cs` publishes `health` and nothing reacts to
 * `health <= 0`. When it goes negative the engine runs `Farmer.startDeathScene`'s sibling - the
 * faint at Farmer.cs:7657 - which warps to the clinic, charges money, destroys up to three random
 * pack slots (`Farmer.LoseItemsOnDeath`, Farmer.cs:3272-3295) and opens a `DialogueBox` that holds
 * dispatch. The Mod keeps accepting actions for a location the actor has left, the dialogue holds
 * `CanDispatchNow` false, and the companion stalls with no cause it can name. That is not one bug:
 * a modal opened, a settlement sheet stood, a tree became a stump, a crop died, a bubble was
 * refused - every one is "an external state change the Mod can neither observe nor report".
 *
 * WHAT IS DERIVED, AND FROM WHERE. The population is not a list here; it is read out of the
 * engine on every run:
 *
 *   1. `Farmer.IsBusyDoingSomething()` (Farmer.cs) is the ENGINE'S OWN enumeration of everything
 *      that holds the actor. Every predicate in that body becomes a state. The gate fails when a
 *      member appears there with no row, and when a row names a member that is no longer there -
 *      so a game-version bump cannot quietly widen the blind spot, and a row cannot outlive its
 *      engine fact.
 *   2. `ENGINE_STATES` below holds the states the guard does NOT name but the engine changes
 *      anyway: the faint/death path, the pass-out, a location change, weather, the date, and the
 *      two things death takes that the companion cannot see. Each carries an `engineAnchor` - the
 *      exact decompiled declaration - which must be present, so a state cannot be invented.
 *
 * HOW "OBSERVABLE" IS DECIDED, MECHANICALLY. A row is observable exactly when it has a `wired`
 * anchor: a fragment inside the wire-snapshot builder (`CreateBridgeSnapshot`) or inside a
 * `Sensory/*.cs` world-fact publisher. An unobservable row must have NO `wired` anchor and its
 * engine member must not appear in either place. So the table cannot drift from the code in
 * either direction: publish `Game1.fadeToBlack` and the row that says it is invisible goes red
 * until someone flips it and says what the companion now reads; delete the publication and the
 * observable row goes red. The failure names the STATE, not a line number.
 *
 * WHAT THIS GATE DOES NOT DO. It does not add a recovery workflow, a lifecycle or a state machine,
 * and it does not dismiss a menu on the companion's behalf: `76c51da4` and `541775c2` both
 * established that deciding FOR the companion is worse than reporting to it. A gap's deliverable
 * is a finding with evidence plus the smallest observation that would close it (`closesWith`).
 * Target-radar families (a stump, a dead crop) are a different population - the things the world
 * holds, not the states the actor is in - and are out of scope here.
 *
 * Usage:
 *   node tools/audit-stardew-state-coverage.mjs            # gate; exits 1 on any finding
 *   node tools/audit-stardew-state-coverage.mjs --table    # the coverage table as markdown
 *   node tools/audit-stardew-state-coverage.mjs --json     # machine-readable report
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStardewDecompileRoot } from "./lib/stardew-decompile-root.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MOD_DIR = "integrations/stardew";
const SNAPSHOT_FILE = `${MOD_DIR}/farmhandexecutioncontroller.cs`;
const SNAPSHOT_BUILDER = "public BridgeSnapshot CreateBridgeSnapshot(";
const WORLD_FACT_DIR = `${MOD_DIR}/Sensory`;

/** The engine's own enumeration of "something holds the actor", read on every run. */
const ENGINE_GUARD = { file: "StardewValley/Farmer.cs", declaration: "public virtual bool IsBusyDoingSomething()" };

/**
 * States the guard above does NOT enumerate, each with the decompiled declaration that proves the
 * member exists. `origin` says which engine path changes it and what that costs the companion.
 */
export const ENGINE_STATES = Object.freeze([
  {
    state: "health",
    member: "player.health",
    engineAnchor: { file: "StardewValley/Farmer.cs", fragment: "public int health = 100;" },
    origin:
      "the value the faint threshold reads (Farmer.cs:7657: `health <= 0 && !Game1.killScreen && timeOfDay < 2600`)",
  },
  {
    state: "passedOut",
    member: "player.passedOut",
    engineAnchor: { file: "StardewValley/Farmer.cs", fragment: "public bool passedOut;" },
    origin:
      "the pass-out night: set by Game1.PassOutNewDay (Game1.cs:10351) after performPassoutWarp (Farmer.cs:5866), consumed by Game1.NewDay (Game1.cs:10372-10380)",
  },
  {
    state: "currentLocation",
    member: "player.currentLocation",
    engineAnchor: { file: "StardewValley/Character.cs", fragment: "public GameLocation currentLocation" },
    origin:
      "the engine warps a walking player with no request from the Mod (Farmer.cs:8586 `isCollidingWithWarp` -> :8595 `warpFarmer`), and every death/pass-out path warps too",
  },
  {
    state: "weather",
    member: "Game1.IsRainingHere",
    engineAnchor: {
      file: "StardewValley/Game1.cs",
      fragment: "public static bool IsRainingHere(GameLocation location = null)",
    },
    origin:
      "the macro state that changes what the whole day permits; green rain is a rain SUBTYPE (GameLocation.cs:1439-1452)",
  },
  {
    state: "date",
    member: "Game1.Date",
    engineAnchor: {
      file: "StardewValley/Game1.cs",
      fragment: "public static WorldDate Date => netWorldState.Value.Date;",
    },
    origin: "the rollover that retires every time-of-day fact, every scheduled villager and every crop stage",
  },
  {
    state: "money",
    member: "player.Money",
    engineAnchor: { file: "StardewValley/Farmer.cs", fragment: "public int Money" },
    origin:
      "death charges it (Event.cs:227 MineDeath `player.Money = Math.Max(0, player.Money - val)`; Event.cs:240-241 HospitalDeath bills `min(1000, Money)`) with no request from the Mod",
  },
  {
    state: "itemsLostLastDeath",
    member: "itemsLostLastDeath",
    engineAnchor: {
      file: "StardewValley/Farmer.cs",
      fragment: "public NetObjectList<Item> itemsLostLastDeath = new NetObjectList<Item>();",
    },
    origin:
      "death destroys up to three random pack slots (Farmer.cs:3281-3293 `Items[num2] = null`), and the slot count does NOT change, so nothing the snapshot publishes moves",
  },
]);

/**
 * The coverage table. One row per derived state.
 *
 *   observable  true  -> `wired` names the publication and must exist inside it
 *               false -> `wired` is empty and `member` appears in neither publication surface
 *   wired       the fragment that puts the state on the wire
 *   read        where the Mod reads the state privately; proves the state is real, not that it is seen
 *   note        what a reader can and cannot conclude
 *   closesWith  the smallest observation that would close the gap (unobservable rows only)
 */
export const STATE_COVERAGE = Object.freeze([
  {
    state: "eventUp",
    observable: true,
    member: "Game1.eventUp",
    wired: [{ file: SNAPSHOT_FILE, fragment: "ActorDispositionKind: WorldModel.KindForWire(this.disposition.Kind)" }],
    read: [{ file: `${MOD_DIR}/WorldModel.cs`, fragment: "bool eventUp = Game1.eventUp;" }],
    note: "`actorDispositionKind=event`. It outranks every other kind in WorldModel.Classify, so a festival cannot be masked by the modal a festival opens.",
  },
  {
    state: "activeClickableMenu",
    observable: true,
    member: "Game1.activeClickableMenu",
    wired: [
      { file: SNAPSHOT_FILE, fragment: "ActorDispositionKind: WorldModel.KindForWire(this.disposition.Kind)" },
      {
        file: SNAPSHOT_FILE,
        fragment: "ActorDispositionDetail: this.disposition.ModalType ?? this.disposition.TransientKind",
      },
    ],
    read: [
      { file: `${MOD_DIR}/WorldModel.cs`, fragment: "string? menuType = Game1.activeClickableMenu?.GetType().Name;" },
    ],
    note: "`actorDispositionKind=modal` plus `actorDispositionDetail` naming the menu class, and `actorDispositionActionOwned` saying whether this Mod opened it. A settlement sheet the Mod never opened therefore reads as a modal the world owns.",
  },
  {
    state: "UsingTool",
    observable: true,
    member: "player.UsingTool",
    wired: [{ file: SNAPSHOT_FILE, fragment: "ActorDispositionKind: WorldModel.KindForWire(this.disposition.Kind)" }],
    read: [
      { file: `${MOD_DIR}/WorldModel.cs`, fragment: "player.UsingTool," },
      { file: `${MOD_DIR}/WorldModel.cs`, fragment: "if (facts.UsingTool || facts.ToolCharged)" },
    ],
    note: "`actorDispositionKind=transient`, detail `toolAnimation`. Bounded by WorldModel.TransientRetryWindowMs, the same number the refusal evidence publishes.",
  },
  {
    state: "freezePause",
    observable: true,
    member: "freezePause",
    wired: [{ file: SNAPSHOT_FILE, fragment: "ActorDispositionKind: WorldModel.KindForWire(this.disposition.Kind)" }],
    read: [
      { file: `${MOD_DIR}/WorldModel.cs`, fragment: "player.freezePause > 0," },
      {
        file: `${MOD_DIR}/WorldModel.cs`,
        fragment: 'return new ActorDisposition(ActorDispositionKind.Transient, null, false, "freezePause");',
      },
    ],
    note: "`actorDispositionKind=transient`, detail `freezePause`. The faint arms 7000 ms of it (Game1.cs:6461) and the death arms 8000 ms (Farmer.cs:7671), so the faint is visible as a freeze - but only as a freeze, never as a death.",
  },
  {
    state: "CanMove",
    observable: true,
    member: "player.CanMove",
    wired: [
      { file: SNAPSHOT_FILE, fragment: "player.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp," },
    ],
    read: [{ file: SNAPSHOT_FILE, fragment: "if (projected == LocalDispositionKind.Idle && !actor.CanMove)" }],
    note: "Reaches the wire ONLY as one conjunct of `actionable`, so the companion can tell that the body is held but not which state holds it: a knockback, a warp transition, a slingshot charge, a paused single animation and a genuine movement lock all produce `actionable=false` with `actorDispositionKind=idle`. The refusal path already names the anonymous case (`movement_lock`, WorldModel.DescribeBodyHold), the snapshot does not.",
    closesWith:
      "publish the `movement_lock` transient in `actorDispositionDetail` when Idle and !CanMove, which is the same value the refusal evidence already computes",
  },
  {
    state: "health",
    observable: true,
    member: "player.health",
    wired: [{ file: SNAPSHOT_FILE, fragment: "player.health," }],
    read: [],
    note: "`health` is a required snapshot field. The VALUE is observable; the death it is heading for is not - see `killScreen`. Nothing in the Mod branches on `health <= 0`, which is the measured defect this gate was built from.",
  },
  {
    state: "currentLocation",
    observable: true,
    member: "player.currentLocation",
    wired: [{ file: SNAPSHOT_FILE, fragment: 'player.currentLocation?.NameOrUniqueName ?? "unknown",' }],
    read: [
      { file: SNAPSHOT_FILE, fragment: '"move_location_changed"' },
      { file: SNAPSHOT_FILE, fragment: 'string reasonCode = !sameLocation ? "item_pickup_location_changed"' },
    ],
    note: "`location` is published every snapshot, and a plain move released by the engine's own warp settles with `move_location_changed` (NavigationWarpLifecycle -> InvalidateLocalMoveAfterLocationChange), so a reader can compare a fresh `location` against the location an in-flight execution captured. Travel and navigation keep ownership through their own postconditions instead.",
  },
  {
    state: "weather",
    observable: true,
    member: "Game1.IsRainingHere",
    wired: [{ file: SNAPSHOT_FILE, fragment: "Weather: ProjectWeather()," }],
    read: [{ file: SNAPSHOT_FILE, fragment: 'if (Game1.IsGreenRainingHere()) return "green_rain";' }],
    note: "`weather` is one stable token (green_rain | lightning | rain | snow | debris | sunny). It is projected from the WORLD flags (`Game1.isRaining` and siblings), not from `Game1.IsRainingHere()`, so a companion standing in the mine reads the valley's rain. That is a precision gap, not a blindness: rain vs sunny is distinguishable.",
    closesWith:
      "read `Game1.IsRainingHere(currentLocation)` for an indoor-aware token, if the difference matters to a task",
  },
  {
    state: "date",
    observable: true,
    member: "Game1.Date",
    wired: [
      { file: SNAPSHOT_FILE, fragment: "DayOfMonth: Game1.Date?.DayOfMonth ?? 0" },
      { file: `${WORLD_FACT_DIR}/StardewSalientEventHooks.cs`, fragment: '"day_started"' },
    ],
    read: [],
    note: "`dayOfMonth`/`seasonIndex`/`year` on every snapshot, plus a `day_started` world_fact carrying the total day. Both halves move on a rollover, so the reader can tell a new day from a stale one.",
  },
  {
    state: "fadeToBlack",
    observable: false,
    member: "Game1.fadeToBlack",
    wired: [],
    read: [{ file: `${MOD_DIR}/farmhandexecutioncontroller.itemtileactions.cs`, fragment: "!Game1.fadeToBlack" }],
    note: "Set by the engine around every warp and every night fade (Game1.cs:4226, :5683, :6169, :10038). While it is true `Farmer.IsBusyDoingSomething()` answers true, yet the snapshot reports `actorDispositionKind=idle` and, whenever `CanMove` is still true, `actionable=true` - an observation that is WRONG, not merely imprecise. The one reader is `use_warp_item`'s own pre-flight, which refuses itself; no consumer can see the state.",
    closesWith: "publish it as a transient kind (`fade`) in `actorDispositionDetail`",
  },
  {
    state: "currentMinigame",
    observable: false,
    member: "Game1.currentMinigame",
    wired: [],
    read: [],
    note: "A minigame (fishing, Journey of the Prairie King) owns the screen and the input; `IsBusyDoingSomething()` answers true for its whole duration. Nothing in the Mod reads it, so the companion is told `idle` and plots a farm route while the actor is inside an arcade cabinet.",
    closesWith: "publish it as a transient kind (`minigame`) in `actorDispositionDetail`",
  },
  {
    state: "isWarping",
    observable: false,
    member: "Game1.isWarping",
    wired: [],
    read: [
      {
        file: `${MOD_DIR}/farmhandexecutioncontroller.itemtileactions.cs`,
        fragment: "if (Game1.isWarping || player.freezePause > 0)",
      },
    ],
    note: "The transition between two locations. The snapshot cannot name it: during a warp the Mod reports `idle`, and `actionable` may be either value depending on the frame the observation landed on. A refusal that carries `freezePause` can be mistaken for the warp, and a warp that raised no freeze is invisible.",
    closesWith: "publish it as a transient kind (`warping`) in `actorDispositionDetail`",
  },
  {
    state: "killScreen",
    observable: false,
    member: "Game1.killScreen",
    wired: [],
    read: [],
    origin:
      "the DEATH SEQUENCE: armed by the faint at Farmer.cs:7657-7677, consumed by GameLocation.checkForEvents (GameLocation.cs:15548-15618), which starts the PlayerKilled event and resets health to 10",
    note: "THE MEASURED DEFECT. Armed at Farmer.cs:7657-7677 with `CanMove=false`, `freezePause=8000`, `dialogueUp=false`; consumed by `GameLocation.checkForEvents` (GameLocation.cs:15548), which warps to the clinic, runs `HospitalDeath`/`MineDeath` (money charged, up to three pack slots destroyed) and resets `health` to 10. The companion sees `health` and `transient/freezePause`, which is also what a 2-second tool swing looks like; it cannot see that it died, that it is about to be moved, or that it already paid.",
    closesWith: "publish `is_dead` (or the disposition detail `death`) as a fact, plus the money/items rows below",
  },
  {
    state: "PauseForSingleAnimation",
    observable: false,
    member: "FarmerSprite.PauseForSingleAnimation",
    wired: [],
    read: [],
    note: "A scripted sprite animation holds the actor (FarmerSprite.cs:320). It collapses into the same `idle` + `actionable=false` shape as every other anonymous movement lock, so it is indistinguishable from a knockback.",
    closesWith: "fold it into the `movement_lock` transient detail, which the refusal path already reports",
  },
  {
    state: "usingSlingshot",
    observable: false,
    member: "usingSlingshot",
    wired: [],
    read: [],
    note: "A slingshot charge holds the actor (Farmer.cs:714). Same collapse as above, and unlike a tool swing it is not bounded by the transient retry window, so a parked request waits on a state nothing named.",
    closesWith: "fold it into the `movement_lock` transient detail",
  },
  {
    state: "passedOut",
    observable: false,
    member: "player.passedOut",
    wired: [],
    read: [
      {
        file: `${MOD_DIR}/SleepAndAdvanceDayLifecycle.cs`,
        fragment: 'if (Game1.player.passedOut) { reason = "passed_out"; return false; }',
      },
    ],
    note: 'The night lifecycle reads the flag to yield to the engine, and its evidence string names `passed_out` - but that reaches the lifecycle\'s own log, never the snapshot. In multiplayer the flag arrives with a `ReadyCheckDialog("sleep")`, which IS visible as a modal, and it is indistinguishable there from a sleep the player chose. In single player `PassOutNewDay` calls `NewDay` directly and never sets the flag at all.',
    closesWith: "publish `is_passed_out` as a snapshot fact beside `health`",
  },
  {
    state: "money",
    observable: false,
    member: "player.Money",
    wired: [],
    read: [],
    note: "`Farmer.Money` is never in the snapshot. Death bills it (Event.cs:240-241 up to 1000g, Event.cs:221-227 a luck-scaled slice for a mine death) with no request from the Mod, so the companion can spend against a balance it cannot read and never learns it was charged. Money only ever appears inside individual receipts (`money_before`/`money_after` on a purchase), which is a fact about an action, not about the world.",
    closesWith: "publish `money` as a snapshot field",
  },
  {
    state: "itemsLostLastDeath",
    observable: false,
    member: "itemsLostLastDeath",
    wired: [],
    read: [],
    note: "`LoseItemsOnDeath` (Farmer.cs:3272-3295) nils up to three random pack slots and records them here. `inventorySlots` counts `Items.Count`, which does NOT change when a slot is set to null, and `inventoryItemFacts` is published only for a few action families - so a death can take three items and move nothing the snapshot publishes.",
    closesWith:
      "publish the lost-item identities (or a bounded `items_lost_last_death` fact) and make `inventorySlots` count occupied slots",
  },
]);

// ---------------------------------------------------------------------------------------------
// Source reading

/** The body of one member, from its declaration to the matching close brace. */
function memberBody(source, declaration) {
  const at = source.indexOf(declaration);
  if (at < 0) return null;
  let depth = 0;
  let started = false;
  for (let index = source.indexOf("{", at); index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      started = true;
    } else if (character === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(at, index + 1);
    }
  }
  return null;
}

/** The line number of a fragment inside a source text, for the report's provenance column. */
function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * The engine's own list of everything that holds the actor, as engine member names.
 *
 * Every `if (<predicate>)` in `IsBusyDoingSomething()` is one holding state. The predicate is
 * reduced to the MEMBER it tests - `Game1.activeClickableMenu != null`, `freezePause > 0` and
 * `!CanMove` all name a member - so the derivation cannot be satisfied by rewording a condition.
 */
export function deriveEngineGuardStates(decompileRoot) {
  const source = readFileSync(path.join(decompileRoot, ENGINE_GUARD.file), "utf8");
  const body = memberBody(source, ENGINE_GUARD.declaration);
  if (body === null) {
    throw new Error(
      `state_coverage_engine_guard_missing: ${ENGINE_GUARD.file} no longer declares ` +
        `\`${ENGINE_GUARD.declaration}\` - the engine moved its own list of holding states, so this ` +
        "gate's population must be re-derived before it can say anything",
    );
  }

  const states = [];
  const bodyAt = source.indexOf(body);
  for (const match of body.matchAll(/if \(([^)]+)\)/g)) {
    const predicate = match[1].trim();
    const member = predicate
      .replace(/^!/, "")
      .replace(/ != null$/, "")
      .replace(/ > 0$/, "")
      .replace(/ != 0$/, "")
      .trim();
    states.push({
      state: member
        .replace(/^Game1\./, "")
        .replace(/^FarmerSprite\./, "")
        .replace(/^this\./, ""),
      member,
      line: lineAt(source, bodyAt + match.index),
    });
  }
  if (states.length === 0) {
    throw new Error(
      `state_coverage_engine_guard_empty: ${ENGINE_GUARD.declaration} parsed to zero predicates - a ` +
        "derivation that finds nothing must never report 'no gaps'",
    );
  }
  return states;
}

// ---------------------------------------------------------------------------------------------
// The gate

/**
 * Audit the table against the code. Returns `{ rows, findings }`; a finding names its STATE.
 *
 * The three checks, in the order they are worth reading:
 *   1. population - every state the engine names has a row, and every row names a state the engine
 *      still has (drift in both directions);
 *   2. observable rows are published where the table says they are;
 *   3. unobservable rows are published nowhere, so closing a gap fails the gate until the table
 *      agrees that it was closed.
 */
export function auditStateCoverage({ root = ROOT, decompileRoot } = {}) {
  const engineRoot = decompileRoot ?? resolveStardewDecompileRoot({ repositoryRoot: root });
  const surface = readPublicationSurface(root);
  const findings = [];
  const rows = classifyRows(deriveEngineGuardStates(engineRoot), findings);

  const engine = engineReader(engineRoot);
  for (const classified of rows) {
    checkEngineAnchor(classified, engine, findings);
    if (classified.row.observable) checkObservable(classified.row, surface, findings);
    else checkStillBlind(classified.row, surface, root, findings);
  }

  return { rows: rows.map(describeRow), findings };
}

/**
 * The two publication surfaces a state can reach: the wire snapshot builder's body, and the
 * `Sensory/*.cs` world-fact publishers. Read once per audit so every verdict reads the same text.
 */
function readPublicationSurface(root) {
  const snapshot = readFileSync(path.join(root, SNAPSHOT_FILE), "utf8");
  const body = memberBody(snapshot, SNAPSHOT_BUILDER);
  if (body === null) {
    throw new Error(
      `state_coverage_snapshot_builder_missing: ${SNAPSHOT_FILE} does not declare \`${SNAPSHOT_BUILDER}\` - ` +
        "the publication surface this gate reads is the wire snapshot builder, and it cannot be guessed",
    );
  }
  const facts = ["NpcDialoguePager.cs", "StardewSalientEventHooks.cs"].map((name) =>
    readFileSync(path.join(root, WORLD_FACT_DIR, name), "utf8"),
  );
  const inSnapshot = (fragment) => body.includes(fragment);
  const inWorldFact = (fragment) => facts.some((text) => text.includes(fragment));
  return { inSnapshot, inWorldFact, publishedAnywhere: (fragment) => inSnapshot(fragment) || inWorldFact(fragment) };
}

/**
 * The population check, in both directions: a state the engine holds with no row is a blind spot, and
 * a row whose state the engine no longer holds is a stale claim. Rows that survive are returned.
 */
function classifyRows(guardStates, findings) {
  const derived = new Map(guardStates.map((guard) => [guard.state, guard]));
  for (const guard of guardStates) {
    if (STATE_COVERAGE.some((row) => row.state === guard.state)) continue;
    findings.push(
      `unclassified_engine_state: ${guard.state} (Farmer.cs:${guard.line}, \`${guard.member}\`) holds the actor ` +
        "and no row in STATE_COVERAGE says whether the companion can see it - add a row with an observable " +
        "verdict and the evidence for it",
    );
  }

  const rows = [];
  for (const row of STATE_COVERAGE) {
    const guard = derived.get(row.state);
    const engineState = ENGINE_STATES.find((candidate) => candidate.state === row.state);
    if (guard !== undefined && engineState !== undefined) {
      findings.push(
        `ambiguous_coverage_row: ${row.state} is both guard-derived and declared in ENGINE_STATES - one state, ` +
          "one origin",
      );
    } else if (guard === undefined && engineState === undefined) {
      findings.push(
        `stale_coverage_row: ${row.state} has a row but is neither in Farmer.IsBusyDoingSomething() nor in ` +
          "ENGINE_STATES - the engine no longer changes this state, or the row's spelling drifted",
      );
    } else {
      rows.push({ row, guard, engineState });
    }
  }

  for (const engineState of ENGINE_STATES) {
    if (STATE_COVERAGE.some((row) => row.state === engineState.state)) continue;
    findings.push(`stale_engine_state: ${engineState.state} is declared in ENGINE_STATES with no coverage row`);
  }

  return rows;
}

/** A cached reader for the decompiled tree, so one file is read once per audit. */
function engineReader(engineRoot) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) cache.set(file, readFileSync(path.join(engineRoot, file), "utf8"));
    return cache.get(file);
  };
}

/** A declared non-guard state cites its own engine declaration; that citation must still resolve. */
function checkEngineAnchor({ row, engineState }, engine, findings) {
  const anchor = engineState?.engineAnchor;
  if (anchor === undefined) return;
  let text;
  try {
    text = engine(anchor.file);
  } catch {
    findings.push(`engine_anchor_unreadable: ${row.state} cites ${anchor.file}, which is not in the decompiled tree`);
    return;
  }
  if (text.includes(anchor.fragment)) return;
  findings.push(
    `engine_anchor_drifted: ${row.state} cites \`${anchor.fragment}\` in ${anchor.file}, which no longer ` +
      "contains it - re-derive the state against the target version instead of trusting this row",
  );
}

/** An observable row must be published exactly where it says it is. */
function checkObservable(row, surface, findings) {
  if (row.wired.length === 0) {
    findings.push(`observable_without_publication: ${row.state} is marked observable but names no wire anchor`);
    return;
  }
  for (const anchor of row.wired) {
    const readable =
      anchor.file === SNAPSHOT_FILE ? surface.inSnapshot(anchor.fragment) : surface.inWorldFact(anchor.fragment);
    if (readable) continue;
    const where = anchor.file === SNAPSHOT_FILE ? `${SNAPSHOT_BUILDER}'s body` : `${WORLD_FACT_DIR}/*`;
    findings.push(
      `publication_missing: ${row.state} is marked observable but \`${anchor.fragment}\` is not in ${where} - ` +
        "either the publication was removed (the companion went blind) or it moved",
    );
  }
}

/**
 * A blind row must stay blind: nothing may reach the wire, its private readers must still exist, and
 * it must name the observation that would close it.
 */
function checkStillBlind(row, surface, root, findings) {
  if (row.wired.length > 0) {
    findings.push(
      `unobservable_row_claims_a_publication: ${row.state} is marked unobservable but names a wire anchor - ` +
        "flip the verdict and say what the companion now reads, or delete the anchor",
    );
  }
  if (surface.publishedAnywhere(row.member)) {
    findings.push(
      `gap_closed_but_row_still_blind: ${row.state} (\`${row.member}\`) now reaches the wire, but its row still ` +
        "says the companion cannot see it - flip `observable` and record the publication",
    );
  }
  for (const reader of row.read) {
    let text;
    try {
      text = readFileSync(path.join(root, reader.file), "utf8");
    } catch {
      findings.push(`private_reader_missing: ${row.state} cites ${reader.file}, which does not exist`);
      continue;
    }
    if (text.includes(reader.fragment)) continue;
    findings.push(
      `private_reader_drifted: ${row.state} cites \`${reader.fragment}\` in ${reader.file}, which no longer ` +
        "contains it",
    );
  }
  if (typeof row.closesWith === "string" && row.closesWith.length >= 20) return;
  findings.push(
    `gap_without_a_closing_observation: ${row.state} is unobservable but does not say the smallest observation ` +
      "that would close it - a finding with no next step is a complaint",
  );
}

/** One report row: where the state comes from, whether it is visible, and the line that proves it. */
function describeRow({ row, guard, engineState }) {
  const origin =
    guard === undefined
      ? `ENGINE_STATES (${engineState.origin})`
      : `Farmer.IsBusyDoingSomething (Farmer.cs:${guard.line}, \`${guard.member}\`)`;
  return {
    state: row.state,
    origin,
    observable: row.observable,
    evidence: describeEvidence(row),
    note: row.note,
    closesWith: row.closesWith ?? null,
  };
}

function describeEvidence(row) {
  const format = (entry) => `${entry.file}: \`${entry.fragment}\``;
  if (row.wired.length > 0) return row.wired.map(format).join(" + ");
  if (row.read.length > 0) return `read only, never published: ${row.read.map(format).join(" ; ")}`;
  return "read nowhere";
}

// ---------------------------------------------------------------------------------------------
// Report

function table(report) {
  const lines = ["| # | state | where it comes from | observable | evidence |", "| --- | --- | --- | --- | --- |"];
  report.rows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | \`${row.state}\` | ${row.origin} | ${row.observable ? "**yes**" : "**NO**"} | ${row.evidence} |`,
    );
  });

  const gaps = report.rows.filter((row) => !row.observable);
  if (gaps.length > 0) {
    lines.push("", "### Gaps, and the smallest observation that closes each", "");
    for (const gap of gaps) {
      lines.push(`- **\`${gap.state}\`** - ${gap.note}`, `  - closes with: ${gap.closesWith}`);
    }
  }
  return lines.join("\n");
}

function main(argv) {
  const asJson = argv.includes("--json");
  const asTable = argv.includes("--table");
  const report = auditStateCoverage();

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (asTable) {
    process.stdout.write(`${table(report)}\n`);
  } else {
    const observable = report.rows.filter((row) => row.observable).length;
    process.stdout.write(
      `state_coverage: ${report.rows.length} derived engine states, ${observable} observable, ` +
        `${report.rows.length - observable} blind\n`,
    );
    if (report.findings.length === 0) {
      process.stdout.write("state_coverage: clean\n");
    } else {
      process.stdout.write(`state_coverage: ${report.findings.length} finding(s)\n`);
      for (const finding of report.findings) process.stdout.write(`  ${finding}\n`);
    }
    process.stdout.write("state_coverage: the table is `node tools/audit-stardew-state-coverage.mjs --table`\n");
  }

  if (report.findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2));
}
