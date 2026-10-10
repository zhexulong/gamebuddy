import assert from "node:assert/strict";
import test from "node:test";

import { dialogueFacts, judgeDialogueStream } from "./check-stardew-dialogue-stream.mjs";

/**
 * The dialogue gate's own suite. The two assertions worth having here are the ones that decide whether the gate is
 * honest: an UNOBSERVED run must never pass, and a pager that only read the current page must be caught.
 */
function result(facts, extra = {}) {
  return { configuredFixtureScenario: "native_talk_to_npc_v1", bridgeFacts: facts, ...extra };
}

const dialogueFact = (id, pages, { speaker = "Gus", isQuestion = false } = {}) => ({
  type: "world_fact",
  eventId: id,
  sourceEventId: id,
  worldFactKind: "npc_dialogue_presented",
  worldFactPayload: { speaker, pages, isQuestion, choices: [] },
});

test("a multi-page dialogue in one box passes", () => {
  const verdict = judgeDialogueStream(result([dialogueFact("npc_dialogue_900_1", ["a", "b", "c"])]));
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.reason, "dialogue_stream_closed");
  assert.equal(verdict.observed.pagedAs, "multi_page_single_box");
});

test("a dialogue the game split across boxes ALSO passes, counted across its facts", () => {
  // The reviewer's finding, pinned: a correct pager reports one fact per box, so a per-fact ">= 2 pages" test would
  // fail this run.
  const verdict = judgeDialogueStream(result([dialogueFact("npc_dialogue_900_1", ["a"]), dialogueFact("npc_dialogue_901_2", ["b"])]));
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.observed.pagedAs, "chain_of_boxes");
  assert.equal(verdict.observed.maxPages, 1);
  assert.equal(verdict.observed.chainLength, 2);
});

test("a pager that only read the current page is caught", () => {
  const verdict = judgeDialogueStream(result([dialogueFact("npc_dialogue_900_1", ["only page"])]));
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /g2/);
});

test("never talking to anyone is UNOBSERVED, never a pass", () => {
  const verdict = judgeDialogueStream(result([]));
  assert.equal(verdict.state, "unobserved");
  assert.match(verdict.reason, /no_dialogue_reported/);
});

test("a run against the wrong fixture is blocked rather than judged", () => {
  const verdict = judgeDialogueStream({ bridgeFacts: [dialogueFact("npc_dialogue_900_1", ["a", "b"])] });
  assert.equal(verdict.state, "blocked");
  assert.equal(verdict.reason, "fixture_not_configured");
});

test("the wrong speaker fails G3", () => {
  const verdict = judgeDialogueStream(result([dialogueFact("npc_dialogue_900_1", ["a", "b"], { speaker: "Pierre" })]));
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /g3/);
});

test("a shared identity across two facts fails G4", () => {
  const verdict = judgeDialogueStream(result([dialogueFact("npc_dialogue_900_1", ["a"]), dialogueFact("npc_dialogue_900_1", ["b"])]));
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /g4/);
});

test("the Mod answering for the Agent fails G5 on an informational dialogue", () => {
  const verdict = judgeDialogueStream(
    result([
      dialogueFact("npc_dialogue_900_1", ["a", "b"]),
      { type: "execution_receipt", action: "answer_dialogue", reasonCode: "dialogue_answered" },
    ]),
  );
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /g5/);
});

test("G6 is asserted only when a session file is supplied", () => {
  const facts = [dialogueFact("npc_dialogue_900_1", ["a", "b"])];
  assert.equal(judgeDialogueStream(result(facts)).g.g6, "not_checked");
  assert.equal(judgeDialogueStream(result(facts), { sessionText: "Gus: hello there" }).g.g6, true);
  const missing = judgeDialogueStream(result(facts), { sessionText: "nothing of the sort" });
  assert.equal(missing.state, "blocked");
  assert.match(missing.reason, /g6/);
});

test("dialogueFacts ignores other world facts and other fact types", () => {
  const mixed = [
    dialogueFact("npc_dialogue_900_1", ["a", "b"]),
    { type: "world_fact", worldFactKind: "day_started", eventId: "d1", worldFactPayload: {} },
    { type: "execution_receipt", action: "move_to_tile", reasonCode: "target_reached" },
  ];
  const found = dialogueFacts(result(mixed));
  assert.equal(found.length, 1);
  assert.equal(found[0].eventId, "npc_dialogue_900_1");
});
