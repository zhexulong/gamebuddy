import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME2_ID,
  GAME2_ADAPTER_VERSION,
  GAME2_KNOWN_ACTIONS,
  createGame2Adapter,
} from "./game2-adapter.js";
import type {
  GameActionDispatchInput,
  GameActionDispatchResult,
  GamePostconditionEvaluationInput,
} from "../game-adapter.js";

test("createGame2Adapter returns default metadata and actions", async () => {
  const adapter = createGame2Adapter();
  assert.equal(adapter.gameId, GAME2_ID);
  assert.equal(adapter.version, GAME2_ADAPTER_VERSION);

  const actions = await adapter.getPublishedActions?.();
  assert.ok(actions);
  assert.equal(actions.length, GAME2_KNOWN_ACTIONS.length);
  assert.equal(actions[0].actionId, "move_player");
  assert.equal(actions[1].actionId, "interact");

  const status = await adapter.getStatus?.();
  assert.ok(status);
  assert.equal(status.gameId, GAME2_ID);
  assert.equal(status.connected, false);
});

test("defaultGame2ActionExecutor rejects invalid or unknown actionId", async () => {
  const adapter = createGame2Adapter();

  const emptyResult = await adapter.dispatchAction({
    actionId: "",
    requestId: "req_empty",
    executionId: "exec_empty",
  });
  assert.equal(emptyResult.status, "rejected");
  assert.equal(emptyResult.error, "invalid_action_id");

  const unknownResult = await adapter.dispatchAction({
    actionId: "fly_ship",
    requestId: "req_unknown",
    executionId: "exec_unknown",
  });
  assert.equal(unknownResult.status, "rejected");
  assert.ok(unknownResult.error?.includes("unknown_game2_action"));
});

test("defaultGame2ActionExecutor reports failed when no active bridge session is bound", async () => {
  const adapter = createGame2Adapter();

  const result = await adapter.dispatchAction({
    actionId: "move_player",
    requestId: "req_01",
    executionId: "exec_01",
    parameters: { x: 100, y: 200 },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "no_active_game2_bridge_session");
  assert.equal(result.receipt?.outcome, "failure");
});

test("createGame2Adapter supports fixture injection for action dispatch and postcondition", async () => {
  const dispatchedRequests: GameActionDispatchInput[] = [];

  const adapter = createGame2Adapter({
    actionExecutor: async (input: GameActionDispatchInput): Promise<GameActionDispatchResult> => {
      dispatchedRequests.push(input);
      return Object.freeze({
        executionId: input.executionId,
        status: "completed",
        receipt: Object.freeze({
          outcome: "success",
          reason: "player_moved",
          evidence: Object.freeze({ x: 100, y: 200 }),
        }),
      });
    },
    postconditionEvaluator: async (input: GamePostconditionEvaluationInput) => {
      const receipt = input.receipt as { outcome?: string; evidence?: unknown } | undefined;
      const verified = receipt?.outcome === "success";
      return Object.freeze({
        verified,
        reason: verified ? "player_arrived" : "player_not_arrived",
        evidence: receipt?.evidence,
      });
    },
  });

  const dispatchResult = await adapter.dispatchAction({
    actionId: "move_player",
    requestId: "req_inject",
    executionId: "exec_inject",
    parameters: { x: 100, y: 200 },
  });

  assert.equal(dispatchResult.status, "completed");
  assert.equal(dispatchResult.receipt?.outcome, "success");
  assert.equal(dispatchedRequests.length, 1);

  const evalResult = await adapter.evaluatePostcondition({
    actionId: "move_player",
    executionId: "exec_inject",
    receipt: dispatchResult.receipt,
  });

  assert.equal(evalResult.verified, true);
  assert.equal(evalResult.reason, "player_arrived");
  assert.deepEqual(evalResult.evidence, { x: 100, y: 200 });
});
