#!/usr/bin/env node
import { PortfolioStardewBridgeClient } from "../host/dist-portfolio/portfolio-stardew-bridge.js";
/**
 * Attach-only M8 `enter_mine` → `use_mine_ladder` route runner. On exactly one
 * authenticated Portfolio bridge generation it performs the independent
 * floor-1 native mine entry and then the independent ladder descent as two
 * typed requests with distinct request IDs and receipts. The target-version
 * Mod owns every native observation and mutation; this runner never invents a
 * ladder, moves the player, selects an elevator floor, or falls back to any
 * other route. If the ordinary Mine-exterior entry Given or the floor-1
 * ladder Given is absent, it emits a bounded BLOCKED verdict without sending
 * the ladder request.
 */
import { PORTFOLIO_TOPOLOGY } from "./lib/stardew-portfolio-profile.mjs";

const ACTION = "enter_mine";
const ENTRY_ACTION = "enter_mine";
const LADDER_ACTION = "use_mine_ladder";
const ROUTE = "enter_mine_use_mine_ladder";
const ENTRY_TARGET_FLOOR = 1;

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
  emit({ state: "BLOCKED", code: "m8_execute_mode_not_available", action: ACTION, route: ROUTE });
  process.exitCode = 2;
} else if (hasPreflight === hasAction) {
  emit({
    state: "BLOCKED",
    code: hasPreflight ? "m8_modes_are_mutually_exclusive" : "m8_mode_required",
    action: ACTION,
    route: ROUTE,
  });
  process.exitCode = 2;
} else {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    emit({ state: "BLOCKED", code: "portfolio_environment_missing", missing, action: ACTION, route: ROUTE });
    process.exitCode = 2;
  } else if (!Number.isSafeInteger(GIVEN_WAIT_MS) || GIVEN_WAIT_MS < 1_000 || GIVEN_WAIT_MS > 1_800_000) {
    emit({ state: "BLOCKED", code: "m8_route_given_wait_invalid", action: ACTION, route: ROUTE });
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

    // Phase A: one read-only entry-Given probe loop. The Given is the fixed
    // ordinary Maps/Mine Buildings Action=Mine producer under the player's
    // grab tile; no caller coordinate or action text is accepted.
    const entryWaitDeadline = Date.now() + GIVEN_WAIT_MS;
    let entrySnapshot;
    let entryProbe;
    while (true) {
      entrySnapshot = await client.observe();
      if (!readySnapshot(entrySnapshot)) throw new ActionBlocked("m8_route_snapshot_not_ready");
      const probeRequest = requestIdentity("entry_probe", entrySnapshot.revision, ENTRY_ACTION, scope);
      entryProbe = await client.probeMineEntry(probeRequest);
      latestProbe = entryProbe;
      const givenCode = entryGivenCode(entryProbe, probeRequest, entrySnapshot, scope);
      if (givenCode === null) break;
      if (!actionMode || !waitableEntryGivenCode(givenCode)) throw new ActionBlocked(givenCode, entryProbe);
      if (Date.now() >= entryWaitDeadline) throw new ActionBlocked("m8_route_entry_given_wait_timeout", entryProbe);
      await new Promise((resolve) => setTimeout(resolve, GIVEN_POLL_MS));
    }
    if (!actionMode) {
      emit({
        state: "M8_GIVEN_READY",
        action: ACTION,
        route: ROUTE,
        topology: PORTFOLIO_TOPOLOGY,
        probe: entryProbe,
      });
      return;
    }

    // Phase B: one typed entry request pinned to the probe revision. It has
    // its own request identity and its own receipt and is never folded into
    // the ladder request below.
    const entryRequest = requestIdentity("entry_action", entrySnapshot.revision, ENTRY_ACTION, scope);
    const entryStarted = await client.startMineEntry(entryRequest);
    if (
      entryStarted.request.requestId !== entryRequest.requestId ||
      entryStarted.request.traceId !== entryRequest.traceId ||
      typeof entryStarted.executionId !== "string" ||
      entryStarted.executionId.length === 0
    )
      throw new ActionBlocked("m8_route_entry_start_correlation_invalid", entryProbe);
    const entryTerminal = await entryStarted.terminal;
    if (
      entryTerminal.requestId !== entryRequest.requestId ||
      entryTerminal.traceId !== entryRequest.traceId ||
      entryTerminal.executionId !== entryStarted.executionId ||
      entryTerminal.state !== "succeeded" ||
      entryTerminal.reasonCode !== "enter_mine_floor_used" ||
      !sameScope(entryTerminal.evidence?.scope, scope) ||
      entryTerminal.evidence?.entryObserved !== true ||
      entryTerminal.evidence?.nativeEntryTransitionObserved !== true ||
      entryTerminal.evidence?.lowestMineLevelObserved !== true ||
      entryTerminal.postcondition?.targetFloor !== entryProbe.targetFloor ||
      entryTerminal.postcondition?.actualCurrentFloor !== entryProbe.targetFloor ||
      entryTerminal.postcondition?.observedLowestMineLevel < entryProbe.targetFloor ||
      entryTerminal.postcondition?.freshObservation !== true ||
      entryTerminal.postcondition?.sameExecution !== true
    )
      throw new ActionBlocked("m8_route_entry_terminal_invalid", entryProbe);

    const entryFreshFloor = await client.readMineEntryFreshFloor({
      action: ENTRY_ACTION,
      requestId: entryRequest.requestId,
      traceId: entryRequest.traceId,
      executionId: entryStarted.executionId,
      expectedRevision: entryTerminal.revision,
      deadlineMs: Date.now() + 30_000,
      cancellationToken: entryRequest.cancellationToken,
      scope,
    });
    if (
      entryFreshFloor.requestId !== entryRequest.requestId ||
      entryFreshFloor.traceId !== entryRequest.traceId ||
      entryFreshFloor.executionId !== entryStarted.executionId ||
      entryFreshFloor.revision <= entryTerminal.revision ||
      !sameScope(entryFreshFloor.scope, scope) ||
      entryFreshFloor.fresh !== true ||
      entryFreshFloor.currentFloor !== entryProbe.targetFloor ||
      entryFreshFloor.lowestMineLevel < entryProbe.targetFloor
    )
      throw new ActionBlocked("m8_route_entry_fresh_floor_invalid", entryProbe);

    // Phase C: the ladder Given is probed only after a fresh observe of the
    // post-entry revision, still on the same connection and generation. The
    // ladder phase has its own request identities and receipt. If the
    // floor-1 down-ladder is not reachable, the route blocks without ever
    // sending the ladder request: no auto-ladder is invented.
    const ladderWaitDeadline = Date.now() + GIVEN_WAIT_MS;
    let ladderSnapshot;
    let ladderProbe;
    while (true) {
      ladderSnapshot = await client.observe();
      if (!readySnapshot(ladderSnapshot)) throw new ActionBlocked("m8_route_snapshot_not_ready");
      const probeRequest = requestIdentity("ladder_probe", ladderSnapshot.revision, LADDER_ACTION, scope);
      ladderProbe = await client.probeMineLadder(probeRequest);
      latestProbe = ladderProbe;
      const givenCode = ladderGivenCode(ladderProbe, probeRequest, ladderSnapshot, scope);
      if (givenCode === null) break;
      if (!waitableLadderGivenCode(givenCode)) throw new ActionBlocked(givenCode, ladderProbe);
      if (Date.now() >= ladderWaitDeadline) throw new ActionBlocked("m8_route_ladder_given_wait_timeout", ladderProbe);
      await new Promise((resolve) => setTimeout(resolve, GIVEN_POLL_MS));
    }

    const ladderRequest = requestIdentity("ladder_action", ladderSnapshot.revision, LADDER_ACTION, scope);
    const ladderStarted = await client.startMineLadder(ladderRequest);
    if (
      ladderStarted.request.requestId !== ladderRequest.requestId ||
      ladderStarted.request.traceId !== ladderRequest.traceId ||
      typeof ladderStarted.executionId !== "string" ||
      ladderStarted.executionId.length === 0
    )
      throw new ActionBlocked("m8_route_ladder_start_correlation_invalid", ladderProbe);
    const ladderTerminal = await ladderStarted.terminal;
    if (
      ladderTerminal.requestId !== ladderRequest.requestId ||
      ladderTerminal.traceId !== ladderRequest.traceId ||
      ladderTerminal.executionId !== ladderStarted.executionId ||
      ladderTerminal.state !== "succeeded" ||
      ladderTerminal.reasonCode !== "mine_ladder_floor_used" ||
      !sameScope(ladderTerminal.evidence?.scope, scope) ||
      ladderTerminal.evidence?.entryObserved !== true ||
      ladderTerminal.evidence?.nativeLadderTransitionObserved !== true ||
      ladderTerminal.evidence?.lowestMineLevelObserved !== true ||
      ladderTerminal.postcondition?.targetFloor !== ladderProbe.targetFloor ||
      ladderTerminal.postcondition?.actualCurrentFloor !== ladderProbe.targetFloor ||
      ladderTerminal.postcondition?.observedLowestMineLevel < ladderProbe.targetFloor ||
      ladderTerminal.postcondition?.freshObservation !== true ||
      ladderTerminal.postcondition?.sameExecution !== true
    )
      throw new ActionBlocked("m8_route_ladder_terminal_invalid", ladderProbe);

    const ladderFreshFloor = await client.readMineLadderFreshFloor({
      action: LADDER_ACTION,
      requestId: ladderRequest.requestId,
      traceId: ladderRequest.traceId,
      executionId: ladderStarted.executionId,
      expectedRevision: ladderTerminal.revision,
      deadlineMs: Date.now() + 30_000,
      cancellationToken: ladderRequest.cancellationToken,
      scope,
    });
    if (
      ladderFreshFloor.requestId !== ladderRequest.requestId ||
      ladderFreshFloor.traceId !== ladderRequest.traceId ||
      ladderFreshFloor.executionId !== ladderStarted.executionId ||
      ladderFreshFloor.revision <= ladderTerminal.revision ||
      !sameScope(ladderFreshFloor.scope, scope) ||
      ladderFreshFloor.fresh !== true ||
      ladderFreshFloor.currentFloor !== ladderProbe.targetFloor ||
      ladderFreshFloor.lowestMineLevel < ladderProbe.targetFloor
    )
      throw new ActionBlocked("m8_route_ladder_fresh_floor_invalid", ladderProbe);

    emit({
      state: "M8_ACTION_TERMINAL",
      action: ACTION,
      route: ROUTE,
      topology: PORTFOLIO_TOPOLOGY,
      entry: {
        probe: entryProbe,
        terminal: terminalView(entryTerminal),
        freshFloor: entryFreshFloor,
      },
      ladder: {
        probe: ladderProbe,
        terminal: terminalView(ladderTerminal),
        freshFloor: ladderFreshFloor,
      },
    });
  } catch (error) {
    const blocked = error instanceof ActionBlocked ? error : new ActionBlocked(boundedReason(error), latestProbe);
    emit({
      state: "BLOCKED",
      action: ACTION,
      route: ROUTE,
      code: blocked.code,
      probe: blocked.probe ?? latestProbe,
    });
    process.exitCode = 2;
  } finally {
    client?.close("m8_mine_route_runner_complete");
  }
}

