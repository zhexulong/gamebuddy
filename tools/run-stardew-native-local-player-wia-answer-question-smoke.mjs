import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
  validateNativeLocalFixturePolicy,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const SCENARIO = "native_wia_answer_question_v1";
const EXPECTED_ACTIONS = ["answer_dialogue", "cancel_active_execution", "move_to_tile", "travel", "observe_scene"];
const REQUIRED_CAPABILITIES = ["answer_dialogue", "cancel_active_execution", "move_to_tile", "observe_scene", "travel"].sort();
const RESPONSE_KEY = "yes";

/**
 * WIA §4.2 answer_dialogue live proof (the question half of the modal family):
 * a move is interrupted by a REAL native question modal (createQuestionDialogue
 * via the same path a map Action tile uses); with the question on screen the
 * SAME session answers it through the Modal admission profile with the native
 * answerDialogue seam; the receipt must be succeeded/answer_dialogue_answered
 * with answered_by_native/outro_started facts; the outro closes the dialogue
 * on a later frame, which the fresh snapshot observes as the actor becoming
 * actionable again.
 */
export async function runWiaAnswerQuestionSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 15_000,
    postconditionTimeoutMs = 15_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 15_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeFresh(client);
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);

    const target = chooseDistantSoilTile(snapshot);
    if (target === null) throw new Error("no_distant_live_soil_tile");

    // ---- phase 1: move into the native question modal ----
    const fresh1 = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    const accepted1 = await execute("interrupt", "move_to_tile", { x: target.x, y: target.y }, fresh1, trace, client);
    if (accepted1.state !== "accepted") throw new Error(`interrupt_not_accepted:${accepted1.reasonCode}`);
    const interrupted = await waitForTerminal(receipts, accepted1, terminalTimeoutMs);
    if (interrupted.state !== "invalidated" || interrupted.reasonCode !== "modal_interrupted")
      throw new Error(`interrupt_missing:state=${interrupted.state};reason=${interrupted.reasonCode}`);
    const interruptEvidence = parseStrictEvidence(interrupted.evidence);
    // The interruption happens on the MOVE slot here (unlike the eat slot's
    // native_animation_pending), so the intent-breakpoint fields are the
    // evidence: who interrupted, the target tile, and where the actor was.
    if (
      typeof interruptEvidence.interrupted_by !== "string" ||
      interruptEvidence.interrupted_by.length === 0 ||
      !/^\d+(\.\d+)?,\d+(\.\d+)?$/.test(interruptEvidence.target_tile || "")
    )
      throw new Error(`interrupt_evidence_missing:${JSON.stringify(interruptEvidence)}`);

    // ---- phase 2: answer the question (Modal admission half-loop) ----
    const fresh2 = await waitForFreshSnapshot(client, {
      minRevision: interrupted.revision,
      timeoutMs: postconditionTimeoutMs,
    });
    const accepted2 = await execute(
      "answer",
      "answer_dialogue",
      { responseKey: RESPONSE_KEY },
      fresh2,
      trace,
      client,
      { requireActionable: false },
    );
    // answer_dialogue is a synchronous modal call: the bridge immediate response
    // IS the terminal, exactly like dismiss_modal; accept either shape.
    let answered =
      accepted2.state === "succeeded" && accepted2.reasonCode === "answer_dialogue_answered"
        ? accepted2
        : accepted2.state === "accepted"
          ? await waitForTerminal(receipts, accepted2, terminalTimeoutMs)
          : accepted2;
    if (answered.state !== "succeeded" || answered.reasonCode !== "answer_dialogue_answered")
      throw new Error(`answer_missing:state=${answered.state};reason=${answered.reasonCode}`);
    const answerEvidence = parseStrictEvidence(answered.evidence);
    const answerOk =
      answerEvidence.modal_type === "DialogueBox" &&
      answerEvidence.question === "true" &&
      answerEvidence.response_key === RESPONSE_KEY &&
      answerEvidence.native_answered === "true" &&
      answerEvidence.outro_started === "true";

    // ---- phase 3: the outro closes the dialogue on a later frame ----
    const after = await waitForActionable(
      client,
      await waitForFreshSnapshot(client, {
        minRevision: answered.revision,
        timeoutMs: postconditionTimeoutMs,
      }),
      stabilizeTimeoutMs,
    );
    const passed = answerOk && after.activeExecution == null;
    return {
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "answer_dialogue_complete" : "wia_answer_question_postcondition_mismatch",
      target,
      phases: {
        interrupt: summarizeReceipt(interrupted),
        answer: summarizeReceipt(answered),
      },
      interruptEvidence,
      answerEvidence,
      answerOk,
      after: summarizeSnapshot(after),
      trace,
      before: summarizeSnapshot(snapshot),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runWiaAnswerQuestionSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(phase, action, args, snapshot, trace, client, { requireActionable = true } = {}) {
  if (requireActionable && (snapshot.actionable !== true || snapshot.activeExecution != null))
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_wia_answer_${phase}_${nonce}`;
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
async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(phase, "move_to_tile", { x: target.x, y: target.y }, fresh, trace, client);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => adjacent(latest.tile, target),
  });
}
async function travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  let fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const warp = resolveFarmWarp(fresh);
  if (!adjacent(fresh.tile, { x: warp.sourceX, y: warp.sourceY }))
    fresh = await moveToTile(
      client,
      receipts,
      fresh,
      { x: warp.sourceX, y: warp.sourceY },
      "move_to_farm_warp",
      trace,
      stabilizeTimeoutMs,
      terminalTimeoutMs,
    );
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, fresh, trace, client);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm",
  });
}
function resolveFarmWarp(snapshot) {
  const matches = Array.isArray(snapshot.warps)
    ? snapshot.warps.filter(
        (warp) =>
          warp?.targetLocation === "Farm" &&
          Number.isInteger(warp.sourceX) &&
          Number.isInteger(warp.sourceY) &&
          Number.isInteger(warp.targetX) &&
          Number.isInteger(warp.targetY) &&
          warp.sourceX >= 0 &&
          warp.sourceY >= 0 &&
          warp.targetX >= 0 &&
          warp.targetY >= 0,
      )
    : [];
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return matches[0];
}
function adjacent(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.y - right.y) <= 1
  );
}
function chooseDistantSoilTile(snapshot) {
  const player = { x: snapshot.tile?.x, y: snapshot.tile?.y };
  if (!Number.isInteger(player.x) || !Number.isInteger(player.y)) return null;
  const ranks = Array.isArray(snapshot.soilTiles)
    ? snapshot.soilTiles
        .filter((tile) => Number.isInteger(tile?.x) && Number.isInteger(tile?.y))
        .map((tile) => ({
          ...tile,
          distance: Math.max(Math.abs(tile.x - player.x), Math.abs(tile.y - player.y)),
        }))
        .filter((tile) => tile.distance >= 2)
        .sort((a, b) => b.distance - a.distance)
    : [];
  return ranks.length > 0 ? { x: ranks[0].x, y: ranks[0].y, distance: ranks[0].distance } : null;
}
function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) return {};
    const key = part.slice(0, index);
    if (Object.hasOwn(result, key)) return {};
    result[key] = part.slice(index + 1);
  }
  return result;
}
function validateNativeLocalFixtureConfig(value) {
  if (value?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true)
    throw new Error("native_local_fixture_topology_not_isolated");
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}