// The gate that turns "a run ended and nothing said how" into a red reading, and its falsifiers.
//
// Every fixture here is a real run directory tree, because the property is about what is ON DISK after a process died:
// round67's own shape is a directory holding `launch.json` and nothing else, and it must come out `silent`, named, exit 1.
// No game, no `.live-runs` of this checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const GATE = join(import.meta.dirname, "check-live-run-closures.mjs");
const RUN = "2026-11-17T19-09-31-413Z-multiday_routine";
const NOW = Date.parse("2026-11-17T19:09:31.414Z");
const iso = (ms) => new Date(ms).toISOString();

function area() {
  const root = mkdtempSync(join(tmpdir(), "closures-gate-"));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** One run directory: a launch receipt written by the process that armed it, and (optionally) the record of its ending. */
function runDir(parent, name, { launch = true, closure = null, result = false } = {}) {
  const dir = join(parent, "game-ladder", name);
  mkdirSync(dir, { recursive: true });
  if (launch)
    writeFileSync(
      join(dir, "launch.json"),
      `${JSON.stringify({ schema: "gamebuddy-live-run-launch/v1", kind: "game-ladder", label: "multiday_routine", startedAtMs: NOW, pid: 13860 })}\n`,
    );
  if (closure !== null)
    writeFileSync(
      join(dir, "closure.json"),
      `${JSON.stringify({
        schema: "gamebuddy-live-run-closure/v1",
        run: name,
        state: closure.state,
        reasonCode: closure.reasonCode,
        endedAtMs: NOW + 60_000,
        durationMs: 60_000,
        result: closure.result,
        progress: { present: true, lines: 2, lastEvent: "run_ended", lastTurn: 1 },
      })}\n`,
    );
  if (result) writeFileSync(join(dir, "result.json"), "{}");
  return dir;
}

function gate(root, extra = []) {
  const child = spawnSync(process.execPath, [GATE, "--root", root, ...extra], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

test("round67's own directory - a launch receipt and nothing else - is silent, named, and red", (t) => {
  const fixture = area();
  t.after(() => fixture.remove());
  runDir(fixture.root, RUN);
  const reading = gate(fixture.root);
  assert.equal(reading.status, 1, `a launch receipt with no closure must exit 1:\n${reading.stdout}${reading.stderr}`);
  assert.match(
    reading.stdout,
    /runs examined 1 · closed 0 · recorded-died 0 · bundle-only 0 · silent 1 · not measured 0/u,
  );
  assert.match(reading.stdout, new RegExp(`silent +${RUN}: a launch receipt with no closure`, "u"));
  assert.match(
    reading.stderr,
    new RegExp(`^a_run_that_died_leaves_a_record:${RUN} - a launch receipt with no closure`, "mu"),
    "the blocked reading names the run, not just the count",
  );
});

test("the falsifier: the same directory with a closure is green, so the gate reads the ending and not the tree", (t) => {
  const fixture = area();
  t.after(() => fixture.remove());
  runDir(fixture.root, RUN, {
    closure: { state: "closed", reasonCode: "runner_exited:0", result: "fresh" },
    result: true,
  });
  const reading = gate(fixture.root);
  assert.equal(reading.status, 0, `a recorded ending is not a failure:\n${reading.stdout}${reading.stderr}`);
  assert.match(
    reading.stdout,
    /runs examined 1 · closed 1 · recorded-died 0 · bundle-only 0 · silent 0 · not measured 0/u,
  );
  assert.doesNotMatch(reading.stderr, /a_run_that_died_leaves_a_record/u);
});

test("a recorded death is counted and named, and is neither silent nor a pass", (t) => {
  const fixture = area();
  t.after(() => fixture.remove());
  runDir(fixture.root, RUN, { closure: { state: "died", reasonCode: "runner_exited:1", result: "absent" } });
  const reading = gate(fixture.root);
  assert.equal(reading.status, 0, "the gate is about silence, not about whether the run did well");
  assert.match(reading.stdout, /recorded-died 1 · bundle-only 0 · silent 0/u);
  assert.match(reading.stdout, new RegExp(`recorded-died ${RUN}: died \\(runner_exited:1\\)`, "u"));
});

test("a run directory nothing armed is not measured and is named, not folded into the total", (t) => {
  const fixture = area();
  t.after(() => fixture.remove());
  const unarmed = "2026-11-18T02-00-00-000Z-multiday_routine";
  runDir(fixture.root, unarmed, { launch: false, result: true });
  const reading = gate(fixture.root);
  assert.equal(reading.status, 0);
  assert.match(
    reading.stdout,
    /runs examined 1 · closed 0 · recorded-died 0 · bundle-only 0 · silent 0 · not measured 1/u,
  );
  assert.match(reading.stdout, new RegExp(`not measured +${unarmed}: no launch receipt`, "u"));
});

test("an empty population refuses to agree with itself", (t) => {
  const fixture = area();
  t.after(() => fixture.remove());
  mkdirSync(join(fixture.root, "game-ladder"), { recursive: true });
  const empty = gate(fixture.root);
  assert.equal(empty.status, 2, "zero examined is not zero silent");
  assert.match(empty.stderr, /run_closures_not_measured/u);
  // ...and a caller who can say WHY it is empty gets the pass, with the reason printed beside the count.
  const allowed = gate(fixture.root, ["--allow-empty", "no live run has happened in this clone"]);
  assert.equal(allowed.status, 0);
  assert.match(
    allowed.stdout,
    /runs examined 0 · closed 0 · recorded-died 0 · bundle-only 0 · silent 0 · not measured 0/u,
  );
});

test("--json is the same reading, machine-readable", (t) => {
  const fixture = area();
  t.after(() => fixture.remove());
  runDir(fixture.root, RUN);
  const reading = gate(fixture.root, ["--json"]);
  assert.equal(reading.status, 1);
  const parsed = JSON.parse(reading.stdout);
  assert.equal(parsed.status, "blocked");
  assert.deepEqual(parsed.blockedRuns, [RUN]);
  assert.equal(parsed.examined, 1);
  assert.equal(iso(NOW), "2026-11-17T19:09:31.414Z");
});
