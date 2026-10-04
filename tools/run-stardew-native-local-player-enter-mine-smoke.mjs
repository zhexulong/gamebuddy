import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "enter_mine";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Enter the live mine entrance tile through the native Mine action (normal game progression, no level selector). */
export async function runEnterMineSmoke(client, receipts, config, { terminalTimeoutMs = 10_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    const snapshot = await waitForFreshSnapshot(client, { requireActionable: true, timeoutMs: 15_000 });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseMineEntranceTarget(snapshot);
    const requestId = `native_local_enter_mine_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: target.targetId, slot: null, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("enter_mine_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "mine_entered")
      throw new Error(`enter_mine_failed:${terminal.reasonCode}`);
    const evidence = parseEvidence(terminal.evidence);
    const passed = Number.isInteger(Number(evidence.level)) && Number(evidence.level) >= 1;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "mine_entered" : "mine_entry_postcondition_mismatch",
      target,
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

function chooseMineEntranceTarget(snapshot) {
  const targets = snapshot.mineEntranceTargets ?? [];
  const target = targets.find((entry) => entry?.targetId && Number.isInteger(entry.x) && Number.isInteger(entry.y));
  if (!target) throw new Error("enter_mine_target_missing");
  return target;
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (!detail) throw new Error("enter_mine_evidence_empty");
  return Object.fromEntries(detail.split(";").map((pair) => {
    const index = pair.indexOf("=");
    return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
  }).filter(Boolean));
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runEnterMineSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}