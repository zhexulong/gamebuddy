import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveGameLogs,
  readHostPositionFromLog,
  readLoopPlan,
  runMultiplayerLiveLoop,
} from "./run-stardew-native-local-player-multiplayer-live-loop-smoke.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "gb-loop-"));

test("an absent plan means observe only — the pilot does nothing by default", () => {
  const plan = readLoopPlan(null);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.durationSeconds, 0);
});

test("plan steps are validated and executed in time order", () => {
  const dir = scratch();
  try {
    const path = join(dir, "plan.json");
    writeFileSync(
      path,
      JSON.stringify({
        durationSeconds: 300,
        steps: [
          { atSeconds: 90, kind: "move", tile: { x: 39, y: 57 } },
          { atSeconds: 10, kind: "say", text: "我先去看看东边那块地。" },
          { atSeconds: 30, kind: "observe" },
        ],
      }),
    );
    const plan = readLoopPlan(path);
    assert.equal(plan.durationSeconds, 300);
    assert.deepEqual(
      plan.steps.map((step) => step.atSeconds),
      [10, 30, 90],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed plan fails closed instead of silently doing nothing", () => {
  const dir = scratch();
  try {
    const write = (value) => {
      const path = join(dir, "plan.json");
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    assert.throws(
      () => readLoopPlan(write({ steps: [{ atSeconds: 1, kind: "teleport" }] })),
      /loop_plan_step_kind_invalid/u,
    );
    assert.throws(
      () => readLoopPlan(write({ steps: [{ atSeconds: 1, kind: "say", text: "   " }] })),
      /loop_plan_say_text_invalid/u,
    );
    assert.throws(
      () => readLoopPlan(write({ steps: [{ atSeconds: 1, kind: "move", tile: { x: 1.5, y: 2 } }] })),
      /loop_plan_move_tile_invalid/u,
    );
    assert.throws(
      () => readLoopPlan(write({ steps: [{ atSeconds: -1, kind: "observe" }] })),
      /loop_plan_step_at_seconds_invalid/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the host position is read from the world's own line, or named as absent", () => {
  const dir = scratch();
  try {
    const missing = join(dir, "absent.log");
    assert.equal(readHostPositionFromLog(missing).reason, "host_log_unreadable");

    const empty = join(dir, "empty.log");
    writeFileSync(empty, "[TRACE GameBuddy] nothing about farmers here\n");
    assert.deepEqual(readHostPositionFromLog(empty), { tile: null, reason: "host_position_not_emitted" });

    const named = join(dir, "named.log");
    writeFileSync(named, "GameBuddy farmer: role=host, player_id=1, name=A, location=Farm, tile=3,4\n");
    assert.deepEqual(readHostPositionFromLog(named), { tile: { x: 3, y: 4 }, location: "Farm", reason: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the newest host line wins, so a moved player does not read as standing still", () => {
  const dir = scratch();
  try {
    const path = join(dir, "moved.log");
    writeFileSync(
      path,
      [
        "GameBuddy farmer: role=host, player_id=1, name=A, location=Farm, tile=3,4",
        "GameBuddy farmer: role=host, player_id=1, name=A, location=Farm, tile=8,9",
      ].join("\n"),
    );
    assert.deepEqual(readHostPositionFromLog(path).tile, { x: 8, y: 9 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both game logs are archived, and an unreadable one is named rather than thrown", () => {
  const dir = scratch();
  try {
    const hostLog = join(dir, "SMAPI-latest.txt");
    writeFileSync(hostLog, "host narration\n");
    const archived = archiveGameLogs({
      hostLogPath: hostLog,
      aiLogPath: join(dir, "absent.txt"),
      targetDir: join(dir, "smapi"),
    });
    assert.equal(archived.length, 2);
    assert.equal(archived[0].bytes, "host narration\n".length);
    assert.equal(readFileSync(archived[0].destination, "utf8"), "host narration\n");
    assert.equal(archived[1].destination, null);
    assert.equal(archived[1].reason, "log_unreadable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the loop refuses a topology that has no shared world to observe", async () => {
  await assert.rejects(
    () =>
      runMultiplayerLiveLoop(
        {},
        [],
        { NativeLocalPlayerFixture: { Enable: true } },
        { plan: readLoopPlan(null), traceDir: tmpdir(), durationSeconds: 0 },
      ),
    /multiplayer_live_loop_requires_farmhand_topology/u,
  );
});
