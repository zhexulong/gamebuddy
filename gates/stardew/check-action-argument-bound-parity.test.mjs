/**
 * The falsifier for `check-action-argument-bound-parity.mjs`: every case turns the gate red on purpose.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The Host used to learn a whole-number argument's range by PROBING its own wire
 * predicate, and the probe answered `0..1000` for `x`/`y` while the Mod's declaration said `-1..1000` for the two
 * actions that address a warp SOURCE tile. `-1` is the only tile an edge exit names, so the invented floor refused the
 * one coordinate the action exists for. Nothing compared a hand-written constant with its declaration, which is why the
 * gate is a static comparison of the two populations and not a behaviour probe: a bound that disagrees is visible before
 * anything mounts.
 *
 * THE THREE REDS, and they are the three codes:
 *
 *   history  the tree the fix replaced (`8264f967^`), where the shared constants were `Type.Integer(intervalAcceptedBy(…))`
 *            derived at run time - nothing could READ the floor that refused the edge exit, so the gate names the members
 *            `argument_bound_unreadable:travel.x:TILE_COORDINATE_SCHEMA` and exits 1.
 *   inject   `travel`/`enter_exit` switched back to the walk-target constant in an otherwise green tree ->
 *            `argument_bound_disagrees_with_its_declaration:travel.x:declared=-1..1000:written=0..1000`, the exact
 *            round99 defect.
 *   inject   `move_to_tile`'s `x` declared with no ceiling while the schema still states `maximum: 1000` ->
 *            `argument_bound_written_without_a_declaration:move_to_tile.x`: a second authority, which is the class that
 *            needs no disagreement to be wrong.
 *
 * red-proof: history `git show 8264f967^:host/src/game-tools.ts` (with that revision's own `protocol-target-facts.ts` and
 *            `action-surface.v1.json`) -> 139 `argument_bound_unreadable` findings naming
 *            `travel.x:TILE_COORDINATE_SCHEMA`, exit 1 (gates/stardew/check-action-argument-bound-parity.test.mjs)
 * red-proof: inject  `WARP_SOURCE_COORDINATE_SCHEMA` replaced by `TILE_COORDINATE_SCHEMA` on travel's and enter_exit's
 *            x/y -> `argument_bound_disagrees_with_its_declaration:travel.x:declared=-1..1000:written=0..1000`, exit 1
 *            (gates/stardew/check-action-argument-bound-parity.test.mjs)
 * red-proof: inject  `maximum` deleted from `move_to_tile.x` in the declaration ->
 *            `argument_bound_written_without_a_declaration:move_to_tile.x`, exit 1
 *            (gates/stardew/check-action-argument-bound-parity.test.mjs)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkArgumentBoundParity,
  declaredArgumentBounds,
  GAME_TOOLS_PATH,
  SURFACE_PATH,
  TARGET_FACTS_PATH,
  writtenArgumentBounds,
} from "./check-action-argument-bound-parity.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SURFACE_TEXT = readFileSync(resolve(REPOSITORY_ROOT, SURFACE_PATH), "utf8");
const TOOLS_TEXT = readFileSync(resolve(REPOSITORY_ROOT, GAME_TOOLS_PATH), "utf8");
const FACTS_TEXT = readFileSync(resolve(REPOSITORY_ROOT, TARGET_FACTS_PATH), "utf8");

function reading({ surface = JSON.parse(SURFACE_TEXT), tools = TOOLS_TEXT, facts = FACTS_TEXT } = {}) {
  return checkArgumentBoundParity({ surface, tools, facts });
}

/** A revision's own copy of a path, or `null` when this clone does not carry that revision. */
function fromRevision(revision, path) {
  try {
    return execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const codes = (report) => report.findings.map((finding) => finding.code);
const named = (report, code, argument) =>
  report.findings.some((finding) => finding.code === code && finding.argument === argument);

test("the committed tree's hand-written bounds are the ones the Mod declares", () => {
  const report = reading();
  assert.deepEqual(report.findings, [], "a hand-written schema constant must be the declaration's own number");
  assert.equal(report.status, "passed");
  assert.ok(
    report.examined > 150,
    `blocked: ${report.examined} arguments were examined, so one of the two populations is short`,
  );
  // The four buckets and the unreadable count are a partition of the examined set, so a population that stopped being
  // read shows up here rather than as a smaller set that agrees with itself.
  assert.equal(
    report.examined,
    report.agreed + report.declaredOnly + report.handWrittenOnly + report.disagreeing + report.unreadable,
    "agreed + declared-only + hand-written-only + disagreeing + unreadable must be the examined set",
  );
});

test("the one tile an edge exit names is compared, not skipped", () => {
  const report = reading();
  const travel = report.rows.find((row) => row.argument === "travel.x");
  assert.ok(travel !== undefined, "travel.x must be in the hand-written population: it is the defect this gate is for");
  assert.equal(travel.declared, "-1..1000");
  assert.equal(travel.written, "-1..1000");
  // A row the declaration bounds and no hand-written schema states is reported with its name rather than dropped: the
  // descriptor-derived mounts read the declaration directly, which is the correct number and no hand-written statement.
  assert.ok(report.declaredOnlyMembers.includes("till_soil.charge"));
});

test("the tree the fix replaced cannot read its own bounds, and the gate names the members", (t) => {
  // Each side names its own revision, because no single revision carries both facts: `8264f967^` is the source the fix
  // replaced (its constants were derived by probing `isTileCoordinate`/`isToolSlot` at run time), and the declaration
  // that names `-1` is what `8264f967` published. The unreadable code does not consult the declaration at all, so the
  // mix cannot manufacture the finding - it prints the source's own constant name.
  const tools = fromRevision("8264f967^", GAME_TOOLS_PATH);
  const facts = fromRevision("8264f967^", TARGET_FACTS_PATH);
  if (tools === null || facts === null) {
    t.skip("the pre-fix revision is not in this clone");
    return;
  }
  const report = reading({ tools, facts });
  assert.equal(report.status, "failed");
  assert.ok(
    named(report, "argument_bound_unreadable", "travel.x"),
    `the constant that refused the edge exit must be named: ${codes(report).join(", ")}`,
  );
  assert.ok(report.findings.every((finding) => finding.code === "argument_bound_unreadable"));
});

test("a warp source written with the walk target's floor is the round99 defect, named with both ranges", () => {
  // The exact shape: the two transition actions take a tile one outside the map, and the walk-target constant says 0.
  // Only the MEMBERS are switched - the constants' own declarations stay, or the injection would restate one constant
  // and every tile argument in the file would move with it.
  let switched = TOOLS_TEXT;
  for (const member of ["x", "y"])
    switched = switched.replaceAll(`${member}: WARP_SOURCE_COORDINATE_SCHEMA`, `${member}: TILE_COORDINATE_SCHEMA`);
  assert.notEqual(switched, TOOLS_TEXT, "blocked: the injection matched nothing, so the fixture proves nothing");
  const report = reading({ tools: switched });
  assert.equal(report.status, "failed");
  for (const argument of ["travel.x", "travel.y", "enter_exit.x", "enter_exit.y"])
    assert.ok(
      named(report, "argument_bound_disagrees_with_its_declaration", argument),
      `${argument} must be named: ${JSON.stringify(report.findings)}`,
    );
  const travelX = report.findings.find((finding) => finding.argument === "travel.x");
  assert.equal(travelX.id, "argument_bound_disagrees_with_its_declaration:travel.x:declared=-1..1000:written=0..1000");
  assert.equal(report.disagreeing, 4);
});

test("a bound the declaration does not state is a second authority even when it happens to agree", () => {
  const surface = JSON.parse(SURFACE_TEXT);
  const moveToTile = surface.actions.find((action) => action.actionId === "move_to_tile");
  assert.ok(moveToTile !== undefined, "blocked: move_to_tile is not in the declaration");
  delete moveToTile.argumentSchema.x.maximum;
  assert.deepEqual(moveToTile.argumentSchema.x, { type: "integer", minimum: 0 }, "blocked: the fixture did not change");
  const report = reading({ surface });
  assert.equal(report.status, "failed");
  assert.ok(named(report, "argument_bound_written_without_a_declaration", "move_to_tile.x"));
  assert.equal(report.handWrittenOnly, 1);
});

test("an argument with no whole-number range on either side is in neither population", () => {
  const bounds = declaredArgumentBounds(JSON.parse(SURFACE_TEXT));
  // A closed set and a free string are not ranges: they carry `enum` / `minLength`, which a coordinate comparison would
  // read as an absent end and then a missing declaration.
  assert.equal(bounds.has("equip_tool.tool"), false);
  assert.equal(bounds.has("send_multiplayer_chat.text"), false);
  assert.equal(bounds.has("plant_seed.x"), true);
});

test("a reading that lost one of its two sides is BLOCKED, never a pass over the other one", () => {
  const emptyDeclaration = reading({ surface: { schema: "gamebuddy-action-descriptors/v1", actions: [] } });
  assert.equal(emptyDeclaration.status, "blocked");

  const noSchemas = reading({ tools: "export const nothing = 1;\n", facts: FACTS_TEXT });
  assert.equal(noSchemas.status, "blocked");

  // And a member this reader cannot resolve is a finding rather than a silent pass, on the real source with its one
  // tile constant made unreadable - which is exactly the shape the pre-fix code had everywhere.
  const opaque = writtenArgumentBounds({
    tools: TOOLS_TEXT.replace(
      /const TILE_COORDINATE_SCHEMA = Type\.Integer\(\{[\s\S]*?\}\);/u,
      "const TILE_COORDINATE_SCHEMA = Type.Integer(intervalAcceptedBy(isTileCoordinate));",
    ),
    facts: FACTS_TEXT,
  });
  assert.ok(
    opaque.unreadable.some((member) => member.action === "move_to_tile" && member.argument === "x"),
    "a computed range must be reported as unreadable, not dropped",
  );
});
