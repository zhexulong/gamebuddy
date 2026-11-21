// The four records a run writes about itself, held against the reader that opens them.
//
// Every absence in this file is one a reader could pass silently: a missing `owner.json` is a root with no
// reservation, a journal under another continuity is a file that exists and binds the wrong session, a trace
// with the right spans but a foreign pid is another lane's client. The suite drives the reader over a fixture
// root it writes itself, so each shape is red without needing a live run to produce it.
//
// red-proof: delete the fixture's `session/stardew-session.json` -> `session_document_absent` names every path
//   it looked for; point the trace reader at a ledger whose pids are not the trace's -> `ai_client_trace_not_hers`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  aiClientTraceOf,
  describeRunRecords,
  FACTS,
  ownerAdmissionOf,
  readAttempts,
  readRunRecords,
  recoveryJournalOf,
  sessionIdentityOf,
} = require("./run-records.cjs");

const BOOTSTRAP = "1576b57d-dfe4-413c-854e-cb4be4fbe445";
const CONTINUITY = "lane_continuity";
const SAVE_ID = "454944440";
const WORLD_ID = "6484304440686003362";
const FARMHAND_ID = "-1742279278141574684";
const COMPANION_ID = "lane_companion";
const NONCE = "946d3c73b0ef40159e876ee162a11377";
const GAME_PID = 21848;

/** One run root, written the way a passing run leaves it, with the members each case varies. */
function fixtureRoot({
  owner = {},
  session = {},
  manifest = {},
  journal = true,
  trace = null,
  pids = [GAME_PID],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gb-run-records-"));
  const data = join(root, "GameBuddy", "data");
  const attempt = join(data, "stardew-private-bootstrap", BOOTSTRAP);
  const sessionDirectory = join(attempt, "session");
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(
    join(attempt, "owner.json"),
    JSON.stringify({
      schema: "gamebuddy-stardew-private-bootstrap-owner/v4",
      bootstrapId: BOOTSTRAP,
      companionId: COMPANION_ID,
      state: "reserved",
      ownerRecordRevision: 1,
      aiClient: { kind: "launch_reserved", launchGeneration: "734fa4e0-6c62-4dfe-9785-96f9404dac9f" },
      managedPaths: ["owner.json", "ai-client", "ai-client/Mods", "ai-client/Mods/GameBuddy/manifest.json"],
      ...owner,
    }),
    "utf8",
  );
  writeFileSync(
    join(sessionDirectory, "stardew-attachment-response.json"),
    JSON.stringify({
      state: "ready",
      reasonCode: "manifest_issued",
      manifestPath: "stardew-farmhand-manifest.json",
      updatedAtUnixMs: 1795270170462,
    }),
    "utf8",
  );
  writeFileSync(
    join(sessionDirectory, "stardew-farmhand-manifest.json"),
    JSON.stringify({
      saveId: SAVE_ID,
      worldId: WORLD_ID,
      companionId: COMPANION_ID,
      farmhandId: FARMHAND_ID,
      cabinId: "FarmHouse98d0719d-b7ab-48a6-b83c-aa0d489b20c4",
      sessionNonce: NONCE,
      ...manifest,
    }),
    "utf8",
  );
  if (session !== null)
    writeFileSync(
      join(sessionDirectory, "stardew-session.json"),
      JSON.stringify({
        saveId: SAVE_ID,
        worldId: WORLD_ID,
        hostPlayerId: WORLD_ID,
        runtimeRole: "player_host",
        state: "ready",
        nonce: NONCE,
        signature: "xeI8rPfm",
        cabins: [
          { cabinId: "FarmHouse801f", ownerFarmhandId: "1830117227862559840", boundCompanionId: "other_companion" },
          {
            cabinId: "FarmHouse98d0",
            ownerFarmhandId: FARMHAND_ID,
            boundCompanionId: COMPANION_ID,
            isBusy: true,
          },
        ],
        ...session,
      }),
      "utf8",
    );
  const journalDirectory = join(data, "stardew-recovery", CONTINUITY, SAVE_ID, WORLD_ID);
  if (journal !== null) {
    mkdirSync(journalDirectory, { recursive: true });
    writeFileSync(
      join(journalDirectory, "stardew-logical-action-recovery-journal.jsonl"),
      typeof journal === "string"
        ? journal
        : `${JSON.stringify({
            kind: "header",
            schemaVersion: 2,
            scope: {
              continuityId: CONTINUITY,
              integrationId: "stardew",
              product: "stardew",
              saveId: SAVE_ID,
              worldId: WORLD_ID,
            },
          })}\n`,
      "utf8",
    );
  }
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "run-processes.jsonl"),
    pids
      .map((pid) => JSON.stringify({ pid, role: "game-smapi", startTime: "2026-11-21T22:09:38.4803370+08:00" }))
      .join("\n"),
    "utf8",
  );
  const traceDirectory = join(root, "traces");
  mkdirSync(traceDirectory, { recursive: true });
  if (trace !== null)
    writeFileSync(
      join(traceDirectory, trace.name ?? "gamebuddy-trace-20261121-220935.json"),
      JSON.stringify({
        displayTimeUnit: "ms",
        otherData: { source: "GameBuddy.Stardew.Mod", runId: "20261121-220935" },
        traceEvents: (trace.dispatches ?? []).map((type, index) => ({
          name: "mod.dispatch",
          ph: "X",
          ts: 1795285239683762 + index,
          dur: 45510,
          pid: trace.pid ?? GAME_PID,
          tid: 1,
          cat: "mod",
          args: { type, correlationId: `correlation-${String(index)}` },
        })),
      }),
      "utf8",
    );
  return {
    root,
    data,
    state,
    traceDirectory,
    principal: { playerId: "lane_player", companionId: COMPANION_ID, continuityId: CONTINUITY },
    read: (over = {}) =>
      readRunRecords({
        declaredDataRoot: data,
        principal: { playerId: "lane_player", companionId: COMPANION_ID, continuityId: CONTINUITY },
        stateDir: state,
        traceDirectory,
        ...over,
      }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const HER_TRACE = {
  dispatches: ["hello", "observe_request", "system_notice_request", "companion_presentation_request"],
};

test("a passing run's own records are all four read, and the four facts are the chain's", () => {
  const fixture = fixtureRoot({ trace: HER_TRACE });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.deepEqual(
      [reading.owner.reason, reading.session.reason, reading.journal.reason, reading.trace.reason],
      [null, null, null, null],
      `every record a passing run leaves must read: ${JSON.stringify(reading)}`,
    );
    assert.equal(reading.attempts, 1);
    const lines = describeRunRecords(reading);
    assert.equal(lines.length, 5);
    for (const fact of [FACTS.owner, FACTS.session, FACTS.journal, FACTS.trace])
      assert.ok(
        lines.some((line) => line.startsWith(`CHAIN RECORD ${fact} - `)),
        `${fact} has to be the line that answers it: ${JSON.stringify(lines)}`,
      );
    assert.match(lines[4], /^CHAIN RECORD 4 of 4 record\(s\) read from 1 attempt\(s\)$/u);
    // The header-only clause is the journal's own shape, and the detail has to say so rather than leave it
    // to the reader to notice that no action line is there.
    assert.match(reading.journal.detail, /header-only/u);
  } finally {
    fixture.dispose();
  }
});

test("owner.json absent is named, with every path that was looked for", () => {
  const fixture = fixtureRoot({ trace: HER_TRACE });
  try {
    rmSync(join(fixture.data, "stardew-private-bootstrap", BOOTSTRAP, "owner.json"), { force: true });
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.owner.reason, "owner_json_absent");
    assert.match(reading.owner.detail, /1 attempt\(s\) examined/u);
    assert.match(reading.owner.detail, /owner\.json/u);
    // The session is still read: the two absences are different facts about the same tree.
    assert.equal(reading.session.reason, null);
  } finally {
    fixture.dispose();
  }
});

