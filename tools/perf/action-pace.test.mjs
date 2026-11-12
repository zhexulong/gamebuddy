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

test("the game-side interval is named once, and the Mod's own clock is the one the verdict reads", () => {
  // Neither stamp pair contains a model step: the dispatch is taken before the bridge call and the
  // settle after the receipt, so prompt assembly, provider latency and think time are outside by
  // construction rather than subtracted afterwards.
  assert.equal(GAME_SIDE_INTERVAL.flat.start, "actionTrace[].dispatchedAtMs");
  assert.equal(GAME_SIDE_INTERVAL.flat.end, "actionTrace[].settledAtMs");
  assert.equal(GAME_SIDE_INTERVAL.program.start, "result.programOutcomes[].executions[].atMs");
  assert.equal(GAME_SIDE_INTERVAL.program.end, "result.programOutcomes[].executions[].settledAtMs");
  assert.equal(GAME_SIDE_INTERVAL.preferred, "program");
});

test("a trace id that is not a catalogue action is declared, never dropped", () => {
  const classes = actionAnimationClasses();
  for (const [actionId, declared] of Object.entries(TRACE_ONLY_ACTIONS)) {
    assert.equal(animationClassOf(actionId, classes), declared.class, `${actionId} must keep its declared class`);
    assert.match(declared.reason, /\S/u, `${actionId} must say what it stands for`);
  }
  assert.equal(animationClassOf("break_rock_source", classes), "toolSwing");
  // One line a reader can compare across actions, pinned so the format cannot drift unnoticed.
  assert.equal(
    paceLine({
      action: "till_soil",
      animationClass: "toolSwing",
      channel: "program",
      instances: 103,
      oursMs: 138,
      oursP95Ms: 1450,
      floorMs: 480,
      ratio: 0.29,
    }),
    "action_pace: till_soil · tiles 1 · ours p50 138ms p95 1450ms · floor 480ms (toolSwing, n=103 on program) · ratio 0.29",
  );
});

/** One bundle root holding both channels, in the shapes the artifacts really have. */
async function fixtureBundle({ flat = [], program = [], flatRejected = 0 } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-action-pace-"));
  const bundle = join(root, ".live-runs", "bundle-a");
  await mkdir(bundle, { recursive: true });
  if (flat.length > 0 || flatRejected > 0) {
    const rows = flat.map((row) => ({
      via: "flat",
      action: row.action,
      requestId: `req-${row.action}-${row.ms}`,
      state: "succeeded",
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
  return root;
}

test("the measurement reads both channels and prefers the Mod's own clock", async () => {
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
    assert.equal(measurement.resultFiles, 1);
    assert.equal(measurement.timedInstances, 3, "one flat row and two program rows");
    assert.equal(measurement.examinedInstances, 2, "the verdict reads one channel per action");
    assert.equal(measurement.rejectedInstances, 3, "a refusal closes a wait, it is counted and excluded");

    const till = measurement.rows.find((row) => row.action === "till_soil");
    assert.equal(till.channel, "program", "when both channels answer, the Mod's own stamps are the verdict");
    assert.equal(till.oursMs, 240);
    assert.equal(till.channels.length, 2, "both channels stay visible beside the one the verdict reads");
    assert.equal(till.ratio, 0.5);

    const harvest = measurement.rows.find((row) => row.action === "harvest_crop");
    assert.equal(harvest.floorMs, 16.67);
    assert.ok(harvest.ratio > 100);
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
    assert.equal(paceBound(recorded.actions.harvest_crop), 120 * (1 + ACTION_PACE_TOLERANCE));

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
        /^action_pace_above_native_floor:harvest_crop:240:4000:16\.67 p95 4000ms n=1 on program \(recorded ratio 120, bound 180\.00\)$/mu,
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
    assert.match(stdout, /^action_pace_population: bundleRoot=.* actionTraceFiles=[1-9]\d* resultFiles=[1-9]\d* /mu);
    assert.match(stdout, /^action_pace_ok examined=[1-9]\d* priced=[1-9]\d* /mu);
    // The tool families sit at the engine's own swing; a hand pick does not, and the line says so.
    const till =
      /^action_pace: till_soil · tiles 1 · ours p50 ([\d.]+)ms p95 [\d.]+ms · floor 480ms \(toolSwing, n=\d+ on \w+\) · ratio ([\d.]+)$/mu.exec(
        stdout,
      );
    assert.ok(till, "till_soil must be priced against the 480 ms hoe swing");
    assert.equal(Number(till[2]), Math.round((Number(till[1]) / 480) * 100) / 100);
    assert.match(
      stdout,
      /^action_pace: harvest_crop · tiles 1 · ours p50 [\d.]+ms p95 [\d.]+ms · floor 16\.67ms \(hand, /mu,
    );
    // Actions the engine declares no constant for are a named gap on every run, never a silent drop.
    assert.match(stdout, /^action_pace_unpriced: sleep \(unpriced\) /mu);
  },
);
