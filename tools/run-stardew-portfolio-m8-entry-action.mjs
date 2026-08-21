#!/usr/bin/env node
import { PortfolioStardewBridgeClient } from "../host/dist-portfolio/portfolio-stardew-bridge.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
/**
 * Attach-only M8 `enter_mine` runner. The optional ordered combo profile
 * performs an independent native `skip_event` first, then the independent
 * Mine-exterior to floor-1 transition. Each action has its own receipt and
 * evidence; this runner never folds the two effects together.
 */
import { PORTFOLIO_TOPOLOGY } from "./lib/stardew-portfolio-profile.mjs";

const ACTION = "enter_mine";
const SKIP_EVENT_ACTION = "skip_event";
const TARGET_FLOOR = 1;
const skipEventEnabled = process.env.GAMEBUDDY_PORTFOLIO_M8_SKIP_EVENT_ENABLED === "1";

class ActionBlocked extends Error {
  constructor(code, probe = null) {
    super(code);
    this.code = code;
    this.probe = probe;
  }
}

const REQUIRED = [
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
const diagnosticJournal = createDiagnosticJournal(process.env.GAMEBUDDY_PORTFOLIO_M8_RUNNER_JOURNAL_PATH);

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
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    emit({ state: "BLOCKED", code: "portfolio_environment_missing", missing, action: ACTION });
    process.exitCode = 2;
  } else if (!Number.isSafeInteger(GIVEN_WAIT_MS) || GIVEN_WAIT_MS < 1_000 || GIVEN_WAIT_MS > 1_800_000) {
    emit({ state: "BLOCKED", code: "m8_entry_given_wait_invalid", action: ACTION });
    process.exitCode = 2;
  } else {
    await run({ actionMode: hasAction });
  }
}

