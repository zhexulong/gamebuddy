import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "toggle_mine_lamp";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Toggle one native MineShaft Lamp tile through the Lamp action. */
export async function runToggleMineLampSmoke(client, receipts, config, { terminalTimeoutMs = 8_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    const snapshot = await waitForFreshSnapshot(client, { requireActionable: true, timeoutMs: 15_000 });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseMineLampTarget(snapshot);
    const requestId = `native_local_toggle_mine_lamp_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: `${target.x},${target.y}`, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("toggle_mine_lamp_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "mine_lamp_toggled")
      throw new Error(`toggle_mine_lamp_failed:${terminal.reasonCode}`);
    const evidence = parseEvidence(terminal.evidence);
    const passed = evidence.handled === "true" && evidence.tile === `${target.x},${target.y}`;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "mine_lamp_toggled" : "mine_lamp_postcondition_mismatch",
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

function chooseMineLampTarget(snapshot) {
  const targets = snapshot.mineLampTargets ?? [];
  const target = targets.find((entry) => Number.isInteger(entry?.x) && Number.isInteger(entry?.y));
  if (!target) throw new Error("mine_lamp_target_missing");
  return target;
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (!detail) throw new Error("toggle_mine_lamp_evidence_empty");
  return Object.fromEntries(detail.split(";").map((pair) => {
    const index = pair.indexOf("=");
    return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
  }).filter(Boolean));
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runToggleMineLampSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}