import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import { createFarmhandCompanionPresentationPort } from "./farmhand-companion-presentation.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import { createStardewActionTools, type MoveCapableIntegration } from "./game-tools.js";
import type { Scope } from "./protocol.js";
import { createRunTrace, RUN_SPAN_NAMES, type RunTraceSpan, toChromeTrace } from "./run-trace.js";
import { summarizeActionCadenceFromSpans } from "./run-trace-cadence.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";

// One fake clock for the whole run: a span's numbers mean nothing if two stages read two clocks.
function fixedClock(startMs = 1_000): { readonly now: () => number; advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

test("the exporter emits Perfetto-readable JSON for three nested spans", () => {
  const clock = fixedClock();
  const trace = createRunTrace("run_01", { now: clock.now });
  const action = trace.begin(RUN_SPAN_NAMES.action, { actionId: "harvest_crop", requestId: "req_01" });
  clock.advance(120);
  const admission = trace.begin(RUN_SPAN_NAMES.admission, { result: "granted" }, action.spanId);
  clock.advance(5);
  const journalWrite = trace.begin(RUN_SPAN_NAMES.journalWrite, { logicalActionId: "req_01" }, admission.spanId);
  clock.advance(7);
  journalWrite.end();
  admission.end();
  clock.advance(400);
  action.end({ state: "succeeded" });

  const spans = trace.spans();
  assert.deepEqual(
    spans.map((span) => [span.name, span.parentId]),
    [
      ["action", null],
      ["admission", spans[0]!.spanId],
      ["journal.write", spans[1]!.spanId],
    ],
  );
  const chrome = toChromeTrace(spans);
  assert.equal(chrome.displayTimeUnit, "ms");
  assert.equal(chrome.traceEvents.length, 3);
  for (const event of chrome.traceEvents) {
    assert.deepEqual(Object.keys(event).sort(), ["args", "dur", "name", "ph", "pid", "tid", "ts"]);
    assert.equal(event.ph, "X");
    assert.equal(event.pid, 1);
    assert.equal(event.tid, 1);
    assert.ok(Number.isInteger(event.ts) && Number.isInteger(event.dur));
    assert.ok(event.dur >= 0);
    assert.equal(typeof event.args, "object");
  }
  const [actionEvent, admissionEvent, journalEvent] = chrome.traceEvents;
  // Milliseconds on the recorder become the microseconds Chrome/Perfetto read, on one unbroken clock.
  assert.equal(actionEvent!.ts, 1_000_000);
  assert.equal(admissionEvent!.ts, 1_120_000);
  assert.equal(journalEvent!.ts, 1_125_000);
  assert.equal(journalEvent!.dur, 7_000);
  assert.equal(admissionEvent!.dur, 12_000);
  assert.equal(actionEvent!.dur, 532_000);
  assert.deepEqual(actionEvent!.args, { actionId: "harvest_crop", requestId: "req_01", state: "succeeded" });
  // The JSON Perfetto receives is plain data: no undefined, no NaN, no live handle.
  const serialized = JSON.parse(JSON.stringify(chrome)) as { traceEvents: Array<Record<string, unknown>> };
  assert.equal(serialized.traceEvents.length, 3);
  assert.ok(serialized.traceEvents.every((event) => Object.values(event).every((value) => value !== undefined)));
});

test("an open span exports as a zero-duration span that names itself incomplete", () => {
  const clock = fixedClock();
  const trace = createRunTrace("run_02", { now: clock.now });
  trace.begin(RUN_SPAN_NAMES.action, { actionId: "advance_day" });
  const [event] = toChromeTrace(trace.spans()).traceEvents;
  assert.equal(event!.dur, 0);
  assert.deepEqual(event!.args, { actionId: "advance_day", open: true });
});

test("a span tree yields the same per-action cadence totals the old action-trace aggregator produced", async () => {
  const dispatch = (startMs: number, settleMs: number | null): RunTraceSpan => ({
    traceId: "run_03",
    spanId: `action_${String(startMs)}`,
    parentId: null,
    name: RUN_SPAN_NAMES.action,
    startMs,
    endMs: settleMs,
    attributes: Object.freeze({ actionId: "move_to_tile" }),
  });
  const spans = [dispatch(100, 350), dispatch(1_000, 1_000), dispatch(2_000, null), dispatch(4_000, 4_100)];

  const hostCadence = summarizeActionCadenceFromSpans(spans);
  assert.deepEqual(hostCadence, {
    actions: 4,
    measured: 3,
    unmeasured: 1,
    execMs: { median: 100, max: 250, sum: 350 },
    thinkMs: { median: 825, max: 1_000, sum: 1_650 },
    idleMs: { median: 1_000, max: 2_000, sum: 3_900 },
  });

  // The old aggregator is the authority for these numbers while both instruments exist: run it on the entries the
  // pre-span harness built from the same moments, and require the span derivation to agree exactly.
  const legacySpecifier = "../../tools/lib/action-cadence.mjs";
  const legacy = (await import(legacySpecifier)) as {
    summarizeActionCadence: (entries: readonly unknown[]) => unknown;
  };
  const legacyCadence = legacy.summarizeActionCadence([
    { dispatchedAtMs: 100, settledAtMs: 350 },
    { dispatchedAtMs: 1_000, settledAtMs: 1_000 },
    { dispatchedAtMs: 2_000 },
    { dispatchedAtMs: 4_000, settledAtMs: 4_100 },
  ]);
  assert.deepEqual(hostCadence, legacyCadence);
});

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};

