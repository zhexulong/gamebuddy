import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bodyProgramJournalPath,
  createBodyProgramJournalFallback,
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

function eventsFor(programId) {
  return [
    { cursor: 1, programId, kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null },
    { cursor: 2, programId, kind: "admission_challenge", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1 },
    { cursor: 3, programId, kind: "native_dispatch", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1 },
    { cursor: 4, programId, kind: "node_completed", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1 },
    { cursor: 5, programId, kind: "native_dispatch", catalogRevision: 1, nodeId: "n02", nodeAttempt: 1 },
    { cursor: 6, programId, kind: "node_completed", catalogRevision: 1, nodeId: "n02", nodeAttempt: 1 },
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

test("a journal on disk proves the executions a dead bridge could not report", () => {
  const programId = "plan_16_a93f3dbf3576006d";
  const written = writeJournal(
    journalDocument({ programs: [harvestedProgram(programId)], events: eventsFor(programId) }),
  );
  const fallback = createBodyProgramJournalFallback(written);
  const outcome = fallback.outcomeFor(programId);
  assert.equal(outcome.dispatched, 2, "two native_dispatch events are two executions");
  assert.deepEqual(outcome.executions, [
    { nodeId: "n01", nodeAttempt: 1, cursor: 3 },
    { nodeId: "n02", nodeAttempt: 1, cursor: 5 },
  ]);
  assert.deepEqual(
    outcome.nodeOutcomes,
    [
      { nodeId: "n01", state: "succeeded" },
      { nodeId: "n02", state: "succeeded" },
    ],
    "the durable numeric enum is named in the same vocabulary the bridge uses",
  );
  assert.equal(outcome.programState, "succeeded");
  assert.equal(fallback.state().ok, true);
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
