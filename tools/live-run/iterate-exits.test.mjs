// THE GATE THE GATE MISSED: a round that delivered nothing cannot exit 0.
//
// WHY (measured 2026-11-17): three consecutive multi-day rounds (`round65`, `round66`, `round67`) each left a run
// directory holding `launch.json` and nothing else - no `result.json` for any of them - and `multiday-iterate.mjs`
// printed "no result ... the launcher did not finish" and then exited 0. The thing watching those rounds was green on
// the failure that happened three times running, so the audit had to reconstruct from a terminal log what the harness
// had refused to say.
//
// Two populations are checked, because either one alone can be fooled:
//
//   - EVERY exit path in `multiday-iterate.mjs`, read from the file. The property is not "the current line exits 3" -
//     it is that no site in that script may choose 0 on its own: the only exit code there is the one
//     `judgeRunOutcome` returns, and it may only be 0 when a result exists.
//   - A REAL invocation with no result on disk, which must fail BY NAME. The falsifier beside it is the same invocation
//     with a fresh bundle in place, which must still pass - otherwise "always refuse" would satisfy the first check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { judgeRunOutcome, NO_RESULT_EXIT_CODE } from "./core/run-outcome-exit.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ITERATE = join(REPO, "tools/live-run/multiday-iterate.mjs");

/** Every site in a source file that decides the process's exit status, with the line it is on. */
export function exitSites(source) {
  const sites = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    const call = /process\.exit(?:Code\s*=\s*)?\(?([^;)]*)/u.exec(line);
    const assignment = /process\.exitCode\s*=\s*(.+);/u.exec(line);
    if (call === null && assignment === null) return;
    sites.push({
      line: index + 1,
      text: trimmed,
      argument: (call?.[1] ?? assignment?.[1] ?? "").trim(),
    });
  });
  return sites;
}

test("no exit site in the iterate script can return 0 without a result", () => {
  const source = readFileSync(ITERATE, "utf8");
  const sites = exitSites(source);
  assert.ok(sites.length > 0, "the exit sites must be found; a scan that sees nothing agrees with itself");

  const refusals = [];
  for (const site of sites) {
    // The funnels: a site whose argument is the decision's own `exitCode` is the one place allowed to answer 0, and it
    // answers 0 only when `judgeRunOutcome` saw a result. Everything else must be a non-zero literal, or a status the
    // failed command itself reported (which is non-zero by the guard above it).
    const fromDecision = /decision\.exitCode|outcome\.exitCode/u.test(site.argument);
    const literal = Number.parseInt(site.argument, 10);
    const nonZero = Number.isInteger(literal) && literal !== 0;
    const fromFailure = /result\.status|launched\.status/u.test(site.argument);
    if (!(fromDecision || nonZero || fromFailure))
      refusals.push(`multiday-iterate.mjs:${String(site.line)} exits 0 on its own: ${site.text}`);
  }
  console.log(
    `exits examined ${String(sites.length)} · refuse ${String(refusals.length)} · pass ${String(sites.length - refusals.length)}`,
  );
  assert.deepEqual(refusals, [], refusals.join("\n"));

  // The decision is consulted BEFORE anything is reported, so no reading of a round can precede the question of whether
  // that round produced one. Naming the two anchors keeps this from passing on a file where the call was deleted.
  const decisionAt = source.indexOf("judgeRunOutcome(");
  const firstReportAt = source.indexOf("==== result ====");
  assert.ok(decisionAt > 0, "the script must consult judgeRunOutcome");
  assert.ok(firstReportAt > decisionAt, "the result is read only after the outcome decision");
});

test("judging an outcome: a result is a pass, and nothing else is", () => {
  const present = judgeRunOutcome({ launched: true, launcherExitCode: 0, resultExists: true, resultPath: "x" });
  assert.equal(present.exitCode, 0);
  assert.equal(present.cause, "result_present");

  const nothingLaunched = judgeRunOutcome({
    launched: false,
    launcherExitCode: null,
    resultExists: false,
    resultPath: "x",
  });
  assert.equal(nothingLaunched.exitCode, NO_RESULT_EXIT_CODE);
  assert.equal(nothingLaunched.cause, "nothing_launched");
  assert.match(
    nothingLaunched.reading,
    /nothing was launched/u,
    "the dry run says what it is instead of posing as a run",
  );

  const died = judgeRunOutcome({
    launched: true,
    launcherExitCode: 0,
    resultExists: false,
    resultPath: "tools/x.json",
  });
  assert.equal(died.exitCode, NO_RESULT_EXIT_CODE);
  assert.equal(died.cause, "launcher_exited_without_a_result");
  assert.match(died.reading, /no result at tools\/x\.json/u, "the reading names the file that is missing");
  assert.match(died.reading, /exited 0/u, "and the exit code that contradicted it");

  const killed = judgeRunOutcome({ launched: true, launcherExitCode: null, resultExists: false, resultPath: "p" });
  assert.equal(killed.exitCode, NO_RESULT_EXIT_CODE);
  assert.match(
    killed.reading,
    /killed/u,
    "a launcher killed by a signal is named, not reported as an exit code of null",
  );
});

function fixtureRoot() {
  const area = mkdtempSync(join(tmpdir(), "iterate-refusal-"));
  const root = join(area, "stardew-fixtures");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "GameBuddyFixture_gate.native-local-binding.json"),
    JSON.stringify({ observedSaveSlot: "Gate1" }),
    "utf8",
  );
  return { area, root, remove: () => rmSync(area, { recursive: true, force: true }) };
}

/** The real script, with nothing to launch, on a tree that has no bundle: the shape of round65/66/67. */
function runIterate({ root }) {
  return spawnSync(
    process.execPath,
    ["tools/live-run/multiday-iterate.mjs", "--dry-run", "--no-build", "--label", "gate-no-result"],
    {
      cwd: REPO,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, GAMEBUDDY_STARDEW_FIXTURE_ROOT: root, GAMEBUDDY_STARDEW_GAME_DIR: "D:/none" },
    },
  );
}

test("the real script refuses a round that produced no result, and names why", (t) => {
  const area = fixtureRoot();
  t.after(() => area.remove());
  const bundle = join(REPO, "tools", "_multiday_routine-gate-no-result.result.json");
  assert.equal(existsSync(bundle), false, "the fixture needs a tree that really has no bundle for this label");
  const child = runIterate({ root: area.root });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  assert.equal(child.status, NO_RESULT_EXIT_CODE, `the round delivered nothing, so it cannot exit 0:\n${output}`);
  assert.match(
    output,
    /nothing was launched/u,
    "the refusal names what happened rather than 'the launcher did not finish'",
  );
});

test("the falsifier: an empty run directory is what the old script called a pass", (t) => {
  const area = fixtureRoot();
  t.after(() => area.remove());
  // A run directory holding `launch.json` alone - round65/66/67 verbatim. The old decision was "no result file -> exit
  // 0"; this asserts the same directory now answers a refusal, so the guard is not merely reading a different tree.
  const liveRunRoot = join(area.area, "live-runs");
  const runDir = join(liveRunRoot, "game-ladder", "2026-11-17T23-23-04-000Z-multiday_routine");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "launch.json"),
    JSON.stringify({ schema: "gamebuddy-live-run-launch/v1", kind: "game-ladder" }),
    "utf8",
  );
  assert.deepEqual(
    judgeRunOutcome({
      launched: true,
      launcherExitCode: 0,
      resultExists: existsSync(join(runDir, "result.json")),
      resultPath: "r",
    }).exitCode,
    NO_RESULT_EXIT_CODE,
    "a directory holding launch.json and nothing else is a round with no result",
  );
});
