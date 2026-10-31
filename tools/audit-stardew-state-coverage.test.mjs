// Regression gate for the engine state-coverage audit.
//
// The audit answers ONE question that a live run used to answer instead: for each state the engine
// can change under the Mod's feet, can the companion tell "this happened" from "nothing happened"?
// Its whole value is that the population is derived rather than listed, so a test that only asserts
// "no findings" would pass on an audit that had stopped looking. Every case below mutates one hop in
// an isolated copy of the files the audit reads and asserts the audit NAMES the state it broke.
//
// The synthetic engine tree matters for the same reason: the real one is gitignored, and a suite
// whose red cases only run where the game sources exist would be green on every checkout.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { auditStateCoverage, deriveEngineGuardStates, STATE_COVERAGE } from "./audit-stardew-state-coverage.mjs";
import { resolveStardewDecompileRoot } from "./lib/stardew-decompile-root.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The Mod files the audit reads, copied into an isolated root per case. */
const TRACKED = [
  "integrations/stardew/farmhandexecutioncontroller.cs",
  "integrations/stardew/farmhandexecutioncontroller.itemtileactions.cs",
  "integrations/stardew/WorldModel.cs",
  "integrations/stardew/SleepAndAdvanceDayLifecycle.cs",
  "integrations/stardew/Sensory/NpcDialoguePager.cs",
  "integrations/stardew/Sensory/StardewSalientEventHooks.cs",
];

const SNAPSHOT = "integrations/stardew/farmhandexecutioncontroller.cs";
const ITEM_TILE = "integrations/stardew/farmhandexecutioncontroller.itemtileactions.cs";

/**
 * A synthetic `Farmer.cs` holding the engine's own holding-state enumeration plus the declarations
 * the table cites. Shaped after the real file (`if (predicate) { return true; }` per state) so the
 * derivation is exercised the way the decompiled source exercises it.
 */
const SYNTHETIC_FARMER = [
  "namespace StardewValley",
  "{",
  "\tpublic class Farmer",
  "\t{",
  "\t\tpublic int health = 100;",
  "\t\tpublic bool passedOut;",
  "\t\tpublic int Money",
  "\t\t{",
  "\t\t\tget { return money; }",
  "\t\t}",
  "\t\tpublic NetObjectList<Item> itemsLostLastDeath = new NetObjectList<Item>();",
  "\t\tpublic virtual bool IsBusyDoingSomething()",
  "\t\t{",
  "\t\t\tif (Game1.eventUp)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (Game1.activeClickableMenu != null)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (UsingTool)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (freezePause > 0)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (!CanMove)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (FarmerSprite.PauseForSingleAnimation)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (usingSlingshot)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (Game1.fadeToBlack)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (Game1.currentMinigame != null)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (Game1.isWarping)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\tif (Game1.killScreen)",
  "\t\t\t{",
  "\t\t\t\treturn true;",
  "\t\t\t}",
  "\t\t\treturn false;",
  "\t\t}",
  "\t}",
  "}",
].join("\n");

const SYNTHETIC_ENGINE = Object.freeze({
  "StardewValley/Farmer.cs": SYNTHETIC_FARMER,
  "StardewValley/Character.cs": "\tpublic GameLocation currentLocation\n",
  "StardewValley/Game1.cs": [
    "public static bool killScreen;",
    "public static bool IsRainingHere(GameLocation location = null)",
    "public static WorldDate Date => netWorldState.Value.Date;",
  ].join("\n"),
});

const workspaces = [];
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function sandbox({ engine = SYNTHETIC_ENGINE } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "state-coverage-"));
  workspaces.push(dir);
  for (const relative of TRACKED) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(ROOT, relative), target);
  }
  const engineRoot = path.join(dir, "engine");
  writeEngine(engineRoot, engine);
  return {
    dir,
    audit: () => auditStateCoverage({ root: dir, decompileRoot: engineRoot }),
    writeEngine: (files) => writeEngine(engineRoot, files),
    read: (relative) => readFileSync(path.join(dir, relative), "utf8"),
    write: (relative, content) => writeFileSync(path.join(dir, relative), content),
    replace: (relative, from, to) => {
      const current = readFileSync(path.join(dir, relative), "utf8");
      assert.ok(current.includes(from), `the sandbox copy must contain the fragment being replaced: ${from}`);
      writeFileSync(path.join(dir, relative), current.replace(from, to));
    },
  };
}

