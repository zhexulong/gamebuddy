import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bodyProgramJournalPath,
  createBodyProgramJournalFallback,
  executionsFromJournalEvents,
  stardewDataPath,
} from "./stardew-body-program-journal.mjs";

/**
 * One journal document in the shape the Mod actually writes (`WindowsBodyProgramJournalStore.cs`, schemaVersion 1),
 * taken from a real file measured 2026-10-27: numeric enum states, `programs[].program.programId`, and events carrying
 * the journal's own `cursor`.
 */
function journalDocument({ programs = [], events = [] } = {}) {
  return {
    schemaVersion: 1,
    scope: {
      integrationId: "stardew",
      saveId: "451844707",
      worldId: "-7866265671321385885",
      playerId: "-7866265671321385885",
      companionId: "companion_native_local",
    },
    policyIdentity: { value: "b2a1db9ca079497da2d5bf833ee1e9eb", capabilityRevision: 1 },
    eventHighWater: events.reduce((highest, event) => Math.max(highest, event.cursor), 0),
    programs,
    events,
  };
}

/** A program that ran: two nodes succeeded, one native dispatch each, exactly as the Mod records them. */
function harvestedProgram(programId = "plan_16_a93f3dbf3576006d") {
  return {
    program: {
      programId,
      catalogRevision: 1,
      nodes: [
        { nodeId: "n01", actionId: "harvest_crop", canonicalArguments: {}, dependsOn: [], bindings: {} },
        { nodeId: "n02", actionId: "harvest_crop", canonicalArguments: {}, dependsOn: [], bindings: {} },
      ],
    },
    state: 2,
    stopEpoch: 0,
    nodes: [
      { nodeId: "n01", state: 5, nodeAttempt: 1, admissionAttempt: 1 },
      { nodeId: "n02", state: 5, nodeAttempt: 1, admissionAttempt: 1 },
    ],
    facts: [],
  };
}

/**
 * The same program's events, each carrying the Mod's monotonic `atMs` - the moment the journal appended it, which is
 * the dispatch on a `native_dispatch` and the settlement on `node_completed` (`BodyProgramJournalClock`).
 */
function eventsFor(programId) {
  return [
    { cursor: 1, programId, kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null, atMs: 1000 },
    {
      cursor: 2,
      programId,
      kind: "admission_challenge",
      catalogRevision: 1,
      nodeId: "n01",
      nodeAttempt: 1,
      atMs: 1100,
    },
    { cursor: 3, programId, kind: "native_dispatch", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1, atMs: 1200 },
    { cursor: 4, programId, kind: "node_completed", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1, atMs: 1450 },
    { cursor: 5, programId, kind: "native_dispatch", catalogRevision: 1, nodeId: "n02", nodeAttempt: 1, atMs: 1500 },
    { cursor: 6, programId, kind: "node_completed", catalogRevision: 1, nodeId: "n02", nodeAttempt: 1, atMs: 1700 },
  ];
}

/** A journal written to a real path under the scope the store derives, and the reader that opens it. */
function writeJournal(document) {
  const dataPath = mkdtempSync(join(tmpdir(), "gb-body-program-journal-"));
  const scope = {
    saveId: "451844707",
    worldId: "-7866265671321385885",
    playerId: "-7866265671321385885",
    companionId: "companion_native_local",
  };
  const path = bodyProgramJournalPath({ dataPath, scope });
  assert.ok(path !== null, "the store's own path must be derivable from a complete scope");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(document));
  return { dataPath, scope, path };
}

