import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateActionDevelopmentContract, validateActionContractEquipTool } from "../src/action-contract.mjs";
import { readGeneratedEquipToolContract } from "../src/contract-export.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(directory);
const contract = JSON.parse(await readFile(path.join(projectDirectory, "contracts", "equip_tool.json"), "utf8"));

test("requires the checked artifact to exactly match Core exporter output", async () => {
  const generated = Buffer.from(JSON.stringify(contract));
  const exact = await readGeneratedEquipToolContract({
    runExport: async () => generated,
    readArtifact: async () => Buffer.from(JSON.stringify(contract)),
  });
  assert.deepEqual(exact, generated);
  await assert.rejects(
    readGeneratedEquipToolContract({
      runExport: async () => generated,
      readArtifact: async () => Buffer.from(JSON.stringify({ ...contract, actionId: "drifted" })),
    }),
    /artifact_drift/,
  );
});

test("validates the checked-in equip_tool contract", () => {
  const validated = validateActionContractEquipTool(contract);
  assert.equal(validated.actionId, "equip_tool");
  assert.equal(validated.familyId, "body_tools");
  assert.deepEqual(validated.args.requiredProperties, ["tool"]);
  assert.deepEqual(validated.args.toolAllowedValues, ["axe", "pickaxe", "hoe", "watering_can", "fishing_rod", "weapon", "scythe", "shears", "milk_pail", "pan"]);
  assert.deepEqual(validated.terminal.successReasonCodes, ["tool_equipped", "already_equipped"]);
  assert.deepEqual(validated.terminal.evidenceFields, ["tool", "before", "expected", "after"]);
  assert.ok(Object.isFrozen(validated));
});

test("rejects wrong schema, game ID, unknown top-level keys, and identity drift", () => {
  assert.throws(() => validateActionDevelopmentContract({ ...contract, schema: "wrong/v1" }), /invalid_schema/);
  assert.throws(() => validateActionDevelopmentContract({ ...contract, gameId: "minecraft" }), /invalid_game_id/);
  assert.throws(() => validateActionDevelopmentContract({ ...contract, extra: true }), /invalid_shape/);
  assert.throws(() => validateActionDevelopmentContract({ ...contract, actionId: "enter/mine" }), /invalid_action_id/);
  assert.throws(() => validateActionContractEquipTool({ ...contract, actionId: "enter_mine" }), /wrong_action_id/);
  assert.throws(() => validateActionContractEquipTool({ ...contract, lifecycle: "experimental" }), /wrong_lifecycle/);
  assert.throws(() => validateActionContractEquipTool({ ...contract, kind: "read_only" }), /wrong_kind/);
});

test("rejects invalid args and terminal shapes", () => {
  assert.throws(() => validateActionDevelopmentContract({ ...contract, args: { ...contract.args, requiredProperties: [] } }), /invalid_required_properties/);
  assert.throws(() => validateActionDevelopmentContract({ ...contract, args: { ...contract.args, toolAllowedValues: [] } }), /invalid_tool_allowed_values/);
  assert.throws(() => validateActionDevelopmentContract({ ...contract, args: { ...contract.args, slotMinimum: 0 } }), /invalid_args_shape/);
  assert.throws(() => validateActionDevelopmentContract({ ...contract, terminal: { ...contract.terminal, evidenceFields: [] } }), /invalid_evidence_fields/);
  assert.throws(() => validateActionDevelopmentContract({ ...contract, terminal: { ...contract.terminal, successReasonCodes: [] } }), /invalid_success_reason_codes/);
  assert.throws(() => validateActionDevelopmentContract({ ...contract, terminal: { ...contract.terminal, successReasonCode: "tool_selected" } }), /invalid_terminal_shape/);
});