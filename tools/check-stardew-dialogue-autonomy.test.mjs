import assert from "node:assert/strict";
import test from "node:test";

import { judgeDialogueAutonomy } from "./check-stardew-dialogue-autonomy.mjs";

/**
 * The judge's own contract. Each case is a way the autonomy claim could be satisfied while proving nothing, which
 * is the failure mode this repo keeps meeting: a gate that passes on a run that did not test the thing.
 */

const PURITY = [{ role: "user", goal: "去镇上的酒馆找个人聊聊天，然后回来告诉我你们都聊了些什么。" }];

function result(overrides = {}) {
  return {
    configuredFixtureScenario: "native_talk_to_npc_multi_page_v1",
    sessionTurns: PURITY,
    bridgeFacts: [
      {
        type: "world_fact",
        eventId: "npc_dialogue_94_1",
        correlationId: "npc_dialogue_94_1",
        worldFactKind: "npc_dialogue_presented",
        worldFactPayload: {
          kind: "npc_dialogue_presented",
          payloadJson: JSON.stringify({ speaker: "Lewis", pages: ["a", "b"], isQuestion: false, choices: [] }),
        },
      },
      {
        type: "execution_receipt",
        reasonCode: "talk_to_npc_talked",
        requestId: "9f1c2d3e-aaaa-bbbb-cccc-000000000001",
        executionId: "exec-1",
      },
    ],
    ...overrides,
  };
}

test("a pure goal, a reported dialogue and a tool-layer talk PASS", () => {
  // The transcript must carry the PAGES (not merely the speaker) - see the A5-strength case below for why.
  const verdict = judgeDialogueAutonomy(result(), { sessionText: 'the model saw: Lewis said "a" and "b"' });
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.g.a1, true);
  assert.equal(verdict.g.a5, true);
});

test("a goal that names the mechanism is BLOCKED, however complete the run looks", () => {
  for (const goal of [
    "去用 talk_to_npc 找 Lewis 聊聊天",
    "走到 12,14 然后跟人说话",
    "先走过去，然后打开对话框",
    "go talk to the villager and expect a dialogue box",
  ]) {
    const verdict = judgeDialogueAutonomy(result({ sessionTurns: [{ role: "user", goal }] }), {});
    assert.equal(verdict.state, "blocked", goal);
    assert.match(verdict.reason, /^prompt_not_pure/);
  }
});

test("ordinary connective words are NOT impure: the card's own example goal uses them", () => {
  // This is the rule that had to be loosened, and the reason matters: `然后` was flagged as a "step sequence",
  // which made the judge reject the frozen card's own example prompt ("去跟 <村民> 说句话，然后回来告诉我你做了
  // 什么"). A purity rule must reject MECHANISM leaks, not natural speech.
  for (const goal of [
    "去跟村民说句话，然后回来告诉我你做了什么",
    "先去镇上，接着回来",
    "找个人聊聊天，最后告诉我聊了什么",
  ]) {
    const verdict = judgeDialogueAutonomy(result({ sessionTurns: [{ role: "user", goal }] }), {});
    assert.notEqual(verdict.state, "blocked", goal);
  }
});

test("no goal at all cannot be judged for autonomy", () => {
  const verdict = judgeDialogueAutonomy(result({ sessionTurns: [] }), {});
  assert.equal(verdict.state, "blocked");
  assert.equal(verdict.reason, "no_player_goal_recorded");
});

test("never talking is UNOBSERVED, not passed - and it names what the Agent did try", () => {
  const verdict = judgeDialogueAutonomy(
    result({ bridgeFacts: [], attemptedActionIds: ["move_to_tile"], succeededActionIds: [] }),
    {},
  );
  assert.equal(verdict.state, "unobserved");
  assert.match(verdict.reason, /no_dialogue_fact/);
  assert.deepEqual(verdict.observed.attempted, ["move_to_tile"]);
});

test("a transcript that carries only the SPEAKER does not satisfy A5: it must carry the dialogue TEXT", () => {
  // The gap a first version had: the speaker name is satisfied by the talk receipt itself (`npc=Lewis`), so A5
  // passed a run whose dialogue text never reached the model. The card's own live run looked exactly like that
  // until the session was read closely, so this case pins the difference.
  const speakerOnly = judgeDialogueAutonomy(result(), { sessionText: "tool result: npc=Lewis;talked_to_today=true" });
  assert.equal(speakerOnly.state, "blocked");
  assert.match(speakerOnly.reason, /a5/);

  // Both pages present IS a pass (the transcript may store them JSON-escaped; the judge searches both forms).
  const both = judgeDialogueAutonomy(result(), { sessionText: 'Lewis said: "a" and also "b"' });
  assert.equal(both.state, "passed");
  assert.equal(both.g.a5, true);

  // Only ONE of two pages is not enough: a truncating delivery must not pass.
  const partial = judgeDialogueAutonomy(result(), { sessionText: 'Lewis said: "a"' });
  assert.equal(partial.state, "blocked");
  assert.match(partial.reason, /a5/);
});

test("a dialogue fact with no talk receipt is BLOCKED: the fact alone does not prove the Agent acted", () => {
  const verdict = judgeDialogueAutonomy(
    result({ bridgeFacts: [result().bridgeFacts[0]] }),
    {},
  );
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /a3/);
});

test("a harness-prefixed requestId fails A4: the dispatch must come from the tool layer", () => {
  const facts = result().bridgeFacts.map((fact) =>
    fact.type === "execution_receipt" ? { ...fact, requestId: "native_local_dialogue_stream_1" } : fact,
  );
  const verdict = judgeDialogueAutonomy(result({ bridgeFacts: facts }), {});
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /a4/);
});

test("without a transcript A5 is not_checked, and the verdict still passes on what was provable", () => {
  const verdict = judgeDialogueAutonomy(result(), {});
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.g.a5, "not_checked");
  assert.equal(verdict.observed.attestedInContext, false);
});

test("a pinned prompt hash must match exactly", () => {
  const wrong = judgeDialogueAutonomy(result(), { pinnedPromptHash: "0".repeat(64) });
  assert.equal(wrong.state, "blocked");
  assert.match(wrong.reason, /^prompt_hash_mismatch/);
});