test("the journal path is the store's own path, derived from the documented data root and the run's scope", () => {
  // `ModEntry.GetBodyProgramJournalRoot()` is `SMAPI.Constants.DataPath`, the folder that CONTAINS `Saves`, and the
  // store joins `BodyProgramJournal-v1/stardew/<save>/<world>/<player>/<companion>/journal.json` onto it.
  assert.equal(
    stardewDataPath({ APPDATA: "C:\\Users\\player\\AppData\\Roaming" }),
    join("C:\\Users\\player\\AppData\\Roaming", "StardewValley"),
  );
  assert.equal(stardewDataPath({}), null, "no data root is named rather than guessed");
  assert.equal(
    bodyProgramJournalPath({
      dataPath: join("C:", "data"),
      scope: { saveId: "451844707", worldId: "-786", playerId: "-786", companionId: "companion_native_local" },
    }),
    join(
      "C:",
      "data",
      "BodyProgramJournal-v1",
      "stardew",
      "451844707",
      "-786",
      "-786",
      "companion_native_local",
      "journal.json",
    ),
  );
  // An incomplete or unsafe scope addresses no journal: a neighbouring save's programs are not this run's evidence.
  assert.equal(bodyProgramJournalPath({ dataPath: "C:\\data", scope: { saveId: "451844707" } }), null);
  assert.equal(
    bodyProgramJournalPath({
      dataPath: "C:\\data",
      scope: { saveId: "..", worldId: "-786", playerId: "-786", companionId: "companion_native_local" },
    }),
    null,
  );
});

test("a journal node names its own state and the reason the file holds, and an unnameable state stays unnameable", () => {
  // The file is the only place a reason survives a dead bridge: `rejectionCode` on a veto, `failureCode` on a
  // dispatched failure, `hint` beside it. A durable state this build cannot name must NOT be guessed at - a null state
  // is a row the projection reads as `unknown`, which is the truth, rather than an invented name.
  const programId = "plan_16_reasons";
  const program = harvestedProgram(programId);
  program.state = 3;
  program.nodes = [
    {
      nodeId: "n01",
      state: 9,
      nodeAttempt: 1,
      admissionAttempt: 1,
      rejectionCode: "policy_denied",
      failureCode: null,
      hint: null,
    },
    {
      nodeId: "n02",
      state: 6,
      nodeAttempt: 1,
      admissionAttempt: 1,
      rejectionCode: null,
      failureCode: "no_native_path",
      hint: "closest=49,14",
    },
    { nodeId: "n03", state: 42, nodeAttempt: 1, admissionAttempt: 1 },
  ];
  const outcome = createBodyProgramJournalFallback(writeJournal(journalDocument({ programs: [program] }))).outcomeFor(
    programId,
  );
  assert.deepEqual(outcome.journalNodes, [
    { nodeId: "n01", state: "rejected", rejectionCode: "policy_denied", failureCode: null, hint: null },
    { nodeId: "n02", state: "failed", rejectionCode: null, failureCode: "no_native_path", hint: "closest=49,14" },
    { nodeId: "n03", state: null, rejectionCode: null, failureCode: null, hint: null },
  ]);
});

test("a journal on disk proves the executions a dead bridge could not report", () => {
  const programId = "plan_16_a93f3dbf3576006d";
  const written = writeJournal(
    journalDocument({ programs: [harvestedProgram(programId)], events: eventsFor(programId) }),
  );
  const fallback = createBodyProgramJournalFallback(written);
  const outcome = fallback.outcomeFor(programId);
  assert.equal(outcome.dispatched, 2, "two native_dispatch events are two executions");
  assert.deepEqual(outcome.executions, [
    { nodeId: "n01", nodeAttempt: 1, cursor: 3, atMs: 1200, settledAtMs: 1450 },
    { nodeId: "n02", nodeAttempt: 1, cursor: 5, atMs: 1500, settledAtMs: 1700 },
  ]);
  assert.deepEqual(
    outcome.journalNodes,
    [
      {
        nodeId: "n01",
        state: "succeeded",
        rejectionCode: null,
        failureCode: null,
        hint: null,
      },
      {
        nodeId: "n02",
        state: "succeeded",
        rejectionCode: null,
        failureCode: null,
        hint: null,
      },
    ],
    "the durable numeric enum is named in the same vocabulary the bridge uses",
  );
  assert.equal(outcome.programState, "succeeded");
  assert.equal(fallback.state().ok, true);
});

