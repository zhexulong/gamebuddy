// Regression gate for the scene-affordance-kind projection audit.
//
// The audit exists because `water_source` was invisible to a whole layer for a
// while: present in the Mod enum, the Host protocol and the scanner, missing
// from the BridgeProtocol allowlists, so real observations failed during
// serialization. A test that only asserts "no findings" would pass on a broken
// audit, so every case below mutates one hop and asserts the audit names it.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { auditSceneKindProjection } from "./audit-stardew-scene-kind-projection.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PROTOCOL = path.join(ROOT, "integrations/stardew/src/Core/Protocol/BridgeProtocol.cs");

const original = readFileSync(BRIDGE_PROTOCOL, "utf8");
const restore = () => writeFileSync(BRIDGE_PROTOCOL, original);

after(restore);

test("current projection is clean and covers the full kind set", () => {
  const report = auditSceneKindProjection();

  assert.ok(report.kindCount >= 13, `expected at least 13 kinds, saw ${report.kindCount}`);
  assert.deepEqual(report.findings, [], "no hop may disagree with the Mod enum");

  const wires = report.perKind.map((row) => row.wire);
  assert.equal(new Set(wires).size, wires.length, "wire values must be unique");
  const prefixes = report.perKind.map((row) => row.refPrefix);
  assert.equal(new Set(prefixes).size, prefixes.length, "ref prefixes must be unique");

  // The kind that shipped broken must be present and dense/sparse-classified.
  const water = report.perKind.find((row) => row.wire === "water_source");
  assert.ok(water, "water_source must be audited");
  assert.equal(water.member, "WaterSource");
});

test("a kind dropped from the BridgeProtocol outbound allowlist is reported", () => {
  // This is exactly the shipped defect: the Mod classifies and sends the kind,
  // but the outbound validator refuses to serialize it.
  const mutated = original.replace(' or "water_source"', "");
  assert.notEqual(mutated, original, "mutation must actually change the source");
  writeFileSync(BRIDGE_PROTOCOL, mutated);

  const report = auditSceneKindProjection();
  const named = report.findings.filter((f) => f.hop === "BridgeProtocol outbound");
  assert.deepEqual(named.map((f) => f.kind), ["water_source"], "audit must name the dropped kind");

  restore();
});

test("a kind dropped from the BridgeProtocol inbound allowlist is reported", () => {
  const mutated = original.replace(
    'affordance.Kind is "npc" or "chest" or "crop" or "tree" or "animal" or "forage" or "door" or "machine" or "water_source" or "weed" or "stone" or "debris" or "artifact_spot"',
    'affordance.Kind is "npc" or "chest" or "crop" or "tree" or "animal" or "forage" or "door" or "machine" or "weed" or "stone" or "debris" or "artifact_spot"',
  );
  assert.notEqual(mutated, original, "mutation must actually change the source");
  writeFileSync(BRIDGE_PROTOCOL, mutated);

  const report = auditSceneKindProjection();
  const named = report.findings.filter((f) => f.hop === "BridgeProtocol inbound");
  assert.deepEqual(named.map((f) => f.kind), ["water_source"], "audit must name the dropped kind");

  restore();
});

test("a layer admitting an undeclared kind is reported as a superset", () => {
  // Forward compatibility is a bug here: the Mod enum is the authority, so a
  // layer that accepts a kind the Mod cannot emit would publish an unshippable
  // contract.
  const mutated = original.replace(
    'or "artifact_spot"',
    'or "artifact_spot" or "trap_spot"',
  );
  assert.notEqual(mutated, original, "mutation must actually change the source");
  writeFileSync(BRIDGE_PROTOCOL, mutated);

  const report = auditSceneKindProjection();
  const named = report.findings.filter((f) => f.kind === "trap_spot");
  assert.ok(named.length > 0, "audit must reject a layer-only kind");

  restore();
});

test("a duplicate ref prefix is reported", () => {
  const contractsPath = path.join(ROOT, "integrations/stardew/navigation/scenecontracts.cs");
  const contractsOriginal = readFileSync(contractsPath, "utf8");
  try {
    // Give Stone the same opaque ref prefix as Tree.
    const mutated = contractsOriginal.replace(
      "SceneAffordanceKind.Stone => \"st\"",
      "SceneAffordanceKind.Stone => \"t\"",
    );
    assert.notEqual(mutated, contractsOriginal, "mutation must actually change the source");
    writeFileSync(contractsPath, mutated);

    const report = auditSceneKindProjection();
    const duplicated = report.findings.filter((f) => f.hop === "ToRefPrefix" && f.detail.includes("already used"));
    assert.equal(duplicated.length, 1, "audit must report exactly one prefix collision");
    assert.equal(duplicated[0].kind, "Stone");
  } finally {
    writeFileSync(contractsPath, contractsOriginal);
  }
});
