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

const ACTION = "cook_recipe";
const SCENARIO = "native_cook_recipe_v1";
const RECIPE_ALIAS = "Fried_Egg";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute the cook_recipe contract against an already-connected bridge session. */
export async function runCookRecipeSmoke(
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
    const requestId = `native_local_cook_recipe_${Date.now()}`;
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
      throw new Error("cook_recipe_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "dish_cooked")
      throw new Error(`cook_recipe_failed:${terminal.state}:${terminal.reasonCode}`);
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const passed =
      after.revision >= terminal.revision &&
      evidence.station?.startsWith("cookout_kit@") === true &&
      evidence.disposition === "inventory" &&
      evidence.count_incremented === "true" &&
      evidence.native_menu_opened === "false" &&
      Number(evidence.recipes_cooked_after) === Number(evidence.recipes_cooked_before) + 1 &&
      Number(evidence.inventory_after) === Number(evidence.inventory_before) + Number(evidence.delivered);
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "dish_cooked" : "cook_recipe_postcondition_mismatch",
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
    const result = await runCookRecipeSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

export { ACTION as COOK_RECIPE_ACTION, SCENARIO as COOK_RECIPE_FIXTURE_SCENARIO };
