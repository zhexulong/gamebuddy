// The orchestrator's exit status is the runner's, driven by a REAL child process on the other end.
//
// The orchestrator launches SMAPI and cannot be run by a test, so what is checked here is the decision it wires plus the
// command that decides it: a child that exits 7 must make the process exit 7 (it exited 0 before this existed, because
// the code was printed and dropped), and a child that exits 0 having printed no verdict answered nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  judgeRunnerExit,
  readRunnerVerdict,
  RUNNER_EXIT_UNREPORTED,
  RUNNER_NO_VERDICT,
} from "./ladder-runner-exit.mjs";

/** A real child, so the exit code and the stdout are the runtime's own and not a hand-written stub. */
function runChild(source) {
  const result = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", timeout: 60_000 });
  return { exitCode: result.status, stdout: String(result.stdout ?? "") };
}

test("a child that fails makes the orchestrator exit with its code", () => {
  const child = runChild("process.exit(7);");
  assert.equal(child.exitCode, 7, "the fixture child must really exit 7");
  const verdict = judgeRunnerExit({ exitCode: child.exitCode, stdout: child.stdout });
  assert.equal(verdict.exitCode, 7, "the child's failure exit code is the orchestrator's exit code");
});

test("a settled run keeps its own code and its own verdict line", () => {
  const child = runChild(
    'process.stdout.write("progress line\\n");process.stdout.write(`${JSON.stringify({ state: "passed" })}\\n`);',
  );
  const verdict = judgeRunnerExit({ exitCode: child.exitCode, stdout: child.stdout });
  assert.deepEqual(verdict, { exitCode: 0, verdictLine: '{"state":"passed"}', reading: null });
});

test("a run that printed no verdict never exits 0", () => {
  const child = runChild('process.stdout.write("nothing but prose\\n");');
  assert.equal(child.exitCode, 0, "the fixture child really succeeded");
  const verdict = judgeRunnerExit({ exitCode: child.exitCode, stdout: child.stdout });
  assert.equal(verdict.exitCode, RUNNER_EXIT_UNREPORTED);
  assert.equal(verdict.reading, RUNNER_NO_VERDICT, "the reading is named, so it is not read as a generic failure");
  assert.equal(verdict.verdictLine, undefined);
});

test("a child the runtime reported no code for is not a success", () => {
  // `close` reports a null code when the child was killed; silence is not an answer.
  const verdict = judgeRunnerExit({ exitCode: null, stdout: '{"state":"passed"}\n' });
  assert.equal(verdict.exitCode, RUNNER_EXIT_UNREPORTED);
  assert.equal(verdict.reading, RUNNER_NO_VERDICT);
});

test("the verdict line is the last JSON object the runner printed", () => {
  const stdout = '{"state":"running"}\nnoise\n{"state":"blocked","failure":{"reasonCode":"x"}}\n';
  assert.equal(readRunnerVerdict(stdout), '{"state":"blocked","failure":{"reasonCode":"x"}}');
  assert.equal(readRunnerVerdict("no json here"), undefined);
});
