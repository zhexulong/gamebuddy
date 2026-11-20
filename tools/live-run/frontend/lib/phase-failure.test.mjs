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

/**
 * The measured shape (`.tmp/lane-livenow4.md`, r15): `w-game-launch` exited 1 and the phase exited 3
 * for it, while `z-game-disconnect` measured nothing and said so. The operator's line quoted `z`'s
 * `game_never_reached_ready` - a code that answers "was this measured", never "why did the phase
 * exit" - because the reading took the last named code in an append-only log. The failing driver's
 * own section is where the reason is, and `DRIVER <key> FAILED (exit n)` is the phase's own record
 * of which driver that is.
 */
test("the phase's line names the driver that failed, not the driver that ran last", () => {
  const log = logWith([
    "===== capture invocation 2026-11-20T15:01:16.649Z drivers=[a,w,x,y,z] force=true =====",
    "========== w-game-launch ==========",
    "  | CHAIN 2/9 launch admitted",
    "  | FAILED: game_launch_unavailable:game_unavailable/stardew_contained_player_host_launch_failed",
    "  exit=1 elapsed=9s",
    "  DRIVER w-game-launch FAILED (exit 1)",
    "========== x-game-death ==========",
    "  | NOT-MEASURED: game_never_reached_ready: the instance never reached instance=running",
    "  NOT-MEASURED x-game-death: game_never_reached_ready - instance=crashed",
    "  exit=0 elapsed=0s",
    "========== z-game-disconnect ==========",
    "  | NOT-MEASURED: game_never_reached_ready: the instance never reached instance=running",
    "  NOT-MEASURED z-game-disconnect: game_never_reached_ready - instance=crashed",
    "  exit=0 elapsed=0s",
    "DONE-CAPTURE failed=1 of 5 ran=5 skipped=0 not-selected=0 not-measured=2 blocked-by-product=0 failed-drivers=[w-game-launch] not-measured-drivers=[x-game-death:game_never_reached_ready,z-game-disconnect:game_never_reached_ready]",
  ]);
  try {
    const line = describePhaseFailure({ phase: "capture", code: 3, logPath: log.path });
    assert.equal(
      line,
      "phase capture failed (exit 3) - w-game-launch: game_launch_unavailable:game_unavailable/stardew_contained_player_host_launch_failed",
    );
    // The not-measured verdict is a different fact and must not be quoted as this phase's reason.
    assert.equal(line.includes("game_never_reached_ready"), false);
  } finally {
    log.cleanup();
  }
});

test("a failing driver whose own lines named nothing answers its name and no borrowed code", () => {
  const log = logWith([
    "========== w-game-launch ==========",
    "  | the tab closed before the launch request was answered",
    "  DRIVER w-game-launch FAILED (exit 9)",
    "========== z-game-disconnect ==========",
    "  NOT-MEASURED z-game-disconnect: game_never_reached_ready - instance=crashed",
  ]);
  try {
    assert.equal(
      describePhaseFailure({ phase: "capture", code: 3, logPath: log.path }),
      "phase capture failed (exit 3) - w-game-launch",
    );
  } finally {
    log.cleanup();
  }
});

test("a log with no per-driver failure record keeps the phase's own last named refusal", () => {
  const log = logWith([
    "=== PIN: detached worktree at abc123 ===",
    "  previous_worktree_not_cleared:D:\\gb\\shots.stage\\worktree",
  ]);
  try {
    assert.equal(
      describePhaseFailure({ phase: "pin", code: 1, logPath: log.path }),
      "phase pin failed (exit 1) - previous_worktree_not_cleared:D:\\gb\\shots.stage\\worktree",
    );
  } finally {
    log.cleanup();
  }
});

test("a log that cannot be read is not a refusal", () => {
  assert.equal(lastNamedRefusal(join(tmpdir(), "gb-no-such-phase.log")), null);
  assert.equal(describePhaseFailure({ phase: "build", code: 1, logPath: null }), "phase build failed (exit 1)");
});
