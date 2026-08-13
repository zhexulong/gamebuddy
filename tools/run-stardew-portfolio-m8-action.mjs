#!/usr/bin/env node
/**
 * Attach-only M8 runner. The target-version Mod must already be running;
 * --preflight observes one fresh snapshot and sends exactly one read-only probe;
 * --action performs that same probe before one typed action request. It never
 * launches Stardew, starts P0b, writes a save, invokes a save/close/reopen
 * lifecycle, or invokes UI/input automation. This action's declared result is
 * the same-execution elevator transition and fresh current-floor observation;
 * it does not claim a persistence effect.
 */
import { computePortfolioBindingHash } from "./lib/stardew-portfolio-contract-primitives.mjs";
import { PORTFOLIO_TOPOLOGY } from "./lib/stardew-portfolio-profile.mjs";
import { PortfolioStardewBridgeClient } from "../host/dist-portfolio/portfolio-stardew-bridge.js";

const ACTION = "select_mine_elevator_floor";
const required = [
  "GAMEBUDDY_PORTFOLIO_PIPE_NAME", "GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN",
  "GAMEBUDDY_PORTFOLIO_SAVE_ID", "GAMEBUDDY_PORTFOLIO_WORLD_ID",
  "GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID", "GAMEBUDDY_PORTFOLIO_COMPANION_ID",
  "GAMEBUDDY_PORTFOLIO_BINDING_GENERATION", "GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT",
];

