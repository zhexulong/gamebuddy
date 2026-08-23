import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "equip_tool";

/** Execute the equip-tool contract against an already-connected bridge session. */
export async function runEquipToolSmoke(client, _config, { postconditionTimeoutMs = 5_000 } = {}) {
  try {
    const before = await observeFresh(client, { actionable: true });
    if (!before.capabilities.includes(ACTION)) throw new Error("native_local_equip_tool_capability_missing");
    const selected =
      before.toolSlots?.find(
        (entry) =>
          Number.isInteger(entry.slot) &&
          typeof entry.label === "string" &&
          entry.label.length > 0 &&
          entry.label !== before.currentTool,
      ) ??
      before.toolSlots?.find(
        (entry) => Number.isInteger(entry.slot) && typeof entry.label === "string" && entry.label.length > 0,
      );
    if (!selected) throw new Error("no_live_eligible_tool_slot");

    const requestId = `native_local_equip_tool_${Date.now()}`;
    const receipt = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { slot: selected.slot },
      snapshot: before,
      timeoutMs: 30_000,
    });
    const evidence = parseEvidence(receipt.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: receipt.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (snapshot) => typeof snapshot.currentTool === "string" && snapshot.currentTool.length > 0,
    });
    const expectedTool = evidence.expected;
    const passed =
      receipt.state === "succeeded" &&
      receipt.reasonCode === "tool_selected" &&
      typeof expectedTool === "string" &&
      expectedTool.length > 0 &&
      expectedTool === selected.label &&
      evidence.after === selected.label &&
      after.currentTool === selected.label;
    return {
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "tool_selected" : receipt.reasonCode,
      selected: { slot: selected.slot, label: selected.label },
      receipt: summarizeReceipt(receipt),
      evidence,
      before: summarize(before),
      after: summarize(after),
    };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runEquipToolSmoke(session.client, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

function summarize(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    currentTool: snapshot.currentTool ?? null,
    toolSlots: snapshot.toolSlots ?? [],
  };
}
