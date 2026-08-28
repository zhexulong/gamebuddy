import {
  connectNativeLocalClient,
  observeFresh,
  readNativeClientConfig,
  summarizeSnapshot,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "find_destination", "inspect_self", "inspect_world_map"];

/**
 * Exercise the published Navigation read-only contract against one ordinary,
 * target-version native world. This sends no execution request and treats any
 * receipt fact as a failed zero-mutation assertion.
 */
export async function runNavigationReadOnlySmoke(
  client,
  receipts,
  config,
) {
  validateFixtureConfig(config);
  const before = await observeFresh(client, { actionable: true });
  assertExactCapabilities(before);
  const firstMap = await client.navigationRead({ operation: "inspect_world_map", args: {} });
  assertWorldMapResult(firstMap);
  const afterInspect = await observeFresh(client, { actionable: true });
  assertExactCapabilities(afterInspect);
  const query = chooseQuery(firstMap);
  const find = await client.navigationRead({ operation: "find_destination", args: { query } });
  assertFindResult(find);
  const afterFind = await observeFresh(client, { actionable: true });
  assertExactCapabilities(afterFind);
  if (afterInspect.revision !== before.revision || afterFind.revision !== before.revision)
    throw new Error("navigation_read_only_revision_changed");
  if (receipts.length !== 0 || client.state.latestReceipt !== null)
    throw new Error("navigation_read_only_execution_receipt_observed");

  const invalid = await expectBridgeRejected(
    client,
    { operation: "find_destination", args: { query: "" } },
    "invalid_navigation_read_request",
  );
  const invalidReference = await expectBridgeRejected(
    client,
    { operation: "inspect_world_map", args: { nodeRef: `nr1_${"A".repeat(22)}` } },
    "world_map_node_invalid",
  );
  if (receipts.length !== 0 || client.state.latestReceipt !== null)
    throw new Error("navigation_read_only_execution_receipt_observed");

  return {
    state: "passed",
    topology: "native_local_player_fixture",
    before: summarizeSnapshot(before),
    afterInspect: summarizeSnapshot(afterInspect),
    afterFind: summarizeSnapshot(afterFind),
    findStatus: find.status,
    invalid,
    invalidReference,
    mutationCount: 0,
    executionReceiptCount: 0,
  };
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runNavigationReadOnlySmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateFixtureConfig(config) {
  const fixture = config?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== "navigation_read_only_v1" ||
    !Array.isArray(config.EnabledActions) ||
    JSON.stringify(config.EnabledActions) !== JSON.stringify(["inspect_world_map", "find_destination"])
  )
    throw new Error("navigation_read_only_fixture_config_invalid");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
}

function assertExactCapabilities(snapshot) {
  const actual = [...(snapshot.capabilities ?? [])].sort();
  const expected = [...EXPECTED_CAPABILITIES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("navigation_read_only_capability_surface_mismatch");
}

function assertWorldMapResult(result) {
  if (
    result?.status !== "succeeded" ||
    result.reason !== "world_map_observed" ||
    !Array.isArray(result.entries) ||
    result.entries.length > 20
  )
    throw new Error("navigation_read_only_world_map_result_invalid");
}

function chooseQuery(result) {
  const label = result.entries.find((entry) => typeof entry?.label === "string" && entry.label.length > 0)?.label;
  if (label === undefined) throw new Error("navigation_read_only_world_map_has_no_queryable_entry");
  return label;
}

function assertFindResult(result) {
  if (!result || !["resolved", "candidates", "not_found", "blocked"].includes(result.status))
    throw new Error("navigation_read_only_find_result_invalid");
  if (result.status === "resolved" && result.destination == null)
    throw new Error("navigation_read_only_find_result_invalid");
  if (result.status === "candidates" && (!Array.isArray(result.candidates) || result.candidates.length < 1 || result.candidates.length > 3))
    throw new Error("navigation_read_only_find_result_invalid");
}

async function expectBridgeRejected(client, request, reason) {
  try {
    await client.navigationRead(request);
  } catch (error) {
    if (error instanceof Error && error.message === `bridge_rejected:${reason}`) return reason;
    throw error;
  }
  throw new Error(`navigation_read_only_expected_rejection_missing:${reason}`);
}