const hasPreflight = process.argv.includes("--preflight");
const hasAction = process.argv.includes("--action");
if (process.argv.includes("--execute")) {
  emit({ state: "BLOCKED", code: "m8_execute_mode_not_available", action: ACTION });
  process.exitCode = 2;
} else if (hasPreflight === hasAction) {
  emit({ state: "BLOCKED", code: hasPreflight ? "m8_modes_are_mutually_exclusive" : "m8_mode_required", action: ACTION });
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
  try {
    const bindingGeneration = Number(process.env.GAMEBUDDY_PORTFOLIO_BINDING_GENERATION);
    const selectedCheckpoint = Number(process.env.GAMEBUDDY_PORTFOLIO_M8_CHECKPOINT);
    if (!Number.isSafeInteger(bindingGeneration) || bindingGeneration <= 0 ||
        !Number.isSafeInteger(selectedCheckpoint) || selectedCheckpoint < 5 || selectedCheckpoint > 120 || selectedCheckpoint % 5 !== 0)
      throw new Error("m8_probe_configuration_invalid");
    const nativeScope = {
      saveId: process.env.GAMEBUDDY_PORTFOLIO_SAVE_ID,
      worldId: process.env.GAMEBUDDY_PORTFOLIO_WORLD_ID,
      localPlayerId: process.env.GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID,
      companionId: process.env.GAMEBUDDY_PORTFOLIO_COMPANION_ID,
      bindingGeneration,
    };
    const scope = {
      integrationId: "stardew_portfolio",
      topology: PORTFOLIO_TOPOLOGY,
      ...nativeScope,
      bindingHash: computePortfolioBindingHash(nativeScope),
    };
    client = await PortfolioStardewBridgeClient.connect(
      scope,
      process.env.GAMEBUDDY_PORTFOLIO_PIPE_NAME,
      process.env.GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN,
    );
    const snapshot = await client.observe();
    if (snapshot.state !== "ready" || snapshot.revision < 0 || snapshot.worldReady !== true ||
        snapshot.singlePlayer !== true || snapshot.currentLocalPlayerMatches !== true)
      throw new Error(`m8_probe_snapshot_not_ready:${snapshot.reasonCode}`);
    const now = Date.now();
    const request = {
      action: ACTION,
      requestId: `m8_probe_${process.pid}_${now}`,
      traceId: `m8_probe_trace_${process.pid}_${now}`,
      idempotencyKey: `m8_probe_idem_${process.pid}_${now}`,
      selectedCheckpoint,
      expectedRevision: snapshot.revision,
      deadlineMs: now + 30_000,
      cancellationToken: `m8_probe_cancel_${process.pid}_${now}`,
      scope,
    };
    const probe = await client.probeMineElevator(request);
    if (probe.requestId !== request.requestId || probe.traceId !== request.traceId ||
        probe.revision !== snapshot.revision || probe.selectedCheckpoint !== selectedCheckpoint ||
        !sameScope(probe.scope, scope) || probe.fresh !== true ||
        probe.entryObserved !== true || probe.targetUnlocked !== true)
      throw new Error("m8_probe_given_not_ready");
    if (!actionMode) {
      emit({ state: "M8_GIVEN_READY", action: ACTION, topology: PORTFOLIO_TOPOLOGY, probe });
      return;
    }

    // The action has new request identities, but is pinned to the exact
    // revision observed before the one read-only Given probe.
    const actionNow = Date.now();
    const actionRequest = {
      action: ACTION,
      requestId: `m8_action_${process.pid}_${actionNow}`,
      traceId: `m8_action_trace_${process.pid}_${actionNow}`,
      idempotencyKey: `m8_action_idem_${process.pid}_${actionNow}`,
      selectedCheckpoint,
      expectedRevision: snapshot.revision,
      deadlineMs: actionNow + 30_000,
      cancellationToken: `m8_action_cancel_${process.pid}_${actionNow}`,
      scope,
    };
    const started = await client.startMineElevator(actionRequest);
    if (started.request.requestId !== actionRequest.requestId ||
        started.request.traceId !== actionRequest.traceId || started.executionId.length === 0)
      throw new Error("m8_action_start_correlation_invalid");
    const terminal = await started.terminal;
    if (terminal.requestId !== actionRequest.requestId || terminal.traceId !== actionRequest.traceId ||
        terminal.executionId !== started.executionId || terminal.state !== "succeeded" ||
        terminal.reasonCode !== "mine_elevator_floor_selected" ||
        !sameScope(terminal.evidence?.scope, scope) ||
        terminal.postcondition?.selectedCheckpoint !== selectedCheckpoint ||
        terminal.postcondition?.actualCurrentFloor !== selectedCheckpoint ||
        terminal.postcondition?.freshObservation !== true ||
        terminal.postcondition?.sameExecution !== true)
      throw new Error("m8_action_terminal_correlation_invalid");
    const freshFloor = await client.readMineElevatorFreshFloor({
      action: ACTION,
      requestId: actionRequest.requestId,
      traceId: actionRequest.traceId,
      executionId: started.executionId,
      expectedRevision: terminal.revision,
      deadlineMs: Date.now() + 30_000,
      cancellationToken: actionRequest.cancellationToken,
      scope,
    });
    if (freshFloor.requestId !== actionRequest.requestId || freshFloor.traceId !== actionRequest.traceId ||
        freshFloor.executionId !== started.executionId || freshFloor.revision <= terminal.revision ||
        !sameScope(freshFloor.scope, scope) || freshFloor.fresh !== true ||
        freshFloor.currentFloor !== selectedCheckpoint || freshFloor.lowestMineLevel < selectedCheckpoint)
      throw new Error("m8_action_fresh_floor_correlation_invalid");
    // This primitive changes the player's current mine location but does not
    // claim to increase or persist MineShaft.lowestLevelReached. The terminal
    // receipt plus fresh post-warp floor fact is therefore its complete action
    // result; any aggregate M8 progress/persistence monitor belongs to the
    // route action that actually advances mine progress.
    const actionTerminal = {
      requestId: terminal.requestId,
      traceId: terminal.traceId,
      executionId: terminal.executionId,
      state: terminal.state,
      revision: terminal.revision,
      reasonCode: terminal.reasonCode,
      evidence: {
        scope: terminal.evidence.scope,
        phaseTrace: terminal.evidence.phaseTrace,
        entryObserved: terminal.evidence.entryObserved,
        currentFloorBefore: terminal.evidence.currentFloorBefore,
        lowestMineLevelBefore: terminal.evidence.lowestMineLevelBefore,
        opaqueElevatorTarget: terminal.evidence.opaqueElevatorTarget,
        nativeElevatorTransitionObserved: terminal.evidence.nativeElevatorTransitionObserved,
        currentFloorAfter: terminal.evidence.currentFloorAfter,
        lowestMineLevelAfter: terminal.evidence.lowestMineLevelAfter,
        lowestMineLevelObserved: terminal.evidence.lowestMineLevelObserved,
      },
      postcondition: {
        selectedCheckpoint: terminal.postcondition.selectedCheckpoint,
        actualCurrentFloor: terminal.postcondition.actualCurrentFloor,
        observedLowestMineLevel: terminal.postcondition.observedLowestMineLevel,
        opaqueElevatorTarget: terminal.postcondition.opaqueElevatorTarget,
        freshObservation: terminal.postcondition.freshObservation,
        sameExecution: terminal.postcondition.sameExecution,
      },
    };
    emit({
      state: "M8_ACTION_TERMINAL",
      action: ACTION,
      topology: PORTFOLIO_TOPOLOGY,
      terminal: actionTerminal,
      freshFloor,
    });
  } catch (error) {
    emit({ state: "BLOCKED", action: ACTION, code: boundedReason(error) });
    process.exitCode = 2;
  } finally {
    client?.close("m8_action_runner_complete");
  }
}

function sameScope(actual, expected) {
  const fields = [
    "integrationId", "topology", "saveId", "worldId", "localPlayerId",
    "companionId", "bindingGeneration", "bindingHash",
  ];
  return actual !== null && typeof actual === "object" && !Array.isArray(actual) &&
    Object.keys(actual).length === fields.length &&
    fields.every((field) => actual[field] === expected[field]);
}
function boundedReason(error) {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 256);
}
function emit(value) {
  console.log(JSON.stringify(value));
}
