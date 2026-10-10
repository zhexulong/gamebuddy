import assert from "node:assert/strict";
import test from "node:test";

import { evidenceDetailOf, evidenceField, remedyForBodyHold } from "./stardew-action-remedy.js";

test("every named hold gets a countermeasure, and none of them is the same text", () => {
  const codes = ["actor_held_by_modal", "transient_busy", "cutscene_active", "actor_passed_out"];
  const guidances = codes.map((code) => remedyForBodyHold(code, null)?.guidance);
  for (const [index, guidance] of guidances.entries()) {
    assert.ok(guidance, `${codes[index]} must have a countermeasure: a named hold with no remedy is only a ` + "prettier dead end");
  }
  // The point of the whole change: one code used to cover all of these, so five states gave one answer.
  assert.equal(new Set(guidances).size, codes.length, "each hold must be answered differently or the Agent still cannot choose");
});

test("a modal points at the tool that matches whether an answer is owed", () => {
  const question = remedyForBodyHold("actor_held_by_modal", "modal_type=DialogueBox;is_question=true;can_move=false");
  assert.equal(question?.action, "stardew_answer_dialogue");
  assert.match(question?.guidance ?? "", /stardew_answer_dialogue/);

  const informational = remedyForBodyHold("actor_held_by_modal", "modal_type=DialogueBox;is_question=false;can_move=false");
  assert.equal(informational?.action, "stardew_dismiss_modal");
  assert.match(informational?.guidance ?? "", /stardew_dismiss_modal/);
});

test("an unreadable answer state is honest rather than promising a close that may be refused", () => {
  // A non-dialogue operation menu: the question flag is absent because it does not apply, and dismiss_modal's
  // audited whitelist may refuse it. The guidance must not claim the close will work.
  const remedy = remedyForBodyHold("actor_held_by_modal", "modal_type=LetterViewerMenu;is_question=unknown;can_move=false");
  assert.equal(remedy?.action, "stardew_dismiss_modal");
  assert.match(remedy?.guidance ?? "", /refuses menus it is not allowed to close/);
  assert.match(remedy?.guidance ?? "", /report the blockage/, "the Agent must be told what to do if the remedy fails");
});

test("a transient hold tells the Agent to wait and to keep the SAME target", () => {
  const remedy = remedyForBodyHold("transient_busy", "transient_kind=toolAnimation;retry_window_ms=2000;can_move=false");
  assert.equal(remedy?.action, null, "no tool can shorten a transient, so none may be named");
  assert.match(remedy?.guidance ?? "", /toolAnimation/);
  assert.match(remedy?.guidance ?? "", /2000/);
  assert.match(remedy?.guidance ?? "", /SAME request/, "changing the target is the failure mode this prevents");
});

test("a hold with no countermeasure says so instead of naming a tool", () => {
  for (const code of ["cutscene_active", "actor_passed_out"]) {
    const remedy = remedyForBodyHold(code, null);
    assert.equal(remedy?.action, null, `${code} cannot be cleared by a tool`);
    assert.match(remedy?.guidance ?? "", /retry|Do not issue|Do not retry/i);
  }
});

test("every named body owner gets actionable guidance, and no two owners read the same", () => {
  const owners = [
    "body_owned_by_navigation",
    "body_owned_by_travel",
    "body_owned_by_movement",
    "body_owned_by_approach",
    "body_owned_by_ride",
    "body_owned_by_day_advance",
    "body_owned_by_activity",
  ];
  const guidances = owners.map((code) => remedyForBodyHold(code, null)?.guidance);
  for (const [index, guidance] of guidances.entries()) {
    assert.ok(guidance, `${owners[index]} must name a next step, not just report the hold`);
    assert.match(guidance ?? "", /Wait|Re-issue/, `${owners[index]} must say to wait or to re-issue`);
  }
  assert.equal(
    new Set(guidances).size,
    owners.length,
    "owners that share a sentence leave the Agent guessing which hold it is again",
  );
});

test("only a supersedable owner is told to re-issue; every other owner must settle first", () => {
  // The Mod's frozen table marks an in-flight local movement supersedable by a newer command, but ONLY a
  // movement displaces it: `RequestLocalMove` cancels `active`, while any other action goes through shared
  // admission and is refused again. The guidance must therefore name both cases instead of promising a
  // takeover to whichever request happens to be holding the code.
  const movement = remedyForBodyHold("body_owned_by_movement", null)?.guidance ?? "";
  assert.match(movement, /if you meant to walk somewhere, re-issue the request now/);
  assert.match(movement, /Any other action has to wait/, "a tool action must not be told to re-issue blindly");
  for (const code of [
    "body_owned_by_travel",
    "body_owned_by_approach",
    "body_owned_by_ride",
    "body_owned_by_day_advance",
    "body_owned_by_activity",
    "body_owned_by_navigation",
  ]) {
    assert.match(remedyForBodyHold(code, null)?.guidance ?? "", /Wait for/, `${code} cannot be interrupted`);
  }
  // Navigation is deliberately in the settle-only list above, matching the Mod's own `interruptible=false`.
  // It used to offer a takeover here as well; that contradicted the structured fact published in the same
  // snapshot, and the movement path has no clean takeover to offer (`RequestLocalMove`'s occupancy guard does
  // not include `activeNavigate`). One authority, one answer.
  const navigation = remedyForBodyHold("body_owned_by_navigation", null)?.guidance ?? "";
  assert.match(navigation, /cannot be taken over/, "the guidance must say so plainly");
  assert.doesNotMatch(navigation, /also takes over|takes over from/, "and must not promise a takeover the Mod denies");
});

test("a body_owned_* code the table does not list still gets a generic actionable remedy", () => {
  // A named hold the Host has not heard of yet must not degrade to an unknown-error dead end.
  const remedy = remedyForBodyHold("body_owned_by_future_owner", null);
  assert.equal(remedy?.action, null, "a prefixed hold names no tool");
  assert.match(remedy?.guidance ?? "", /Wait for it to settle/);
  assert.match(remedy?.guidance ?? "", /re-issue the same request/);
});

test("the bare legacy body_owned stays a dead end for the prefix fallback", () => {
  // `body_owned` is not `body_owned_`: the fallback must not swallow the code whose test asserts no remedy.
  assert.equal(remedyForBodyHold("body_owned", null), null);
});

test("a reason code that is not a body hold gets no remedy", () => {
  // Attaching a remedy here would tell the Agent to close a dialogue that is not open.
  for (const code of ["player_not_actionable", "invalid_target_tile", "no_native_path", "body_owned", "accepted", null]) {
    assert.equal(remedyForBodyHold(code, "modal_type=DialogueBox"), null, `${String(code)} is not a body hold`);
  }
});

test("the Mod's evidence is read in both the shapes it arrives in", () => {
  assert.equal(evidenceDetailOf({ detail: "a=1;b=2" }), "a=1;b=2");
  assert.equal(evidenceDetailOf("a=1"), "a=1", "a bare string is accepted rather than silently dropped");
  assert.equal(evidenceDetailOf(null), null);
  assert.equal(evidenceDetailOf({ other: 1 }), null);

  assert.equal(evidenceField("a=1;is_question=false;b=2", "is_question"), "false");
  assert.equal(evidenceField("a=1", "is_question"), null);
  assert.equal(evidenceField(null, "is_question"), null);
  // A value that itself contains '=' must survive, or a modal type with punctuation would be truncated.
  assert.equal(evidenceField("modal_type=DialogueBox;x=a=b", "x"), "a=b");
});
