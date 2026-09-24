import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "plant_sapling";
const SCENARIO = "native_plant_sapling_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute the plant_sapling contract against an already-connected bridge session. */
export async function runPlantSaplingSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    const before = await observeFresh(client, { actionable: true });
    assertExactCapabilities(before, EXPECTED_CAPABILITIES);
    // The fixture guarantees exactly one legally plantable tile with a standable
    // neighbour and warps the player onto that neighbour. Discovery scans a wider
    // radius, so select the target the player can actually act on instead of the
    // first one the snapshot happens to list: the native admission requires
    // Chebyshev <= 1 and nothing here may walk (move_to_tile is not a capability
    // of this fixture).
    const target = chooseAdjacentSaplingTarget(before);
    const requestId = `native_local_plant-sapling_${Date.now()}`;
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
      throw new Error("plant_sapling_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "sapling_planted")
      throw new Error(`plant_sapling_failed:${terminal.reasonCode}`);
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await observeFresh(client, { actionable: true, minRevision: terminal.revision });
    assertExactCapabilities(after, EXPECTED_CAPABILITIES);
    const passed =
      after.revision >= terminal.revision &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.item === target.qualifiedItemId &&
      evidence.native_placement === "true";
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "sapling_planted" : "plant_sapling_postcondition_mismatch",
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


function chooseAdjacentSaplingTarget(snapshot) {
  const targets = snapshot.treeSaplingTargets ?? [];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("plant_sapling_target_count_expected_at_least_1_got_0");
  const wellFormed = targets.filter(
    (entry) =>
      entry?.targetId &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y) &&
      (Number.isInteger(entry.slot) || entry.slot === 0) &&
      typeof entry.qualifiedItemId === "string" &&
      entry.qualifiedItemId.length > 0,
  );
  if (wellFormed.length === 0) throw new Error("plant_sapling_target_malformed");
  const adjacent = wellFormed.filter(
    (entry) => Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1,
  );
  if (adjacent.length === 0) throw new Error("plant_sapling_no_adjacent_target");
  return adjacent[0];
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
    const result = await runPlantSaplingSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
