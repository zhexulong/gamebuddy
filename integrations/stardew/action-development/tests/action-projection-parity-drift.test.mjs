import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTION_SURFACE_OPTIONAL_ACTION_KEYS,
  parseActionSurface,
} from "../src/action-surface.mjs";
import {
  STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS,
} from "../src/static-projection/action-descriptor-snapshot.mjs";
import {
  PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS,
  PROJECTION_PARITY_GUARD_ORDER,
  PROJECTION_PARITY_MAX_JSON_BYTES,
  validateActionProjectionParity,
} from "../src/static-projection/action-projection-parity.mjs";
import {
  PROJECTION_PARITY_SNAPSHOT_RELATIVE_PATH,
  produceProjectionParitySnapshot,
} from "../src/static-projection/projection-parity-producer.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.dirname(directory);
const producerSourcePath = path.join(packageDirectory, "src", "static-projection", "projection-parity-producer.mjs");

async function loadCheckedInSnapshot() {
  const text = await readFile(path.join(packageDirectory, PROJECTION_PARITY_SNAPSHOT_RELATIVE_PATH), "utf8");
  return { text, snapshot: JSON.parse(text) };
}

test("checked-in parity snapshot equals the deterministic producer recomputation", async () => {
  const produced = await produceProjectionParitySnapshot();
  const { snapshot, text } = await loadCheckedInSnapshot();

  assert.deepEqual(produced, snapshot);
  assert.equal(JSON.stringify(produced), JSON.stringify(snapshot));
  assert.equal(JSON.stringify(produced, null, 2) + "\n", text);
});

test("regeneration is idempotent and always passes the strict checker", async () => {
  const first = await produceProjectionParitySnapshot();
  const second = await produceProjectionParitySnapshot();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const validated = validateActionProjectionParity(first);
  assert.equal(Object.isFrozen(validated), true);
});

test("registrations preserve exact identity/lifecycle/kind tuples of the generated surface artifact", async () => {
  const produced = await produceProjectionParitySnapshot();
  const artifact = parseActionSurface(await readFile(
    path.join(packageDirectory, "contracts", "generated", "action-surface.v1.json"),
    "utf8",
  ));
  assert.deepEqual(produced.surface.actions, artifact.actions);
  assert.deepEqual(
    produced.lifecycle.executableActionIds,
    artifact.actions
      .filter((action) => (action.lifecycle === "published" || action.lifecycle === "live_verified") && action.kind === "execution")
      .map((action) => action.actionId),
  );
  assert.deepEqual(
    produced.lifecycle.experimentalActionIds,
    artifact.actions
      .filter((action) => action.lifecycle === "experimental")
      .map((action) => action.actionId),
  );
  assert.equal(
    produced.surface.actions.some((action) => action.lifecycle === "withdrawn"),
    false,
  );
});

test("protocol/schema union facts are produced from package-owned documents", async () => {
  const produced = await produceProjectionParitySnapshot();
  assert.deepEqual(produced.protocol.schemas, [...produced.protocol.schemas].sort());
  assert.ok(produced.protocol.schemas.includes("gamebuddy-action-descriptors/v1"));
  assert.ok(produced.protocol.schemas.includes("gamebuddy-stardew-static-action-projection/v1"));
  assert.ok(produced.protocol.schemas.includes("gamebuddy-stardew-tool-inventory/v1"));
  assert.deepEqual(produced.protocol.fixedControls, PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS);
  assert.deepEqual(produced.protocol.fixedControls, STATIC_PROJECTION_FIXED_PROTOCOL_CONTROL_IDS);
});

test("native-local runner and fixture ownership are produced from package-owned sources", async () => {
  const produced = await produceProjectionParitySnapshot();
  const executable = new Set(produced.lifecycle.executableActionIds);
  for (const actionId of produced.ownership.localFixtureOwnedActionIds) {
    assert.ok(executable.has(actionId));
  }
  const native = new Set(produced.ownership.nativeActionIds);
  assert.equal(
    native.size + produced.ownership.localFixtureOwnedActionIds.length,
    produced.lifecycle.executableActionIds.length,
  );
  assert.ok(produced.ownership.localFixtureOwnedActionIds.includes("equip_tool"));
  for (const file of produced.fixtureOwnedFiles) {
    assert.match(file, /^tests\/fixtures\/[a-z0-9][a-z0-9._-]*\.json$/);
  }
  assert.ok(produced.fixtureOwnedFiles.includes("tests/fixtures/action-surface.v1.fixture.json"));
  assert.deepEqual(produced.guardOrder, PROJECTION_PARITY_GUARD_ORDER);
});

