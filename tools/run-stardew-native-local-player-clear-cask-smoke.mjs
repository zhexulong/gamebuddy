import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "clear_cask";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "equip_tool", ACTION];

/** Execute the clear_cask contract with an explicit Axe equip preflight. */
export async function runClearCaskSmoke(client, receipts, config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    let snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseAdjacentCaskTarget(snapshot);
    const equipped = await executeFresh(client, {
      requestId: `native_local_clear_cask_equip_${Date.now()}`,
      idempotencyKey: `native_local_clear_cask_equip_${Date.now()}_idem`,
      action: "equip_tool", args: { tool: "axe" }, snapshot, timeoutMs: 15_000,
    });
    trace.push({ phase: "equip_tool", receipt: summarizeReceipt(equipped) });
    const equipTerminal = await waitForTerminal(receipts, equipped, terminalTimeoutMs);
    if (equipTerminal.state !== "succeeded" || !["tool_equipped", "already_equipped"].includes(equipTerminal.reasonCode))
      throw new Error(`equip_failed:${equipTerminal.reasonCode}`);

    snapshot = await observeFresh(client, { actionable: true, minRevision: equipTerminal.revision });
    const slot = chooseToolSlot(snapshot, "axe");
    const requestId = `native_local_clear_cask_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId, idempotencyKey: `${requestId}_idem`, action: ACTION,
      args: { slot, x: target.x, y: target.y, expectedTargetId: target.targetId }, snapshot, timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: target.targetId, slot, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("clear_cask_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "cask_cleared")
      throw new Error(`clear_cask_failed:${terminal.reasonCode}`);

    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const passed = after.revision >= terminal.revision && evidence.target === target.targetId && evidence.tool === "axe" && evidence.had_held_object === "false" && evidence.removed === "true" && evidence.postcondition === "true";
    return {
      state: passed ? "passed" : "blocked", topology: "native_local_player_fixture",
      reasonCode: passed ? "cask_cleared" : "clear_cask_postcondition_mismatch", target, slot,
      receipt: summarizeReceipt(terminal), evidence, trace, durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked", topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt), trace, durationMs: Date.now() - startedAt,
    };
  }
}

function chooseToolSlot(snapshot, label) {
  const matches = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === label);
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_tool_slot" : `no_tool_slot_${label}`);
  return matches[0].slot;
}

function chooseAdjacentCaskTarget(snapshot) {
  const targets = snapshot.caskTargets ?? [];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("clear_cask_target_count_expected_at_least_1_got_0");
  const adjacent = targets.filter((entry) => entry?.targetId && Number.isInteger(entry.x) && Number.isInteger(entry.y)
    && Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1);
  if (adjacent.length === 0) throw new Error("clear_cask_no_adjacent_target");
  return adjacent[0];
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(detail.split(";").map((pair) => {
    const index = pair.indexOf("=");
    return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
  }).filter(Boolean));
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runClearCaskSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
