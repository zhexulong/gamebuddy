// The launcher's half of "a killed run costs its own verdict": it owns the fixture transaction, so it owns that
// transaction's release when the run was stopped from outside.
//
// Measured 2026-11-06 at 19:37:14: an external timeout ended the launcher mid-await, leaving the transaction unreleased
// and no restore ever run. What is checkable offline is the wiring the fix depends on: the trap is armed BEFORE the run
// takes the transaction, both exits run ONE restore, and the killed record never pretends to hold evidence the launcher
// does not have.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const LAUNCHER = readFileSync(new URL("./launch-ladder-live.mjs", import.meta.url), "utf8");

/** The body of one top-level `function` / `async function` declaration, by its own braces. */
function functionBody(source, name) {
  const marker = `function ${name}(`;
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `the launcher must define ${name}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

test("the interrupt trap is armed before the run takes the fixture transaction", () => {
  // Arming it after `prepare` would leave every window before that unteardownable - and `prepare` is the first step
  // that takes the lock, so it is the wrong side of the line.
  assert.match(
    LAUNCHER,
    /import \{[\s\S]{0,200}installLiveRunInterrupt,[\s\S]{0,300}\} from "\.\.\/\.\.\/lib\/live-run-teardown\.mjs";/u,
    "the trap is the shared one the runner also uses, not a second copy",
  );
  assert.match(LAUNCHER, /installLiveRunInterrupt\(\{ onInterrupt: killedTeardown \}\);/u);
  const armedAt = LAUNCHER.indexOf("installLiveRunInterrupt({ onInterrupt: killedTeardown });");
  const firstWaitAt = LAUNCHER.indexOf("await waitForFreeFixture();");
  assert.ok(armedAt > 0 && firstWaitAt > armedAt, "the trap must be armed before the first wait, not after prepare");
  // No hand-rolled second trap: one mechanism, one owner.
  assert.equal(
    (LAUNCHER.match(/process\.on(?:ce)?\(/gu) ?? []).length,
    0,
    "signal listening lives in the shared module",
  );
});

test("both exits run the one restore, so a killed run cannot miss the ordinary teardown", () => {
  // The defect was a teardown that only ONE path ran. Two call sites of one function is the falsifier: a third command
  // spelled inline somewhere would leave the count at one and the copy free to rot.
  assert.equal(
    (LAUNCHER.match(/^\s*restoreFixtureTransaction\(\);$/gmu) ?? []).length,
    2,
    "the ordinary tail and the killed teardown must call the same restore",
  );
  const killed = functionBody(LAUNCHER, "killedTeardown");
  const ordinary = LAUNCHER.slice(LAUNCHER.indexOf("await childSettled;"));
  for (const [where, body] of [
    ["the killed teardown", killed],
    ["the ordinary tail", ordinary],
  ]) {
    assert.match(body, /restoreFixtureTransaction\(\);/u, `${where} must restore the fixture transaction`);
  }
  // And the restore is the fixture tool's own command, forwarded as one invocation rather than re-derived here.
  const wrapper = functionBody(LAUNCHER, "restoreFixtureTransaction");
  assert.match(wrapper, /restoreFixtureTransactionSteps\(\{/u);
  assert.doesNotMatch(wrapper, /execFileSync|spawnSync/u, "the command lives in the shared module");
});

test("the killed teardown orders itself: settle, reap, restore, then the record", () => {
  const killed = functionBody(LAUNCHER, "killedTeardown");
  const settleAt = killed.indexOf("KILL_SETTLE_MS");
  const reapAt = killed.indexOf("killProcessTree(");
  const restoreAt = killed.indexOf("restoreFixtureTransaction();");
  const recordAt = killed.indexOf("writeKilledRunRecord({");
  assert.ok(settleAt >= 0 && reapAt > settleAt, "the runner is given its settle window before the game is reaped");
  assert.ok(restoreAt > reapAt, "the fixture is restored after the game stops touching it");
  assert.ok(recordAt > restoreAt, "the record is written once the lock is released");
  // A restore that refuses must not swallow the verdict: the record is outside the try that catches the refusal.
  assert.match(killed, /\} catch \(error\) \{[\s\S]*?\n {2}\}\n {2}writeKilledRunRecord\(\{/u);
});

test("the launcher's killed record names the signal and says which evidence it does not have", () => {
  const killed = functionBody(LAUNCHER, "killedTeardown");
  assert.match(killed, /state: "killed",/u);
  assert.match(
    killed,
    /reasonCode: killedReasonCode\(signal\),/u,
    "the reason has one spelling, shared with the runner",
  );
  // The day records and counters are the runner's; this record must name their absence rather than publish zeroes that
  // read like a measured run.
  assert.match(
    killed,
    /evidence: \{ dayRecords: null, counters: null, reason: "runner_published_no_bundle" \},/u,
    "an unmeasured day record is named absent, never zero",
  );
});
