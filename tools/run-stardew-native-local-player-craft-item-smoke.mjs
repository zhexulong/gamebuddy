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

const ACTION = "craft_item";
const SCENARIO = "native_craft_item_v1";
const RECIPE_ALIAS = "Wood_Fence";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute the craft_item contract against an already-connected bridge session. */
export async function runCraftItemSmoke(
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
    const requestId = `native_local_craft_item_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { expectedTargetId: RECIPE_ALIAS },
      snapshot: before,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("craft_item_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "crafted_item_created")
      throw new Error(`craft_item_failed:${terminal.state}:${terminal.reasonCode}`);
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const passed =
      after.revision >= terminal.revision &&
      evidence.disposition === "added_to_inventory" &&
      evidence.materials_consumed_exactly === "true" &&
      evidence.inventory_postcondition === "true" &&
      evidence.count_postcondition === "true" &&
      evidence.native_menu_opened === "false" &&
      Number(evidence.count_after) === Number(evidence.count_before) + 1;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "crafted_item_created" : "craft_item_postcondition_mismatch",
      recipe: RECIPE_ALIAS,
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

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runCraftItemSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

export { ACTION as CRAFT_ITEM_ACTION, SCENARIO as CRAFT_ITEM_FIXTURE_SCENARIO };
