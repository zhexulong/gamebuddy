import assert from "node:assert/strict";
import test from "node:test";
import {
  buildABProgram,
  createLocalAdmissionResponder,
  runMachineABSmoke,
  waitForProgramTerminal,
} from "./run-stardew-native-local-player-machine-ab-smoke.mjs";

const capabilities = ["cancel_active_execution", "inspect_self", "machine_inspect", "machine_load", "move_to_tile"];
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
  EnabledActions: ["move_to_tile", "machine_inspect", "machine_load"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "native_machine_coffee_load_v1",
    LogicalSaveName: "GameBuddyFixtureABTest",
    ObservedSaveSlot: "GameBuddyFixtureABTest_1",
  },
};

test("buildABProgram emits an RFC 6901-bound inspect→load program", () => {
  const program = buildABProgram(target, { programId: "ab_1" });
  assert.equal(program.programId, "ab_1");
  assert.equal(program.nodes.length, 2);
  assert.equal(program.nodes[0].actionId, "machine_inspect");
  assert.equal(program.nodes[1].actionId, "machine_load");
  assert.deepEqual(program.nodes[1].dependsOn, ["inspect"]);
  assert.deepEqual(program.nodes[1].bindings, { expectedTargetId: { nodeId: "inspect", factName: "machine_target_id" } });
  assert.equal(program.nodes[0].arguments.expectedTargetId.canonicalValue, "keg-target");
  assert.equal(program.nodes[1].arguments.expectedQualifiedItemId.canonicalValue, "(O)433");
  // Nodes never carry a clock field; the Mod derives the watchdog at admission.
  assert.equal("deadlineMs" in program.nodes[0], false);
  assert.equal("deadlineMs" in program.nodes[1], false);
});

test("admission responder grants only visible actions and rejects stale catalog", async () => {
  const client = {
    state: {
      sessionId: "session_1",
      catalogRevision: 7,
      policyIdentity: { value: "policy/1", capabilityRevision: 1 },
      catalogRegistrations: [{ actionId: "machine_inspect" }, { actionId: "machine_load" }],
      enabledActionIds: ["move_to_tile", "machine_inspect", "machine_load"],
    },
  };
  const respond = createLocalAdmissionResponder(client);
  const granted = await respond({
    programId: "ab_1", nodeId: "inspect", nodeAttempt: 1, admissionAttempt: 1,
    stopEpoch: 0, catalogRevision: 7, policyIdentity: { value: "policy/1", capabilityRevision: 1 },
    actionId: "machine_inspect", canonicalBoundArgs: {}, derivedResourceClaims: {}, deadlineMs: 1_000_000,
  });
  assert.equal(granted.result, "granted");
  assert.equal(granted.grantId, "host_grant_1");
  const stale = await respond({
    programId: "ab_1", nodeId: "load", nodeAttempt: 1, admissionAttempt: 1,
    stopEpoch: 0, catalogRevision: 8, policyIdentity: { value: "policy/1", capabilityRevision: 1 },
    actionId: "machine_load", canonicalBoundArgs: {}, derivedResourceClaims: {}, deadlineMs: 1_000_000,
  });
  assert.equal(stale.result, "rejected");
  assert.equal(stale.code, "catalog_stale");
  const denied = await respond({
    programId: "ab_1", nodeId: "x", nodeAttempt: 1, admissionAttempt: 1,
    stopEpoch: 0, catalogRevision: 7, policyIdentity: { value: "policy/1", capabilityRevision: 1 },
    actionId: "not_visible", canonicalBoundArgs: {}, derivedResourceClaims: {}, deadlineMs: 1_000_000,
  });
  assert.equal(denied.result, "rejected");
  assert.equal(denied.code, "policy_denied");
});