test("an owner record that reserves a different companion than the manifest binds is refused by name", () => {
  const fixture = fixtureRoot({ trace: HER_TRACE, owner: { companionId: "somebody_else" } });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.owner.reason, "owner_json_without_the_manifest_this_run_issued");
    assert.match(reading.owner.detail, /somebody_else/u);
    assert.match(reading.owner.detail, new RegExp(COMPANION_ID, "u"));
  } finally {
    fixture.dispose();
  }
});

test("session document absent is named, and no journal path is guessed from a session nobody read", () => {
  const fixture = fixtureRoot({ session: null, trace: HER_TRACE });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.session.reason, "session_document_absent");
    assert.match(reading.session.detail, /stardew-session\.json/u);
    assert.equal(reading.journal.reason, "recovery_journal_continuity_unknown");
    assert.match(reading.journal.detail, /no path can be derived and none was guessed/u);
  } finally {
    fixture.dispose();
  }
});

test("a session whose host player is not the world's player is not the live world's identity", () => {
  const fixture = fixtureRoot({ trace: HER_TRACE, session: { hostPlayerId: "1234" } });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.session.reason, "session_identity_inconsistent");
    assert.match(reading.session.detail, /hostPlayerId "1234" is not worldId/u);
  } finally {
    fixture.dispose();
  }
});

test("a session whose cabins are bound to other companions names the companion it looked for", () => {
  const fixture = fixtureRoot({
    trace: HER_TRACE,
    session: { cabins: [{ cabinId: "c1", ownerFarmhandId: "9", boundCompanionId: "another_companion" }] },
  });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.session.reason, "session_identity_inconsistent");
    assert.match(reading.session.detail, /no cabin is bound to the run's companion "lane_companion"/u);
  } finally {
    fixture.dispose();
  }
});

test("a journal that is not on disk under this continuity is named with the path it looked for", () => {
  const fixture = fixtureRoot({ journal: null, trace: HER_TRACE });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.journal.reason, "recovery_journal_absent");
    assert.match(reading.journal.detail, /stardew-logical-action-recovery-journal\.jsonl/u);
    assert.match(reading.journal.detail, new RegExp(`continuity ${JSON.stringify(CONTINUITY)}`, "u"));
  } finally {
    fixture.dispose();
  }
});

