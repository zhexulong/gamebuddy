import assert from "node:assert/strict";
import test from "node:test";
import {
  STARDEW_GAME_ID,
  STARDEW_ADAPTER_VERSION,
  STARDEW_KNOWN_ACTIONS,
  createStardewGameAdapter,
  type StardewGameAdapterOptions,
} from "./stardew-game-adapter.js";
import type {
  GameActionDispatchInput,
  GameActionDispatchResult,
  GamePostconditionEvaluationInput,
  GamePostconditionEvaluationResult,
} from "../../game-adapter.js";

test("createStardewGameAdapter returns default metadata and actions", async () => {
  const adapter = createStardewGameAdapter();
  assert.equal(adapter.gameId, STARDEW_GAME_ID);
  assert.equal(adapter.version, STARDEW_ADAPTER_VERSION);

  const actions = await adapter.getPublishedActions?.();
  assert.deepEqual(actions, STARDEW_KNOWN_ACTIONS);

  const status = await adapter.getStatus?.();
  assert.deepEqual(status, {
    gameId: STARDEW_GAME_ID,
    connected: false,
    version: STARDEW_ADAPTER_VERSION,
    statusText: "standby",
  });
});

test("defaultStardewActionExecutor rejects empty actionId", async () => {
  const adapter = createStardewGameAdapter();
  const input: GameActionDispatchInput = {
    actionId: "",
    requestId: "req-1",
    executionId: "exec-1",
  };
  const result = await adapter.dispatchAction(input);
  assert.equal(result.status, "rejected");
  assert.equal(result.error, "invalid_action_id");
  assert.equal(result.receipt?.outcome, "rejected");
});

test("defaultStardewActionExecutor rejects unknown actionId", async () => {
  const adapter = createStardewGameAdapter();
  const input: GameActionDispatchInput = {
    actionId: "fly_rocket",
    requestId: "req-2",
    executionId: "exec-2",
  };
  const result = await adapter.dispatchAction(input);
  assert.equal(result.status, "rejected");
  assert.ok(result.error?.includes("unknown_stardew_action"));
  assert.equal(result.receipt?.outcome, "rejected");
});

test("defaultStardewActionExecutor reports failed when no active bridge session is bound", async () => {
  const adapter = createStardewGameAdapter();
  const input: GameActionDispatchInput = {
    actionId: "equip_tool",
    requestId: "req-3",
    executionId: "exec-3",
    parameters: { toolName: "Axe" },
  };
  const result = await adapter.dispatchAction(input);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "no_active_stardew_bridge_session");
  assert.equal(result.receipt?.outcome, "failure");
});

test("createStardewGameAdapter supports fixture injection for action dispatch and postcondition", async () => {
  const mockCalls: GameActionDispatchInput[] = [];
  const options: StardewGameAdapterOptions = {
    actionExecutor: async (input: GameActionDispatchInput): Promise<GameActionDispatchResult> => {
      mockCalls.push(input);
      return {
        executionId: input.executionId,
        status: "completed",
        receipt: {
          outcome: "success",
          evidence: { slot: 0, tool: "Axe" },
        },
      };
    },
    postconditionEvaluator: async (
      input: GamePostconditionEvaluationInput,
    ): Promise<GamePostconditionEvaluationResult> => {
      return {
        verified: true,
        reason: "fixture_verified",
        evidence: input.evidence,
      };
    },
    cancelHandler: async (execId: string) => execId === "exec-mock",
  };

  const adapter = createStardewGameAdapter(options);

  const dispatchInput: GameActionDispatchInput = {
    actionId: "equip_tool",
    requestId: "req-mock",
    executionId: "exec-mock",
    parameters: { toolName: "Axe" },
  };

  const dispatchResult = await adapter.dispatchAction(dispatchInput);
  assert.equal(dispatchResult.status, "completed");
  assert.equal(dispatchResult.receipt?.outcome, "success");
  assert.equal(mockCalls.length, 1);
  assert.deepEqual(mockCalls[0], dispatchInput);

  const postconditionResult = await adapter.evaluatePostcondition({
    actionId: "equip_tool",
    executionId: "exec-mock",
    receipt: dispatchResult.receipt,
    evidence: dispatchResult.receipt?.evidence,
  });
  assert.equal(postconditionResult.verified, true);
  assert.equal(postconditionResult.reason, "fixture_verified");

  const cancelResult = await adapter.cancelAction?.("exec-mock");
  assert.equal(cancelResult, true);
});

test("defaultStardewPostconditionEvaluator verifies receipt outcome", async () => {
  const adapter = createStardewGameAdapter();

  const missingResult = await adapter.evaluatePostcondition({
    actionId: "equip_tool",
    executionId: "exec-test",
  });
  assert.equal(missingResult.verified, false);
  assert.equal(missingResult.reason, "receipt_missing");

  const successResult = await adapter.evaluatePostcondition({
    actionId: "equip_tool",
    executionId: "exec-test",
    receipt: { outcome: "success", details: { slot: 1 } },
  });
  assert.equal(successResult.verified, true);
  assert.equal(successResult.reason, "outcome_success");

  const failureResult = await adapter.evaluatePostcondition({
    actionId: "equip_tool",
    executionId: "exec-test",
    receipt: { outcome: "failure", reason: "inventory_full" },
  });
  assert.equal(failureResult.verified, false);
  assert.equal(failureResult.reason, "inventory_full");
});
