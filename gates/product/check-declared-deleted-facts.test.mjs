/**
 * The falsifiers for `tools/check-declared-deleted-facts.mjs`.
 *
 * Every case below drives the REAL gate through its CLI, because the claim it makes is about a run's own log and a
 * helper exercised directly proves nothing about the file the runner calls.
 *
 *   ① the committed `round66` fact stream is RED, naming the kinds that survived the deletion with their counts -
 *      `accepted · 46`, `running · 17` (whose reason codes say `tool_approach_completed 14`), `tool_equipped · 1`
 *   ② the same log with those fact lines removed is GREEN, and every declared-deleted kind reads `gone`
 *   ③ a real excerpt holding the pump's account line - which PRINTS `receipt:accepted: 2` and `semantic:route_progress:
 *      0` - is GREEN: a mention is not a value, and this is the falsifier that would have caught a substring count
 *   ④ a pump that has stopped holding `body_idle` while the document still declares it is RED, named by the member
 *   ⑤ the document's FACT column flipped into a held progress state is RED - the direction nobody looks at
 *   ⑥ the three zeroes: a named log that is absent is BLOCKED (exit 2), a named log with no fact line is BLOCKED, and a
 *      checkout with no run at all prints the skip marker and exits 0 (`not_measured`, never `passed`)
 *   ⑦ `--expect` is an assertion that can be wrong: the pinned reading passes and a pin that drops a survivor fails
 *   ⑧ the transcription of the document expires: a document that declares one more kind is red by that member's name
 *   ⑨ with no `--log` the gate reads the newest run log it can find and names it, which is the runner's half
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const ROOT = repositoryRoot(import.meta.url);
const GATE = join(ROOT, "gates/product/check-declared-deleted-facts.mjs");
const FIXTURES = join(ROOT, "tools/fixtures/declared-deleted");
const ROUND66 = join(FIXTURES, "round66-facts.runner-log");
const MENTIONS = join(FIXTURES, "round66-mentions-only.runner-log");
const AUTHORITY = join(FIXTURES, "authority");

/** The declared-deleted kinds `round66`'s two authorities name, which a fact line may carry as a value. */
const DECLARED_DELETED = new Set([
  "accepted",
  "running",
  "meaningful_progress",
  "snapshot",
  "tile_advanced",
  "tool_equipped",
  "body_idle",
  "execution_started",
  "route_progress",
]);

function run(...args) {
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function scratch(name) {
  const directory = mkdtempSync(join(tmpdir(), `declared-deleted-${name}-`));
  return directory;
}

/** One fact's kind values, read the way the gate reads them: value positions only, never free text. */
function kindValues(line) {
  const at = line.indexOf("BRIDGE_FACT ");
  if (at < 0) return new Set();
  const rest = line.slice(at + "BRIDGE_FACT ".length);
  const brace = rest.indexOf("{");
  let fact;
  try {
    fact = JSON.parse(brace < 0 ? rest : rest.slice(brace));
  } catch {
    return new Set();
  }
  const values = new Set();
  for (const field of ["type", "state", "reasonCode", "worldFactKind", "kind"])
    if (typeof fact?.[field] === "string") values.add(fact[field]);
  for (const field of ["state", "reasonCode", "kind", "worldFactKind"])
    if (typeof fact?.worldFactPayload?.[field] === "string") values.add(fact.worldFactPayload[field]);
  return values;
}

test("① the real round66 fact stream is red, and it names the survivors with their counts", () => {
  const { status, stdout, stderr } = run("--log", ROUND66);
  assert.equal(status, 1, "a log that still carries a declared-deleted kind must fail");
  assert.match(stdout, /declared-deleted kinds examined 9 · gone 6 · still produced 3/u);
  assert.match(stderr, /✖ declared_deleted_fact_still_produced:accepted - accepted · 46 · /u);
  assert.match(stderr, /✖ declared_deleted_fact_still_produced:running - running · 17 · /u);
  assert.match(
    stderr,
    /reasonCodes tool_approach_completed 14, item_pickup_approach_completed 3/u,
    "the step code that survived rides the `running` state, and the finding has to say so by name",
  );
  assert.match(
    stderr,
    /✖ declared_deleted_fact_still_produced:tool_equipped - tool_equipped · 1 · .*resourcetoolactions\.cs:\d+/u,
  );
  for (const gone of ["tile_advanced", "route_progress", "body_idle", "execution_started", "meaningful_progress"])
    assert.ok(!stderr.includes(`still_produced:${gone}`), `\`${gone}\` is gone in this log and must not be named`);
});

test("② the same log with the survivor lines removed is green, and every kind reads gone", () => {
  const directory = scratch("clean");
  const kept = readFileSync(ROUND66, "utf8")
    .split(/\r?\n/u)
    .filter((line) => {
      const values = kindValues(line);
      for (const value of values) if (DECLARED_DELETED.has(value)) return false;
      return true;
    });
  const path = join(directory, "clean.log");
  writeFileSync(path, `${kept.join("\n")}\n`);
  const facts = kept.filter((line) => line.includes("BRIDGE_FACT ")).length;
  assert.ok(facts > 0, "the derived fixture must still hold facts, or green would be the zero-population kind");

  const { status, stdout, stderr } = run("--log", path);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /declared-deleted kinds examined 9 · gone 9 · still produced 0/u);
  assert.equal(stderr.trim(), "", "nothing may be reported against a log whose survivors were removed");
});