test("a header bound to another continuity is refused, not read as this session's", () => {
  const fixture = fixtureRoot({
    trace: HER_TRACE,
    journal: `${JSON.stringify({
      kind: "header",
      schemaVersion: 2,
      scope: {
        continuityId: "another_continuity",
        integrationId: "stardew",
        product: "stardew",
        saveId: SAVE_ID,
        worldId: WORLD_ID,
      },
    })}\n`,
  });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.journal.reason, "recovery_journal_unbound");
    assert.match(
      reading.journal.detail,
      /scope\.continuityId "another_continuity" is not the run's "lane_continuity"/u,
    );
  } finally {
    fixture.dispose();
  }
});

test("a journal that carries an action says how many, instead of claiming the header-only shape", () => {
  const fixture = fixtureRoot({
    trace: HER_TRACE,
    journal: `${JSON.stringify({ kind: "header", schemaVersion: 2, scope: { continuityId: CONTINUITY, saveId: SAVE_ID, worldId: WORLD_ID } })}\n${JSON.stringify({ kind: "record", value: { state: "prepared", actionId: "water_crop" } })}\n`,
  });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.journal.reason, null);
    assert.match(reading.journal.detail, /holds 1 action line\(s\)/u);
    assert.ok(!/header-only/u.test(reading.journal.detail), "a journal that acted cannot be described as header-only");
  } finally {
    fixture.dispose();
  }
});

test("no trace written after this launch is named absent, with the examination count", () => {
  const fixture = fixtureRoot({ trace: null });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.trace.reason, "ai_client_trace_absent");
    assert.match(reading.trace.detail, /examined 0 file\(s\)/u);
  } finally {
    fixture.dispose();
  }
});
test("a trace that dispatches no ingress frame is not hers, whatever else it carries", () => {
  // The player host's own trace: a tick gate held by the world creation and no `hello`, because its profile
  // is authored with `EnableLocalBridge: false` and it never opens a bridge session.
  const fixture = fixtureRoot({ trace: { dispatches: [] } });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.trace.reason, "ai_client_trace_not_hers");
    assert.match(reading.trace.detail, /none dispatches hello/u);
  } finally {
    fixture.dispose();
  }
});

test("her trace reads even when the run recorded no pid for the process it ran in", () => {
  // `firstjoin-r1` measured this shape: the ledger holds the two SMAPI loaders and the trace belongs to their
  // game child, so a pid join would refuse a trace that is hers. The pid is reported as corroboration.
  const fixture = fixtureRoot({ trace: { ...HER_TRACE, pid: 424242 } });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.trace.reason, null);
    assert.match(reading.trace.detail, /pid \[424242\] \(not among the game pids this run recorded/u);
  } finally {
    fixture.dispose();
  }
});

test("her trace whose pid the run did record says so, so the two readings are told apart", () => {
  const fixture = fixtureRoot({ trace: HER_TRACE });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.trace.reason, null);
    assert.match(reading.trace.detail, /recorded by this run as one of/u);
  } finally {
    fixture.dispose();
  }
});

test("her trace that never heard the presentation frame is incomplete, and names the missing frame", () => {
  const fixture = fixtureRoot({ trace: { dispatches: ["hello", "observe_request"] } });
  try {
    const reading = fixture.read({ sinceMs: 0 });
    assert.equal(reading.trace.reason, "ai_client_trace_incomplete");
    assert.match(reading.trace.detail, /companion_presentation_request is not among them/u);
  } finally {
    fixture.dispose();
  }
});

test("a trace written before this launch is not a candidate, however many spans it carries", () => {
  const fixture = fixtureRoot({ trace: HER_TRACE });
  try {
    const reading = fixture.read({ sinceMs: Date.now() + 60_000 });
    assert.equal(reading.trace.reason, "ai_client_trace_absent");
    assert.match(
      reading.trace.detail,
      /none is a gamebuddy-trace-\*\.json whose own run id starts inside this run's window/u,
    );
  } finally {
    fixture.dispose();
  }
});

test("the readers answer the same verdicts when called one at a time, so a driver can report one fact", () => {
  const fixture = fixtureRoot({ trace: HER_TRACE });
  try {
    const attempts = readAttempts(fixture.data);
    assert.equal(attempts.length, 1);
    const owner = ownerAdmissionOf(attempts);
    const session = sessionIdentityOf(attempts, { principal: fixture.principal });
    const journal = recoveryJournalOf({
      declaredDataRoot: fixture.data,
      principal: fixture.principal,
      session,
    });
    const trace = aiClientTraceOf({ traceDirectory: fixture.traceDirectory, stateDir: fixture.state, sinceMs: 0 });
    assert.deepEqual([owner.reason, session.reason, journal.reason, trace.reason], [null, null, null, null]);
  } finally {
    fixture.dispose();
  }
});
