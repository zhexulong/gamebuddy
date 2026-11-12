// red-proof: fixture  a bundle whose `harvest_crop` duration is doubled against a recorded ratio -> the CLI prints
//   `action_pace_above_native_floor:harvest_crop:` naming the action, our p50 and the floor, exit 1
//   (tools/perf/action-pace.test.mjs)
/**
 * The game-action performance standard's own checks.
 *
 * Three questions, three groups: do the declared constants say where they came from; does one
 * action's floor come out of the engine's own animation branches; and does the gate name the action
 * when a real measurement crosses the recorded ratio. The last one is driven twice - once with a
 * fixture bundle whose duration is doubled, and once against this checkout's own `.live-runs`
 * bundles when they exist - because a gate only proves it can fire on a reading it produced.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACTION_PACE_TOLERANCE,
  ANIMATION_CLASS,
  actionAnimationClasses,
  actionPaceRecord,
  animationClassOf,
  assertDeclaredConstants,
  CHANNEL_PREFERENCE,
  compareActionPace,
  DECLARED_CONSTANTS,
  GAME_SIDE_INTERVAL,
  measureActionPace,
  nativeFloorMs,
  paceBound,
  paceLine,
  percentile,
  renderActionPace,
  TICK_MS,
  TRACE_ONLY_ACTIONS,
  WALK_MS_PER_TILE,
} from "../lib/action-pace.mjs";

const gatePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "check-perf-budget.mjs");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("every declared constant names the line it came from, and an unsourced one is refused", () => {
  assert.equal(assertDeclaredConstants(), Object.keys(DECLARED_CONSTANTS).length);
  for (const [name, declared] of Object.entries(DECLARED_CONSTANTS)) {
    assert.match(declared.source.file, /\S/u, `${name} must name a file`);
    assert.equal(typeof declared.value, "number");
  }
  // The one step that is a framework fact, not a Stardew constant, says so in its own source.
  assert.match(DECLARED_CONSTANTS.ELAPSED_MS_PER_TICK.source.file, /^System\.TimeSpan\.Milliseconds$/u);
  assert.throws(() => assertDeclaredConstants({ SOME_MS: { value: 12 } }), /action_pace_constant_unsourced:SOME_MS/u);
  assert.throws(
    () => assertDeclaredConstants({ SOME_MS: { value: 12, source: { invented: "it felt right" } } }),
    /action_pace_constant_invented:SOME_MS:it felt right/u,
  );
});

test("the walk is derived from the engine's own speed, multiplier and tick, not chosen", () => {
  // 64 px tile / (2 px/tick * 0.066 * 16 ms) * (1000/60 ms per tick)
  const expected = (64 / (2 * 0.066 * 16)) * (1000 / 60);
  assert.equal(WALK_MS_PER_TILE, expected);
  assert.ok(Math.abs(WALK_MS_PER_TILE - 505) < 1, `walk should read ~505 ms/tile, read ${WALK_MS_PER_TILE}`);
  assert.ok(Math.abs(TICK_MS.value - 16.6667) < 0.001);
});

test("one swing, one tile of work, and the engine's own branches decide the floor", () => {
  assert.equal(nativeFloorMs({ action: "till_soil" }), 480, "one hoe swing is 8 frames x 60 ms");
  assert.equal(nativeFloorMs({ action: "till_soil", tiles: 2 }), 960);
  assert.ok(
    Math.abs(nativeFloorMs({ action: "till_soil", tiles: 1, distance: 3 }) - (480 + 3 * WALK_MS_PER_TILE)) < 1e-9,
  );
  assert.equal(nativeFloorMs({ action: "water_crop" }), 375, "the can animates 3 frames x 125 ms");
  assert.equal(nativeFloorMs({ action: "harvest_crop" }), TICK_MS.value, "a hand pick has no animation gate");
  assert.ok(
    Math.abs(nativeFloorMs({ action: "move_to_tile" }) - WALK_MS_PER_TILE) < 1e-9,
    "movement's work IS the walk",
  );
  assert.equal(nativeFloorMs({ action: "sleep" }), null, "no engine constant exists, and null is not zero");
  assert.throws(
    () => nativeFloorMs({ action: "not_an_action", classes: new Map() }),
    /action_pace_unclassified_action/u,
  );
});

test("the class table's population is the Mod's action catalogue, not a list of five actions", () => {
  const classes = actionAnimationClasses();
  // The catalogue is read from the Mod's registrations; every action in it resolves to a class.
  assert.ok(classes.size > 100, `expected the whole catalogue, got ${classes.size}`);
  for (const [actionId, className] of classes) {
    assert.ok(className in ANIMATION_CLASS, `${actionId} resolved to unknown class ${className}`);
  }
  assert.equal(animationClassOf("till_soil", classes), "toolSwing");
  assert.equal(animationClassOf("respond_level_up", classes), "unpriced");
  assert.equal(animationClassOf("plant_seed", classes), "hand", "unlisted catalogue actions take the hand default");

  // A class entry that names an id nobody registers is refused, and the id is printed.
  assert.throws(
    () => actionAnimationClasses({ exceptions: { toolSwing: ["a_retired_action"] } }),
    /action_pace_classifies_unknown_action:toolSwing:a_retired_action/u,
  );
  // One action in two classes is a disagreement about the same work, not last-wins.
  assert.throws(
    () => actionAnimationClasses({ exceptions: { toolSwing: ["till_soil"], hand: ["till_soil"] } }),
    /action_pace_action_in_two_classes:till_soil:toolSwing:hand/u,
  );
});

test("percentiles are nearest-rank and an empty list is unknown, never zero", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.5), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95), 19);
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
});

test("the game-side interval is named once, and the receipt chain is the channel the verdict reads", () => {
  // No channel contains a model step: the dispatch is taken before the call and the settle after the
  // receipt, so prompt assembly, provider latency and think time are outside by construction rather
  // than subtracted afterwards.
  assert.equal(GAME_SIDE_INTERVAL.receipts.start, "timeline[].atMs of the execution's first receipt");
  assert.equal(GAME_SIDE_INTERVAL.receipts.end, "timeline[].atMs of the execution's terminal receipt");
  assert.match(GAME_SIDE_INTERVAL.receipts.distance, /tile_advanced/u);
  assert.equal(GAME_SIDE_INTERVAL.flat.start, "actionTrace[].dispatchedAtMs");
  assert.equal(GAME_SIDE_INTERVAL.flat.end, "actionTrace[].settledAtMs");
  assert.equal(GAME_SIDE_INTERVAL.program.start, "result.programOutcomes[].executions[].atMs");
  assert.equal(GAME_SIDE_INTERVAL.program.end, "result.programOutcomes[].executions[].settledAtMs");
  // The receipts channel is preferred because it is the only one that carries the DISTANCE beside the
  // duration; a channel that cannot see the walk cannot price it, and pricing it at zero is what
  // accused `harvest_crop` of 135x the engine.
  assert.deepEqual(CHANNEL_PREFERENCE, ["receipts", "program", "flat"]);
  for (const channel of CHANNEL_PREFERENCE)
    assert.ok(GAME_SIDE_INTERVAL[channel] !== undefined, `${channel} must name its own stamps`);
});

test("a trace id that is not a catalogue action is declared, never dropped", () => {
  const classes = actionAnimationClasses();
  for (const [actionId, declared] of Object.entries(TRACE_ONLY_ACTIONS)) {
    assert.equal(animationClassOf(actionId, classes), declared.class, `${actionId} must keep its declared class`);
    assert.match(declared.reason, /\S/u, `${actionId} must say what it stands for`);
  }
  assert.equal(animationClassOf("break_rock_source", classes), "toolSwing");
  assert.equal(animationClassOf("chop_tree_source", classes), "toolSwing");
  // One line a reader can compare across actions, pinned so the format cannot drift unnoticed.
  assert.equal(
    paceLine({
      action: "harvest_crop",
      animationClass: "hand",
      channel: "receipts",
      instances: 98,
      oursMs: 2232,
      oursP95Ms: 4360,
      walkTiles: 10,
      floorMs: 5067.17,
      ratio: 0.44,
    }),
    "action_pace: harvest_crop · tiles 1 + walk 10 tiles · ours p50 2232ms p95 4360ms · floor 5067.17ms (hand, n=98 on receipts) · ratio 0.44",
  );
  // A row whose channel recorded no walk says nothing about one.
  assert.doesNotMatch(
    paceLine({
      action: "till_soil",
      animationClass: "toolSwing",
      channel: "receipts",
      instances: 128,
      oursMs: 103,
      oursP95Ms: 1404,
      walkTiles: 0,
      floorMs: 480,
      ratio: 0.21,
    }),
    /walk/u,
  );
});

/** One bundle root holding every channel, in the shapes the artifacts really have. */
async function fixtureBundle({ flat = [], program = [], timeline = [], flatRejected = 0 } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-action-pace-"));
  const bundle = join(root, ".live-runs", "bundle-a");
  await mkdir(bundle, { recursive: true });
  if (flat.length > 0 || flatRejected > 0) {
    const rows = flat.map((row) => ({
      via: "flat",
      action: row.action,
      requestId: `req-${row.action}-${row.ms}`,
      state: row.state ?? "succeeded",
      dispatchedAtMs: 1_700_000_000_000,
      settledAtMs: 1_700_000_000_000 + row.ms,
    }));
    for (let index = 0; index < flatRejected; index += 1)
      rows.push({
        via: "flat",
        action: "till_soil",
        state: "rejected",
        reasonCode: "out_of_range",
        dispatchedAtMs: 1,
        settledAtMs: 400,
      });
    await writeFile(join(bundle, "actionTrace.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  if (program.length > 0) {
    const executions = program.map((row, index) => ({
      nodeId: `n${index}`,
      nodeAttempt: 1,
      cursor: index,
      atMs: 100 * index,
      settledAtMs: 100 * index + row.ms,
    }));
    const nodeOutcomes = program.map((row, index) => ({
      nodeId: `n${index}`,
      actionId: row.action,
      state: "succeeded",
    }));
    await writeFile(
      join(bundle, "result.json"),
      `${JSON.stringify({ programOutcomes: [{ programId: "plan_fixture", accepted: true, observed: true, executions, nodeOutcomes }] })}\n`,
    );
  }
  if (timeline.length > 0) {
    const rows = [];
    for (const [index, row] of timeline.entries()) {
      const executionId = `exec-${index}`;
      const base = 1_700_000_000_000 + 10_000 * index;
      rows.push({
        atMs: base,
        type: "semantic_event",
        worldFactPayload: { bodyTrace: { category: "execution_started", executionId } },
      });
      for (let tile = 0; tile < row.tiles; tile += 1)
        rows.push({ atMs: base + 1 + tile, type: "execution_receipt", reasonCode: "tile_advanced", executionId });
      rows.push({
        atMs: base + row.ms,
        type: "execution_receipt",
        reasonCode: "settled",
        executionId,
        worldFactPayload: { executionId, actionId: row.action, state: row.state ?? "succeeded" },
      });
    }
    await writeFile(join(bundle, "timeline.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  return root;
}

test("the measurement reads every channel and reads the receipt chain where it can", async () => {
  const root = await fixtureBundle({
    flat: [{ action: "till_soil", ms: 900 }],
    program: [
      { action: "till_soil", ms: 240 },
      { action: "harvest_crop", ms: 2000 },
    ],
    flatRejected: 3,
  });
  try {
    const measurement = measureActionPace({ bundleRoot: join(root, ".live-runs") });
    assert.equal(measurement.status, "measured");
    assert.equal(measurement.actionTraceFiles, 1);
    assert.equal(
      measurement.timelineFiles,
      0,
      "an older bundle has no receipt chain, and that is a fallback not a zero",
    );
    assert.equal(measurement.resultFiles, 1);
    assert.equal(measurement.timedInstances, 3, "one flat row and two program rows");
    assert.equal(measurement.examinedInstances, 2, "the verdict reads one channel per action");
    assert.equal(measurement.rejectedInstances, 3, "a refusal closes a wait, it is counted and excluded");

    const till = measurement.rows.find((row) => row.action === "till_soil");
    assert.equal(till.channel, "program", "with no receipt chain, the Mod's journal span is the verdict");
    assert.equal(till.oursMs, 240);
    assert.equal(till.channels.length, 2, "every channel stays visible beside the one the verdict reads");
    assert.equal(till.walkTiles, 0, "a channel that cannot see the walk records none");
    assert.equal(till.floorMs, 480, "so its floor stays one swing");
    assert.equal(till.ratio, 0.5);

    const harvest = measurement.rows.find((row) => row.action === "harvest_crop");
    assert.equal(harvest.floorMs, 16.67);
    assert.ok(harvest.ratio > 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the walk the receipts recorded is charged to the floor, and the ratio moves for that reason", async () => {
  // The same action, the same duration, recorded once with ten tiles of route inside it and
  // once with none. Only the floor may differ, and it must differ by exactly ten tiles.
  const walked = await fixtureBundle({ timeline: [{ action: "harvest_crop", ms: 2200, tiles: 10 }] });
  const inRange = await fixtureBundle({ timeline: [{ action: "harvest_crop", ms: 2200, tiles: 0 }] });
  const tillWalked = await fixtureBundle({ timeline: [{ action: "till_soil", ms: 900, tiles: 2 }] });
  const tillInRange = await fixtureBundle({ timeline: [{ action: "till_soil", ms: 900, tiles: 0 }] });
  try {
    const harvest = measureActionPace({ bundleRoot: join(walked, ".live-runs") }).rows[0];
    assert.equal(harvest.channel, "receipts");
    assert.equal(harvest.walkTiles, 10);
    assert.equal(harvest.floorMs, 5067.17, "one hand tick plus ten recorded tiles at the engine's walk");
    assert.equal(harvest.ratio, 0.43);

    const flatHarvest = measureActionPace({ bundleRoot: join(inRange, ".live-runs") }).rows[0];
    assert.equal(flatHarvest.walkTiles, 0);
    assert.equal(flatHarvest.floorMs, 16.67);
    assert.equal(flatHarvest.ratio, 132, "the same 2200 ms against a floor that forgot the walk is 132x");

    // The walk is the ACTION's, not a property of its class: till_soil's floor moves when its own
    // receipts record a walk and stays put when they do not.
    const till = measureActionPace({ bundleRoot: join(tillWalked, ".live-runs") }).rows[0];
    assert.equal(till.floorMs, 1490.1);
    const stillTill = measureActionPace({ bundleRoot: join(tillInRange, ".live-runs") }).rows[0];
    assert.equal(stillTill.floorMs, 480);
    assert.equal(stillTill.ratio, 1.88);
  } finally {
    for (const root of [walked, inRange, tillWalked, tillInRange]) await rm(root, { recursive: true, force: true });
  }
});

test("an accepted dispatch is a wait, not a duration, and an unsettled execution is not a zero", async () => {
  const root = await fixtureBundle({
    flat: [
      { action: "move_to_tile", ms: 25, state: "accepted" },
      { action: "move_to_tile", ms: 1400, state: "succeeded" },
      { action: "break_rock_source", ms: 35, state: "accepted" },
    ],
  });
  try {
    const measurement = measureActionPace({ bundleRoot: join(root, ".live-runs") });
    const move = measurement.rows.find((row) => row.action === "move_to_tile");
    assert.equal(move.instances, 1, "only the settled dispatch is a duration");
    assert.equal(move.oursMs, 1400);
    assert.equal(
      measurement.rows.some((row) => row.action === "break_rock_source"),
      false,
    );
    assert.equal(measurement.unattributedInstances, 2, "the two accepted rows closed a handshake");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a doubled duration names the action, and the bound is the recorded ratio plus tolerance", async () => {
  const root = await fixtureBundle({ program: [{ action: "harvest_crop", ms: 2000 }] });
  try {
    const bundles = join(root, ".live-runs");
    const recorded = actionPaceRecord({ measurement: measureActionPace({ bundleRoot: bundles }) });
    assert.equal(recorded.actions.harvest_crop.ratio, 120);
    assert.equal(recorded.actions.harvest_crop.walkTiles, 0);
    // The bound carries one quantum of the floor's own resolution: a 1 ms stamp cannot bound
    // itself to zero, or the next reading of an instant action is a false regression.
    assert.equal(paceBound(recorded.actions.harvest_crop), (120 + 1 / 16.67) * (1 + ACTION_PACE_TOLERANCE));

    const inBudget = renderActionPace({
      measurement: measureActionPace({ bundleRoot: bundles }),
      verdict: compareActionPace({ measurement: measureActionPace({ bundleRoot: bundles }), baseline: recorded }),
      bundleRoot: bundles,
    });
    assert.equal(inBudget.failed, false);
    assert.match(inBudget.lines.at(-1), /^action_pace_ok examined=1 priced=1 unpriced=0/u);

    // The injected violation: the same action, twice as slow.
    const doubled = await fixtureBundle({ program: [{ action: "harvest_crop", ms: 4000 }] });
    try {
      const measurement = measureActionPace({ bundleRoot: join(doubled, ".live-runs") });
      const verdict = compareActionPace({ measurement, baseline: recorded });
      const rendered = renderActionPace({ measurement, verdict, bundleRoot: join(doubled, ".live-runs") });
      assert.equal(verdict.above.length, 1);
      assert.equal(verdict.above[0].row.action, "harvest_crop");
      assert.equal(rendered.failed, true);
      assert.match(
        rendered.lines.join("\n"),
        /^action_pace_above_native_floor:harvest_crop:240:4000:16\.67 p95 4000ms n=1 on program \(recorded ratio 120, bound 180\.09\)$/mu,
      );
    } finally {
      await rm(doubled, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nothing to measure today is blocked, and bundles with no durations are a defect", async () => {
  const empty = await fixtureBundle({});
  try {
    const missing = measureActionPace({ bundleRoot: join(empty, "no-such-root") });
    assert.equal(missing.status, "no_bundle_root");
    const rendered = renderActionPace({
      measurement: missing,
      verdict: compareActionPace({ measurement: missing, baseline: {} }),
      bundleRoot: "/nowhere",
    });
    assert.equal(rendered.failed, false, "no artifacts in this tree is not a regression");
    assert.match(rendered.lines.join("\n"), /^action_pace_blocked: no_bundle_root at /mu);
    assert.doesNotMatch(rendered.lines.join("\n"), /action_pace_ok/u);

    const silent = measureActionPace({ bundleRoot: join(empty, ".live-runs") });
    assert.equal(silent.status, "no_durations", "the root exists and holds no bundle");
    const silentRender = renderActionPace({
      measurement: silent,
      verdict: compareActionPace({ measurement: silent, baseline: {} }),
      bundleRoot: join(empty, ".live-runs"),
    });
    assert.equal(silentRender.failed, true, "bundles that exist and carry no timed action are a defect");
    assert.match(silentRender.lines.join("\n"), /^action_pace_blocked: runs_carry_no_action_durations /mu);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("an unrecorded action, a vanished recording and an unclassified trace id all fail", async () => {
  const root = await fixtureBundle({
    flat: [{ action: "an_unclassified_thing", ms: 50 }],
    program: [{ action: "till_soil", ms: 240 }],
  });
  try {
    const measurement = measureActionPace({ bundleRoot: join(root, ".live-runs") });
    const verdict = compareActionPace({ measurement, baseline: { actions: { gone_action: { ratio: 1 } } } });
    assert.deepEqual(
      verdict.unknown.map((row) => row.action),
      ["an_unclassified_thing"],
    );
    assert.deepEqual(
      verdict.unrecorded.map((row) => row.action),
      ["till_soil"],
    );
    assert.deepEqual(verdict.missing, ["gone_action"]);
    const rendered = renderActionPace({ measurement, verdict, bundleRoot: join(root, ".live-runs") });
    assert.equal(rendered.failed, true);
    const text = rendered.lines.join("\n");
    assert.match(text, /^action_pace_failed above=0 unrecorded=1 missing=1 unknown=1 /mu);
    assert.match(text, /^action_pace_unknown_action: an_unclassified_thing /mu);
    assert.match(text, /^action_pace_unrecorded: till_soil /mu);
    assert.match(text, /^action_pace_missing: gone_action /mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the CLI names the action and exits 1 on a bundle that doubled", async () => {
  const root = await fixtureBundle({
    program: [
      { action: "till_soil", ms: 240 },
      { action: "harvest_crop", ms: 2000 },
    ],
  });
  try {
    const bundles = join(root, ".live-runs");
    const recorded = actionPaceRecord({ measurement: measureActionPace({ bundleRoot: bundles }) });
    await mkdir(join(root, "tools", "perf"), { recursive: true });
    await writeFile(join(root, "tools", "perf", "action-pace-baseline.json"), `${JSON.stringify(recorded, null, 2)}\n`);

    const inBudget = execFileSync(
      process.execPath,
      [gatePath, "--root", root, "--bundles", bundles, "--action-pace-only"],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.match(inBudget, /^action_pace_population: /mu);
    assert.match(inBudget, /^action_pace_ok examined=2 priced=2 /mu);

    // The injected violation: `harvest_crop` alone is twice as slow.
    const doubled = await fixtureBundle({
      program: [
        { action: "till_soil", ms: 240 },
        { action: "harvest_crop", ms: 4000 },
      ],
    });
    try {
      let failure;
      try {
        execFileSync(
          process.execPath,
          [gatePath, "--root", root, "--bundles", join(doubled, ".live-runs"), "--action-pace-only"],
          { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.status, 1, "an action past its recorded ratio must fail the gate");
      assert.match(failure.stdout, /^action_pace_above_native_floor:harvest_crop:240:4000:16\.67 /mu);
      assert.doesNotMatch(failure.stdout, /^action_pace_ok /mu);
    } finally {
      await rm(doubled, { recursive: true, force: true });
    }

    // The other injected violation, and the one this change exists for: the SAME duration with
    // the walk missing from the receipt chain. The floor loses the ten tiles it was paying for, so
    // an action that was inside its bound becomes 132x its floor and the gate names it.
    const walked = await fixtureBundle({ timeline: [{ action: "harvest_crop", ms: 2200, tiles: 10 }] });
    const walkedBundles = join(walked, ".live-runs");
    try {
      const walkedRecord = actionPaceRecord({ measurement: measureActionPace({ bundleRoot: walkedBundles }) });
      await writeFile(
        join(root, "tools", "perf", "action-pace-baseline.json"),
        `${JSON.stringify(walkedRecord, null, 2)}\n`,
      );
      const clean = execFileSync(
        process.execPath,
        [gatePath, "--root", root, "--bundles", walkedBundles, "--action-pace-only"],
        { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      assert.match(clean, /^action_pace_ok examined=1 priced=1 /mu);

      const unwalked = await fixtureBundle({ timeline: [{ action: "harvest_crop", ms: 2200, tiles: 0 }] });
      try {
        let failure;
        try {
          execFileSync(
            process.execPath,
            [gatePath, "--root", root, "--bundles", join(unwalked, ".live-runs"), "--action-pace-only"],
            { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch (error) {
          failure = error;
        }
        assert.equal(failure?.status, 1, "the walk is what keeps harvest_crop inside its bound");
        assert.match(failure.stdout, /^action_pace_above_native_floor:harvest_crop:132:2200:16\.67 /mu);
      } finally {
        await rm(unwalked, { recursive: true, force: true });
      }
    } finally {
      await rm(walked, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "a real bundle replays as ratios, not as a pass",
  { skip: !existsSync(join(repositoryRoot, ".live-runs")) },
  () => {
    const stdout = execFileSync(process.execPath, [gatePath, "--action-pace-only"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(
      stdout,
      /^action_pace_population: bundleRoot=.* actionTraceFiles=[1-9]\d* timelineFiles=[1-9]\d* resultFiles=[1-9]\d* /mu,
    );
    assert.match(stdout, /^action_pace_ok examined=[1-9]\d* priced=[1-9]\d* /mu);
    // The tool families sit at the engine's own swing; a hand pick does not, and the line says so.
    const till =
      /^action_pace: till_soil · tiles 1 · ours p50 ([\d.]+)ms p95 [\d.]+ms · floor 480ms \(toolSwing, n=\d+ on \w+\) · ratio ([\d.]+)$/mu.exec(
        stdout,
      );
    assert.ok(till, "till_soil records no walk at the median, so it is still priced against the 480 ms hoe swing");
    assert.equal(Number(till[2]), Math.round((Number(till[1]) / 480) * 100) / 100);
    // The hand pick was accused of 135x while the floor forgot the walk it performs; the tiles hit
    // walked are named on the same line, and the floor is the sum of the two components.
    const harvest =
      /^action_pace: harvest_crop · tiles 1 \+ walk (\d+) tiles · ours p50 ([\d.]+)ms p95 [\d.]+ms · floor ([\d.]+)ms \(hand, n=\d+ on receipts\) · ratio ([\d.]+)$/mu.exec(
        stdout,
      );
    assert.ok(harvest, "harvest_crop's line must name the walk it charges to its floor");
    assert.ok(Number(harvest[1]) > 1, "a self-walked action records the tiles it walked");
    assert.equal(
      Number(harvest[3]),
      Math.round(nativeFloorMs({ action: "harvest_crop", distance: Number(harvest[1]) }) * 100) / 100,
      "the floor is one hand tick plus the tiles on the same line, at the engine's own walk",
    );
    assert.ok(Number(harvest[4]) < 1, "an action that mostly walks is engine-dominated, not 135x the engine");
    // Actions the engine declares no constant for are a named gap on every run, never a silent drop.
    assert.match(stdout, /^action_pace_unpriced: sleep \(unpriced\) /mu);
  },
);
