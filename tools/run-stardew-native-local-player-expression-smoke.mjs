// Stardew-local expression smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned
// teardown all come from the shared harness. Action-specific logic (emote enum
// selection, the emote_busy precondition, the facing postcondition and the
// actor-state rereads) stays in this runner.
//
// Both actions are pure embodied-actor mutations:
//   express_emote  -> Farmer.doEmote(int)      postcondition emote_started
//   face_direction -> Farmer.faceDirection(int) postcondition actor_facing_matches
// Neither needs a world object, an inventory slot or a prior navigation, which
// is why the fixture scenario creates no world fact at all.

import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  TERMINAL_STATES,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const EMOTE_ACTION = "express_emote";
const FACING_ACTION = "face_direction";
// `happy` (32) is safe for any actor state and is the emote the retired
// SDW-LIVE-COOP-01 scenario dispatched, so the evidence stays comparable.
const EMOTE = "happy";
const FACING_DIRECTIONS = Object.freeze({ up: 0, right: 1, down: 2, left: 3 });

export async function runExpressionSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 20_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    // Inside the try so a non-isolated topology is reported as a blocked result
    // rather than escaping as an unhandled throw; every runner outcome must be
    // a value the caller can record.
    validateNativeLocalFixtureConfig(config);
    const before = await observeFresh(client, { actionable: true });
    if (!before.capabilities.includes(EMOTE_ACTION))
      throw new Error("native_local_express_emote_capability_missing");
    if (!before.capabilities.includes(FACING_ACTION))
      throw new Error("native_local_face_direction_capability_missing");
    // doEmote is a no-op while an emote is armed (`emote_busy`), so the fixture
    // must start from a settled actor rather than replacing an in-flight emote.
    if (before.activeExecution != null) throw new Error("native_local_expression_actor_busy");

    const emote = await dispatch(client, trace, "emote", EMOTE_ACTION, { emote: EMOTE }, before);
    // A native emote arms synchronously, so the bridge can answer with the
    // terminal receipt directly instead of an interim `accepted`. Both shapes
    // are legitimate: `waitForTerminal` accepts the immediate response when it
    // already carries a terminal state, and otherwise waits on the receipt
    // stream for the same request/execution pair.
    if (emote.state !== "accepted" && !isTerminalState(emote.state))
      throw new Error(`express_emote_not_accepted:${emote.reasonCode}`);
    const emoteTerminal = await waitForTerminal(receipts, emote, terminalTimeoutMs);
    if (emoteTerminal.state !== "succeeded" || emoteTerminal.reasonCode !== "emote_started")
      throw new Error(`express_emote_failed:${emoteTerminal.reasonCode}`);
    const emoteEvidence = parseEmoteEvidence(emoteTerminal.evidence);
    if (emoteEvidence.emote !== EMOTE) throw new Error("express_emote_evidence_mismatch");
    if (emoteEvidence.nativeDispatched !== true) throw new Error("express_emote_native_not_dispatched");
    const afterEmote = await waitForStableRevision(client, {
      revision: emoteTerminal.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (snapshot) => snapshot.actionable === true && snapshot.activeExecution == null,
    });

    // face_direction is exercised in the same turn against the SAME actor. The
    // Mod owns the facing postcondition (`actor_facing_matches` is only emitted
    // after the native FacingDirection equals the requested value), so this
    // runner proves revision advance and actor settlement rather than
    // re-deriving facing from a snapshot field the Host does not publish.
    const facingTarget = await observeFresh(client, { actionable: true });
    const requested = chooseFacingDirection();
    const facing = await dispatch(
      client,
      trace,
      "facing",
      FACING_ACTION,
      { direction: requested },
      facingTarget,
    );
    if (facing.state !== "accepted" && !isTerminalState(facing.state))
      throw new Error(`face_direction_not_accepted:${facing.reasonCode}`);
    const facingTerminal = await waitForTerminal(receipts, facing, terminalTimeoutMs);
    if (facingTerminal.state !== "succeeded" || facingTerminal.reasonCode !== "actor_facing_matches")
      throw new Error(`face_direction_failed:${facingTerminal.reasonCode}`);
    const facingEvidence = parseFacingEvidence(facingTerminal.evidence);
    if (facingEvidence.direction !== requested) throw new Error("face_direction_evidence_mismatch");
    const afterFacing = await waitForStableRevision(client, {
      revision: facingTerminal.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (snapshot) => snapshot.actionable === true && snapshot.activeExecution == null,
    });

    assertExactProof({ emote, emoteTerminal, facing, facingTerminal, afterEmote, afterFacing });
    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "emote_started",
      emote: {
        requested: EMOTE,
        reasonCode: emoteTerminal.reasonCode,
        evidence: emoteEvidence,
      },
      facing: {
        requested,
        expectedFacingValue: FACING_DIRECTIONS[requested],
        reasonCode: facingTerminal.reasonCode,
        evidence: facingEvidence,
      },
      // Distinct native execution identities for the two actions. The redacted
      // receipt summary omits executionId by design, so the identities come
      // from the trace entries, which record the exact accepted executionId.
      executions: Object.freeze({
        emote: trace.find((entry) => entry.phase === "emote")?.executionId ?? null,
        facing: trace.find((entry) => entry.phase === "facing")?.executionId ?? null,
      }),
      receipt: summarizeReceipt(emoteTerminal),
      facingReceipt: summarizeReceipt(facingTerminal),
      before: summarizeSnapshot(before),
      afterEmote: summarizeSnapshot(afterEmote),
      afterFacing: summarizeSnapshot(afterFacing),
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

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runExpressionSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