test("an execution carries the moment the Mod dispatched and settled it, and a later read changes neither", async () => {
  // The two moments the metric needs are the GAME's, so they are the journal's own values: 1200/1450 and 1500/1700 were
  // appended by the Mod when it dispatched and when each action's terminal landed. A reader that stamped the row on the
  // way out - the read moment - would answer with a number no journal contains, and the durations below would be the
  // evaluator's own latency instead of the game's work.
  const programId = "plan_16_a93f3dbf3576006d";
  const written = writeJournal(
    journalDocument({ programs: [harvestedProgram(programId)], events: eventsFor(programId) }),
  );
  const first = createBodyProgramJournalFallback(written).outcomeFor(programId);
  assert.deepEqual(
    first.executions.map((execution) => [execution.atMs, execution.settledAtMs]),
    [
      [1200, 1450],
      [1500, 1700],
    ],
  );
  assert.deepEqual(
    first.executions.map((execution) => execution.settledAtMs - execution.atMs),
    [250, 200],
    "each execution is a duration on one monotonic clock, which is what the cadence measures",
  );

  // A restart, later: the same file read again must return the stamps it stored. A build that re-stamped at read time
  // would answer with a later number on the second read (this delay is what makes the two distinguishable).
  await new Promise((resolve) => setTimeout(resolve, 60));
  const replayed = createBodyProgramJournalFallback(written).outcomeFor(programId);
  assert.deepEqual(replayed.executions, first.executions);
});

test("an execution that has not settled is null, and node_completed wins over the program's own settlement", () => {
  const programId = "plan_16_a93f3dbf3576006d";
  const events = [
    { cursor: 1, programId, kind: "native_dispatch", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1, atMs: 100 },
    { cursor: 2, programId, kind: "native_dispatch", catalogRevision: 1, nodeId: "n02", nodeAttempt: 1, atMs: 200 },
    { cursor: 3, programId, kind: "node_completed", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1, atMs: 450 },
    { cursor: 4, programId, kind: "node_settled", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1, atMs: 500 },
  ];
  const rows = executionsFromJournalEvents(events);
  assert.deepEqual(
    rows.map((row) => [row.nodeId, row.atMs, row.settledAtMs]),
    [
      ["n01", 100, 450],
      // Dispatched and never settled: null (unmeasured), never 0 - a zero would read as an impossibly fast execution.
      ["n02", 200, null],
    ],
    "the action's own terminal is the settlement; the program's later settlement is only the fallback",
  );
});

test("a journal that does not hold the program proves nothing about it", () => {
  const programId = "plan_16_a93f3dbf3576006d";
  const written = writeJournal(
    journalDocument({ programs: [harvestedProgram(programId)], events: eventsFor(programId) }),
  );
  const fallback = createBodyProgramJournalFallback(written);
  assert.equal(fallback.outcomeFor("plan_999_not_in_this_scope"), null);
  assert.equal(fallback.outcomeFor(null), null);
});

test("a missing journal is a named reason, not an empty outcome", () => {
  const written = writeJournal(journalDocument());
  const fallback = createBodyProgramJournalFallback({ dataPath: written.dataPath, scope: written.scope });
  // The journal written by `writeJournal` holds no programs, which is a different fact from an unreadable file.
  assert.deepEqual(fallback.state(), {
    path: written.path,
    ok: true,
    reason: null,
  });
  const absent = createBodyProgramJournalFallback({
    dataPath: written.dataPath,
    scope: { ...written.scope, companionId: "companion_without_a_journal" },
  });
  assert.deepEqual(absent.state(), {
    path: absent.path,
    ok: false,
    reason: "journal_absent",
  });
  assert.equal(absent.outcomeFor("plan_16_a93f3dbf3576006d"), null);
});

test("the journal is opened once, and only when an outcome is actually asked for", () => {
  const programId = "plan_16_a93f3dbf3576006d";
  const written = writeJournal(
    journalDocument({ programs: [harvestedProgram(programId)], events: eventsFor(programId) }),
  );
  let reads = 0;
  const fallback = createBodyProgramJournalFallback({
    ...written,
    readFile: (path, encoding) => {
      reads += 1;
      return readFileSync(path, encoding);
    },
  });
  assert.equal(reads, 0, "a bridge that answers must never cost a file read");
  fallback.outcomeFor(programId);
  fallback.outcomeFor(programId);
  fallback.state();
  assert.equal(reads, 1, "six failed queries read the journal once, not once per program");
});
