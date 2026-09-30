/**
 * A→B Body Program live gate for the native-local player topology.
 *
 * Verifies, on a real target-version Stardew/SMAPI session with the real Mod,
 * that one RFC 6901-bound Body Program (A: machine_inspect producing the
 * machine_target_id fact; B: machine_load binding expectedTargetId to that
 * fact) is verified and accepted by the Mod, then automatically advanced by
 * the Mod-owned controller on the game thread without any second Agent turn,
 * producing a terminal `machine_coffee_loaded` receipt with intact evidence
 * and postcondition.
 *
 * Reuses the same fixture/flags and dist-test client loading as the
 * Navigation mutation smoke. The program wire calls (programSubmit /
 * programStatus / programEvents) are the same wire the materializer's
 * stardew_submit_action_program tool sends (submit performs authoritative
 * validation with zero-side-effect rejection); the admission responder here
 * mirrors the Host side of the body_node_admission_challenge/result contract.
 */
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForActionable,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_machine_coffee_load_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "machine_inspect", "machine_load"];
const REQUIRED_CAPABILITIES = [
  "cancel_active_execution",
  "inspect_self",
  "machine_inspect",
  "machine_load",
  "move_to_tile",
];

/** Load the emitted Host client from the local dist-test artifact. */
async function loadDistTestClient(entry) {
  const { LocalStardewBridgeClient, bindLocalStardewBridgeBodyNodeAdmission } = await import(`../host/dist-test/${entry}`);
  return { LocalStardewBridgeClient, bindLocalStardewBridgeBodyNodeAdmission };
}

/** One RFC 6901-bound A→B candidate: inspect produces machine_target_id, load consumes it. */
export function buildABProgram(target, { programId }) {
  return {
    programId,
    nodes: [
      {
        nodeId: "inspect",
        actionId: "machine_inspect",
        arguments: {
          x: { type: "integer", canonicalValue: String(target.x) },
          y: { type: "integer", canonicalValue: String(target.y) },
          expectedTargetId: { type: "string", canonicalValue: target.targetId },
        },
        dependsOn: [],
        bindings: {},
      },
      {
        nodeId: "load",
        actionId: "machine_load",
        arguments: {
          slot: { type: "integer", canonicalValue: String(target.loadInputSlot) },
          x: { type: "integer", canonicalValue: String(target.x) },
          y: { type: "integer", canonicalValue: String(target.y) },
          expectedQualifiedItemId: { type: "string", canonicalValue: target.loadInputQualifiedItemId },
          // The descriptor requires every argument present; the runtime value is
          // replaced by the producer fact through the RFC 6901 binding below.
          expectedTargetId: { type: "string", canonicalValue: "bound-from-inspect" },
        },
        dependsOn: ["inspect"],
        bindings: { expectedTargetId: { nodeId: "inspect", factName: "machine_target_id" } },
      },
    ],
  };
}

/** Host-side admission responder mirroring the materializer's decision surface. */
export function createLocalAdmissionResponder(client, { grantIdPrefix = "host_grant" } = {}) {
  let admitted = 0;
  return async function respondToAdmissionChallenge(challenge) {
    const state = client.state;
    const visible =
      state?.catalogRegistrations?.some(
        (registration) =>
          registration?.actionId === challenge?.actionId &&
          (state.enabledActionIds === undefined || state.enabledActionIds.includes(challenge.actionId)),
      ) ?? false;
    if (!visible) return { ...challenge, result: "rejected", code: "policy_denied" };
    if (state?.catalogRevision !== undefined && challenge?.catalogRevision !== state.catalogRevision)
      return { ...challenge, result: "rejected", code: "catalog_stale" };
    admitted += 1;
    return {
      ...challenge,
      result: "granted",
      grantId: `${grantIdPrefix}_${admitted}`,
      attachmentGeneration: state?.sessionId ?? "local_session",
      policyRevision: state?.policyIdentity?.value ?? "local_policy",
      executionBinding: null,
    };
  };
}

