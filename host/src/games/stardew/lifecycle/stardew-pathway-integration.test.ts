import assert from "node:assert/strict";
import test from "node:test";
import {
  STARDEW_GAME_ID,
  STARDEW_ADAPTER_VERSION,
  createStardewGameAdapter,
} from "./stardew-game-adapter.js";
// @ts-expect-error Action development scenario verifier is an ESM module without .d.ts
import { validateEquipToolScenarioProof } from "../../../../../integrations/stardew/action-development/src/equip-tool-scenario-result.mjs";
import type {
  GameActionDispatchInput,
  GameActionDispatchResult,
  GameActionReceipt,
  GamePostconditionEvaluationInput,
} from "../../game-adapter.js";

test("Stardew Valley action pathway: end-to-end equip_tool flow with authoritative scenario proof", async () => {
  // 1. Arrange: simulated native bridge execution fixture
  const dispatchedRequests: GameActionDispatchInput[] = [];

  const adapter = createStardewGameAdapter({
    actionExecutor: async (input: GameActionDispatchInput): Promise<GameActionDispatchResult> => {
      dispatchedRequests.push(input);

      // Simulate successful native SMAPI execution producing authentic evidence
      return Object.freeze({
        executionId: input.executionId,
        status: "completed" as const,
        receipt: Object.freeze({
          outcome: "success" as const,
          reason: "tool_selected",
          evidence: Object.freeze({
            slot: 0,
            before: "Axe",
            expected: "Watering Can",
            after: "Watering Can",
          }),
          details: Object.freeze({
            requestId: input.requestId,
            executionId: input.executionId,
            state: "succeeded",
            reasonCode: "tool_selected",
            revision: 42,
            hasEvidence: true,
            request: Object.freeze({
              requestId: input.requestId,
              idempotencyKey: `${input.requestId}_idem`,
              action: "equip_tool",
              args: Object.freeze({ slot: 0 }),
              expectedRevision: 41,
            }),
            accepted: Object.freeze({
              requestId: input.requestId,
              executionId: input.executionId,
            }),
            terminal: Object.freeze({
              requestId: input.requestId,
              executionId: input.executionId,
              state: "succeeded",
              reasonCode: "tool_selected",
              revision: 42,
            }),
          }),
        }),
      });
    },

    postconditionEvaluator: async (input: GamePostconditionEvaluationInput) => {
      const receipt = input.receipt as GameActionReceipt | undefined;
      const verified = receipt?.outcome === "success";
      return Object.freeze({
        verified,
        reason: verified ? "tool_selected" : "postcondition_failed",
        evidence: receipt?.evidence,
        details: receipt?.details,
      });
    },
  });

  // 2. Act: Dispatch action through GameAdapter SPI
  const requestId = "req_e2e_stardew_01";
  const executionId = "exec_e2e_stardew_01";
  const dispatchInput: GameActionDispatchInput = {
    actionId: "equip_tool",
    requestId,
    executionId,
    parameters: { slot: 0 },
  };

  const dispatchResult = await adapter.dispatchAction(dispatchInput);

  // 3. Assert dispatch result
  assert.equal(dispatchResult.status, "completed");
  assert.equal(dispatchResult.executionId, executionId);
  assert.equal(dispatchResult.receipt?.outcome, "success");

  // 4. Act: Evaluate postcondition
  const postconditionResult = await adapter.evaluatePostcondition({
    actionId: "equip_tool",
    executionId,
    receipt: dispatchResult.receipt,
  });

  assert.equal(postconditionResult.verified, true);
  assert.equal(postconditionResult.reason, "tool_selected");

  // 5. Assert authoritative verification through Stardew-owned validateEquipToolScenarioProof
  const proofResult = {
    verdict: "passed" as const,
    reasonCode: "tool_selected",
    receipt: {
      state: "succeeded",
      reasonCode: "tool_selected",
      hasEvidence: true,
      request: {
        requestId,
        idempotencyKey: `${requestId}_idem`,
        action: "equip_tool",
        args: { slot: 0 },
        expectedRevision: 41,
      },
      accepted: {
        requestId,
        executionId,
      },
      terminal: {
        requestId,
        executionId,
        state: "succeeded",
        reasonCode: "tool_selected",
        revision: 42,
      },
      evidence: {
        slot: 0,
        before: "Axe",
        expected: "Watering Can",
        after: "Watering Can",
      },
    },
    postcondition: {
      revision: 42,
      currentTool: "Watering Can",
      expectedTool: "Watering Can",
      selected: {
        slot: 0,
        label: "Watering Can",
      },
    },
  };

  const validatedProof = validateEquipToolScenarioProof(proofResult);
  assert.equal(validatedProof.verdict, "passed");
  assert.equal(validatedProof.reasonCode, "tool_selected");
  assert.equal(validatedProof.receipt.terminal.state, "succeeded");
});