function moveIntegration(execute: MoveCapableIntegration["execute"]): MoveCapableIntegration {
  const state = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["move_to_tile"],
    catalogRevision: 1,
    enabledActionIds: ["move_to_tile"],
    snapshot: {
      revision: 3,
      location: "Farm",
      tile: { x: 1, y: 2 },
      stamina: 100,
      exhausted: false,
      health: 100,
      actionable: true,
      capabilities: ["move_to_tile"],
      catalogRevision: 1,
      enabledActionIds: ["move_to_tile"],
      presentationLocale: "en-US",
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      activeExecution: null,
    },
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  return {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return state;
    },
    execute,
    async cancel() {
      throw new Error("must_not_cancel");
    },
  } as MoveCapableIntegration & StardewBridgeConnection;
}

test("one dispatched action records action, admission, and bridge.call spans on the run clock", async () => {
  const clock = fixedClock();
  const trace = createRunTrace("run_action", { now: clock.now });
  const receipt = {
    requestId: "req_action",
    executionId: "exec_action",
    actionId: "move_to_tile",
    state: "succeeded" as const,
    reasonCode: "target_reached",
    revision: 4,
    evidence: {},
  };
  const ledger = new ExecutionCorrelationLedger(async () => receipt, { trace });
  const owner = { ownerId: "owner_01", epoch: 1 };
  const integration = moveIntegration(async () => {
    clock.advance(240);
    return receipt;
  });
  const tool = createStardewActionTools(
    integration,
    undefined,
    () => ({
      observer: ledger,
      owner,
      cancelExact: (requestId, executionId, reasonCode) =>
        ledger.requestCancelExact(owner, requestId, executionId, reasonCode),
    }),
    trace,
  ).find((candidate) => candidate.name === "stardew_move_to_tile")!;

  clock.advance(10);
  await tool.execute(
    "test",
    { x: 3, y: 4, requestId: "req_action", idempotencyKey: "key_action" },
    new AbortController().signal,
    () => {},
    {} as never,
  );

  const spans = trace.spans();
  assert.deepEqual(
    spans.map((span) => span.name),
    [RUN_SPAN_NAMES.action, RUN_SPAN_NAMES.admission, RUN_SPAN_NAMES.bridgeCall],
  );
  assert.equal(spans[0]!.parentId, null);
  assert.equal(spans[1]!.parentId, spans[0]!.spanId);
  assert.equal(spans[2]!.parentId, spans[0]!.spanId);
  assert.equal(spans[0]!.attributes.requestId, "req_action");
  assert.equal(spans[0]!.attributes.state, "succeeded");
  assert.equal(spans[2]!.attributes.actionId, "move_to_tile");
  // One clock: the bridge span starts after admission ended, and the action span encloses both.
  assert.ok(spans[1]!.startMs >= spans[0]!.startMs);
  assert.ok(spans[1]!.endMs! <= spans[2]!.startMs);
  assert.ok(spans[2]!.endMs! <= spans[0]!.endMs!);
});

test("the durable journal write nests under the admission span it belongs to", async () => {
  const trace = createRunTrace("run_journal");
  const prepared: string[] = [];
  const journal = {
    allocateDispatchOrdinal: () => 1,
    async prepare(record: { logicalActionId: string }) {
      prepared.push(record.logicalActionId);
    },
  };
  const ledger = new ExecutionCorrelationLedger(async () => ({}) as never, {
    recoveryJournal: journal as never,
    trace,
  });
  const request = {
    requestId: "req_journal",
    idempotencyKey: "key_journal",
    action: "move_to_tile" as const,
    args: { x: 1, y: 2 },
    expectedRevision: 3,
    deadlineMs: Date.now() + 30_000,
  };
  const admission = trace.begin(RUN_SPAN_NAMES.admission, { requestId: "req_journal" });
  await ledger.beforeWrite({
    ownerId: "owner_01",
    epoch: 1,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    recoveryMaterial: { logicalActionId: request.requestId, request },
    traceParentId: admission.spanId,
  });
  admission.end();

  assert.deepEqual(prepared, ["req_journal"]);
  const journalSpan = trace.spans().find((span) => span.name === RUN_SPAN_NAMES.journalWrite)!;
  assert.equal(journalSpan.parentId, admission.spanId);
  assert.equal(journalSpan.attributes.logicalActionId, "req_journal");
  assert.equal(journalSpan.attributes.actionId, "move_to_tile");
  assert.ok(journalSpan.endMs !== null);
});

test("a present span ends at the moment the companion text committed", async () => {
  const clock = fixedClock();
  const trace = createRunTrace("run_present", { now: clock.now });
  const binding = Object.freeze({});
  const port = createFarmhandCompanionPresentationPort(
    {
      state: { snapshot: { revision: 7 } },
      async presentCompanionText() {
        clock.advance(33);
      },
      async presentSystemNotice() {},
    },
    { capture: () => ({ binding, epoch: 4, assertCurrent: () => {} }) },
    undefined,
    trace,
  );
  await port.present(
    {
      surface: "game",
      expressionId: "expr_01",
      sessionId: "session_01",
      sourceEventId: "event_01",
      text: "§12§ 我进屋了。",
      locale: "zh-CN",
    },
    { hostBinding: binding, assertHostCurrent: () => {} },
  );
  const [present] = trace.spans();
  assert.equal(present!.name, RUN_SPAN_NAMES.present);
  assert.equal(present!.attributes.expressionId, "expr_01");
  assert.equal(present!.attributes.sourceEventId, "event_01");
  assert.equal(present!.endMs! - present!.startMs, 33);
  // The commit time the old `pieceAtMs` carried is the span's end, on the run clock.
  assert.equal(
    toChromeTrace([present!]).traceEvents[0]!.ts + toChromeTrace([present!]).traceEvents[0]!.dur,
    present!.endMs! * 1000,
  );
});
