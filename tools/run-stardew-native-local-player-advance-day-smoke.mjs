import {
  assertTopologyCapabilities,
  classifyTopology,
  connectNativeLocalClient,
  executeFresh,
  observeTopologySnapshot,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "advance_day";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * Dispatch the cross-day lifecycle through the real bridge and assert that the
 * day actually advanced.
 *
 * The action carries no arguments: the Farmhand's own bed and its native
 * sleep-ready state are the whole input. This runner therefore sends the empty
 * args object and then requires natively observed evidence — a save, a day-start
 * edge, and a day counter that moved by exactly one — rather than trusting the
 * receipt's own claim.
 *
 * The lifecycle is a multi-frame execution, so the terminal legitimately arrives
 * long after the Accepted receipt: a co-op night waits on other players.
 */
export async function runAdvanceDaySmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 300_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  const topology = validateTopologyConfig(config);
  try {
    const before = await observeTopologySnapshot(client, topology, { actionable: true });
    assertTopologyCapabilities(before, topology, EXPECTED_CAPABILITIES);

    const requestId = `native_local_advance-day_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {},
      snapshot: before,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    trace.push({ terminal: summarizeReceipt(terminal) });
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("advance_day_terminal_identity_mismatch");

    const evidence = parseStrictEvidence(terminal.evidence);
    // The postcondition of a day advance is that the day advanced, NOT that the
    // actor is actionable: a new day legitimately opens with a fade/day-start
    // sequence during which the world is briefly not actionable. Requiring
    // actionable here would assert something the action never promised.
    const after = await observeTopologySnapshot(client, topology, { actionable: false });

    const dayBefore = Number(evidence.day_before);
    const dayAfter = Number(evidence.day_after);
    const daysBefore = Number(evidence.days_before);
    const daysAfter = Number(evidence.days_after);
    // Independent cross-check: the receipt's own total-day claim must agree with
    // the day the world actually reports afterwards. Total days run continuously
    // across seasons, so the calendar day is derivable and is not a restatement
    // of the receipt.
    const expectedDayOfMonth = ((dayAfter % 28) + 28) % 28 + 1;
    const worldAgrees = after.dayOfMonth === expectedDayOfMonth;
    const passed =
      terminal.state === "succeeded" &&
      terminal.reasonCode === "day_advanced" &&
      evidence.saved_observed === "true" &&
      evidence.day_started_observed === "true" &&
      Number.isInteger(dayBefore) &&
      Number.isInteger(dayAfter) &&
      dayAfter === dayBefore + 1 &&
      Number.isInteger(daysBefore) &&
      Number.isInteger(daysAfter) &&
      daysAfter === daysBefore + 1 &&
      worldAgrees;
    return {
      state: passed ? "passed" : "blocked",
      topology,
      reasonCode: passed ? "day_advanced" : `advance_day_failed:${terminal.reasonCode}`,
      receipt: summarizeReceipt(terminal),
      evidence,
      dayAdvanced: Number.isInteger(dayBefore) && dayAfter === dayBefore + 1,
      daysPlayedAdvanced: Number.isInteger(daysBefore) && daysAfter === daysBefore + 1,
      worldObservedDayOfMonth: after.dayOfMonth,
      expectedDayOfMonth,
      worldAgreesWithReceipt: worldAgrees,
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology,
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

function validateTopologyConfig(value) {
  const topology = classifyTopology(value);
  if (topology === "shared_world_farmhand" && value.ActionPolicyVersion !== 1)
    throw new Error("shared_world_action_policy_invalid");
  return topology;
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
    const result = await runAdvanceDaySmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
