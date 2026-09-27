import assert from "node:assert/strict";
import test from "node:test";
import { runToolRecoveryChainSmoke } from "./run-stardew-native-local-player-tool-recovery-chain-smoke.mjs";

const CAPABILITIES = ["cancel_active_execution", "equip_tool", "inspect_self", "move_to_tile", "travel", "till_soil"];

function fixtureConfig(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "native_till_soil_v1",
      LogicalSaveName: "GameBuddyFixture",
      ObservedSaveSlot: "GameBuddyFixture_445094166",
    },
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ActionPolicyVersion: 0,
    EnabledActions: ["move_to_tile", "travel", "equip_tool", "till_soil"],
    ...overrides,
  };
}

/** Fake client replaying the exact recovery chain (breakpoint -> recover -> retry). */
function createFake() {
  const listeners = new Set();
  let revision = 7;
  let tool = "Axe";
  let hoeEquipped = false;
  let tilled = false;
  const snapshotOf = () => ({
    revision,
    location: "Farm",
    tile: { x: 2, y: 2 },
    actionable: true,
    activeExecution: null,
    capabilities: CAPABILITIES,
    toolSlots: [{ label: "Hoe", slot: 0 }, { label: "Axe", slot: 1 }],
    currentTool: tool,
    soilTiles: tilled ? [] : [{ x: 2, y: 1 }],
  });
  const client = {
    state: { snapshot: snapshotOf() },
    observe: async () => {
      const snapshot = snapshotOf();
      client.state.snapshot = snapshot;
      return snapshot;
    },
    execute: async ({ requestId, action, args }) => {
      const executionId = `execution-${action}-${requestId}`;
      if (action === "equip_tool") {
        revision += 1;
        tool = "Hoe";
        return { requestId, executionId, state: "succeeded", reasonCode: "tool_equipped", revision };
      }
      if (action === "till_soil") {
        if (!hoeEquipped) {
          // Deterministic breakpoint: rejected before any native ingress.
          hoeEquipped = tool.toLowerCase().includes("hoe");
          if (!hoeEquipped) {
            revision += 1;
            return { requestId, executionId, state: "rejected", reasonCode: "hoe_not_equipped", revision };
          }
        }
        revision += 1;
        const receipt = { requestId, executionId, state: "accepted", reasonCode: "accepted", revision };
        publish(receipt);
        tilled = true;
        publish({
          ...receipt,
          state: "succeeded",
          reasonCode: "soil_tilled",
          revision,
          evidence: { detail: `location=Farm;target=${args.x},${args.y};before=none;after=HoeDirt;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2` },
        });
        return receipt;
      }
      throw new Error(`unexpected_action:${action}`);
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = (payload) => {
    for (const listener of listeners) listener({ type: "execution_receipt", payload });
  };
  return client;
}

test("recovery-chain runner passes with breakpoint -> equip -> retry in one journal", async () => {
  const client = createFake();
  const receipts = [];
  client.onFact((fact) => {
    if (fact.type === "execution_receipt") receipts.push(fact.payload);
  });
  const result = await runToolRecoveryChainSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "soil_tilled");
  assert.deepEqual(result.target, { x: 2, y: 1 });
  // Three receipts from the same session {requestId, executionId, reasonCode}.
  assert.equal(result.chain.breakpoint.reasonCode, "hoe_not_equipped");
  assert.equal(result.chain.recovery.reasonCode, "tool_equipped");
  assert.equal(result.chain.retry.reasonCode, "soil_tilled");
  assert.equal(result.chain.contiguousJournal, true);
  // Monotonic revisions and distinct execution ids prove the journal sequence.
  assert.ok(result.chain.breakpoint.revision < result.chain.recovery.revision);
  assert.ok(result.chain.recovery.revision < result.chain.retry.revision);
  assert.notEqual(result.chain.breakpointReceipt.executionId, result.chain.recoveryReceipt.executionId);
  assert.notEqual(result.chain.recoveryReceipt.executionId, result.chain.retryReceipt.executionId);
  assert.equal(result.evidence.before, "none");
  assert.equal(result.evidence.after, "HoeDirt");
  assert.equal(result.freshTargetGone, true);
  assert.equal(result.after.revision, result.receipt.revision);
});

test("recovery-chain runner fails when the breakpoint does not reject (Hoe already equipped)", async () => {
  const client = createFake();
  // Force the default tool to already be the Hoe so the breakpoint is absent.
  client.observe = async () => {
    const before = await createFake().observe();
    before.currentTool = "Hoe";
    before.toolSlots = [{ label: "Hoe", slot: 0 }];
    client.state.snapshot = before;
    return before;
  };
  const receipts = [];
  const result = await runToolRecoveryChainSmoke(client, receipts, fixtureConfig());
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /breakpoint_unavailable_hoe_already_equipped/);
});

test("recovery-chain runner rejects a non-isolated action policy", async () => {
  const client = createFake();
  await assert.rejects(
    runToolRecoveryChainSmoke(client, [], fixtureConfig({ EnabledActions: ["till_soil"] })),
    (error) => error?.message === "native_local_till_soil_action_policy_invalid",
  );
});