test("③ a kind that survives only in an account field is green: a mention is not a value", () => {
  const text = readFileSync(MENTIONS, "utf8");
  // The fixture must really carry the mentions, or this case proves nothing about mention counting.
  assert.match(text, /traces \d+ \{receipt:accepted: \d+/u);
  assert.match(text, /semantic:route_progress: 0/u);
  assert.match(text, /semantic:body_idle: 0/u);

  const { status, stdout, stderr } = run("--log", MENTIONS);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /declared-deleted kinds examined 9 · gone 9 · still produced 0/u);
  assert.match(stdout, /account\/diagnostic lines carry MENTIONS that are not counted/u);
});

test("④ a pump that stopped holding a declared-deleted kind is red, named by the member", () => {
  const { status, stderr } = run("--root", AUTHORITY, "--log", MENTIONS);
  assert.equal(status, 1);
  assert.match(stderr, /✖ declared_deleted_doc_and_code_disagree:body_idle - /u);
  assert.match(stderr, /semantic:body_idle.*decision/u);
});

test("⑤ the document's FACT column held as progress is red: the mirror direction", () => {
  const directory = scratch("mirror");
  const pump = readFileSync(join(AUTHORITY, "host/src/event-pump.ts"), "utf8").replace(
    '  accepted: "the terminal receipt for the same execution wakes the model",',
    '  rejected: "a refusal filed as a trace here",\n  accepted: "the terminal receipt for the same execution wakes the model",',
  );
  assert.notEqual(pump, readFileSync(join(AUTHORITY, "host/src/event-pump.ts"), "utf8"), "the injection must land");
  mkdirSync(join(directory, "host/src"), { recursive: true });
  mkdirSync(join(directory, "design"), { recursive: true });
  writeFileSync(join(directory, "host/src/event-pump.ts"), pump);
  writeFileSync(join(directory, "design/fact-authority.md"), readFileSync(join(AUTHORITY, "design/fact-authority.md")));

  const { status, stderr } = run("--root", directory, "--log", MENTIONS);
  assert.equal(status, 1);
  assert.match(stderr, /✖ declared_deleted_doc_and_code_disagree:receipt:rejected - /u);
});

