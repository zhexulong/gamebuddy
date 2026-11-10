// The launcher's report is this attempt's, and its exit status is the runner's.
//
// The launcher drives a real game and cannot be unit-run, so what is checkable offline is that it wires the shared
// decisions instead of a second copy of them: the bundle already at its path is superseded BEFORE the launch, the
// bundle it reads afterwards is judged for freshness, and the child's own exit code reaches `process.exitCode` in both
// scripts. Measured before this existed: a crashed attempt printed the previous attempt's `state`, and a failing runner
// left both scripts exiting 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const LAUNCHER = readFileSync(new URL("./launch-ladder-live.mjs", import.meta.url), "utf8");
const ORCHESTRATOR = readFileSync(new URL("../../_ladder-live-orchestrator.mjs", import.meta.url), "utf8");

test("the launcher supersedes the previous bundle before it launches anything", () => {
  assert.match(
    LAUNCHER,
    /import \{ judgeResultFreshness, supersedePreviousResult \} from "\.\.\/core\/result-freshness\.mjs";/u,
  );
  const supersedeAt = LAUNCHER.indexOf("supersedePreviousResult({ resultPath })");
  const spawnAt = LAUNCHER.indexOf('spawn(node, ["tools/_ladder-live-orchestrator.mjs"]');
  assert.ok(supersedeAt > 0 && spawnAt > supersedeAt, "the previous bundle is moved aside before the next run starts");
  // …and the launch time is captured before the spawn, or a bundle written during the run cannot be told from one
  // written before it.
  const launchedAt = LAUNCHER.indexOf("const launchedAtMs = Date.now();");
  assert.ok(launchedAt > 0 && launchedAt < spawnAt, "the launch stamp must precede the run it names");
  assert.match(LAUNCHER, /const freshness = judgeResultFreshness\(\{ resultPath, launchedAtMs \}\);/u);
});

test("a stale bundle is named instead of printed, and is not stamped with this attempt's teardown", () => {
  const tail = LAUNCHER.slice(LAUNCHER.indexOf("const freshness = judgeResultFreshness"));
  assert.ok(tail.length > 0);
  assert.match(
    tail,
    /if \(freshness\.state === "stale"\) \{\n\s+console\.log\(freshness\.reading\);\n\s+process\.exitCode = 1;/u,
  );
  // The `RESULT` line is printed for a fresh bundle only: the stale arm must not fall through to it.
  const freshAt = tail.indexOf('else if (freshness.state === "fresh") {');
  const resultAt = tail.indexOf('"RESULT"');
  assert.ok(freshAt > 0 && resultAt > freshAt, "the result is printed only for a bundle this launch wrote");
  // Stamping a bundle this launch did not write would forge another run's teardown account.
  assert.match(
    tail,
    /if \(freshness\.state === "stale"\) \{\n\s+console\.error\(\n\s+"RECLAMATION_INCOMPLETE",\n\s+JSON\.stringify\(\{ reasonCode: "run_reclamation_not_stamped:stale_result_precedes_launch" \}\),\n\s+\);\n\} else \{\n\s+stampReclamationAccount\(fixtureRestore\);\n\}/u,
  );
});

test("both scripts pass the child's exit code on instead of printing it", () => {
  // The launcher: `exitCode` was captured from the child's close and used only for a console line.
  assert.match(
    LAUNCHER,
    /await childSettled;\nconsole\.log\("live runner exit:", exitCode,[\s\S]{0,400}?process\.exitCode = exitCode \?\? 1;/u,
  );
  // The orchestrator: it now asks the shared decision, and assigns what it answers.
  assert.match(ORCHESTRATOR, /import \{ judgeRunnerExit \} from "\.\/live-run\/game\/ladder-runner-exit\.mjs";/u);
  assert.match(ORCHESTRATOR, /const verdict = judgeRunnerExit\(\{ exitCode: runnerExit, stdout: runnerStdout \}\);/u);
  assert.match(ORCHESTRATOR, /process\.exitCode = verdict\.exitCode;/u);
  // A run that printed no verdict says so by name; the console line alone is not a verdict.
  assert.match(ORCHESTRATOR, /if \(verdict\.reading !== null\) console\.error\(verdict\.reading,/u);
});