/** Poll program_status until the program reaches a terminal state. */
export async function waitForProgramTerminal(client, programId, { timeoutMs = 600_000, intervalMs = 250 } = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const status = await client.programStatus({ programId });
    last = status?.snapshot ?? null;
    if (last !== null) {
      const terminal = ["succeeded", "failed", "cancelled", "quarantined", "recovery_required"].includes(last.state);
      if (terminal) return { state: last.state, snapshot: last, status };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`program_terminal_timeout:${last?.state ?? "no_snapshot"}`);
}

/** Run the A→B gate against an already-connected bridge session. */
export async function runMachineABSmoke(
  client,
  receipts,
  config,
  { bindAdmission, terminalTimeoutMs = 600_000, postconditionTimeoutMs = 15_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  const programId = `ab_program_${Date.now()}`;
  try {
    validateNativeLocalFixtureConfig(config);
    if (typeof bindAdmission !== "function") throw new Error("admission_binder_required");
    const before = await requireActionableMachineSnapshot(client);
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    const target = chooseOnlyLoadableKeg(before);
    // Nodes carry no clock field: the Mod derives each action's execution budget
    // from its descriptor-owned static watchdog at admission time (watchdog
    // authority; Agent-facing candidates never submit deadlines).
    const program = buildABProgram(target, { programId });

    // submit performs authoritative validation; rejected candidates return
    // bounded diagnostics with zero side effects, so no separate verify round
    // trip exists.
    const submit = await client.programSubmit(program);
    trace.push({ phase: "program_submit", code: submit.code, diagnostics: submit.verification?.diagnostics ?? [] });
    if (submit.code !== "accepted")
      throw new Error(`program_submit_not_accepted:${submit.code}:${JSON.stringify(submit.verification?.diagnostics ?? [])}`);

    // The Mod-owned controller now advances the graph on the game thread:
    // inspect executes first, its machine_target_id fact materializes B's
    // expectedTargetId binding, and load executes without any Agent turn.
    const terminal = await waitForProgramTerminal(client, programId, { timeoutMs: terminalTimeoutMs });
    trace.push({ phase: "program_terminal", state: terminal.state });
    if (terminal.state !== "succeeded")
      throw new Error(`program_terminal_not_succeeded:${terminal.state}`);

    // Collect the B node terminal receipt from the fact stream.
    const loadNodes = terminal.snapshot?.nodes ?? [];
    const loadNode = loadNodes.find((node) => node?.nodeId === "load");
    const terminalReceipt = receipts.find(
      (receipt) =>
        receipt?.actionId === "machine_load" &&
        ["succeeded", "failed", "cancelled", "expired", "uncertain"].includes(receipt?.state),
    );
    if (loadNode?.state !== "succeeded" || terminalReceipt?.state !== "succeeded")
      throw new Error(`machine_load_node_not_succeeded:${loadNode?.state ?? "missing"}/${terminalReceipt?.state ?? "no_receipt"}`);
    const evidence = parseEvidence(terminalReceipt.evidence);

    const after = await waitForFreshSnapshot(client, {
      minRevision: terminalReceipt.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: false,
      check: (snapshot) => Array.isArray(snapshot.machineTargets),
    });
    const reread = (after.machineTargets ?? []).find((entry) => entry?.targetId === target.targetId);
    const passed =
      terminalReceipt.reasonCode === "machine_coffee_loaded" &&
      reread?.qualifiedItemId === "(BC)12" &&
      reread.readyForHarvest === false &&
      // Live game time flows after the load: minutesUntilReady starts at 120
      // and ticks down on the real clock, so accept any value in (0, 120].
      Number.isInteger(reread.minutesUntilReady) &&
      reread.minutesUntilReady >= 1 &&
      reread.minutesUntilReady <= 120 &&
      reread.heldObjectQualifiedItemId === "(O)395" &&
      reread.lastInputQualifiedItemId === "(O)433" &&
      evidence.location === before.location &&
      evidence.target === target.targetId &&
      evidence.machine === "(BC)12" &&
      evidence.input === "(O)433";
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "a_to_b_machine_loaded" : "a_to_b_postcondition_mismatch",
      programId,
      program: { nodes: program.nodes.map((node) => ({ nodeId: node.nodeId, actionId: node.actionId })) },
      submit: { code: submit.code, diagnostics: submit.verification?.diagnostics ?? [] },
      terminal: { state: terminal.state, nodeState: loadNode?.state ?? null },
      receipt: summarizeReceipt(terminalReceipt),
      evidence,
      reread: summarizeTarget(reread),
      before: summarizeWithMachines(before),
      after: summarizeWithMachines(after),
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      programId,
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadDistTestClient });
  try {
    const { bindLocalStardewBridgeBodyNodeAdmission } = await loadDistTestClient("local-stardew-bridge.js");
    const responder = createLocalAdmissionResponder(session.client);
    bindLocalStardewBridgeBodyNodeAdmission(session.client, responder);
    const result = await runMachineABSmoke(session.client, session.receipts, config, {
      bindAdmission: (client) => bindLocalStardewBridgeBodyNodeAdmission(client, responder),
    });
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateNativeLocalFixtureConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    typeof fixture.LogicalSaveName !== "string" ||
    !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(fixture.LogicalSaveName) ||
    typeof fixture.ObservedSaveSlot !== "string" ||
    !new RegExp(`^${fixture.LogicalSaveName}_[0-9]{1,32}$`).test(fixture.ObservedSaveSlot)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}

async function requireActionableMachineSnapshot(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (
    !Number.isInteger(snapshot?.tile?.x) ||
    !Number.isInteger(snapshot?.tile?.y) ||
    !Array.isArray(snapshot?.capabilities) ||
    !Array.isArray(snapshot?.warps) ||
    !Array.isArray(snapshot?.machineTargets)
  )
    throw new Error("native_local_machine_snapshot_facts_missing");
  return snapshot;
}

function adjacent(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.y - right.y) <= 1
  );
}

