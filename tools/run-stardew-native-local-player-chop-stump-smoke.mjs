import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "chop_stump";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "equip_tool", ACTION];

/** Execute the chop_stump contract (with equip_tool preflight) against an already-connected bridge session. */
export async function runChopstumpSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    let snapshot = await observeFresh(client, { actionable: true });
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const target = chooseOnlyStumpTarget(snapshot);

    // equip_tool is the action-owned prerequisite: the handler revalidates
    // CurrentToolIndex == slot on the game thread, so we must equip first and
    // read the exact equipped slot from a fresh snapshot.
    const equipped = await executeFresh(client, {
      requestId: `native_local_chop_stump_equip_${Date.now()}`,
      idempotencyKey: `native_local_chop_stump_equip_${Date.now()}_idem`,
      action: "equip_tool",
      args: { tool: "axe" },
      snapshot,
      timeoutMs: 15_000,
    });
    trace.push({ phase: "equip_tool", receipt: summarizeReceipt(equipped) });
    const equipTerminal = await waitForTerminal(receipts, equipped, terminalTimeoutMs);
    if (equipTerminal.state !== "succeeded" || !["tool_equipped", "already_equipped"].includes(equipTerminal.reasonCode))
      throw new Error(`equip_failed:${equipTerminal.reasonCode}`);

    snapshot = await observeFresh(client, { actionable: true, minRevision: equipTerminal.revision });
    const slot = chooseToolSlot(snapshot, "(T)Axe");
    const requestId = `native_local_chop_stump_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {
        slot,
        x: target.x,
        y: target.y,
        expectedTargetId: target.targetId,
      },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: target.targetId, slot, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("chop_stump_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "stump_cleared")
      throw new Error(`chop_stump_failed:${terminal.reasonCode}`);
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
    assertExactCapabilities(after, EXPECTED_CAPABILITIES);
    const passed =
      after.revision >= terminal.revision &&
      evidence.target === target.targetId &&
      evidence.type === "tree_stump" &&
      evidence.tool === "axe" &&
      evidence.stump_removed === "true";
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "stump_cleared" : "chop_stump_postcondition_mismatch",
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

function chooseToolSlot(snapshot, label) {
  const matches = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === label);
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_tool_slot" : `no_tool_slot_${label}`);
  return matches[0].slot;
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  const fields = Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
  return fields;
}

function chooseOnlyStumpTarget(snapshot) {
  const targets = snapshot.treeStumpTargets ?? [];
  if (targets.length !== 1) throw new Error(`chop_stump_target_count_expected_1_got_${targets.length}`);
  const target = targets[0];
  if (!target?.targetId || !Number.isInteger(target.x) || !Number.isInteger(target.y))
    throw new Error("chop_stump_target_malformed");
  return target;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runChopstumpSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
