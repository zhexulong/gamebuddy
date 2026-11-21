// A launch that waits must say what it waits for, or the wait is indistinguishable from a hang.
//
// Measured 2026-11-21 (`round87b`): a launch sat at 0% CPU, with no phase file, no child process and no output, and an
// operator spent seven minutes looking for a file to delete instead of reading what the run was waiting for. These
// assertions are about the LINE, because the line is the fix: the lock's path, its holder, its age, and what happens
// next - printed on the first iteration and on every heartbeat after it.
//
// Real lock directories and a real clock seam: `sleep` is the only thing faked, so every age here is a real mtime read.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FIXTURE_WAIT, waitForFixtureRootFree } from "./fixture-wait.mjs";

const LOCK_NAME = ".stardew-native-local-player-fixture.lock";
const lockOf = (root) => join(root, LOCK_NAME);
/** `age`/`grace` arithmetic crosses a millisecond either way, so a rendered second is compared with its neighbours. */
const around = (ms) => {
  const value = Math.round(ms / 1000);
  return new RegExp(`(?:${String(value - 1)}|${String(value)}|${String(value + 1)})s`, "u");
};

/** A clock the test moves: `now` is the only time source, and `sleep` advances it. */
function fakeClock(startMs = 1_700_000_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

function collector() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

/** A lock directory of the given age, as the fixture transaction leaves it. */
function heldLock(root, { ageMs, clock }) {
  const lockPath = lockOf(root);
  mkdirSync(lockPath, { recursive: true });
  const when = new Date(clock.now() - ageMs);
  utimesSync(lockPath, when, when);
  return lockPath;
}

test("a free root costs no wait and says nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-wait-free-"));
  try {
    const clock = fakeClock();
    const { lines, log } = collector();
    const result = await waitForFixtureRootFree({
      lockPath: lockOf(root),
      gameProcessIds: () => [],
      ownerId: () => null,
      sleep: clock.sleep,
      now: clock.now,
      log,
    });

    assert.equal(result.state, "free");
    assert.deepEqual(lines, [], "nothing is being waited for, so there is nothing to read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wait names the lock, its holder, its age and the next step on every heartbeat", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-wait-heartbeat-"));
  try {
    const clock = fakeClock();
    const ageMs = 5 * 60_000;
    const lockPath = heldLock(root, { ageMs, clock });
    let alive = [4321];
    const { lines, log } = collector();
    const result = await waitForFixtureRootFree({
      lockPath,
      gameProcessIds: () => alive,
      ownerId: () => "owner-a",
      sleep: async (ms) => {
        await clock.sleep(ms);
        // The game exits and the transaction goes with it: the next iteration is free.
        alive = [];
        rmSync(lockPath, { recursive: true, force: true });
      },
      now: clock.now,
      log,
    });

    assert.equal(result.state, "free");
    assert.equal(lines.length, 1, "one heartbeat, because the wait ended on the next iteration");
    const [line] = lines;
    assert.match(line, /^\[wait\] fixture busy · /u);
    assert.ok(line.includes(`waiting_for=${lockPath}`), `the line names the lock's own path: ${line}`);
    assert.match(line, /held_by=transaction:owner-a\+game_pid:4321/u);
    assert.match(line, new RegExp(`age=${around(ageMs).source}`, "u"));
    assert.match(line, /next_step=wait_for_the_game_process_that_holds_it_to_exit/u);
    assert.match(line, new RegExp(`deadline_in=${around(FIXTURE_WAIT.deadlineMs).source}`, "u"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock a live game holds is never renamed aside, however old it is", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-wait-live-game-"));
  try {
    const clock = fakeClock();
    const lockPath = heldLock(root, { ageMs: 10 * 60_000, clock });
    let alive = [777];
    let beats = 0;
    const { lines, log } = collector();
    const result = await waitForFixtureRootFree({
      lockPath,
      gameProcessIds: () => alive,
      ownerId: () => null,
      sleep: async (ms) => {
        await clock.sleep(ms);
        beats += 1;
        if (beats < 3) return;
        alive = [];
        rmSync(lockPath, { recursive: true, force: true });
      },
      now: clock.now,
      log,
    });

    // Ten minutes of idle is past every grace period, and the lock is STILL not touched: a live holder owns it.
    assert.equal(result.state, "free");
    assert.equal(
      lines.some((line) => line.startsWith("[recover]")),
      false,
      "clearing a live game's lock is cleaning another lane's work, not recovery",
    );
    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes(".orphaned-")),
      [],
      "nothing was renamed aside while the game was alive",
    );
    assert.match(lines[0], /held_by=game_pid:777/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a transaction with no game alive is renamed aside, never deleted, and the rename is named", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-wait-reclaim-"));
  try {
    const clock = fakeClock();
    const ageMs = 5 * 60_000;
    const lockPath = heldLock(root, { ageMs, clock });
    const { lines, log } = collector();
    const result = await waitForFixtureRootFree({
      lockPath,
      gameProcessIds: () => [],
      ownerId: () => "owner-a",
      sleep: clock.sleep,
      now: clock.now,
      log,
    });

    assert.equal(result.state, "reclaimed");
    assert.equal(existsSync(lockPath), false, "the held path is gone");
    assert.equal(existsSync(result.aside), true, "renamed aside, never deleted: a killed run's only fork point");
    assert.match(result.aside, /\.stardew-native-local-player-fixture\.lock\.orphaned-\d+$/u);
    assert.equal(
      lines.length,
      1,
      "the reclaim is reported, not performed in silence: it is the moment the lock a human wanted to delete stops",
    );
    assert.match(lines[0], /^\[recover\] orphaned fixture transaction renamed aside: /u);
    assert.ok(lines[0].includes(result.aside), "the line names where it was put");
    assert.match(lines[0], /held_by=transaction:owner-a/u);
    assert.match(lines[0], new RegExp(`age=${around(ageMs).source}`, "u"));
    assert.match(lines[0], /no_game_process_alive$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh orphan is left alone, and the line says how long until it is reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-wait-fresh-orphan-"));
  try {
    const clock = fakeClock();
    const lockPath = heldLock(root, { ageMs: 0, clock });
    let beats = 0;
    const { lines, log } = collector();
    const result = await waitForFixtureRootFree({
      lockPath,
      gameProcessIds: () => [],
      ownerId: () => null,
      sleep: async (ms) => {
        await clock.sleep(ms);
        beats += 1;
        if (beats < 2) return;
        rmSync(lockPath, { recursive: true, force: true });
      },
      now: clock.now,
      log,
    });

    assert.equal(result.state, "free");
    assert.match(lines[0], /next_step=rename_the_held_transaction_aside_after_\d+s_more_idle/u);
    assert.equal(
      lines.some((line) => line.startsWith("[recover]")),
      false,
      "a fresh orphan is a barrier, not residue",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock that names nobody reads as unreadable, not as an empty holder", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-wait-unreadable-"));
  try {
    // The incident's shape: a zero-byte lease, no record, no game - a file that could not say whether its holder was
    // alive. It is printed as what it is instead of being read as an absent owner.
    const clock = fakeClock();
    const lockPath = lockOf(root);
    mkdirSync(lockPath, { recursive: true });
    let beats = 0;
    const { lines, log } = collector();
    await waitForFixtureRootFree({
      lockPath,
      gameProcessIds: () => [],
      ownerId: () => null,
      sleep: async (ms) => {
        await clock.sleep(ms);
        beats += 1;
        if (beats < 1) return;
        rmSync(lockPath, { recursive: true, force: true });
      },
      now: clock.now,
      log,
    });

    assert.match(lines[0], /held_by=unreadable_transaction_record/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the deadline is a refusal that names the lock, its holder and its age, and it is never shortened", async () => {
  const root = mkdtempSync(join(tmpdir(), "fixture-wait-deadline-"));
  try {
    const clock = fakeClock();
    const lockPath = heldLock(root, { ageMs: 0, clock });
    const { lines, log } = collector();

    const error = await waitForFixtureRootFree({
      lockPath,
      // A live game keeps the lock for ever, so the only way out of this wait is the deadline. That is the case a
      // bounded wait must describe rather than sit in.
      gameProcessIds: () => [777],
      ownerId: () => "owner-a",
      sleep: clock.sleep,
      now: clock.now,
      log,
    }).then(
      () => assert.fail("a held lock with a live game must not be reported as free"),
      (thrown) => thrown,
    );
    assert.ok(error instanceof Error);
    assert.ok(
      error.message.startsWith(`fixture_never_became_free:${lockPath}:`),
      `expiry names the condition and the lock instead of a bare timeout: ${error.message}`,
    );
    assert.match(error.message, /held_by=transaction:owner-a\+game_pid:777:/u, "and who was holding it");
    assert.match(error.message, /:age=\d+s:waited=\d+s$/u, "and how long it had been held and waited for");
    assert.ok(lines.length > 0, "and the wait said what it was waiting for all the way to the refusal");
    assert.ok(
      FIXTURE_WAIT.deadlineMs >= 45 * 60_000,
      `deadline ${String(FIXTURE_WAIT.deadlineMs)}ms - a shorter deadline turns a hang into a failure with a smaller ` +
        "number on it instead of fixing the wait",
    );
    assert.ok(FIXTURE_WAIT.heartbeatMs <= 60_000, "a wait silent for over a minute is the failure this module answers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