function validMachineTargets(snapshot) {
  return (snapshot.machineTargets ?? []).filter(
    (target) =>
      Number.isInteger(target?.x) &&
      Number.isInteger(target?.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      typeof target.targetId === "string" &&
      target.targetId.length > 0 &&
      typeof target.qualifiedItemId === "string" &&
      target.qualifiedItemId.length > 0 &&
      typeof target.readyForHarvest === "boolean" &&
      Number.isInteger(target.minutesUntilReady) &&
      (target.heldObjectQualifiedItemId == null || typeof target.heldObjectQualifiedItemId === "string") &&
      (target.lastInputQualifiedItemId == null || typeof target.lastInputQualifiedItemId === "string") &&
      adjacent(snapshot.tile, target),
  );
}

function chooseOnlyLoadableKeg(snapshot) {
  const targets = validMachineTargets(snapshot).filter(
    (entry) =>
      entry.qualifiedItemId === "(BC)12" &&
      entry.readyForHarvest === false &&
      entry.minutesUntilReady === 0 &&
      entry.heldObjectQualifiedItemId == null &&
      entry.lastInputQualifiedItemId == null &&
      Number.isInteger(entry.loadInputSlot) &&
      entry.loadInputQualifiedItemId === "(O)433" &&
      entry.loadInputStack === 5,
  );
  if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_loadable_keg" : "no_loadable_keg");
  return targets[0];
}

function parseEvidence(receiptEvidence) {
  const detail = typeof receiptEvidence?.detail === "string" ? receiptEvidence.detail : "";
  const fields = Object.fromEntries(
    detail.split(";").map((part) => {
      const index = part.indexOf("=");
      return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : ["", ""];
    }),
  );
  return fields;
}

function summarizeTarget(target) {
  if (target === null || target === undefined) return null;
  return {
    targetId: target.targetId,
    x: target.x,
    y: target.y,
    qualifiedItemId: target.qualifiedItemId,
    readyForHarvest: target.readyForHarvest,
    minutesUntilReady: target.minutesUntilReady,
    heldObjectQualifiedItemId: target.heldObjectQualifiedItemId ?? null,
    lastInputQualifiedItemId: target.lastInputQualifiedItemId ?? null,
    loadInputSlot: target.loadInputSlot ?? null,
    loadInputQualifiedItemId: target.loadInputQualifiedItemId ?? null,
    loadInputStack: target.loadInputStack ?? null,
  };
}

function summarizeWithMachines(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    machineTargets: snapshot.machineTargets?.map(summarizeTarget) ?? [],
  };
}

function same(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}