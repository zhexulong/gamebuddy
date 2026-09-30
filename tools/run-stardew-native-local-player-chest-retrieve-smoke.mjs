import {
  assertTopologyCapabilities,
  classifyTopology,
  connectNativeLocalClient,
  executeFresh,
  observeTopologySnapshot,
  readNativeClientConfig,
  validateNativeLocalFixturePolicy,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "chest_retrieve";
const SCENARIO = "native_chest_retrieve_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute the chest_retrieve contract against an already-connected bridge session. */
export async function runChestRetrieveSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  const topology = validateTopologyConfig(config);
  try {
    const before = await observeTopologySnapshot(client, topology, { actionable: true });
    assertTopologyCapabilities(before, topology, EXPECTED_CAPABILITIES);
    const target = chooseOnlyChestRetrieveTarget(before);
    const requestId = `native_local_chest-retrieve_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {
        slot: 0,
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
      throw new Error("chest_retrieve_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "chest_retrieved")
      throw new Error(`chest_retrieve_failed:${terminal.reasonCode}`);
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeTopologySnapshot(client, topology, { actionable: true, minRevision: terminal.revision });
    assertTopologyCapabilities(after, topology, EXPECTED_CAPABILITIES);
    const passed =
      after.revision >= terminal.revision &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.item === target.qualifiedItemId &&
      evidence.native_menu_opened === "false" &&
      evidence.inventory_before === "0";
    return {
      state: passed ? "passed" : "blocked",
      topology,
      reasonCode: passed ? "chest_retrieved" : "chest_retrieve_postcondition_mismatch",
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
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

/**
 * Select the topology this contract is being executed under.
 *
 * The shared world is the real AI-Farmhand topology: an authenticated Farmhand
 * provisioner owns the bridge and the version-1 default-consent policy
 * publishes the consented surface, including the experimental action under
 * test once the profile opts into it. The chest precondition belongs to the
 * Host-side fixture, so it is not asserted from the client config here. The
 * isolated native-local fixture keeps its strict capability equality.
 */
function validateTopologyConfig(value) {
  const topology = classifyTopology(value);
  // The retired `ActionPolicyVersion` selector is gone; policy is the derived
  // deny-by-exception block, so the shape check is what still applies.
  validateNativeLocalFixturePolicy(value, {});
  return topology;
}

/** The sole player-owned ordinary Chest target the contract will admit. */
export function chooseOnlyChestRetrieveTarget(snapshot) {
  const targets = snapshot.chestRetrieveTargets ?? [];
  if (targets.length !== 1) throw new Error(`chest_retrieve_target_count_expected_1_got_${targets.length}`);
  const target = targets[0];
  if (!target?.targetId || !Number.isInteger(target.x) || !Number.isInteger(target.y) || typeof target.qualifiedItemId !== "string")
    throw new Error("chest_retrieve_target_malformed");
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
    const result = await runChestRetrieveSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
