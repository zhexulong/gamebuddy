// The operator's line for a failed phase.
//
// The measured cost: run 3 of five died as `Error: phase pin failed (exit 1)` while `pin.log` held the
// reason, so the only way to learn it was to open a log nobody knew to open.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describePhaseFailure, lastNamedRefusal } from "./phase-failure.mjs";

function logWith(lines) {
  const root = mkdtempSync(join(tmpdir(), "gb-phase-failure-"));
  const path = join(root, "pin.log");
  writeFileSync(path, lines.join("\n"), "utf8");
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the refusal a phase named reaches the operator's line", () => {
  const log = logWith([
    "=== PIN: detached worktree at abc123 ===",
    "  | remove: error: 'D:\\gb\\shots.stage\\worktree' is not a working tree",
    "  previous_worktree_not_cleared:D:\\gb\\shots.stage\\worktree",
    "  remedy: pass a FRESH --out",
    "DONE-PIN-FAIL (previous worktree could not be cleared)",
  ]);
  try {
    assert.equal(lastNamedRefusal(log.path), "previous_worktree_not_cleared:D:\\gb\\shots.stage\\worktree");
    assert.equal(
      describePhaseFailure({ phase: "pin", code: 1, logPath: log.path }),
      "phase pin failed (exit 1) - previous_worktree_not_cleared:D:\\gb\\shots.stage\\worktree",
    );
  } finally {
    log.cleanup();
  }
});

test("a phase that named nothing keeps its plain line instead of quoting a sentence", () => {
  const log = logWith([
    "=== PIN: detached worktree at abc123 ===",
    "  DONE-PIN-FAIL (worktree add failed)",
    "  remedy: pass a FRESH --out",
  ]);
  try {
    // `DONE-PIN-FAIL`, `remedy:` and a drive letter are not refusal codes: none carries a snake_case
    // word before its colon, so the line stays exactly what the phase reported.
    assert.equal(lastNamedRefusal(log.path), null);
    assert.equal(describePhaseFailure({ phase: "pin", code: 1, logPath: log.path }), "phase pin failed (exit 1)");
  } finally {
    log.cleanup();
  }
});

test("the most recent attempt's refusal is the one reported", () => {
  const log = logWith([
    "  launch_state_missing:C:\\old\\stage\\state\\launch.json",
    "  launch_state_missing:C:\\new\\stage\\state\\launch.json",
  ]);
  try {
    assert.equal(lastNamedRefusal(log.path), "launch_state_missing:C:\\new\\stage\\state\\launch.json");
  } finally {
    log.cleanup();
  }
});

test("a three-letter first segment is a code, not a shortening of one", () => {
  // Measured on a real launch refusal: `cdp_port_held_by_pid:<pid>:<dir>`. The first segment is `cdp`,
  // and a word boundary never appears inside the identifier, so a rule needing four characters before
  // the first underscore read the whole line as naming nothing.
  const log = logWith([
    "CDP PORT LOCK REFUSED: cdp_port_held_by_pid:41152:E:\\gb\\shots.stage: cdp port 9345 is held by pid 41152",
    "DONE-LAUNCH-FAILED",
  ]);
  try {
    assert.match(String(lastNamedRefusal(log.path)), /^cdp_port_held_by_pid:41152:/u);
  } finally {
    log.cleanup();
  }
});

test("a log that cannot be read is not a refusal", () => {
  assert.equal(lastNamedRefusal(join(tmpdir(), "gb-no-such-phase.log")), null);
  assert.equal(describePhaseFailure({ phase: "build", code: 1, logPath: null }), "phase build failed (exit 1)");
});
