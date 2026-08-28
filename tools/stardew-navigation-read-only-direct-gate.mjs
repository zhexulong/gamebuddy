import { readFile, writeFile } from "node:fs/promises";

import {
  connectNativeLocalClient,
  observeFresh,
  readNativeClientConfig,
  summarizeSnapshot,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const READ_ONLY_CAPABILITIES = [
  "cancel_active_execution",
  "find_destination",
  "inspect_self",
  "inspect_world_map",
];
// `inspect_self` and `cancel_active_execution` are fixed protocol controls,
// not Navigation publications. Removing the two enabled read operations must
// withdraw only those operations, while preserving the control surface.
const WITHDRAWN_CAPABILITIES = [
  "cancel_active_execution",
  "inspect_self",
];

/**
 * Direct target-runtime gate for the two Navigation read-only operations.
 * The only Mod requests it sends are navigation_read_request and
 * observe_request. It deliberately never invokes execute, cancel, or receipt
 * recovery, so any execution receipt is a failed gate.
 */
export async function runNavigationReadOnlyDirectGate(
  client,
  receipts,
  config,
  {
    withdrawReadOnlyCapabilities,
    closeActiveConnection,
    connectForeignScope,
    reconnectTargetScope,
    waitForPolicyReload,
  } = {},
) {
  validateFixtureConfig(config);
  if (
    typeof withdrawReadOnlyCapabilities !== "function" ||
    typeof closeActiveConnection !== "function" ||
    typeof connectForeignScope !== "function" ||
    typeof reconnectTargetScope !== "function" ||
    typeof waitForPolicyReload !== "function"
  )
    throw new Error("navigation_read_only_gate_dependencies_unavailable");

  let activeClient = client;
  let activeReceipts = receipts;
  let activeClose = closeActiveConnection;
  const observedReceipts = new Set();
  const trackReceipts = (clientReceipts) => {
    if (!Array.isArray(clientReceipts)) throw new Error("navigation_read_only_receipt_buffer_invalid");
    for (const receipt of clientReceipts) observedReceipts.add(receipt);
  };
  trackReceipts(activeReceipts);
  const before = await observeFresh(activeClient, { actionable: true });
  assertCapabilities(before, READ_ONLY_CAPABILITIES);
  const initialRevision = before.revision;

  const root = await activeClient.navigationRead({ operation: "inspect_world_map", args: {} });
  assertWorldMapResult(root);
  const afterRoot = await rereadUnchanged(activeClient, initialRevision);

  // A returned node/cursor can only be consumed after the Mod has freshly
  // rebuilt its source-derived directory. The opaque reference store verifies
  // the source generation again while resolving it.
  const continuation = firstContinuation(root);
  let afterContinuation = null;
  if (continuation !== null) {
    const result = await activeClient.navigationRead(continuation);
    assertWorldMapResult(result);
    afterContinuation = await rereadUnchanged(activeClient, initialRevision);
  }

  const query = chooseQuery(root);
  const find = await activeClient.navigationRead({ operation: "find_destination", args: { query } });
  assertFindResult(find);
  const afterFind = await rereadUnchanged(activeClient, initialRevision);

  const invalidQuery = await expectBridgeRejected(
    activeClient,
    { operation: "find_destination", args: { query: "" } },
    "invalid_navigation_read_request",
  );
  const malformedReference = await expectBlockedResult(
    activeClient,
    { operation: "inspect_world_map", args: { nodeRef: `nr1_${"A".repeat(22)}` } },
    "world_map_node_invalid",
  );
  trackReceipts(activeReceipts);
  await assertNoExecution(activeClient, observedReceipts);

  // The native local pipe permits one peer, so exercise a real foreign-scope
  // hello on its own generation, then reconnect the authenticated target scope.
  // The foreign peer must fail authentication before any read can be sent.
  await activeClose();
  await delay(300);
  const foreignScope = await expectForeignScopeRejected(connectForeignScope);
  const reconnected = await reconnectTargetScope();
  activeClient = reconnected.client;
  activeReceipts = reconnected.receipts;
  activeClose = reconnected.close;
  const afterReconnect = await rereadUnchanged(activeClient, initialRevision);

  trackReceipts(activeReceipts);
  await assertNoExecution(activeClient, observedReceipts);
  await withdrawReadOnlyCapabilities();
  await waitForPolicyReload();
  const withdrawn = await waitForWithdrawal(activeClient);
  assertCapabilities(withdrawn, WITHDRAWN_CAPABILITIES);
  const withdrawnOperation = await expectCapabilityNotReady(
    activeClient,
    { operation: "inspect_world_map", args: {} },
  );
  trackReceipts(activeReceipts);
  await assertNoExecution(activeClient, observedReceipts);
  await activeClose();
  await delay(300);
  const freshForFind = await reconnectTargetScope();
  activeClient = freshForFind.client;
  activeReceipts = freshForFind.receipts;
  activeClose = freshForFind.close;
  const withdrawnFindOperation = await expectCapabilityNotReady(
    activeClient,
    { operation: "find_destination", args: { query } },
  );
  trackReceipts(activeReceipts);
  await assertNoExecution(activeClient, observedReceipts);
  await activeClose();

  return {
    state: "navigation_read_only_direct_gate_completed",
    topology: "native_local_player_fixture",
    before: summarizeSnapshot(before),
    afterRoot: summarizeSnapshot(afterRoot),
    afterContinuation: afterContinuation === null ? null : summarizeSnapshot(afterContinuation),
    afterFind: summarizeSnapshot(afterFind),
    afterReconnect: summarizeSnapshot(afterReconnect),
    invalidQuery,
    malformedReference,
    foreignScope,
    withdrawn: summarizeSnapshot(withdrawn),
    withdrawnOperation,
    withdrawnFindOperation,
    mutationCount: 0,
    executionReceiptCount: 0,
  };
}

if (import.meta.main) {
  const configPath = requiredArg("--client-config");
  const config = await readNativeClientConfig();
  let session = await connectNativeLocalClient(config);
  try {
    const result = await runNavigationReadOnlyDirectGate(session.client, session.receipts, config, {
      withdrawReadOnlyCapabilities: () => withdrawReadOnlyCapabilities(configPath),
      closeActiveConnection: () => session.close(),
      connectForeignScope: () => connectForeignScope(config),
      reconnectTargetScope: async () => {
        const next = await connectNativeLocalClient(config);
        session = next;
        return { ...next, close: () => next.close() };
      },
      waitForPolicyReload: () => delay(1_100),
    });
    console.log(JSON.stringify(result));
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
    config.ActionPolicyVersion !== 0 ||
    !Array.isArray(config.EnabledActions) ||
    JSON.stringify(config.EnabledActions) !== JSON.stringify(["inspect_world_map", "find_destination"])
  )
    throw new Error("navigation_read_only_fixture_config_invalid");
}

function assertCapabilities(snapshot, expectedCapabilities) {
  const actual = [...(snapshot?.capabilities ?? [])].sort();
  const expected = [...expectedCapabilities].sort();
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

function assertFindResult(result) {
  if (!result || !["resolved", "candidates", "not_found", "invalid", "blocked"].includes(result.status))
    throw new Error("navigation_read_only_find_result_invalid");
  if (result.status === "resolved" && result.destination == null)
    throw new Error("navigation_read_only_find_result_invalid");
  if (
    result.status === "candidates" &&
    (!Array.isArray(result.candidates) || result.candidates.length < 1 || result.candidates.length > 3)
  )
    throw new Error("navigation_read_only_find_result_invalid");
}

function firstContinuation(result) {
  const nodeRef = result.entries.find((entry) => typeof entry?.nodeRef === "string")?.nodeRef;
  if (nodeRef !== undefined) return { operation: "inspect_world_map", args: { nodeRef } };
  if (typeof result.nextCursor === "string") return { operation: "inspect_world_map", args: { cursor: result.nextCursor } };
  return null;
}

function chooseQuery(result) {
  const label = result.entries.find((entry) => typeof entry?.label === "string" && entry.label.length > 0)?.label;
  if (label === undefined) throw new Error("navigation_read_only_world_map_has_no_queryable_entry");
  return label;
}

async function rereadUnchanged(client, expectedRevision) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (snapshot.revision !== expectedRevision) throw new Error("navigation_read_only_revision_changed");
  assertCapabilities(snapshot, READ_ONLY_CAPABILITIES);
  return snapshot;
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

async function expectBlockedResult(client, request, reason) {
  const result = await client.navigationRead(request);
  if (result?.status === "blocked" && result.reason === reason) return reason;
  throw new Error(`navigation_read_only_expected_block_missing:${reason}`);
}

async function expectForeignScopeRejected(connectForeignScope) {
  try {
    await connectForeignScope();
  } catch (error) {
    if (error instanceof Error && error.message === "bridge_rejected:authentication_failed")
      return "authentication_failed";
    throw error;
  }
  throw new Error("navigation_read_only_foreign_scope_accepted");
}

async function expectCapabilityNotReady(client, request) {
  try {
    await client.navigationRead(request);
  } catch (error) {
    if (error instanceof Error && error.message === "bridge_capability_not_ready") return "bridge_capability_not_ready";
    throw error;
  }
  throw new Error("navigation_read_only_withdrawn_operation_accepted");
}

async function assertNoExecution(client, observedReceipts) {
  if (!(observedReceipts instanceof Set) || observedReceipts.size !== 0 || client.state.latestReceipt !== null)
    throw new Error("navigation_read_only_execution_receipt_observed");
}

async function withdrawReadOnlyCapabilities(configPath) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("navigation_read_only_fixture_config_invalid");
  }
  if (!Array.isArray(config.EnabledActions) || config.ActionPolicyVersion !== 0)
    throw new Error("navigation_read_only_fixture_config_invalid");
  await writeFile(configPath, `${JSON.stringify({ ...config, EnabledActions: [] }, null, 2)}\n`);
}

async function waitForWithdrawal(client) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await client.observe();
    if (
      sameCapabilities(client.state.capabilities, WITHDRAWN_CAPABILITIES) &&
      sameCapabilities(snapshot.capabilities, WITHDRAWN_CAPABILITIES)
    )
      return snapshot;
    await delay(100);
  }
  throw new Error("navigation_read_only_withdrawal_not_observed");
}

async function connectForeignScope(config) {
  const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");
  const scope = {
    integrationId: "stardew",
    saveId: config.SaveId,
    worldId: `${config.WorldId}_foreign`,
    playerId: config.PlayerId,
    companionId: config.CompanionId,
  };
  const foreign = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
  foreign.close();
}

function sameCapabilities(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const sortedExpected = [...expected].sort();
  return [...actual].sort().every((value, index) => value === sortedExpected[index]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
