import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "collect_crab_pot_output";
const SCENARIO = "native_crab_pot_collect_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute the collect_crab_pot_output contract against an already-connected bridge session. */
export async function runCrabPotCollectSmoke(
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
    const target = chooseOnlyCrabPotCollectTarget(before);
    const requestId = `native_local_crab_pot_collect_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot: before,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: target.targetId, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("crab_pot_collect_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "crab_pot_output_collected")
      throw new Error(`crab_pot_collect_failed:${terminal.state}:${terminal.reasonCode}`);
    const evidence = parseStrictEvidence(terminal.evidence);
    // The native collection starts an actor animation (animateOnce sets
    // CanMove=false), so the player is deliberately not actionable right after
    // the receipt. The pot state is still readable, and the point of this reread
    // is that the collected pot is gone from the mature set, not that the actor
    // has finished its animation.
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
    });
    assertExactCapabilities(after, EXPECTED_CAPABILITIES);
    const delivered = Number(evidence.stack_delivered);
    const passed =
      after.revision >= terminal.revision &&
      evidence.target === target.targetId &&
      evidence.pot === "(O)710" &&
      evidence.pot_retained === "true" &&
      evidence.native_handled === "true" &&
      evidence.held_after === "none" &&
      evidence.ready_after === "false" &&
      evidence.tile_index_after === "710" &&
      evidence.bait_after === "none" &&
      Number.isSafeInteger(delivered) &&
      delivered >= 1 &&
      delivered <= 2 &&
      Number(evidence.inventory_after) === Number(evidence.inventory_before) + delivered &&
      (after.crabPotCollectTargets ?? []).every((entry) => entry?.targetId !== target.targetId);
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "crab_pot_output_collected" : "crab_pot_collect_postcondition_mismatch",
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

function chooseOnlyCrabPotCollectTarget(snapshot) {
  const targets = snapshot.crabPotCollectTargets ?? [];
  if (targets.length !== 1) throw new Error(`crab_pot_collect_target_count_expected_1_got_${targets.length}`);
  const target = targets[0];
  if (
    typeof target?.targetId !== "string" ||
    !/^collect_crab_pot_[a-f0-9]{16}$/u.test(target.targetId) ||
    !Number.isInteger(target.x) ||
    !Number.isInteger(target.y) ||
    target.qualifiedItemId !== "(O)710" ||
    typeof target.outputQualifiedItemId !== "string" ||
    target.outputQualifiedItemId.length === 0 ||
    !Number.isInteger(target.outputStack) ||
    target.outputStack < 1
  )
    throw new Error("crab_pot_collect_target_malformed");
  return target;
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
    const result = await runCrabPotCollectSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

export { ACTION as CRAB_POT_COLLECT_ACTION, SCENARIO as CRAB_POT_COLLECT_FIXTURE_SCENARIO };