function writeEngine(root, files) {
  rmSync(root, { recursive: true, force: true });
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

/** Every finding joined, so a case can assert on the state name and the code that names it. */
function findingsOf(report) {
  return report.findings.join("\n");
}

// -- the population is derived, and it derives something ---------------------------------------

test("the engine's own holding-state enumeration is the population, not a list", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "state-coverage-derive-"));
  workspaces.push(dir);
  writeEngine(dir, { "StardewValley/Farmer.cs": SYNTHETIC_FARMER });

  const states = deriveEngineGuardStates(dir).map((entry) => entry.state);
  assert.deepEqual(
    states,
    [
      "eventUp",
      "activeClickableMenu",
      "UsingTool",
      "freezePause",
      "CanMove",
      "PauseForSingleAnimation",
      "usingSlingshot",
      "fadeToBlack",
      "currentMinigame",
      "isWarping",
      "killScreen",
    ],
    "every `if` in IsBusyDoingSomething is one holding state, reduced to the member it tests",
  );
});

test("a guard that parses to nothing fails rather than reporting no gaps", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "state-coverage-empty-"));
  workspaces.push(dir);
  writeEngine(dir, { "StardewValley/Farmer.cs": "\tpublic virtual bool IsBusyDoingSomething()\n\t{\n\t}\n" });
  assert.throws(
    () => deriveEngineGuardStates(dir),
    /state_coverage_engine_guard_empty/u,
    "an empty population and a clean population must never look the same",
  );
});

test("a moved engine guard fails rather than scanning nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "state-coverage-moved-"));
  workspaces.push(dir);
  writeEngine(dir, { "StardewValley/Farmer.cs": "\tpublic class Farmer { }\n" });
  assert.throws(() => deriveEngineGuardStates(dir), /state_coverage_engine_guard_missing/u);
});

// -- red cases: one injected violation per check -----------------------------------------------

test("an engine state with no row is named", () => {
  const box = sandbox();
  box.writeEngine({
    ...SYNTHETIC_ENGINE,
    "StardewValley/Farmer.cs": SYNTHETIC_FARMER.replace(
      "\t\t\tif (usingSlingshot)",
      "\t\t\tif (Game1.isRafting)\n\t\t\t{\n\t\t\t\treturn true;\n\t\t\t}\n\t\t\tif (usingSlingshot)",
    ),
  });

  const findings = findingsOf(box.audit());
  assert.match(findings, /unclassified_engine_state: isRafting/u, "the new holding state is named");
  assert.match(findings, /no row in STATE_COVERAGE says whether the companion can see it/u);
});

test("a row whose engine state disappeared is named", () => {
  const box = sandbox();
  box.writeEngine({
    ...SYNTHETIC_ENGINE,
    "StardewValley/Farmer.cs": SYNTHETIC_FARMER.replace(
      "\t\t\tif (usingSlingshot)\n\t\t\t{\n\t\t\t\treturn true;\n\t\t\t}\n",
      "",
    ),
  });

  assert.match(findingsOf(box.audit()), /stale_coverage_row: usingSlingshot/u);
});

test("deleting a publication makes the observable row go blind, by name", () => {
  const box = sandbox();
  box.replace(SNAPSHOT, "player.health,", "0,");

  const findings = findingsOf(box.audit());
  assert.match(findings, /publication_missing: health/u, "the failure names the state, not a line number");
  assert.match(findings, /either the publication was removed \(the companion went blind\) or it moved/u);
});

test("publishing a blind state fails until the row admits it is visible", () => {
  const box = sandbox();
  box.replace(SNAPSHOT, "player.health,", "player.health, Game1.killScreen ? 1 : 0,");

  const findings = findingsOf(box.audit());
  assert.match(findings, /gap_closed_but_row_still_blind: killScreen/u);
  assert.match(findings, /now reaches the wire/u);
});

test("a drifted engine citation fails instead of trusting the row", () => {
  const box = sandbox();
  box.writeEngine({
    ...SYNTHETIC_ENGINE,
    "StardewValley/Farmer.cs": SYNTHETIC_FARMER.replace("public bool passedOut;", "public bool isFainted;"),
  });

  assert.match(findingsOf(box.audit()), /engine_anchor_drifted: passedOut/u);
});