function requestIdentity(phase, expectedRevision, action, scope) {
  const now = Date.now();
  const prefix = `m8_route_${phase}_${process.pid}_${now}`;
  return {
    action,
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

function entryGivenCode(probe, request, snapshot, scope) {
  if (
    probe.requestId !== request.requestId ||
    probe.traceId !== request.traceId ||
    probe.revision !== snapshot.revision ||
    !sameScope(probe.scope, scope) ||
    probe.fresh !== true
  )
    return "m8_route_entry_probe_correlation_invalid";
  if (probe.entryObserved !== true) return "m8_route_entry_not_observed";
  if (!Number.isSafeInteger(probe.currentFloor) || probe.currentFloor !== 0) return "m8_route_entry_location_invalid";
  if (!Number.isSafeInteger(probe.targetFloor) || probe.targetFloor !== ENTRY_TARGET_FLOOR)
    return "m8_route_entry_target_invalid";
  return null;
}

function waitableEntryGivenCode(code) {
  return code === "m8_route_entry_not_observed";
}

function ladderGivenCode(probe, request, snapshot, scope) {
  if (
    probe.requestId !== request.requestId ||
    probe.traceId !== request.traceId ||
    probe.revision !== snapshot.revision ||
    !sameScope(probe.scope, scope) ||
    probe.fresh !== true
  )
    return "m8_route_ladder_probe_correlation_invalid";
  if (probe.entryObserved !== true) return "m8_route_ladder_mine_entry_not_observed";
  if (probe.ladderObserved !== true) return "m8_route_ladder_not_observed";
  if (!Number.isSafeInteger(probe.currentFloor) || probe.currentFloor < 0)
    return "m8_route_ladder_current_floor_invalid";
  if (!Number.isSafeInteger(probe.targetFloor) || probe.targetFloor !== probe.currentFloor + 1)
    return "m8_route_ladder_target_invalid";
  return null;
}

function waitableLadderGivenCode(code) {
  return code === "m8_route_ladder_mine_entry_not_observed" || code === "m8_route_ladder_not_observed";
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
