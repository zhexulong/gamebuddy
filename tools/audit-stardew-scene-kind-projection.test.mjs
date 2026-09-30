// Regression gate for the scene-affordance-kind projection audit.
//
// The audit exists because `water_source` was invisible to a whole layer for a
// while: present in the Mod enum, the Host protocol and the scanner, missing from
// the BridgeProtocol allowlists, so real observations failed during serialization.
// A test that only asserts "no findings" would pass on a broken audit, so every
// case below mutates one hop and asserts the audit names it.
//
// Every case runs against a COPY of the repository subset the audit reads. An
// earlier version rewrote `BridgeProtocol.cs` in place and restored it afterwards,
// which raced the lane editing that file -- its mtime moved within the same minute
// the suite ran, so a restore could have overwritten work that landed in between.
// The audit takes an injectable root so no test needs a shared file.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { auditSceneKindProjection } from "./audit-stardew-scene-kind-projection.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The files the audit reads, copied into an isolated root per test. */
const TRACKED = [
  "integrations/stardew/navigation/scenecontracts.cs",
  "integrations/stardew/navigation/sceneobservationprojection.cs",
  "integrations/stardew/src/Core/Protocol/BridgeProtocol.cs",
  "host/src/protocol.ts",
  "protocol/bridge-v1.schema.json",
];

const workspaces = [];
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "scene-projection-"));
  workspaces.push(dir);
  for (const relative of TRACKED) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(ROOT, relative), target);
  }
  return {
    dir,
    audit: () => auditSceneKindProjection({ root: dir }),
    readRaw: (relative) => readFileSync(path.join(ROOT, relative), "utf8"),
    write: (relative, content) => writeFileSync(path.join(dir, relative), content),
    original: (relative) => readFileSync(path.join(ROOT, relative), "utf8"),
  };
}

const BRIDGE = "integrations/stardew/src/Core/Protocol/BridgeProtocol.cs";
const CONTRACTS = "integrations/stardew/navigation/scenecontracts.cs";
const SCHEMA = "protocol/bridge-v1.schema.json";

test("current projection is clean and covers the full kind set", () => {
  const report = auditSceneKindProjection();

  assert.ok(report.kindCount >= 13, `expected at least 13 kinds, saw ${report.kindCount}`);
  assert.deepEqual(report.findings, [], "no hop may disagree with the Mod enum");

  const wires = report.perKind.map((row) => row.wire);
  assert.equal(new Set(wires).size, wires.length, "wire values must be unique");
  const prefixes = report.perKind.map((row) => row.refPrefix);
  assert.equal(new Set(prefixes).size, prefixes.length, "ref prefixes must be unique");

  // The kind that shipped broken must be present and classified.
  const water = report.perKind.find((row) => row.wire === "water_source");
  assert.ok(water, "water_source must be audited");
  assert.equal(water.member, "WaterSource");

  // Ground is a second axis and must be audited on the same run.
  const groundWires = report.groundKinds.map((row) => row.wire);
  assert.deepEqual(groundWires, ["dirt", "grass", "other", "stone", "wood"], "ground kinds must be audited");
});

test("a kind dropped from the BridgeProtocol outbound allowlist is reported", () => {
  const box = sandbox();
  const original = box.original(BRIDGE);
  const mutated = original.replace(' or "water_source"', "");
  assert.notEqual(mutated, original, "mutation must actually change the source");
  box.write(BRIDGE, mutated);

  const named = box.audit().findings.filter((f) => f.hop === "BridgeProtocol outbound");
  assert.deepEqual(named.map((f) => f.kind), ["water_source"], "audit must name the dropped kind");
});

test("a kind dropped from the BridgeProtocol inbound allowlist is reported", () => {
  const box = sandbox();
  const original = box.original(BRIDGE);
  const mutated = original.replace(
    'affordance.Kind is "npc" or "chest" or "crop" or "tree" or "animal" or "forage" or "door" or "machine" or "water_source" or "weed" or "stone" or "debris" or "artifact_spot"',
    'affordance.Kind is "npc" or "chest" or "crop" or "tree" or "animal" or "forage" or "door" or "machine" or "weed" or "stone" or "debris" or "artifact_spot"',
  );
  assert.notEqual(mutated, original, "mutation must actually change the source");
  box.write(BRIDGE, mutated);

  const named = box.audit().findings.filter((f) => f.hop === "BridgeProtocol inbound");
  assert.deepEqual(named.map((f) => f.kind), ["water_source"], "audit must name the dropped kind");
});

test("a layer admitting an undeclared kind is reported as a superset", () => {
  const box = sandbox();
  const original = box.original(BRIDGE);
  const mutated = original.replace('or "artifact_spot"', 'or "artifact_spot" or "trap_spot"');
  assert.notEqual(mutated, original, "mutation must actually change the source");
  box.write(BRIDGE, mutated);

  const named = box.audit().findings.filter((f) => f.kind === "trap_spot");
  assert.ok(named.length > 0, "audit must reject a layer-only kind");
});