test("producer drift is observable for every fact category", async () => {
  const produced = await produceProjectionParitySnapshot();
  const { snapshot } = await loadCheckedInSnapshot();

  const mutate = (transform) => {
    const changed = structuredClone(produced);
    transform(changed);
    return changed;
  };

  // registration identity tuple drift
  assert.notDeepEqual(
    mutate((changed) => { changed.surface.actions[1].outputFacts = { changed: true }; }),
    snapshot,
  );
  // lifecycle partition drift
  assert.notDeepEqual(
    mutate((changed) => { changed.lifecycle.executableActionIds = changed.lifecycle.executableActionIds.slice(1); }),
    snapshot,
  );
  // protocol/schema union drift
  assert.notDeepEqual(
    mutate((changed) => { changed.protocol.schemas = [...changed.protocol.schemas, "extra/v1"].sort(); }),
    snapshot,
  );
  // runner/fixture ownership drift
  assert.notDeepEqual(
    mutate((changed) => { changed.ownership.nativeActionIds = changed.ownership.nativeActionIds.slice(1); }),
    snapshot,
  );
  // guard-order drift
  assert.notDeepEqual(
    mutate((changed) => { changed.guardOrder = [...changed.guardOrder].reverse(); }),
    snapshot,
  );
  // obsolete-route absence drift
  assert.notDeepEqual(
    mutate((changed) => { changed.absentRoutes = ["legacy"]; }),
    snapshot,
  );
});

test("producer reads package-owned documents only, with no root Host/Mod/tool boundary", async () => {
  const source = await readFile(producerSourcePath, "utf8");
  assert.doesNotMatch(source, /(?:from|import)\s+["'](?:\.\.\/){2,}/);
  assert.doesNotMatch(source, /(?:from|import)\s+["'][^"']*(?:host|mod|bridge|runtime)[^"']*["']/i);
  assert.doesNotMatch(source, /\b(?:spawn|exec|shell)\b\s*:?/i);
  assert.doesNotMatch(source, /relativePath:\s*["'][^"']*(?:\.\.|\\|[A-Za-z]:)/);
  assert.match(source, /contracts[\\/]generated[\\/]action-surface\.v1\.json/);
  assert.match(source, /tool-inventory\.json/);
  assert.match(source, /PROJECTION_PARITY_SNAPSHOT_RELATIVE_PATH/);
});

test("checked-in snapshot survives a strict parse round-trip", async () => {
  const { text, snapshot } = await loadCheckedInSnapshot();
  const validated = validateActionProjectionParity(snapshot);
  assert.equal(validated.surface.actions.length, snapshot.surface.actions.length);
  assert.equal(validated.schema, snapshot.schema);
  // Bound against the checker's own declared limit instead of a magic number, so
  // the snapshot cannot silently exceed what the strict consumer will accept.
  assert.equal(Buffer.byteLength(text, "utf8") <= PROJECTION_PARITY_MAX_JSON_BYTES, true);
});

test("the two optional-member lists agree, so neither can drift alone", async () => {
  /*
   * `action-projection-parity.mjs` cannot import anything (its own test asserts that), so its optional
   * member list is spelled a second time. That duplication is the cost of the no-import rule, and it is
   * exactly how the list stayed at the original nine members while 80 of 95 published actions grew
   * `targetFamily`. This test is what pays that cost back: it lives in a file that CAN import both.
   *
   * Red proof: dropping `targetFamily` from the parity module's list fails here by name, before the
   * stricter per-action check gets a chance to report something less precise.
   */
  const source = await readFile(
    path.join(packageDirectory, "src", "static-projection", "action-projection-parity.mjs"),
    "utf8",
  );
  const at = source.indexOf("PROJECTION_PARITY_ACTION_OPTIONAL_KEYS");
  assert.notEqual(at, -1, "the parity module must declare its optional member list where this test reads it");
  const declared = [...source.slice(at, source.indexOf("]", at)).matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"/gu)].map((m) => m[1]);
  assert.deepEqual(
    [...declared].sort(),
    [...ACTION_SURFACE_OPTIONAL_ACTION_KEYS].sort(),
    "the parity checker's optional members must equal the surface validator's: two lists, one fact",
  );
});