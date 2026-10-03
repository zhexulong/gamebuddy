import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "use_raft";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute one native Raft launch. The action starts rafting only; steering remains native keyboard input. */
export async function runUseRaftSmoke(client, receipts, config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseRaftTarget(snapshot);
    const slot = chooseRaftSlot(snapshot);
    const requestId = `native_local_use_raft_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { slot, x: target.x, y: target.y },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: target.targetId, slot, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("use_raft_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "raft_launched")
      throw new Error(`use_raft_failed:${terminal.reasonCode}`);
    const evidence = parseEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: false, minRevision: terminal.revision });
    const passed = after.revision >= terminal.revision && evidence.is_rafting === "true" && evidence.tile === `${target.x},${target.y}`;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "raft_launched" : "raft_launch_postcondition_mismatch",
      target,
      slot,
      receipt: summarizeReceipt(terminal),
      evidence,
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

function chooseRaftTarget(snapshot) {
  const targets = snapshot.raftTargets ?? [];
  const target = targets.find((entry) => entry?.targetId && Number.isInteger(entry.x) && Number.isInteger(entry.y));
  if (!target) throw new Error("use_raft_target_missing");
  return target;
}

function chooseRaftSlot(snapshot) {
  const matches = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "Raft");
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_raft_slot" : "raft_slot_missing");
  return matches[0].slot;
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (!detail) throw new Error("use_raft_evidence_empty");
  return Object.fromEntries(detail.split(";").map((pair) => {
    const index = pair.indexOf("=");
    return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
  }).filter(Boolean));
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runUseRaftSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