async function run({ actionMode }) {
  let client;
  let latestProbe = null;
  try {
    await diagnosticJournal.stage("runner_started");
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
    await diagnosticJournal.stage("bridge_connected");
    const scope = client.scope;
    const deadline = Date.now() + GIVEN_WAIT_MS;
    let snapshot;
    let probe;
    let skipEventProbe = null;
    const skipEventTerminals = [];
    while (true) {
      snapshot = await client.observe();
      await diagnosticJournal.stage("snapshot_observed");
      if (!readySnapshot(snapshot)) throw new ActionBlocked("m8_entry_snapshot_not_ready");
      if (skipEventEnabled) {
        // Re-probe on every fresh snapshot. An Event may arise while this
        // runner waits for the Mine-exterior Given; enter_mine must never
        // race past an independently required skip_event.
        const skipProbeRequest = requestIdentity(SKIP_EVENT_ACTION, "probe", snapshot.revision, scope);
        skipEventProbe = await client.probeSkipEvent(skipProbeRequest);
        await diagnosticJournal.stage("skip_event_probed");
        if (skipEventProbe.eventObserved) {
          await diagnosticJournal.milestone("skip_event_observed");
          if (!actionMode) {
            emit({
              state: "M8_SEQUENCE_READY",
              action: ACTION,
              topology: PORTFOLIO_TOPOLOGY,
              skipEventProbe,
              skipEventTerminals: [],
              probe: null,
            });
            return;
          }
          const skipRequest = requestIdentity(SKIP_EVENT_ACTION, "action", snapshot.revision, scope);
          await diagnosticJournal.stage("skip_event_starting");
          await diagnosticJournal.milestone("skip_event_starting");
          const skipStarted = await client.startSkipEvent(skipRequest);
          await diagnosticJournal.stage("skip_event_accepted");
          await diagnosticJournal.milestone("skip_event_accepted");
          if (
            skipStarted.request.requestId !== skipRequest.requestId ||
            skipStarted.request.traceId !== skipRequest.traceId ||
            typeof skipStarted.executionId !== "string" ||
            skipStarted.executionId.length === 0
          )
            throw new ActionBlocked("m8_skip_event_start_correlation_invalid", skipEventProbe);
          const skipEventTerminal = await skipStarted.terminal;
          await diagnosticJournal.stage("skip_event_terminal_received");
          await diagnosticJournal.milestone("skip_event_terminal_received");
          if (!validSkipEventTerminal(skipEventTerminal, skipRequest, skipStarted.executionId, scope))
            throw new ActionBlocked("m8_skip_event_terminal_invalid", skipEventProbe);
          skipEventTerminals.push(terminalView(skipEventTerminal));
          continue;
        }
      }
      const probeRequest = requestIdentity(ACTION, "probe", snapshot.revision, scope);
      probe = await client.probeMineEntry(probeRequest);
      await diagnosticJournal.stage("enter_mine_probed");
      latestProbe = probe;
      const code = entryGivenCode(probe, probeRequest, snapshot, scope);
      await diagnosticJournal.probe(code ?? "entry_ready");
      if (code === null) break;
      if (!actionMode || !waitableGivenCode(code)) throw new ActionBlocked(code, probe);
      if (Date.now() >= deadline) throw new ActionBlocked("m8_entry_given_wait_timeout", probe);
      await new Promise((resolve) => setTimeout(resolve, GIVEN_POLL_MS));
    }
    if (!actionMode) {
      emit({ state: "M8_GIVEN_READY", action: ACTION, topology: PORTFOLIO_TOPOLOGY, skipEventProbe, probe });
      return;
    }

    const request = requestIdentity(ACTION, "action", snapshot.revision, scope);
    await diagnosticJournal.stage("enter_mine_starting");
    await diagnosticJournal.milestone("enter_mine_starting");
    const started = await client.startMineEntry(request);
    await diagnosticJournal.stage("enter_mine_accepted");
    await diagnosticJournal.milestone("enter_mine_accepted");
    if (
      started.request.requestId !== request.requestId ||
      started.request.traceId !== request.traceId ||
      typeof started.executionId !== "string" ||
      started.executionId.length === 0
    )
      throw new ActionBlocked("m8_entry_start_correlation_invalid", probe);

    const terminal = await started.terminal;
    await diagnosticJournal.stage("enter_mine_terminal_received");
    await diagnosticJournal.milestone("enter_mine_terminal_received");
    if (
      terminal.requestId !== request.requestId ||
      terminal.traceId !== request.traceId ||
      terminal.executionId !== started.executionId ||
      terminal.state !== "succeeded" ||
      terminal.reasonCode !== "enter_mine_floor_used" ||
      !sameScope(terminal.evidence?.scope, scope) ||
      terminal.evidence?.entryObserved !== true ||
      terminal.evidence?.nativeEntryTransitionObserved !== true ||
      terminal.evidence?.lowestMineLevelObserved !== true ||
      terminal.postcondition?.targetFloor !== probe.targetFloor ||
      terminal.postcondition?.actualCurrentFloor !== probe.targetFloor ||
      terminal.postcondition?.observedLowestMineLevel < probe.targetFloor ||
      terminal.postcondition?.freshObservation !== true ||
      terminal.postcondition?.sameExecution !== true
    )
      throw new ActionBlocked("m8_entry_terminal_invalid", probe);

    await diagnosticJournal.stage("fresh_floor_starting");
    const freshFloor = await client.readMineEntryFreshFloor({
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
      freshFloor.currentFloor !== TARGET_FLOOR ||
      freshFloor.lowestMineLevel < TARGET_FLOOR
    )
      throw new ActionBlocked("m8_entry_fresh_floor_invalid", probe);

    await diagnosticJournal.stage("fresh_floor_received");
    emit({
      state: "M8_ACTION_TERMINAL",
      action: ACTION,
      topology: PORTFOLIO_TOPOLOGY,
      skipEventProbe,
      skipEventTerminals,
      probe,
      terminal: terminalView(terminal),
      freshFloor,
    });
  } catch (error) {
    const blocked = error instanceof ActionBlocked ? error : new ActionBlocked(boundedReason(error), latestProbe);
    await diagnosticJournal.stage("runner_blocked");
    emit({ state: "BLOCKED", action: ACTION, code: blocked.code, probe: blocked.probe ?? latestProbe });
    process.exitCode = 2;
  } finally {
    client?.close("m8_entry_runner_complete");
    await diagnosticJournal.stage("runner_finished");
  }
}

function createDiagnosticJournal(value) {
  if (typeof value !== "string" || value.length === 0) return Object.freeze({ stage: async () => undefined });
  const root = resolve(process.cwd(), ".tmp", "m8-live-runs");
  const path = resolve(value);
  const remainder = relative(root, path);
  if (
    remainder.length === 0 ||
    remainder.startsWith("..") ||
    remainder.includes("/") ||
    remainder.includes("\\") ||
    !/^[a-z0-9_-]{1,48}\.runner\.json$/i.test(remainder)
  )
    return Object.freeze({ stage: async () => undefined });
  const record = async (field, value) => {
    try {
      let existing = {};
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
      } catch {
        // A missing or malformed optional journal starts a fresh bounded trace.
      }
      let stages = Array.isArray(existing.stages)
        ? existing.stages.filter((stage) => typeof stage === "string" && /^[a-z_]{1,64}$/.test(stage))
        : [];
      let milestones = Array.isArray(existing.milestones)
        ? existing.milestones.filter((stage) => typeof stage === "string" && /^[a-z_]{1,64}$/.test(stage))
        : [];
      if (field === "stages" && stages.at(-1) !== value) stages = [...stages, value].slice(-16);
      if (field === "milestones" && !milestones.includes(value)) milestones = [...milestones, value].slice(-8);
      const lastProbeCode = field === "lastProbeCode" ? value : existing.lastProbeCode;
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ schema: "gamebuddy-m8-runner-journal/v1", at: new Date().toISOString(), stages, milestones, ...(typeof lastProbeCode === "string" ? { lastProbeCode } : {}) })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporary, path);
    } catch {
      // Optional diagnostics never affect the native action protocol.
    }
  };
  return Object.freeze({
    stage: (stage) => record("stages", stage),
    milestone: (stage) => record("milestones", stage),
    probe: (code) => record("lastProbeCode", code),
  });
}

