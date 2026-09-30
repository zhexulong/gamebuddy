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

const ACTION = "chest_store";
const SCENARIO = "native_chest_store_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute the chest-store contract against an already-connected bridge session. */
export async function runChestStoreSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    const target = chooseOnlyChestStoreTarget(before);
    const requestId = `native_local_chest_store_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {
        slot: target.slot,
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot: before,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: target.targetId, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("chest_store_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "chest_stored")
      throw new Error(`chest_store_failed:${terminal.reasonCode}`);
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const reread = (after.chestStoreTargets ?? []).find((entry) => entry?.targetId === target.targetId);
    const passed =
      after.revision >= terminal.revision &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.item === target.qualifiedItemId &&
      evidence.source_consumed === "true" &&
      evidence.native_menu_opened === "false" &&
      evidence.chest_stack_before === "0" &&
      (reread === undefined || reread.slot !== target.slot);
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "chest_stored" : "chest_store_postcondition_mismatch",
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

function chooseOnlyChestStoreTarget(snapshot) {
  const targets = snapshot.chestStoreTargets ?? [];
  if (targets.length !== 1) throw new Error(`chest_store_target_count_expected_1_got_${targets.length}`);
  const target = targets[0];
  if (!target?.targetId || !Number.isInteger(target.x) || !Number.isInteger(target.y) || !Number.isInteger(target.slot) && target.slot !== 0)
    throw new Error("chest_store_target_malformed");
  return target;
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

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runChestStoreSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}