import assert from "node:assert/strict";
import test from "node:test";
import { runMachineLoadSmoke } from "./run-stardew-native-local-player-machine-load-smoke.mjs";

const capabilities = ["cancel_active_execution", "inspect_self", "machine_load"];
const target = {
  targetId: "keg-target",
  x: 2,
  y: 1,
  qualifiedItemId: "(BC)12",
  readyForHarvest: false,
  minutesUntilReady: 0,
  heldObjectQualifiedItemId: null,
  lastInputQualifiedItemId: null,
  loadInputSlot: 3,
  loadInputQualifiedItemId: "(O)433",
  loadInputStack: 5,
};

const config = {
  ActionPolicyVersion: 0,
  EnabledActions: ["machine_load"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_machine_coffee_load_v1",
  },
};

test("machine-load runner uses shared dispatch, terminal correlation, and fresh reread", async () => {
  let snapshot = {
    revision: 1,
    location: "Farm",
    tile: { x: 2, y: 1 },
    actionable: true,
    activeExecution: null,
    capabilities,
    machineTargets: [target],
  };
  const receipts = [];
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    execute: async (request) => {
      assert.equal(request.action, "machine_load");
      assert.equal(request.expectedRevision, 1);
      assert.deepEqual(request.args, {
        slot: 3,
        x: 2,
        y: 1,
        expectedQualifiedItemId: "(O)433",
        expectedTargetId: "keg-target",
      });
      snapshot = {
        ...snapshot,
        revision: 2,
        machineTargets: [
          {
            ...target,
            readyForHarvest: false,
            minutesUntilReady: 120,
            heldObjectQualifiedItemId: "(O)395",
            lastInputQualifiedItemId: "(O)433",
          },
        ],
      };
      client.state.snapshot = snapshot;
      const accepted = {
        requestId: request.requestId,
        executionId: "machine-load-execution",
        state: "accepted",
        reasonCode: "accepted",
        revision: 2,
      };
      receipts.push({
        ...accepted,
        state: "succeeded",
        reasonCode: "machine_coffee_loaded",
        evidence: {
          detail:
            "location=Farm;target=keg-target;tile=2,1;machine=(BC)12;slot=3;input=(O)433;input_stack_before=5;input_stack_after=removed;last_input=(O)433;held=(O)395;ready_for_harvest=false;minutes_until_ready=120;native_check_action=true",
        },
      });
      return accepted;
    },
  };
  const result = await runMachineLoadSmoke(client, receipts, config);
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "machine_coffee_loaded");
  assert.equal(result.reread.heldObjectQualifiedItemId, "(O)395");
});