test("a duplicate ref prefix is reported", () => {
  const box = sandbox();
  const original = box.original(CONTRACTS);
  const mutated = original.replace('SceneAffordanceKind.Stone => "st"', 'SceneAffordanceKind.Stone => "t"');
  assert.notEqual(mutated, original, "mutation must actually change the source");
  box.write(CONTRACTS, mutated);

  const duplicated = box.audit().findings.filter((f) => f.hop === "ToRefPrefix" && f.detail.includes("already used"));
  assert.equal(duplicated.length, 1, "audit must report exactly one prefix collision");
  assert.equal(duplicated[0].kind, "Stone");
});

test("a ground kind missing from the Host union is reported", () => {
  const box = sandbox();
  const original = box.original("host/src/protocol.ts");
  const mutated = original.replace('| "other";', ";");
  assert.notEqual(mutated, original, "mutation must actually change the source");
  box.write("host/src/protocol.ts", mutated);

  const named = box.audit().findings.filter((f) => f.hop === "host protocol ground union" && f.kind === "other");
  assert.equal(named.length, 1, "audit must name the missing ground kind");
});

// `ObserveSceneGround.dominantKind` must resolve through the shared alias. If it
// inlines its own literal set, the value set exists twice and the two can drift
// apart silently -- the alias check is separate from the value-set comparison
// above, which is why it carries its own hop name.
test("a ground object that inlines its own value set instead of the alias is reported", () => {
  const box = sandbox();
  const original = box.original("host/src/protocol.ts");
  const mutated = original.replace("dominantKind: SceneGroundKind;", 'dominantKind: "grass" | "dirt" | "stone" | "wood" | "other";');
  assert.notEqual(mutated, original, "mutation must actually change the source");
  box.write("host/src/protocol.ts", mutated);

  const named = box.audit().findings.filter((f) => f.hop === "host protocol ground declaration");
  assert.equal(named.length, 1, "audit must report the duplicated value set");
  assert.match(named[0].detail, /does not reference SceneGroundKind/);
});

// The outbound path must derive its wire value from the enum. If it inlines a
// literal instead, a new ground kind can be added to the enum and the wire helper
// while the projection keeps emitting the old set -- the enum stays the authority
// on paper only.
test("an outbound path that bypasses the ground wire helper is reported", () => {
  const box = sandbox();
  const relative = "integrations/stardew/navigation/sceneobservationprojection.cs";
  const original = box.original(relative);
  const mutated = original.replaceAll("SceneGroundKindWire.ToWireValue", "InlineGroundWire");
  assert.notEqual(mutated, original, "mutation must actually change the source");
  box.write(relative, mutated);

  const named = box.audit().findings.filter(
    (f) => f.hop === "BridgeProtocol" && f.detail.includes("SceneGroundKindWire.ToWireValue"),
  );
  assert.equal(named.length, 1, "audit must report an outbound path that bypasses the wire helper");
});

// The defect this change fixes: the Mod emits `ground_limit` with partial=true
// when only ground exceptions were capped, and every layer accepted it except the
// conditional branch of the envelope schema, so a mixed-ground observation was
// unschema-valid.
test("a truncation reason missing from the schema's conditional branch is reported", () => {
  const box = sandbox();
  const original = box.original(SCHEMA);
  const fixed = `"truncatedReason": { "enum": ["maximum_affordances", "payload_limit", "ground_limit"] }`;
  assert.ok(original.includes(fixed), "the branch must start in its fixed form");
  box.write(SCHEMA, original.replace(fixed, `"truncatedReason": { "enum": ["maximum_affordances", "payload_limit"] }`));

  const named = box.audit().findings.filter((f) => f.hop === "envelope schema allOf[0]" && f.detail.includes("ground_limit"));
  assert.equal(named.length, 1, "audit must report the omitted reason on the branch that narrows by partial");
});

test("a ground kind admitted by a layer but absent from the Mod enum is reported", () => {
  const box = sandbox();
  const original = box.original("host/src/protocol.ts");
  const mutated = original.replace('| "other";', '| "other" | "lava";');
  assert.notEqual(mutated, original, "mutation must actually change the source");
  box.write("host/src/protocol.ts", mutated);

  const named = box.audit().findings.filter((f) => f.kind === "lava");
  assert.ok(named.length > 0, "a layer-only ground kind must be rejected");
});

test("the audit reports how many runners it checked", () => {
  const report = auditSceneKindProjection();
  assert.ok(report.runnerCount >= 50, `expected the native-local runners to be audited, saw ${report.runnerCount}`);
});

// Regression: two runners enumerated only "maximum_affordances" and
// "payload_limit", so a valid mixed-ground observation (partial with
// truncatedReason `ground_limit`) was rejected by the runner even though every
// wire layer accepted it. The consumer layer must stay a closed set too.
test("a runner that enumerates a subset of the truncation reasons is reported", () => {
  const box = sandbox();
  const dir = path.join(box.dir, "tools");
  mkdirSync(dir, { recursive: true });
  const runner = "run-stardew-native-local-player-probe-smoke.mjs";
  writeFileSync(
    path.join(dir, runner),
    'const PARTIAL = new Set(["maximum_affordances", "payload_limit"]);\n',
  );
  const named = box.audit().findings.filter((f) => f.hop === `runner ${runner}`);
  assert.deepEqual(
    named.map((f) => f.detail.includes("ground_limit")),
    [true],
    "audit must name the omitted reason",
  );
});

