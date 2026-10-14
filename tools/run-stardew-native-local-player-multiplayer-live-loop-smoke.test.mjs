import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  archiveGameLogs,
  readAgentTurnsFromSession,
  readHostPositionFromLog,
  readLoopPlan,
  runMultiplayerLiveLoop,
} from "./run-stardew-native-local-player-multiplayer-live-loop-smoke.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "gb-loop-"));
const writePlan = (dir, value) => {
  const path = join(dir, "plan.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};

test("an absent plan means observe only — the pilot does nothing by default", () => {
  const plan = readLoopPlan(null);
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.durationSeconds, 0);
});

test("a step names ANY action from the farmhand's surface, with its typed args", () => {
  const dir = scratch();
  try {
    // One step per action FAMILY, because the point is that the plan speaks the whole published surface rather
    // than a hand-picked few.
    const path = writePlan(dir, {
      durationSeconds: 600,
      steps: [
        { atSeconds: 5, action: "harvest_crop", args: { targetRef: "sr1_AAAAAAAAAAAAAAAA" } },
        {
          atSeconds: 20,
          action: "chest_retrieve",
          args: { targetRef: "sr1_BBBBBBBBBBBBBBBB", expectedQualifiedItemId: "(O)24" },
        },
        { atSeconds: 40, action: "chop_stump", args: {} },
        { atSeconds: 60, action: "plant_sapling", args: { targetRef: "sr1_CCCCCCCCCCCCCCCC" } },
        { atSeconds: 90, action: "cut_weeds", args: {} },
        { atSeconds: 120, action: "scythe_crop", args: {} },
        { atSeconds: 150, action: "npc_relationship", args: {} },
        { atSeconds: 180, action: "send_multiplayer_chat", args: { text: "我把东边那块地收了。" } },
        { atSeconds: 210, action: "move_to_tile", args: { x: 39, y: 57 } },
      ],
    });
    const plan = readLoopPlan(path);
    assert.equal(plan.steps.length, 9);
    assert.deepEqual(
      plan.steps.map((step) => step.action),
      [
        "harvest_crop",
        "chest_retrieve",
        "chop_stump",
        "plant_sapling",
        "cut_weeds",
        "scythe_crop",
        "npc_relationship",
        "send_multiplayer_chat",
        "move_to_tile",
      ],
    );
    assert.deepEqual(plan.steps[1].args, { targetRef: "sr1_BBBBBBBBBBBBBBBB", expectedQualifiedItemId: "(O)24" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("steps run in time order regardless of how they were written", () => {
  const dir = scratch();
  try {
    const path = writePlan(dir, {
      durationSeconds: 300,
      steps: [
        { atSeconds: 90, action: "cut_weeds" },
        { atSeconds: 10, action: "move_to_tile", args: { x: 1, y: 2 } },
        { atSeconds: 30, action: "harvest_crop" },
      ],
    });
    assert.deepEqual(
      readLoopPlan(path).steps.map((step) => step.atSeconds),
      [10, 30, 90],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed step fails closed at READ time, before any game launch", () => {
  const dir = scratch();
  try {
    assert.throws(() => readLoopPlan(writePlan(dir, { steps: [{ atSeconds: 1 }] })), /loop_plan_action_id_invalid/u);
    assert.throws(
      () => readLoopPlan(writePlan(dir, { steps: [{ atSeconds: 1, action: "Harvest Crop" }] })),
      /loop_plan_action_id_invalid/u,
    );
    assert.throws(
      () => readLoopPlan(writePlan(dir, { steps: [{ atSeconds: 1, action: "harvest_crop", args: [1] }] })),
      /loop_plan_action_args_invalid/u,
    );
    assert.throws(
      () => readLoopPlan(writePlan(dir, { steps: [{ atSeconds: -1, action: "harvest_crop" }] })),
      /loop_plan_step_at_seconds_invalid/u,
    );
    assert.throws(() => readLoopPlan(writePlan(dir, { steps: ["harvest_crop"] })), /loop_plan_step_invalid/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the host position is read from the world's own line, or named as absent", () => {
  const dir = scratch();
  try {
    assert.equal(readHostPositionFromLog(join(dir, "absent.log")).reason, "host_log_unreadable");

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

test("the rubric grades the AGENT's turns, and an absent transcript measures nothing", () => {
  const dir = scratch();
  try {
    // No transcript: the rubric must report unmeasured rather than pass vacuously.
    assert.deepEqual(readAgentTurnsFromSession(null), []);
    assert.deepEqual(readAgentTurnsFromSession(join(dir, "missing.jsonl")), []);

    const session = join(dir, "session.jsonl");
    writeFileSync(
      session,
      [
        JSON.stringify({ type: "message", role: "user", content: [{ type: "text", text: "今天想做点什么？" }] }),
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "我先去看看东边那块地。" },
            { type: "tool_use", name: "stardew_observe" },
          ],
        }),
        JSON.stringify({
          type: "message",
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "收完了，要不要一起去河边？" }],
        }),
      ].join("\n"),
    );
    const turns = readAgentTurnsFromSession(session);
    // Only the assistant's TEXT is speech: the player's line and the tool_use part are not.
    assert.equal(turns.length, 2);
    assert.equal(turns[0].text, "我先去看看东边那块地。");
    assert.equal(turns[1].text, "收完了，要不要一起去河边？");
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
