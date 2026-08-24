#!/usr/bin/env node
import { PortfolioStardewBridgeClient } from "../host/dist-portfolio/portfolio-stardew-bridge.js";
/**
 * Attach-only M8 `use_mine_ladder` runner. It reads one fresh native ladder
 * Given, then performs at most one typed ladder request. The target-version
 * Mod owns every native observation and mutation.
 */
import { PORTFOLIO_TOPOLOGY } from "./lib/stardew-portfolio-profile.mjs";

const ACTION = "use_mine_ladder";

class ActionBlocked extends Error {
  constructor(code, probe = null) {
    super(code);
    this.code = code;
    this.probe = probe;
  }
}

const required = [
  "GAMEBUDDY_PORTFOLIO_PIPE_NAME",
  "GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN",
  "GAMEBUDDY_PORTFOLIO_SAVE_ID",
  "GAMEBUDDY_PORTFOLIO_WORLD_ID",
  "GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID",
  "GAMEBUDDY_PORTFOLIO_COMPANION_ID",
];

const hasPreflight = process.argv.includes("--preflight");
const hasAction = process.argv.includes("--action");
const GIVEN_WAIT_MS = Number(process.env.GAMEBUDDY_PORTFOLIO_M8_GIVEN_WAIT_MS ?? 600_000);
const GIVEN_POLL_MS = 1_000;
if (process.argv.includes("--execute")) {
  emit({ state: "BLOCKED", code: "m8_execute_mode_not_available", action: ACTION });
  process.exitCode = 2;
} else if (hasPreflight === hasAction) {
  emit({
    state: "BLOCKED",
    code: hasPreflight ? "m8_modes_are_mutually_exclusive" : "m8_mode_required",
    action: ACTION,
  });
  process.exitCode = 2;
} else {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    emit({ state: "BLOCKED", code: "portfolio_environment_missing", missing });
    process.exitCode = 2;
  } else {
    await run({ actionMode: hasAction });
  }
}

async function run({ actionMode }) {
  let client;
  let latestProbe = null;
  try {
    const nativeScope = {
      saveId: process.env.GAMEBUDDY_PORTFOLIO_SAVE_ID,
      worldId: process.env.GAMEBUDDY_PORTFOLIO_WORLD_ID,
      localPlayerId: process.env.GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID,
      companionId: process.env.GAMEBUDDY_PORTFOLIO_COMPANION_ID,
    };
    client = await PortfolioStardewBridgeClient.connectBootstrap(
      nativeScope,
      process.env.GAMEBUDDY_PORTFOLIO_PIPE_NAME,
      process.env.GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN,
    );
    const scope = client.scope;
    if (!Number.isSafeInteger(GIVEN_WAIT_MS) || GIVEN_WAIT_MS < 1_000 || GIVEN_WAIT_MS > 1_800_000)
      throw new ActionBlocked("m8_ladder_given_wait_invalid");
    const waitDeadline = Date.now() + GIVEN_WAIT_MS;
    let snapshot;
    let probe;
    while (true) {
      snapshot = await client.observe();
      if (!readySnapshot(snapshot)) throw new ActionBlocked("m8_ladder_snapshot_not_ready");
      const probeRequest = requestIdentity("probe", snapshot.revision, scope);
      probe = await client.probeMineLadder(probeRequest);
      latestProbe = probe;
      const givenCode = ladderGivenCode(probe, probeRequest, snapshot, scope);
      if (givenCode === null) break;
      if (!actionMode || !waitableGivenCode(givenCode)) throw new ActionBlocked(givenCode, probe);
      if (Date.now() >= waitDeadline) throw new ActionBlocked("m8_ladder_given_wait_timeout", probe);
      await new Promise((resolve) => setTimeout(resolve, GIVEN_POLL_MS));
    }
    if (!actionMode) {
      emit({ state: "M8_GIVEN_READY", action: ACTION, topology: PORTFOLIO_TOPOLOGY, probe });
      return;
    }

    const request = requestIdentity("action", snapshot.revision, scope);
    const started = await client.startMineLadder(request);
    if (
      started.request.requestId !== request.requestId ||
      started.request.traceId !== request.traceId ||
      typeof started.executionId !== "string" ||
      started.executionId.length === 0
    )
      throw new ActionBlocked("m8_ladder_start_correlation_invalid", probe);
    const terminal = await started.terminal;
    if (
      terminal.requestId !== request.requestId ||
      terminal.traceId !== request.traceId ||
      terminal.executionId !== started.executionId ||
      terminal.state !== "succeeded" ||
      terminal.reasonCode !== "mine_ladder_floor_used" ||
      !sameScope(terminal.evidence?.scope, scope) ||
      terminal.evidence?.entryObserved !== true ||
      terminal.evidence?.nativeLadderTransitionObserved !== true ||
      terminal.evidence?.lowestMineLevelObserved !== true ||
      terminal.postcondition?.targetFloor !== probe.targetFloor ||
      terminal.postcondition?.actualCurrentFloor !== probe.targetFloor ||
      terminal.postcondition?.observedLowestMineLevel < probe.targetFloor ||
      terminal.postcondition?.freshObservation !== true ||
      terminal.postcondition?.sameExecution !== true
    )
      throw new ActionBlocked("m8_ladder_terminal_invalid", probe);

    const freshFloor = await client.readMineLadderFreshFloor({
      action: ACTION,
      requestId: request.requestId,
      traceId: request.traceId,
      executionId: started.executionId,
      expectedRevision: terminal.revision,
      deadlineMs: Date.now() + 30_000,
      cancellationToken: request.cancellationToken,
      scope,
    });
    if (
      freshFloor.requestId !== request.requestId ||
      freshFloor.traceId !== request.traceId ||
      freshFloor.executionId !== started.executionId ||
      freshFloor.revision <= terminal.revision ||
      !sameScope(freshFloor.scope, scope) ||
      freshFloor.fresh !== true ||
      freshFloor.currentFloor !== probe.targetFloor ||
      freshFloor.lowestMineLevel < probe.targetFloor
    )
      throw new ActionBlocked("m8_ladder_fresh_floor_invalid", probe);

    emit({
      state: "M8_ACTION_TERMINAL",
      action: ACTION,
      topology: PORTFOLIO_TOPOLOGY,
      probe,
      terminal: terminalView(terminal),
      freshFloor,
    });
  } catch (error) {
    const blocked = error instanceof ActionBlocked ? error : new ActionBlocked(boundedReason(error), latestProbe);
    emit({
      state: "BLOCKED",
      action: ACTION,
      code: blocked.code,
      probe: blocked.probe ?? latestProbe,
    });
    process.exitCode = 2;
  } finally {
    client?.close("m8_ladder_runner_complete");
  }
}

