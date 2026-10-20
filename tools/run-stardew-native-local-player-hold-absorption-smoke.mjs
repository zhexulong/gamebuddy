/**
 * The transient body hold, live: a follow-up action that arrives WHILE the previous one is still animating.
 *
 * The measured shape this exists for (run g99cross): a follow-up arrives 49-154 ms after the previous action settles,
 * the native animation has not released the actor yet, and the Mod used to refuse it by name - so the companion paid a
 * whole model round-trip (12.1 s / 4.7 s / 2.6 s in that run) and re-dispatched the same thing.
 *
 * The Mod now PARKS such a request (no receipt, no native effect) and dispatches it through the full normal path the
 * moment the body frees, recording how long it waited as `held_ms`. This gate creates that shape deliberately: it starts
 * the till-soil contract and, while that action is still in flight, dispatches a second action at the same target.
 *
 * What it asserts:
 *   1. the follow-up is NOT refused by name - it is accepted or settled;
 *   2. a receipt that arrived after a hold carries `held_ms`;
 *   3. if the hold exceeded `TransientRetryWindowMs`, the SAME named refusal comes back instead, and the gate says so.
 */
import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { runTillSoilSmoke } from "./run-stardew-native-local-player-till-soil-smoke.mjs";

const SCENARIO = "native_till_soil_v1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runHoldAbsorptionSmoke(
  client,
  receipts,
  config,
  { inFlightDelayMs = 400, terminalTimeoutMs = 30_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    // The first action runs unchained: its own contract does the setup (hoe, farm, adjacent soil) and then tills, and the
    // gate needs to be sending the follow-up WHILE that is happening.
    // Handled from the moment it starts: this promise is awaited much later, and an unhandled rejection in between
    // would exit Node before the gate could report anything (measured 2026-10-20: no JSON at all).
    const first = runTillSoilSmoke(client, receipts, config).catch((error) => ({
      state: "blocked",
      reasonCode: `first_contract_failed:${String(error instanceof Error ? error.message : error)}`,
    }));
    await delay(inFlightDelayMs);
    const snapshot = await observeFresh(client);
    if (snapshot.actionable !== true && snapshot.activeExecution == null)
      throw new Error("no_action_in_flight_to_hold_against");
    trace.push({
      step: "in_flight",
      actionable: snapshot.actionable,
      activeExecution: summarizeReceipt(snapshot.activeExecution ?? {}),
    });

    // An action that is legal wherever the actor stands: the till-soil contract has already equipped the hoe, so this
    // is idempotent, and it goes through the same admission gate - which is the thing being measured. Targeting a tile
    // would measure geometry instead (the first version asked for soil at the actor's own tile and got
    // `target_out_of_range` once the hold had already worked).
    const followUp = await executeFresh(client, {
      action: "equip_tool",
      args: { tool: "hoe" },
      snapshot,
      requestId: `hold_absorption_follow_up_${String(Date.now())}`,
      idempotencyKey: `hold_absorption_follow_up_${String(Date.now())}_idem`,
      timeoutMs: terminalTimeoutMs,
    });
    trace.push({ step: "follow_up", state: followUp.state, reasonCode: followUp.reasonCode });
    if (followUp.state !== "accepted" && followUp.state !== "succeeded" && followUp.state !== "partially_succeeded")
      throw new Error(`follow_up_refused:${String(followUp.state)}/${String(followUp.reasonCode)}`);
    const settled =
      followUp.state === "accepted" ? await waitForTerminal(receipts, followUp, terminalTimeoutMs) : followUp;
    trace.push({ step: "follow_up_settled", receipt: summarizeReceipt(settled) });
    // `String(object)` yields "[object Object]", which is how this gate first reported `held_ms_missing` for a receipt
    // that had in fact succeeded: the evidence arrives as a string OR as an object, and both shapes have to be read.
    const evidence = typeof settled.evidence === "string" ? settled.evidence : JSON.stringify(settled.evidence ?? "");
    if (!/held_ms=\d+/u.test(evidence)) throw new Error(`held_ms_missing:${evidence.slice(0, 160)}`);
    const firstOutcome = await first;
    trace.push({ step: "first_contract", state: firstOutcome.state, reasonCode: firstOutcome.reasonCode });
    return {
      scenario: SCENARIO,
      state: "passed",
      reasonCode: "hold_absorbed_then_dispatched",
      durationMs: Date.now() - startedAt,
      heldMs: Number.parseInt(/held_ms=(\d+)/u.exec(evidence)[1], 10),
      trace,
    };
  } catch (error) {
    return {
      scenario: SCENARIO,
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      durationMs: Date.now() - startedAt,
      trace,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runHoldAbsorptionSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
