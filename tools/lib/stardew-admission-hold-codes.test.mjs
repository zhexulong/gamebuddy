import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ADMISSION_HOLD_CODES, isAdmissionHold } from "./stardew-admission-hold-codes.mjs";

/**
 * The list must match the Mod's OWN source, or it becomes one more stale mirror - which is the failure it exists
 * to stop. This reads the two Mod files that mint these codes and compares them to the list in both directions.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function modCodes() {
  const world = readFileSync(path.join(ROOT, "integrations", "stardew", "WorldModel.cs"), "utf8");
  const controller = readFileSync(path.join(ROOT, "integrations", "stardew", "farmhandexecutioncontroller.cs"), "utf8");
  // Take the HoldReasonCode switch ONLY. The file also has `KindForWire`, whose arms are the DISPOSITION KINDS
  // (`Idle => "idle"`); a first version scanned every `Kind.X => "…"` arm and so demanded that `idle` be listed
  // as a hold. A drift test that over-reads its source is worse than none, because it fails on correct code.
  const switchAt = world.indexOf("HoldReasonCode(ActorDispositionKind kind) => kind switch");
  assert.notEqual(switchAt, -1, "the HoldReasonCode switch must be findable");
  const raise = world.indexOf("public static string HoldReasonCode", switchAt);
  const body = world.slice(switchAt, raise === -1 ? switchAt + 1200 : raise);
  const fromSwitch = [...body.matchAll(/ActorDispositionKind\.\w+\s*=>\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const generic = [...body.matchAll(/_ => "([a-z_]+)"/g)].map((m) => m[1]);
  const owners = [...controller.matchAll(/"(body_owned(?:_by_[a-z_]+)?)"/g)].map((m) => m[1]);
  return { fromSwitch, generic, owners };
}

test("the list contains every code the Mod's disposition switch can return", () => {
  const { fromSwitch, generic } = modCodes();
  assert.ok(fromSwitch.length >= 4, `expected the named holds, found ${fromSwitch.length}`);
  for (const code of [...fromSwitch, ...generic]) {
    assert.ok(ADMISSION_HOLD_CODES.includes(code), `the Mod can return ${code} but the list omits it`);
  }
});

test("the list contains every named body owner the controller mints", () => {
  const { owners } = modCodes();
  assert.ok(owners.length >= 7, `expected the named owners, found ${owners.length}`);
  for (const code of new Set(owners)) {
    assert.ok(ADMISSION_HOLD_CODES.includes(code), `the Mod mints ${code} but the list omits it`);
  }
});

test("the list carries nothing the Mod cannot return", () => {
  const { fromSwitch, generic, owners } = modCodes();
  const live = new Set([...fromSwitch, ...generic, ...owners]);
  for (const code of ADMISSION_HOLD_CODES) {
    assert.ok(live.has(code), `the list claims ${code}, which the Mod's source does not mint`);
  }
});

test("isAdmissionHold accepts the holds and refuses anything else", () => {
  for (const code of ADMISSION_HOLD_CODES) assert.equal(isAdmissionHold(code), true, code);
  // The point of the helper: an unrelated refusal must NOT read as a hold, or a gate would pass on the wrong one.
  for (const code of ["talk_to_npc_target_not_found", "invalid_deadline", "world_not_ready", "hands_not_empty", "", null, undefined, 7])
    assert.equal(isAdmissionHold(code), false, String(code));
});