function requestIdentity(phase, expectedRevision, scope) {
  const now = Date.now();
  const prefix = `m8_ladder_${phase}_${process.pid}_${now}`;
  return {
    action: ACTION,
    requestId: `${prefix}_request`,
    traceId: `${prefix}_trace`,
    idempotencyKey: `${prefix}_idem`,
    expectedRevision,
    deadlineMs: now + 30_000,
    cancellationToken: `${prefix}_cancel`,
    scope,
  };
}

function readySnapshot(snapshot) {
  return (
    snapshot?.state === "ready" &&
    snapshot.revision >= 0 &&
    snapshot.worldReady === true &&
    snapshot.singlePlayer === true &&
    snapshot.currentLocalPlayerMatches === true
  );
}

function ladderGivenCode(probe, request, snapshot, scope) {
  if (
    probe.requestId !== request.requestId ||
    probe.traceId !== request.traceId ||
    probe.revision !== snapshot.revision ||
    !sameScope(probe.scope, scope) ||
    probe.fresh !== true
  )
    return "m8_ladder_probe_correlation_invalid";
  if (probe.entryObserved !== true) return "m8_ladder_mine_entry_not_observed";
  if (probe.ladderObserved !== true) return "m8_ladder_not_observed";
  if (!Number.isSafeInteger(probe.currentFloor) || probe.currentFloor < 0) return "m8_ladder_current_floor_invalid";
  if (!Number.isSafeInteger(probe.targetFloor) || probe.targetFloor !== probe.currentFloor + 1)
    return "m8_ladder_target_invalid";
  return null;
}

function waitableGivenCode(code) {
  return code === "m8_ladder_mine_entry_not_observed" || code === "m8_ladder_not_observed";
}

function terminalView(terminal) {
  return {
    requestId: terminal.requestId,
    traceId: terminal.traceId,
    executionId: terminal.executionId,
    state: terminal.state,
    revision: terminal.revision,
    reasonCode: terminal.reasonCode,
    evidence: terminal.evidence,
    postcondition: terminal.postcondition,
  };
}

function sameScope(actual, expected) {
  const fields = [
    "integrationId",
    "topology",
    "saveId",
    "worldId",
    "localPlayerId",
    "companionId",
    "bindingGeneration",
    "bindingHash",
  ];
  return (
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual) &&
    Object.keys(actual).length === fields.length &&
    fields.every((field) => actual[field] === expected[field])
  );
}

function boundedReason(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s+/g, " ")
    .slice(0, 256);
}

function emit(value) {
  console.log(JSON.stringify(value));
}