function requestIdentity(action, phase, expectedRevision, scope) {
  const now = Date.now();
  const prefix = `m8_${action}_${phase}_${process.pid}_${now}`;
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
    return "m8_entry_probe_correlation_invalid";
  if (probe.entryObserved !== true) return "m8_entry_not_observed";
  // The typed action owns the fixed default Mine-entry transition directly.
  // Normal-player map interaction is source provenance, not a runtime pose
  // gate for the Mod-owned native seam.
  if (!Number.isSafeInteger(probe.currentFloor) || probe.currentFloor !== 0) return "m8_entry_location_invalid";
  if (!Number.isSafeInteger(probe.targetFloor) || probe.targetFloor !== TARGET_FLOOR) return "m8_entry_target_invalid";
  return null;
}

function waitableGivenCode(code) {
  return code === "m8_entry_not_observed";
}

function validSkipEventTerminal(terminal, request, executionId, scope) {
  return (
    terminal?.requestId === request.requestId &&
    terminal.traceId === request.traceId &&
    terminal.executionId === executionId &&
    terminal.state === "succeeded" &&
    terminal.reasonCode === "skip_event_completed" &&
    sameScope(terminal.evidence?.scope, scope) &&
    terminal.evidence?.eventObserved === true &&
    terminal.evidence?.nativeSkipObserved === true &&
    terminal.evidence?.eventCleared === true &&
    terminal.evidence?.postEventStateClean === true &&
    terminal.postcondition?.postEventStateClean === true &&
    terminal.postcondition?.freshObservation === true &&
    terminal.postcondition?.sameExecution === true
  );
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