/** A synchronous native action may answer with its terminal receipt directly. */
function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

async function dispatch(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_expression_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({
    phase,
    action,
    args,
    requestId,
    executionId: receipt.executionId,
    receipt: summarizeReceipt(receipt),
  });
  return receipt;
}

/** Pick a cardinal direction; the Mod proves the actor actually moved there. */
function chooseFacingDirection() {
  return "left";
}

/** `emote=<name>;native_dispatched=true|false` from the Mod-owned receipt. */
function parseEmoteEvidence(evidence) {
  const entries = parseDetailEntries(evidence, ["emote", "native_dispatched"], "invalid_express_emote_evidence");
  if (typeof entries.emote !== "string" || entries.emote.length === 0)
    throw new Error("invalid_express_emote_evidence");
  if (entries.native_dispatched !== "true" && entries.native_dispatched !== "false")
    throw new Error("invalid_express_emote_evidence");
  return { emote: entries.emote, nativeDispatched: entries.native_dispatched === "true" };
}

/** `direction=<name>;facing=<int>` from the Mod-owned receipt. */
function parseFacingEvidence(evidence) {
  const entries = parseDetailEntries(evidence, ["direction"], "invalid_face_direction_evidence");
  if (typeof entries.direction !== "string" || entries.direction.length === 0)
    throw new Error("invalid_face_direction_evidence");
  return { direction: entries.direction };
}

function parseDetailEntries(evidence, expectedKeys, code) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence))
    throw new Error(code);
  const detail = typeof evidence.detail === "string" ? evidence.detail : "";
  const entries = detail.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index <= 0) throw new Error(code);
    return [part.slice(0, index), part.slice(index + 1)];
  });
  const parsed = Object.fromEntries(entries);
  if (
    entries.length !== expectedKeys.length ||
    Object.keys(parsed).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(parsed, key))
  )
    throw new Error(code);
  return parsed;
}

async function waitForStableRevision(client, { revision, timeoutMs, check }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    const snapshot = await observeFresh(client);
    last = snapshot;
    if (snapshot.revision >= revision && check(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`native_local_expression_postcondition_timeout:${last?.revision ?? "none"}`);
}

function assertExactProof({ emote, emoteTerminal, facing, facingTerminal, afterEmote, afterFacing }) {
  if (emoteTerminal.requestId !== emote.requestId) throw new Error("express_emote_request_id_mismatch");
  if (emoteTerminal.executionId !== emote.executionId) throw new Error("express_emote_execution_id_mismatch");
  if (facingTerminal.requestId !== facing.requestId) throw new Error("face_direction_request_id_mismatch");
  if (facingTerminal.executionId !== facing.executionId) throw new Error("face_direction_execution_id_mismatch");
  // The two actions must be distinct executions: one receipt cannot stand in
  // for another action's delivery.
  if (emoteTerminal.executionId === facingTerminal.executionId)
    throw new Error("expression_execution_identity_collision");
  // Monotonic revisions: the facing receipt must be strictly newer than the
  // emote receipt, and the reread snapshots must not lag their own receipt.
  if (!Number.isSafeInteger(emoteTerminal.revision) || !Number.isSafeInteger(facingTerminal.revision))
    throw new Error("expression_revision_invalid");
  if (facingTerminal.revision <= emoteTerminal.revision)
    throw new Error("expression_revision_not_monotonic");
  if (afterEmote.revision < emoteTerminal.revision || afterFacing.revision < facingTerminal.revision)
    throw new Error("expression_postcondition_revision_mismatch");
}

function validateNativeLocalFixtureConfig(value) {
  if (value?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
}
