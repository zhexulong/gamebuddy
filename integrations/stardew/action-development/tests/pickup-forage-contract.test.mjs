import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateActionContractPickupForage } from "../src/action-contract.mjs";
import { readGeneratedPickupForageContract } from "../src/contract-export.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(directory);
const contract = JSON.parse(await readFile(path.join(projectDirectory, "contracts", "pickup_forage.json"), "utf8"));

test("validates the checked-in pickup_forage v2 contract", () => {
  const validated = validateActionContractPickupForage(contract);
  assert.deepEqual(validated.args.requiredProperties, ["x", "y", "expectedQualifiedItemId", "expectedTargetId"]);
  assert.deepEqual(validated.args.sceneTarget, { type: "ObservationBinding", version: 1, required: true, requiredProperties: ["observationId", "ref"] });
  assert.deepEqual(validated.terminal.successReasonCodes, ["forage_picked_up"]);
  assert.deepEqual(validated.terminal.evidenceFields, ["location", "tile", "item", "removed", "inventory_before", "inventory_after"]);
});

test("requires sceneTarget and rejects fallback-shaped variants", () => {
  assert.throws(() => validateActionContractPickupForage({ ...contract, args: { ...contract.args, sceneTarget: undefined } }), /wrong_scene_target/);
  assert.throws(() => validateActionContractPickupForage({ ...contract, args: { ...contract.args, sceneTarget: { ...contract.args.sceneTarget, required: false } } }), /invalid_scene_target/);
  assert.throws(() => validateActionContractPickupForage({ ...contract, args: { ...contract.args, requiredProperties: ["x", "y"] } }), /wrong_required_properties/);
});

test("requires exact exporter artifact bytes", async () => {
  const generated = Buffer.from(JSON.stringify(contract));
  assert.deepEqual(await readGeneratedPickupForageContract({ runExport: async () => generated, readArtifact: async () => generated }), generated);
  await assert.rejects(readGeneratedPickupForageContract({ runExport: async () => generated, readArtifact: async () => Buffer.from("drift") }), /artifact_drift/);
});