function makeSuccessMock() {
  let snapshot = {
    revision: 1,
    location: "FarmHouse",
    tile: { x: 2, y: 1 },
    actionable: true,
    activeExecution: null,
    capabilities,
    warps: [],
    machineTargets: [target],
  };
  const receipts = [];
  let programAccepted = false;
  let statusCalls = 0;
  const client = {
    state: { snapshot, catalogRevision: 1, policyIdentity: { value: "policy/1", capabilityRevision: 1 } },
    observe: async () => snapshot,
    programSubmit: async (program) => {
      assert.equal("deadlineMs" in (program.nodes[0] ?? {}), false);
      assert.equal(program.nodes[0].actionId, "machine_inspect");
      assert.equal(program.nodes[1].actionId, "machine_load");
      programAccepted = true;
      return { code: "accepted", verification: { accepted: true, catalogRevision: 1, diagnostics: [] }, snapshot: { programId: program.programId, state: "active", catalogRevision: 1, stopEpoch: 0, eventHighWater: 0, nodes: [] } };
    },
    programStatus: async ({ programId }) => {
      if (!programAccepted) return { code: "not_found", snapshot: null };
      statusCalls += 1;
      // Advance to succeeded on the second poll (the Mod game-thread controller
      // would advance on its own ticks; the mock does the same deterministically).
      const succeeded = statusCalls >= 2;
      const receipt = {
        requestId: "req_load_1",
        executionId: "exec_load_1",
        actionId: "machine_load",
        state: "succeeded",
        reasonCode: "machine_coffee_loaded",
        revision: 2,
        evidence: {
          detail:
            "location=FarmHouse;target=keg-target;tile=2,1;machine=(BC)12;slot=3;input=(O)433;input_stack_before=5;input_stack_after=removed;last_input=(O)433;held=(O)395;ready_for_harvest=false;minutes_until_ready=120;native_check_action=true",
        },
      };
      if (succeeded && !receipts.includes(receipt)) receipts.push(receipt);
      if (succeeded) {
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
      }
      return {
        code: "found",
        snapshot: {
          programId,
          state: succeeded ? "succeeded" : "active",
          catalogRevision: 1,
          stopEpoch: 0,
          eventHighWater: 4,
          nodes: [
            { nodeId: "inspect", state: "succeeded", nodeAttempt: 1, admissionAttempt: 1 },
            { nodeId: "load", state: succeeded ? "succeeded" : "running", nodeAttempt: 1, admissionAttempt: 1 },
          ],
        },
      };
    },
  };
  return { client, receipts };
}

test("A→B smoke submits, auto-advances to succeeded, and proves the postcondition", async () => {
  const { client, receipts } = makeSuccessMock();
  const result = await runMachineABSmoke(client, receipts, config, {
    bindAdmission: () => {},
    terminalTimeoutMs: 5_000,
    postconditionTimeoutMs: 5_000,
  });
  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "a_to_b_machine_loaded");
  assert.equal(result.submit.code, "accepted");
  assert.equal(result.terminal.state, "succeeded");
  assert.equal(result.receipt.reasonCode, "machine_coffee_loaded");
  assert.equal(result.evidence.target, "keg-target");
  assert.equal(result.reread.heldObjectQualifiedItemId, "(O)395");
  assert.equal(result.reread.minutesUntilReady, 120);
});

test("A→B smoke stays blocked (not forged) when the program never reaches terminal", async () => {
  let snapshot = {
    revision: 1,
    location: "FarmHouse",
    tile: { x: 2, y: 1 },
    actionable: true,
    activeExecution: null,
    capabilities,
    warps: [],
    machineTargets: [target],
  };
  const client = {
    state: { snapshot },
    observe: async () => snapshot,
    programSubmit: async (program) => ({ code: "accepted", verification: { accepted: true, catalogRevision: 1, diagnostics: [] }, snapshot: { programId: program.programId, state: "active", catalogRevision: 1, stopEpoch: 0, eventHighWater: 0, nodes: [] } }),
    programStatus: async ({ programId }) => ({
      code: "found",
      snapshot: { programId, state: "active", catalogRevision: 1, stopEpoch: 0, eventHighWater: 0, nodes: [] },
    }),
  };
  const result = await runMachineABSmoke(client, [], config, {
    bindAdmission: () => {},
    terminalTimeoutMs: 200,
    postconditionTimeoutMs: 1_000,
  });
  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /program_terminal_timeout/);
});

test("waitForProgramTerminal resolves on Succeeded and surfaces the snapshot", async () => {
  const client = {
    programStatus: async () => ({
      code: "found",
      snapshot: { programId: "ab_2", state: "succeeded", catalogRevision: 1, stopEpoch: 0, eventHighWater: 1, nodes: [] },
    }),
  };
  const terminal = await waitForProgramTerminal(client, "ab_2", { timeoutMs: 5_000, intervalMs: 10 });
  assert.equal(terminal.state, "succeeded");
  assert.equal(terminal.snapshot.programId, "ab_2");
});