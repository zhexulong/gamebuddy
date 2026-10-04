import assert from "node:assert/strict";
import test from "node:test";
import { runWiaAnswerQuestionSmoke } from "./run-stardew-native-local-player-wia-answer-question-smoke.mjs";

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: ["answer_dialogue", "dismiss_modal"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_wia_answer_question_v1",
  },
};

const CAPABILITIES = ["answer_dialogue", "cancel_active_execution", "move_to_tile", "observe_scene", "travel"];

function baseSnapshot(revision, extra) {
  return {
    revision,
    location: "Farm",
    tile: { x: 20, y: 20 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    warps: [],
    soilTiles: [
      { x: 20, y: 20 },
      { x: 34, y: 34 },
      { x: 35, y: 35 },
    ],
    ...extra,
  };
}

function makeClient(overrides = {}) {
  let snapshot = baseSnapshot(5);
  const receipts = [];
  let moveCalls = 0;
  let answerCalls = 0;
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      if (request.action === "move_to_tile") {
        moveCalls++;
        const executionId = `move-exec-${moveCalls}`;
        // The fixture question modal interrupts the first move.
        receipts.push({
          requestId: request.requestId,
          executionId,
          state: "invalidated",
          reasonCode: "modal_interrupted",
          revision: 10,
          evidence: { detail: "interrupted_by=DialogueBox;target_tile=35,35;interrupted_at=20,20;remaining_distance=15;revision=7" },
        });
        snapshot = baseSnapshot(10, { actionable: false, activeExecution: null });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId,
          state: "accepted",
          reasonCode: "accepted",
          revision: 9,
          evidence: { detail: "target=35,35" },
        };
      }
      if (request.action === "answer_dialogue") {
        answerCalls++;
        const executionId = `answer-exec-${answerCalls}`;
        assert.deepEqual(
          request.args,
          { responseKey: "yes" },
          "answer_dialogue args must carry exactly { responseKey } (exact-shape contract)"
        );
        // The Mod answers synchronously: immediate bridge response IS the terminal.
        // The outro closes the dialogue on a later frame; the mock advances
        // the world to the post-outro frame (actionable true) exactly as the
        // live outro does.
        snapshot = baseSnapshot(12, { actionable: true, activeExecution: null });
        client.state.snapshot = snapshot;
        return {
          requestId: request.requestId,
          executionId,
          state: "succeeded",
          reasonCode: "answer_dialogue_answered",
          revision: 12,
          evidence: {
            detail: "modal_type=DialogueBox;question=true;response_key=yes;native_answered=true;outro_started=true;postcondition=dialogue_outro_started",
          },
        };
      }
      throw new Error(`unexpected_action:${request.action}`);
    },
  };
  return { client, receipts, counters: { moveCalls, answerCalls } };
}

test("wia answer question passes the move-interrupted → native-answered loop", async () => {
  const { client, receipts } = makeClient();
  const result = await runWiaAnswerQuestionSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "answer_dialogue_complete");
  assert.equal(result.phases.interrupt.reasonCode, "modal_interrupted");
  assert.equal(result.phases.answer.reasonCode, "answer_dialogue_answered");
  assert.equal(result.interruptEvidence.interrupted_by, "DialogueBox");
  assert.equal(result.interruptEvidence.target_tile, "35,35");
  assert.equal(result.answerEvidence.response_key, "yes");
  assert.equal(result.answerEvidence.native_answered, "true");
  assert.equal(result.answerEvidence.outro_started, "true");
  assert.equal(result.answerOk, true);
  assert.equal(result.after.activeExecution, null);
});

test("wia answer question fails closed when the answer is not accepted", async () => {
  const { client, receipts } = makeClient();
  const originalExecute = client.execute;
  client.execute = async (request) => {
    if (request.action === "answer_dialogue") {
      return {
        requestId: request.requestId,
        executionId: "answer-rejected",
        state: "rejected",
        reasonCode: "response_key_not_offered",
        revision: 11,
        evidence: { detail: "modal_type=DialogueBox;question=true;response_key=yes" },
      };
    }
    return originalExecute(request);
  };
  const result = await runWiaAnswerQuestionSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "answer_missing:state=rejected;reason=response_key_not_offered");
});

test("wia answer question fails closed when the interruption is not classified", async () => {
  const { client, receipts } = makeClient();
  const originalExecute = client.execute;
  client.execute = async (request) => {
    if (request.action === "move_to_tile") {
      const r = await originalExecute(request);
      receipts[receipts.length - 1] = {
        ...receipts[receipts.length - 1],
        state: "succeeded",
        reasonCode: "target_reached",
      };
      return r;
    }
    return originalExecute(request);
  };
  const result = await runWiaAnswerQuestionSmoke(client, receipts, config);
  assert.equal(result.state, "blocked");
});