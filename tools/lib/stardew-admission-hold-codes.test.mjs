import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ADMISSION_HOLD_CODES, WAITING_FOR_BODY_PREFIX, isAdmissionHold } from "./stardew-admission-hold-codes.mjs";

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
  // The EVENT vocabulary, declared as constants beside the body owners, so this mirror reads the Mod's own spelling
  // instead of a hand copy: `event_` is the Mod's own prefix for "the world refused this because of a running event".
  const events = [...controller.matchAll(/internal const string \w+ = "(event_[a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(events.length >= 1, "the Mod must declare its event-vocabulary codes as named constants");
  return { fromSwitch, generic, owners, events };
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

test("the list contains every event code the Mod declares", () => {
  // The cutscene vocabulary grew a second code because one word answered two questions: `cutscene_active` is the hold
  // for every action with no path through a cutscene, while `event_has_no_dialogue_box` is the modal family finding
  // nothing on screen to act on. A live gate that reads "was it a hold?" must recognise both.
  const { events } = modCodes();
  for (const code of events) {
    assert.ok(ADMISSION_HOLD_CODES.includes(code), `the Mod can return ${code} but the list omits it`);
  }
});

test("the list carries nothing the Mod cannot return", () => {
  const { fromSwitch, generic, owners, events } = modCodes();
  const live = new Set([...fromSwitch, ...generic, ...owners, ...events]);
  for (const code of ADMISSION_HOLD_CODES) {
    assert.ok(live.has(code), `the list claims ${code}, which the Mod's source does not mint`);
  }
});

test("the waiting-for-body prefix is the Mod's own spelling", () => {
  // The wait's code is assembled in the Mod from one constant, so this reads that constant rather than trusting a hand
  // copy: a renamed prefix here would silently stop recognising a queued request's refusal.
  const controller = readFileSync(path.join(ROOT, "integrations", "stardew", "farmhandexecutioncontroller.cs"), "utf8");
  const declared = /WaitingForBodyPrefix = "([a-z0-9_:]+)"/.exec(controller);
  assert.notEqual(declared, null, "the Mod must declare the wait prefix as one constant");
  assert.equal(
    WAITING_FOR_BODY_PREFIX,
    declared[1],
    "the harness mirror and the Mod disagree about the wait's spelling, so a queued refusal would read as an unknown code",
  );
});

test("isAdmissionHold accepts the holds and refuses anything else", () => {
  for (const code of ADMISSION_HOLD_CODES) assert.equal(isAdmissionHold(code), true, code);
  // A queued request's expired wait IS a body hold: the body being occupied is what refused it.
  assert.equal(isAdmissionHold("waiting_for_body:body_owned_by_activity"), true, "the named wait");
  assert.equal(
    isAdmissionHold("waiting_for_body:"),
    false,
    "a bare prefix names no owner, so it is not a code the Mod can mint",
  );
  // The point of the helper: an unrelated refusal must NOT read as a hold, or a gate would pass on the wrong one.
  for (const code of [
    "talk_to_npc_target_not_found",
    "invalid_deadline",
    "world_not_ready",
    "hands_not_empty",
    "",
    null,
    undefined,
    7,
  ])
    assert.equal(isAdmissionHold(code), false, String(code));
});
