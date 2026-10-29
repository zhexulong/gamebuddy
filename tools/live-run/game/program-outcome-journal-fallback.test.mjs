/**
 * The evaluator asks the live bridge what a submitted program did. When the game dies mid-run the bridge is gone, and
 * the answer used to be `observed: 0 of 6` for a run whose work was already written to disk.
 *
 * This file drives the REAL `readProgramOutcomes` out of the runner (the runner module has top-level live side effects
 * and never loads in a test) against a REAL journal file in the Mod's own schema, and asserts the two directions:
 * a failed bridge read is answered from the journal (and says so), and a working bridge is answered by the bridge with
 * the journal never opened.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bodyProgramJournalPath, createBodyProgramJournalFallback } from "../../lib/stardew-body-program-journal.mjs";

const RUNNER_SOURCE = readFileSync(new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url), "utf8");

/**
 * Evaluate one named top-level async function of the runner in isolation, the same way the runner's own test file does:
 * the runner cannot be imported, so its declaration text is compiled on its own and must therefore be closure-free.
 */
function extractRunnerFunction(source, name, globals = {}) {
  const marker = `function ${name}`;
  const declarationAt = source.indexOf(marker);
  assert.ok(declarationAt !== -1, `runner must define ${name}`);
  const start =
    source.slice(Math.max(0, declarationAt - 6), declarationAt) === "async " ? declarationAt - 6 : declarationAt;
  let parenDepth = 0;
  let bodyOpen = -1;
  for (let index = declarationAt + marker.length; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "{" && parenDepth === 0) {
      bodyOpen = index;
      break;
    }
  }
  assert.ok(bodyOpen !== -1, `runner function ${name} must have a body`);
  let depth = 0;
  let end = bodyOpen;
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  const body = source.slice(start, end);
  const names = Object.keys(globals);
  return new Function(...names, `${body}\nreturn ${name};`)(...names.map((key) => globals[key]));
}

/** A journal in the Mod's durable schema (`WindowsBodyProgramJournalStore.cs`), with one program that ran twice. */
function journalWith(programId) {
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
    eventHighWater: 6,
    programs: [
      {
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
      },
    ],
    events: [
      { cursor: 1, programId, kind: "accepted", catalogRevision: 1, nodeId: null, nodeAttempt: null },
      { cursor: 3, programId, kind: "native_dispatch", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1 },
      { cursor: 4, programId, kind: "node_completed", catalogRevision: 1, nodeId: "n01", nodeAttempt: 1 },
      { cursor: 5, programId, kind: "native_dispatch", catalogRevision: 1, nodeId: "n02", nodeAttempt: 1 },
      { cursor: 6, programId, kind: "node_completed", catalogRevision: 1, nodeId: "n02", nodeAttempt: 1 },
    ],
  };
}

function writeJournalOnDisk(programId) {
  const dataPath = mkdtempSync(join(tmpdir(), "gb-outcome-fallback-"));
  const scope = {
    saveId: "451844707",
    worldId: "-7866265671321385885",
    playerId: "-7866265671321385885",
    companionId: "companion_native_local",
  };
  const path = bodyProgramJournalPath({ dataPath, scope });
  assert.ok(path !== null, "the store's path must be derivable from a complete scope");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(journalWith(programId)));
  return { dataPath, scope, path };
}

test("a dead bridge is answered from the journal, and the run is not scored as having done nothing", async () => {
  // The measured run: the game exited mid-dispatch, `programStatus` answered `bridge_not_authenticated`, and the
  // evaluator published `observed: false` for all six accepted programs while the journal held their dispatches.
  const programId = "plan_16_a93f3dbf3576006d";
  const written = writeJournalOnDisk(programId);
  const readProgramOutcomes = extractRunnerFunction(RUNNER_SOURCE, "readProgramOutcomes");
  const records = await readProgramOutcomes({
    submissions: [{ programId, accepted: true }],
    statusQuery: async () => {
      throw new Error("bridge_not_authenticated");
    },
    eventsQuery: async () => {
      throw new Error("bridge_not_authenticated");
    },
    journal: createBodyProgramJournalFallback(written),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].observed, true, "the journal proved the program ran, so it is not unobserved");
  assert.equal(records[0].source, "journal", "and it says the evidence came from the file, not the live Mod");
  assert.equal(records[0].dispatched, 2, "two native_dispatch events are two executions");
  assert.deepEqual(records[0].executions, [
    { nodeId: "n01", nodeAttempt: 1, cursor: 3 },
    { nodeId: "n02", nodeAttempt: 1, cursor: 5 },
  ]);
  assert.deepEqual(records[0].nodeOutcomes, [
    { nodeId: "n01", state: "succeeded" },
    { nodeId: "n02", state: "succeeded" },
  ]);
  assert.equal(records[0].accepted, true);
  assert.match(
    String(records[0].observation),
    /bridge_not_authenticated/,
    "the bridge failure that forced the read is named",
  );
  assert.notEqual(
    records.filter((entry) => entry.observed === true).length,
    0,
    "`0 observed` is the defect: a dead bridge must not erase work the disk can prove",
  );
});

