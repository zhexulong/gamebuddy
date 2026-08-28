import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  waitForStableRevision,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "equip_tool";

/** Execute the equip-tool contract and return the exact authority-bearing proof. */
export async function runEquipToolSmoke(
  client,
  receipts,
  _config,
  { terminalTimeoutMs = 30_000, postconditionTimeoutMs = 5_000 } = {},
) {
  try {
    const before = await observeFresh(client, { actionable: true });
    if (!before.capabilities.includes(ACTION)) throw new Error("native_local_equip_tool_capability_missing");
    const selected =
      before.toolSlots?.find(
        (entry) =>
          Number.isSafeInteger(entry.slot) &&
          typeof entry.label === "string" &&
          entry.label.length > 0 &&
          entry.label !== before.currentTool,
      ) ??
      before.toolSlots?.find(
        (entry) => Number.isSafeInteger(entry.slot) && typeof entry.label === "string" && entry.label.length > 0,
      );
    if (!selected) throw new Error("no_live_eligible_tool_slot");

    const requestId = `native_local_equip_tool_${Date.now()}`;
    const request = Object.freeze({
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: Object.freeze({ slot: selected.slot }),
      expectedRevision: before.revision,
    });
    const accepted = await executeFresh(client, {
      ...request,
      snapshot: before,
      timeoutMs: 30_000,
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const evidence = parseEquipToolEvidence(terminal.evidence);
    const after = await waitForStableRevision(client, {
      revision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (snapshot) =>
        snapshot.actionable === true &&
        snapshot.activeExecution == null &&
        snapshot.currentTool === selected.label,
    });

    assertExactProof({ request, accepted, terminal, evidence, selected, before, after });
    return {
      state: "passed",
      reasonCode: "tool_selected",
      selected: { slot: selected.slot, label: selected.label },
      request,
      accepted: { requestId: accepted.requestId, executionId: accepted.executionId },
      terminal: {
        requestId: terminal.requestId,
        executionId: terminal.executionId,
        state: terminal.state,
        reasonCode: terminal.reasonCode,
        revision: terminal.revision,
      },
      evidence,
      postcondition: {
        revision: after.revision,
        currentTool: after.currentTool,
        expectedTool: selected.label,
        selected: { slot: selected.slot, label: selected.label },
      },
    };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runEquipToolSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    await session.close();
  }
}

function parseEquipToolEvidence(evidence) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("invalid_equip_tool_evidence");
  const detail = typeof evidence.detail === "string" ? evidence.detail : "";
  const entries = detail.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index <= 0) throw new Error("invalid_equip_tool_evidence");
    return [part.slice(0, index), part.slice(index + 1)];
  });
  const parsed = Object.fromEntries(entries);
  if (entries.length !== 4 || Object.keys(parsed).length !== 4 || !Object.hasOwn(parsed, "slot") || !Object.hasOwn(parsed, "before") || !Object.hasOwn(parsed, "expected") || !Object.hasOwn(parsed, "after")) throw new Error("invalid_equip_tool_evidence");
  const slot = Number(parsed.slot);
  if (!Number.isSafeInteger(slot) || slot < 0 || [parsed.before, parsed.expected, parsed.after].some((value) => typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256)) throw new Error("invalid_equip_tool_evidence");
  return { slot, before: parsed.before, expected: parsed.expected, after: parsed.after };
}

function assertExactProof({ request, accepted, terminal, evidence, selected, before, after }) {
  if (accepted.requestId !== request.requestId || terminal.requestId !== request.requestId) throw new Error("equip_tool_request_id_mismatch");
  if (terminal.executionId !== accepted.executionId) throw new Error("equip_tool_execution_id_mismatch");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "tool_selected") throw new Error("equip_tool_terminal_mismatch");
  if (!Number.isSafeInteger(terminal.revision) || terminal.revision <= request.expectedRevision || after.revision !== terminal.revision) throw new Error("equip_tool_revision_mismatch");
  if (evidence.slot !== request.args.slot || evidence.slot !== selected.slot || evidence.before !== before.currentTool || evidence.expected !== selected.label || evidence.after !== selected.label || after.currentTool !== selected.label) throw new Error("equip_tool_evidence_mismatch");
}