test("a gap with no closing observation is a complaint, not a finding", () => {
  // The row is real in the sandbox; only its `closesWith` is empty. Re-running the audit with the
  // shipped table mutated in place would race other lanes, so the case reads the exported table and
  // asserts the contract every unobservable row must satisfy.
  for (const row of STATE_COVERAGE.filter((candidate) => !candidate.observable)) {
    assert.equal(typeof row.closesWith, "string", `${row.state} must name the smallest observation that closes it`);
    assert.ok(row.closesWith.length >= 20, `${row.state}'s closing observation must say something`);
  }
});

// -- the shipped table, against the real engine ------------------------------------------------

test("the shipped table is clean against a synthetic engine that holds exactly its states", () => {
  // A green case that always runs, so the red cases above are not the only thing exercising the
  // clean path: the synthetic tree declares every state the table claims, and nothing else.
  const report = sandbox().audit();
  assert.deepEqual(report.findings, [], "a table that agrees with the engine reports nothing");
  assert.ok(
    report.rows.length >= 18,
    `the derived population must stay at least the 11 guard states plus the declared ones, got ${report.rows.length}`,
  );
});

test("the shipped table is clean against the real decompiled engine", { skip: decompileAbsentReason() }, () => {
  // Skipped with a NAMED reason where `/ref/` is absent: a hosted checkout must not report this green.
  const report = auditStateCoverage({
    root: ROOT,
    decompileRoot: resolveStardewDecompileRoot({ repositoryRoot: ROOT }),
  });
  assert.deepEqual(report.findings, [], "the shipped table must agree with the shipped code");
});

test("the four states the defect class was found through are in the table", { skip: decompileAbsentReason() }, () => {
  const states = STATE_COVERAGE.map((row) => row.state);
  for (const required of ["killScreen", "passedOut", "activeClickableMenu", "eventUp", "currentLocation"]) {
    assert.ok(states.includes(required), `${required} must have a coverage row`);
  }

  // The four questions the brief asked, answered by the table rather than by prose:
  const byState = new Map(STATE_COVERAGE.map((row) => [row.state, row]));
  assert.equal(
    byState.get("killScreen").observable,
    false,
    "death: the death SEQUENCE is invisible (health alone is not)",
  );
  assert.equal(byState.get("passedOut").observable, false, "pass-out: the flag is invisible");
  assert.equal(
    byState.get("activeClickableMenu").observable,
    true,
    "a modal the Mod did not open: visible, with its owner",
  );
  assert.equal(byState.get("eventUp").observable, true, "a festival/event: visible");
  assert.equal(byState.get("currentLocation").observable, true, "a location change mid-execution: visible");
});

function decompileAbsentReason() {
  try {
    resolveStardewDecompileRoot({ repositoryRoot: ROOT });
    return false;
  } catch {
    return (
      "requires the decompiled Stardew source tree at ref/external/StardewValleyDecompiled/Stardew Valley " +
      "(gitignored; restore with ilspycmd: 9.1.0.7988)"
    );
  }
}

test("the item-tile pre-flight is the only reader of the warp and fade states", () => {
  // Pins WHERE the private reads are, which is what makes "read but not published" a different
  // verdict from "read nowhere": if a future lane publishes these, the sandbox case above goes red
  // and the rows flip. The file is named here so the table's `read` anchors cannot silently rot.
  const itemTile = readFileSync(path.join(ROOT, ITEM_TILE), "utf8");
  assert.ok(itemTile.includes("!Game1.fadeToBlack"), "use_warp_item's own pre-flight reads fadeToBlack");
  assert.ok(itemTile.includes("if (Game1.isWarping || player.freezePause > 0)"), "and it reads isWarping");
  const snapshot = readFileSync(path.join(ROOT, SNAPSHOT), "utf8");
  for (const state of ["Game1.fadeToBlack", "Game1.isWarping", "Game1.currentMinigame", "Game1.killScreen"]) {
    assert.equal(snapshot.includes(state), false, `${state} must not reach the snapshot until its row says so`);
  }
});
