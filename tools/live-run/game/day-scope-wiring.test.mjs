import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

/**
 * The day loop's OWN use of the day-scoped predicate.
 *
 * `multiday-day-scope.test.mjs` proves the predicate is right. It cannot prove the runner USES it, and
 * that gap was real: the module landed in one commit and the runner was wired to it in the next, so for
 * one commit the tests described a rule nothing ran. A predicate that nothing calls is a green test over
 * a live defect - the exact failure the day-scope rule exists to prevent.
 *
 * These pins read the runner and assert the SHAPE OF ITS CALL SITE, not that a string exists: the scope
 * has to be captured before the loop, and the loop has to consult that scope. Reverting either half
 * fails here rather than shipping a rule the loop does not obey.
 */
const here = dirname(fileURLToPath(import.meta.url));
const runner = readFileSync(join(here, "run-stardew-native-local-agent-ab-live.mjs"), "utf8");

test("the runner imports the day-scoped predicate rather than re-deriving one", () => {
  assert.match(runner, /import \{[^}]*\bnightCrossedInScope\b[^}]*\} from "\.\.\/\.\.\/lib\/multiday-day-scope\.mjs"/u);
  assert.match(runner, /import \{[^}]*\bdayScopeFrom\b[^}]*\} from "\.\.\/\.\.\/lib\/multiday-day-scope\.mjs"/u);
});

test("the day scope is captured BEFORE the loop that consults it", () => {
  // The defect this guards: a scope captured once per RUN (or an untracked clock read) reintroduces the
  // run-as-a-day mistake the predicate exists to stop. Reading the position of the two statements in
  // order is the check that the value handed to the loop belongs to this day.
  const capture = runner.indexOf("const dayScope = dayScopeFrom(");
  const loop = runner.indexOf("while (!nightCrossedIn(dayScope))");

  assert.ok(capture >= 0, "the day loop must capture a day scope");
  assert.ok(loop >= 0, "the day loop must consult that scope, not a freshly derived predicate");
  assert.ok(capture < loop, "the scope must be captured before the loop that reads it");
});

test("no day loop is left calling a run-scoped predicate", () => {
  // The old spelling. If it comes back anywhere, one loop is answering for the whole run again.
  assert.doesNotMatch(runner, /while \(!nightCrossed\(\)\)/u);
  assert.doesNotMatch(runner, /const nightCrossed = \(\) =>/u);
});

test("the captured scope carries the day's own starting facts", () => {
  // All three inputs the predicate needs. A scope captured with only some of them silently loses the
  // clause that would have caught a rollover (or the one that would have caught a stale trace).
  const capture = runner.slice(
    runner.indexOf("const dayScope = dayScopeFrom("),
    runner.indexOf("});", runner.indexOf("const dayScope = dayScopeFrom(")),
  );
  assert.match(capture, /clock: readWorldClock\(\)/u, "the day's own clock");
  assert.match(capture, /dayOfMonth:/u, "the day's own calendar day");
  assert.match(capture, /traceIndex: actionTrace\.length/u, "the day's own trace start");
});