test("the runner actually passes the journal, so the fallback is wired rather than merely available", () => {
  // THE GAP THIS CLOSES, measured 2026-10-29: the three cases above call `readProgramOutcomes` with a `journal` object
  // the TEST supplied, and they stayed 3/3 green when the runner's own call site was changed to `journal: undefined`.
  // A test that provides its own input cannot see the producer stop producing - the same "pinning own input" failure
  // this repository has paid for before (`body-program-script.approach.test.ts`, `TransportApproachWiringTests`).
  //
  // So this case reads the CALL SITE, which is the one thing the behavioural cases structurally cannot reach: the
  // runner module has top-level live side effects and never loads in a test.
  const callSite = RUNNER_SOURCE.slice(RUNNER_SOURCE.indexOf("async function sampleProgramOutcomes"));
  const body = callSite.slice(0, callSite.indexOf("\n}"));
  assert.match(body, /journal:\s*bodyProgramJournal\b/, "the journal must be passed, not left undefined");
  assert.doesNotMatch(
    RUNNER_SOURCE,
    /journal:\s*undefined/,
    "a disabled fallback must be deleted rather than masked: an undefined journal makes the whole module dead code",
  );
});

test("a working bridge answers, and the journal is never opened", async () => {
  // The fallback must not mask a live bridge. The journal here is present and holds the SAME program with a DIFFERENT
  // dispatch count, so a result of 1 can only come from the bridge.
  const programId = "plan_16_a93f3dbf3576006d";
  const written = writeJournalOnDisk(programId);
  let journalReads = 0;
  const journal = createBodyProgramJournalFallback({
    ...written,
    readFile: (path, encoding) => {
      journalReads += 1;
      return readFileSync(path, encoding);
    },
  });
  const readProgramOutcomes = extractRunnerFunction(RUNNER_SOURCE, "readProgramOutcomes");
  const records = await readProgramOutcomes({
    submissions: [{ programId, accepted: true }],
    statusQuery: async () => ({
      code: "found",
      snapshot: { programId, state: "succeeded", nodes: [{ nodeId: "n01", state: "succeeded" }] },
    }),
    eventsQuery: async (_programId, cursor) =>
      cursor === 0
        ? {
            code: "found",
            events: [{ cursor: 2, programId, kind: "native_dispatch", nodeId: "n01", nodeAttempt: 1 }],
            nextCursor: 2,
            highWater: 2,
          }
        : { code: "found", events: [], nextCursor: 2, highWater: 2 },
    journal,
  });
  assert.equal(records[0].observed, true);
  assert.equal(records[0].source, "bridge");
  assert.equal(records[0].dispatched, 1, "the bridge's own count, not the journal's 2");
  assert.equal(journalReads, 0, "a bridge that answers must cost no journal read at all");
});

test("a failed bridge read the journal cannot answer stays unobserved, with its reason", async () => {
  // The other side of the fallback: a journal that is absent, or that does not hold this program, must not turn a
  // failed read into a measured empty execution. `dispatched: null` stays null and the reason stays named.
  const programId = "plan_16_a93f3dbf3576006d";
  const written = writeJournalOnDisk("plan_different_program");
  const readProgramOutcomes = extractRunnerFunction(RUNNER_SOURCE, "readProgramOutcomes");
  const records = await readProgramOutcomes({
    submissions: [{ programId, accepted: true }],
    statusQuery: async () => {
      throw new Error("bridge_not_authenticated");
    },
    eventsQuery: async () => ({ code: "not_found", events: [], nextCursor: 0 }),
    journal: createBodyProgramJournalFallback(written),
  });
  assert.equal(records[0].observed, false);
  assert.equal(records[0].dispatched, null, "an unproven program is never a program that ran nothing");
  assert.equal(records[0].observation, "read_failed:bridge_not_authenticated");

  // And with no journal at all, the pre-existing shape is unchanged.
  const withoutJournal = await readProgramOutcomes({
    submissions: [{ programId, accepted: true }],
    statusQuery: async () => {
      throw new Error("bridge_not_authenticated");
    },
    eventsQuery: async () => ({ code: "not_found", events: [], nextCursor: 0 }),
  });
  assert.equal(withoutJournal[0].observed, false);
  assert.equal(withoutJournal[0].dispatched, null);
});
