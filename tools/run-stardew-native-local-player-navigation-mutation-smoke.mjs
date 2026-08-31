import {
  TERMINAL_STATES,
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "navigate_to_destination";
const SCENARIO = "navigation_mutation_v1";
const EXPECTED_ACTIONS = ["inspect_world_map", "find_destination", ACTION];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "find_destination",
  "inspect_self",
  "inspect_world_map",
  ACTION,
];

/** Run one game-derived, typed Navigation mutation and verify its fresh outcome. */
export async function runNavigationMutationSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 60_000, postconditionTimeoutMs = 10_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  let stage = "config_validation";
  try {
    validateConfig(config);
    stage = "observe_before";
    const before = await observeFresh(client, { actionable: true });
    assertExactCapabilities(before, EXPECTED_CAPABILITIES);

    stage = "inspect_world_map";
    const worldMap = await client.navigationRead({ operation: "inspect_world_map", args: {} });
    assertWorldMap(worldMap);
    const query = config.NativeLocalPlayerFixture.NavigationMutationTargetLabel;
    stage = "find_destination";
    const found = await client.navigationRead({ operation: "find_destination", args: { query } });
    const destination = requireResolvedLabelDestination(found, before.location);

    const requestId = `native_local_navigation_${Date.now()}`;
    stage = "execute";
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { destination },
      snapshot: before,
      timeoutMs: 60_000,
    });
    trace.push({ action: ACTION, selectorKind: destination.kind, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    assertSingleCorrelatedTerminal(receipts, accepted, terminal);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "navigation_completed")
      throw new Error(`navigation_mutation_terminal_failed:${terminal.state}:${terminal.reasonCode}`);
    const evidence = parseCompletionEvidence(terminal.evidence);

    stage = "postcondition_observe";
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    assertExactCapabilities(after, EXPECTED_CAPABILITIES);
    if (after.revision !== terminal.revision) throw new Error("navigation_mutation_postcondition_revision_mismatch");
    if (evidence.destination !== destination.label) throw new Error("navigation_mutation_evidence_destination_mismatch");
    if (evidence.location !== after.location) throw new Error("navigation_mutation_fresh_location_mismatch");

    // Re-resolve from the game after completion. This verifier uses the
    // producer's query and returned selector, never a runner-owned destination.
    stage = "postcondition_find";
    const freshFound = await client.navigationRead({ operation: "find_destination", args: { query } });
    const freshDestination = requireResolvedLabelDestination(freshFound);
    if (!sameSelector(freshDestination, destination))
      throw new Error("navigation_mutation_fresh_selector_mismatch");

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      selectorKind: destination.kind,
      receipt: summarizeReceipt(terminal),
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
      correlationVerified: true,
      evidenceVerified: true,
      postconditionVerified: true,
      traceCount: trace.length,
      mutationCount: 1,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      stage,
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client?.state?.latestReceipt),
      traceCount: trace.length,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runNavigationMutationSmoke(session.client, session.receipts, config);
    const reported = result.state === "blocked"
      ? { ...result, diagnostics: session.diagnostics }
      : result;
    console.log(JSON.stringify(reported));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    await session.close();
  }
}

function validateConfig(config) {
  const fixture = config?.NativeLocalPlayerFixture;
    if (
      fixture?.Enable !== true ||
      fixture.Bootstrap?.Enable === true ||
      fixture.FixtureScenario !== SCENARIO ||
      typeof fixture.NavigationMutationTargetLabel !== "string" ||
      fixture.NavigationMutationTargetLabel.length < 1 ||
      fixture.NavigationMutationTargetLabel.length > 128 ||
    config.ActionPolicyVersion !== 0 ||
    !same(config.EnabledActions, EXPECTED_ACTIONS)
  )
    throw new Error("navigation_mutation_fixture_config_invalid");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
}

function assertWorldMap(result) {
  if (
    result?.status !== "succeeded" ||
    result.reason !== "world_map_observed" ||
    !Array.isArray(result.entries) ||
    result.entries.length > 20
  )
    throw new Error("navigation_mutation_world_map_invalid");
}

function requireResolvedLabelDestination(result, currentLocation) {
  const destination = result?.destination;
  if (
    result?.status !== "resolved" ||
    destination?.kind !== "label" ||
    typeof destination.label !== "string" ||
    destination.label.length === 0 ||
    destination.ref !== null
  )
    throw new Error("navigation_mutation_destination_not_resolved");
  if (currentLocation !== undefined && destination.label === currentLocation)
    throw new Error("navigation_mutation_destination_is_current_location");
  return Object.freeze({ kind: destination.kind, label: destination.label, ref: destination.ref });
}

function assertSingleCorrelatedTerminal(receipts, accepted, selected) {
  const suspicious = receipts.filter(
    (receipt) =>
      (receipt?.requestId === accepted.requestId || receipt?.executionId === accepted.executionId) &&
      (receipt?.requestId !== accepted.requestId || receipt?.executionId !== accepted.executionId),
  );
  if (suspicious.length > 0) throw new Error("navigation_mutation_decoy_receipt_observed");
  const terminals = [accepted, ...receipts].filter(
    (receipt) =>
      receipt?.requestId === accepted.requestId &&
      receipt?.executionId === accepted.executionId &&
      TERMINAL_STATES.has(receipt.state),
  );
  if (terminals.length !== 1 || terminals[0] !== selected)
    throw new Error("navigation_mutation_terminal_receipt_count_invalid");
}

function parseCompletionEvidence(receiptEvidence) {
  const detail = typeof receiptEvidence?.detail === "string" ? receiptEvidence.detail : "";
  if (detail.length === 0) throw new Error("navigation_mutation_evidence_empty");
  const fields = Object.fromEntries(
    detail.split(";").map((part) => {
      const index = part.indexOf("=");
      return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : ["", ""];
    }),
  );
  if (fields.arrived !== "true" || fields.postcondition !== "true")
    throw new Error("navigation_mutation_completion_evidence_invalid");
  return fields;
}

function same(left, right) {
  return Array.isArray(left) && JSON.stringify(left) === JSON.stringify(right);
}

function sameSelector(left, right) {
  return left.kind === right.kind && left.label === right.label && left.ref === right.ref;
}
