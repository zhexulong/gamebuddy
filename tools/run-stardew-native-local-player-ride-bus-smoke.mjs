// Stardew-local ride_bus smoke.
//
// `ride_bus` drives the game's own bus interaction rather than re-implementing it:
// the Mod verifies the ticket machine / vault / driver / fare itself, raises the
// native ticket question through `BusStop.checkAction`, answers it through
// `GameLocation.answerDialogue`, and then waits for the arrival the native cutscene
// produces. Admission therefore returns immediately with a Running receipt
// (`bus_departure_started`) and the terminal lands later, on the same journal.
//
// This runner drives that chain in one native-local session: stand at the ticket
// machine, ride, then confirm the terminal receipt AND that the world actually moved
// the actor to the desert. The fixture only establishes the declared Given (vault
// complete, driver on duty, fare affordable, actor beside the machine), so a pass
// here is evidence about the production ride rather than a fixture-authored warp.
//
// Shared harness helpers (bounded scope, revision-bound requests, exact receipt
// identity, terminal wait, owned teardown) come from
// `stardew-native-smoke-harness-v1.mjs`.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
// The native-local lane loads the compiled test artifact, exactly like the other
// chain runners: the immutable production generation can predate the current
// protocol, which the Mod then rejects as invalid_hello_ack.
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "ride_bus"];
const BUS_STOP_LOCATION = "BusStop";
const BUS_DESTINATION = "Desert";
const RUNNING_REASON = "bus_departure_started";
const TERMINAL_REASON = "bus_arrived";

/** Execute the ride_bus contract against an already-connected bridge session. */
export async function runRideBusSmoke(client, receipts, config, { rideTimeoutMs = 90_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    // The stored profile config is part of the declared Given: a config for another
    // scenario means the run would exercise something other than this contract.
    validateNativeLocalFixtureConfig(config);
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, EXPECTED_CAPABILITIES);
    if (before.location !== BUS_STOP_LOCATION)
      throw new Error(`ride_bus_route_must_start_at_the_bus_stop:${before.location}`);

    const dispatched = await execute(client, trace, "ride", "ride_bus", {}, before);

    // Admission is instantaneous, the ride is not: the Running receipt announces the
    // departure and the terminal arrives when the world finishes the cutscene. A
    // receipt that is already terminal is accepted too, so the runner proves the
    // terminal rather than the timing.
    const terminal =
      dispatched.state === "succeeded" ||
      dispatched.state === "rejected" ||
      dispatched.state === "invalidated" ||
      dispatched.state === "failed" ||
      dispatched.state === "uncertain"
        ? dispatched
        : await waitForTerminal(receipts, dispatched, rideTimeoutMs);

    if (terminal.state !== "succeeded" || terminal.reasonCode !== TERMINAL_REASON)
      throw new Error(`ride_bus_terminal_mismatch:state=${terminal.state};reason=${terminal.reasonCode}`);

    const evidence = parseStrictEvidence(terminal.evidence);
    if (evidence.origin !== BUS_STOP_LOCATION) throw new Error(`ride_bus_origin_mismatch:${evidence.origin}`);
    if (evidence.destination !== BUS_DESTINATION)
      throw new Error(`ride_bus_destination_mismatch:${evidence.destination}`);

    const fare = Number.parseInt(evidence.fare ?? "", 10);
    const moneyBefore = Number.parseInt(evidence.money_before ?? "", 10);
    const moneyAfter = Number.parseInt(evidence.money_after ?? "", 10);
    if (!Number.isFinite(fare) || !Number.isFinite(moneyBefore) || !Number.isFinite(moneyAfter))
      throw new Error(`ride_bus_fare_evidence_missing:${terminal.evidence}`);

    // The world, not the receipt, is the authority on the arrival.
    const after = await waitForFreshSnapshot(client, { minRevision: terminal.revision });
    if (after.location !== BUS_DESTINATION)
      throw new Error(`ride_bus_arrival_not_observed:${after.location}`);

    const detail = {
      reasonCode: TERMINAL_REASON,
      origin: evidence.origin,
      destination: evidence.destination,
      fare,
      moneyBefore,
      moneyAfter,
      runningReason: dispatched.reasonCode ?? null,
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
      trace,
      durationMs: Date.now() - startedAt,
    };
    assertRideBusPostconditions(detail);
    return { state: "passed", ...detail, location: after.location, latestReceipt: summarizeReceipt(terminal) };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: error?.message ?? "ride_bus_smoke_failed",
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * The pass contract, factored out so a negative test can prove each clause rather
 * than trusting the happy path.
 */
export function assertRideBusPostconditions(detail) {
  if (detail.reasonCode !== TERMINAL_REASON) throw new Error(`ride_bus_reason:${detail.reasonCode}`);
  if (detail.origin !== BUS_STOP_LOCATION) throw new Error(`ride_bus_origin:${detail.origin}`);
  if (detail.destination !== BUS_DESTINATION) throw new Error(`ride_bus_destination:${detail.destination}`);
  if (detail.after?.hasLocation !== true) throw new Error("ride_bus_after_missing");
  if (!Number.isFinite(detail.fare) || detail.fare <= 0) throw new Error(`ride_bus_fare_not_positive:${detail.fare}`);
  if (detail.moneyAfter !== detail.moneyBefore - detail.fare)
    throw new Error(`ride_bus_fare_not_deducted:before=${detail.moneyBefore};after=${detail.moneyAfter};fare=${detail.fare}`);
  if (!detail.trace?.some((entry) => entry.action === "ride_bus")) throw new Error("ride_bus_trace");
  return detail;
}

/**
 * The stored fixture config must be this scenario and nothing else. `Portfolio` is
 * deliberately NOT required to be false: it is not a ModConfig property, so the game
 * drops it when it rewrites the profile config, and only an explicit true is a
 * topology violation.
 */
export function validateNativeLocalFixtureConfig(config) {
  if (config?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const scenario = config.NativeLocalPlayerFixture.FixtureScenario;
  if (scenario !== "native_ride_bus_v1")
    throw new Error(`native_local_fixture_scenario_mismatch:${scenario ?? "missing"}`);
}

function parseStrictEvidence(evidence) {
  if (typeof evidence !== "string" || evidence.length === 0) throw new Error("ride_bus_evidence_missing");
  const fields = {};
  for (const part of evidence.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) throw new Error(`ride_bus_evidence_malformed:${part}`);
    fields[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return fields;
}

async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_ride_bus_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, requestId, receipt: summarizeReceipt(receipt) });
  return receipt;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runRideBusSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
