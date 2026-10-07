import assert from "node:assert/strict";
import test from "node:test";
import { isDescriptorDerivedActionId, isModDescriptorComplete } from "./action-registry.js";

/**
 * The gate these tests pin decides VISIBILITY, TOOL MOUNTING and COMPLETION JUDGING at once
 * (action-registry.ts:740-765). Its failure mode is silence: a descriptor-derived action with no arm
 * here is `continue`d out of the visible list, so it never reaches the Agent and no error is raised.
 * That is exactly what happened to withdraw_silo_hay and use_obelisk: both were enrolled as
 * descriptor-derived, neither had an arm, and the suite stayed green because the only test in this
 * area asserted the tool NAME existed rather than that the gate opened.
 *
 * These tests therefore assert the gate OUTCOME for both ids, in BOTH legal descriptor shapes, and
 * assert it stays shut on the wrong ones.
 */

/** The wire shape: hello_ack carries `arguments` (array) and `postcondition` as a record. */
function wireDescriptor({ names, postcondition, effect = "write", nativeBinding = "X.Y" }) {
  return {
    arguments: names.map((name) => ({ name, type: name === "x" || name === "y" ? "integer" : "string" })),
    effect,
    postcondition: { name: postcondition },
    nativeBinding,
  };
}

/** The action-surface shape: `argumentSchema` keyed by name. */
function surfaceDescriptor({ names, postcondition, effect = "write", nativeBinding = "X.Y" }) {
  return {
    argumentSchema: Object.fromEntries(names.map((name) => [name, { type: name === "x" || name === "y" ? "integer" : "string" }])),
    effect,
    postcondition: { name: postcondition },
    nativeBinding,
  };
}

const xyz = ["x", "y", "expectedTargetId"];

test("both new actions are enrolled as descriptor-derived", () => {
  // If this ever stops holding, the gate below stops applying to them and these tests would be
  // checking a rule nothing enforces.
  assert.equal(isDescriptorDerivedActionId("withdraw_silo_hay"), true);
  assert.equal(isDescriptorDerivedActionId("use_obelisk"), true);
});

test("the gate opens for both actions in the wire descriptor shape", () => {
  assert.equal(isModDescriptorComplete("withdraw_silo_hay", wireDescriptor({ names: xyz, postcondition: "silo_hay_taken" })), true);
  assert.equal(isModDescriptorComplete("use_obelisk", wireDescriptor({ names: xyz, postcondition: "obelisk_arrived" })), true);
});

test("the gate opens for both actions in the action-surface descriptor shape", () => {
  assert.equal(isModDescriptorComplete("withdraw_silo_hay", surfaceDescriptor({ names: xyz, postcondition: "silo_hay_taken" })), true);
  assert.equal(isModDescriptorComplete("use_obelisk", surfaceDescriptor({ names: xyz, postcondition: "obelisk_arrived" })), true);
});

test("the gate stays shut when the postcondition is not the one the Mod emits", () => {
  // A gate that opened for any postcondition would be worse than no gate.
  assert.equal(isModDescriptorComplete("withdraw_silo_hay", wireDescriptor({ names: xyz, postcondition: "something_else" })), false);
  assert.equal(isModDescriptorComplete("use_obelisk", wireDescriptor({ names: xyz, postcondition: "something_else" })), false);
  // ...and, critically, one action's postcondition must not open the other's arm.
  assert.equal(isModDescriptorComplete("withdraw_silo_hay", wireDescriptor({ names: xyz, postcondition: "obelisk_arrived" })), false);
});

test("the gate stays shut when the argument shape is wrong", () => {
  assert.equal(isModDescriptorComplete("use_obelisk", surfaceDescriptor({ names: ["x", "y"], postcondition: "obelisk_arrived" })), false);
  assert.equal(
    isModDescriptorComplete("withdraw_silo_hay", wireDescriptor({ names: ["x", "y", "expectedTargetId", "extra"], postcondition: "silo_hay_taken" })),
    false,
  );
  // Reordering is a different contract, not an equivalent one.
  assert.equal(isModDescriptorComplete("use_obelisk", wireDescriptor({ names: ["y", "x", "expectedTargetId"], postcondition: "obelisk_arrived" })), false);
});

test("the gate stays shut when the descriptor is not a write", () => {
  assert.equal(isModDescriptorComplete("withdraw_silo_hay", wireDescriptor({ names: xyz, postcondition: "silo_hay_taken", effect: "read" })), false);
  assert.equal(isModDescriptorComplete("use_obelisk", surfaceDescriptor({ names: xyz, postcondition: "obelisk_arrived", effect: "none" })), false);
});
