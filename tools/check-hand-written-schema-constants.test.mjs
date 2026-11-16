import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditHandWrittenSchemaConstants, statusOf } from "./check-hand-written-schema-constants.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "host/src/game-tools.ts";
const HEAD_SOURCE = readFileSync(join(REPOSITORY_ROOT, SOURCE), "utf8");

/** A throwaway root carrying one `host/src/game-tools.ts`, so a fixture can be a file and never a live edit. */
function fixtureRoot(source) {
  const root = mkdtempSync(join(tmpdir(), "schema-constants-"));
  mkdirSync(join(root, "host", "src"), { recursive: true });
  writeFileSync(join(root, SOURCE), source, "utf8");
  return root;
}

function readingOf(source) {
  const root = fixtureRoot(source);
  try {
    return auditHandWrittenSchemaConstants({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectedReading() {
  return auditHandWrittenSchemaConstants({ root: REPOSITORY_ROOT });
}

/**
 * The real defect, replayed: the commit this gate was written against, before the fix. `git show` is the authority for
 * what shipped, not a hand-copied excerpt - and the count is asserted as a floor, because the point is that the gate
 * SAW the repetition, not that the repetition had exactly N members on one afternoon.
 */
test("the tree before the fix is red, and the finding names the action and the member", (t) => {
  let before;
  try {
    before = execFileSync("git", ["show", "9adf97b5:host/src/game-tools.ts"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    t.skip("the pre-fix revision is not in this clone");
    return;
  }
  const reading = readingOf(before);
  assert.equal(statusOf(reading), "failed");
  assert.ok(reading.restated > 250, `the pasted bounds were seen (restated ${reading.restated})`);
  assert.ok(reading.examined > reading.restated, "the population is larger than its defects");
  const findings = new Set(reading.findings);
  for (const expected of [
    "hand_written_schema_restates_a_constant:move_to_tile:x",
    "hand_written_schema_restates_a_constant:move_to_tile:y",
    "hand_written_schema_restates_a_constant:chest_store:chestId",
    "hand_written_schema_restates_a_constant:till_soil:idempotencyKey",
    "shared_constant_missing:TILE_COORDINATE_SCHEMA",
    "shared_constant_missing:OPAQUE_ID_SCHEMA",
  ])
    assert.ok(findings.has(expected), `${expected} was reported: ${[...findings].slice(0, 5).join(", ")}`);
});

test("the committed tree declares every shared bound exactly once and restates none", () => {
  const reading = expectedReading();
  assert.equal(statusOf(reading), "passed", reading.findings.join("\n"));
  assert.equal(reading.restated, 0);
  assert.ok(reading.fromConstant > 300, `the constants carry the surface (${reading.fromConstant} members)`);
  assert.deepEqual(reading.missing, []);
  assert.deepEqual(reading.unused, []);
  assert.deepEqual(reading.staleOverrides, []);
});

/**
 * The falsifier, in the shape the defect actually arrives: someone writes the bound out again instead of naming it.
 * One injected paste must be one finding, and the fixture must be otherwise green so the finding cannot be inherited.
 */
test("a pasted bound is red even though every constant is still declared and used", () => {
  const injected = HEAD_SOURCE.replace(
    "x: TILE_COORDINATE_SCHEMA,\n          y: TILE_COORDINATE_SCHEMA,",
    "x: Type.Integer({ minimum: 0, maximum: 1000 }),\n          y: TILE_COORDINATE_SCHEMA,",
  );
  assert.notEqual(injected, HEAD_SOURCE, "the fixture injection matched");
  const reading = readingOf(injected);
  assert.deepEqual(
    reading.findings.filter((finding) => finding.startsWith("hand_written_schema_restates_a_constant:")),
    ["hand_written_schema_restates_a_constant:move_to_tile:x"],
  );
});

/** The second way a bound is restated: the constant's own expression copied under a member name no domain owns. */
test("a shared constant's expression pasted under another name is red", () => {
  const injected = HEAD_SOURCE.replace(
    "expectedTargetId: OPAQUE_ID_SCHEMA,",
    "expectedTargetId: OPAQUE_ID_SCHEMA,\n          targetRef: Type.String(opaqueIdShape()),",
  );
  assert.notEqual(injected, HEAD_SOURCE, "the fixture injection matched");
  const reading = readingOf(injected);
  assert.deepEqual(
    reading.findings.filter((finding) => finding.startsWith("hand_written_schema_restates_a_constant:")),
    ["hand_written_schema_restates_a_constant:interact_npc_with_item:targetRef"],
  );
});

/** An exemption that outlives its member is an excuse, so the declaration expires. */
test("an action-local declaration whose member is gone fails the gate", () => {
  const injected = HEAD_SOURCE.replace(
    "choice: literalUnionSchema(vocabulary.map((value) => Type.Literal(value))),",
    "",
  );
  assert.notEqual(injected, HEAD_SOURCE, "the fixture injection matched");
  const reading = readingOf(injected);
  assert.ok(
    reading.findings.includes("action_local_override_no_longer_written:respond_level_up:choice"),
    reading.findings.join("\n"),
  );
});

/** A read that found nothing must not pass: it has lost its reader, not removed the class. */
test("a source with no action schema is blocked rather than green", () => {
  const reading = readingOf("export const nothing = 1;\n");
  assert.equal(reading.examined, 0);
  assert.equal(statusOf(reading), "blocked");
});