test("⑥ the three zeroes are told apart: absent log, log with no facts, and a checkout with no run", () => {
  const absent = run("--log", "tools/fixtures/declared-deleted/absent.log");
  assert.equal(absent.status, 2, "a named log that is not there is NOT MEASURED");
  assert.match(absent.stderr, /declared_deleted_facts_blocked: the log .* does not exist/u);
  assert.match(absent.stdout, /"verdict":"blocked"/u, "the report on stdout must say blocked, not passed with a zero");

  const directory = scratch("nofacts");
  const path = join(directory, "empty.log");
  writeFileSync(path, 'BRIDGE_DIAGNOSTIC {"stage":"nothing"}\nGAME_TURN_ACCOUNT traces 0 {}\n');
  const noFacts = run("--log", path);
  assert.equal(noFacts.status, 2, "a log whose screens hold no BRIDGE_FACT line was not a run");
  assert.match(noFacts.stderr, /holds no BRIDGE_FACT line/u);

  const empty = scratch("nodir");
  const noRun = run("--log-dir", empty);
  assert.equal(noRun.status, 0, "a checkout with no run cannot fail a commit");
  assert.match(noRun.stdout, /^declared_deleted_facts_log_skipped: no run log found/mu);
  assert.match(noRun.stdout, /declared-deleted-facts: not measured/u);
});

test("⑦ --expect is an assertion that can be wrong: the pinned reading passes, a dropped survivor fails", () => {
  const pinned = run("--log", ROUND66, "--expect", "accepted=46,running=17,tool_equipped=1");
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.match(pinned.stdout, /declared-deleted fact pinned: accepted · 46 · /u);

  const dropped = run("--log", ROUND66, "--expect", "accepted=46,running=17");
  assert.equal(dropped.status, 1);
  assert.match(dropped.stderr, /declared_deleted_expectation_mismatch:expect - .*`tool_equipped` was not pinned/u);

  const wrongCount = run("--log", ROUND66, "--expect", "accepted=47,running=17,tool_equipped=1");
  assert.equal(wrongCount.status, 1);
  assert.match(wrongCount.stderr, /`accepted` was pinned at 47 and the log holds 46/u);

  const invented = run("--log", ROUND66, "--expect", "cleared_a_tile=1");
  assert.equal(invented.status, 1);
  assert.match(invented.stderr, /`cleared_a_tile` is not a declared-deleted kind any authority names/u);
});

test("⑧ the transcription expires: a document that declares one more kind is red by that member's name", () => {
  const directory = scratch("drift");
  cpSync(AUTHORITY, directory, { recursive: true });
  const document = readFileSync(join(AUTHORITY, "design/fact-authority.md"), "utf8");
  writeFileSync(join(directory, "design/fact-authority.md"), `${document}\n\n- **\`brand_new_trace\` 不需要存在。**\n`);
  const { status, stdout, stderr } = run("--root", directory, "--log", MENTIONS);
  assert.equal(status, 1);
  assert.match(stderr, /✖ declared_deleted_transcription_drift:brand_new_trace - /u);
  assert.match(
    stdout,
    /declared-by-doc 6/u,
    "the document is the authority, so the parsed member enters the population whether or not the transcription knows it",
  );
});

test("⑨ with no --log it reads the newest run log it can find, and it says which", () => {
  const directory = scratch("newest");
  const older = join(directory, "_multiday_routine-round65-live-runner.log");
  const newer = join(directory, "_multiday_routine-round66-live-runner.log");
  writeFileSync(older, "TRACE nothing\n");
  writeFileSync(newer, readFileSync(ROUND66));
  // The OLDER log is made to look older on disk, so "newest" is a fact of the fixture and not of the order two writes
  // happened to land in.
  const past = new Date(Date.now() - 60_000);
  utimesSync(older, past, past);

  const { status, stdout, stderr } = run("--log-dir", directory);
  assert.equal(status, 1, stderr);
  assert.match(stdout, /declared-deleted facts: log .*_multiday_routine-round66-live-runner\.log/u);
  assert.match(stdout, /still produced 3/u);
});

// red-proof: fixture  the committed round66 fact stream -> the gate names the kinds that survived the deletion with
//   their counts (`accepted · 46`, `running · 17`, `tool_equipped · 1`); the same log with those lines removed is
//   green; and a pump that stopped holding `body_idle` while the document still declares it is red by that member
//   (tools/check-declared-deleted-facts.test.mjs)
