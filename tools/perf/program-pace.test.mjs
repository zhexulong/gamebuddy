// red-proof: fixture  a bundle whose three 10-node programs each take 4x their native floor -> the CLI prints
//   `program_pace_above_native_floor:4:1` with the population AND names the program and the node that held it, exit 1
//   (tools/perf/program-pace.test.mjs)
// red-proof: fixture  the same healthy schedules with their wall clocks doubled -> `program_pace_above_native_floor:0.68:0.6`,
//   exit 1, while every `round94`-`round99` bundle stays green at that same 0.6 (tools/perf/program-pace.test.mjs)
// red-proof: history  `round99`'s own programs -> `program_pace_ok examined=10 ratio=0.34`, so the gate can be green
//   on a run that really happened, and the reading prints `walk=lattice_lower_bound` because the walk it charges is
//   a lower bound on the route (tools/perf/program-pace.test.mjs)
/**
 * Program pace's own checks: does the floor come out of the run's own node tiles, are the programs it cannot
 * price excluded BY NAME rather than silently dropped, does a dense program fail the gate while an honest
 * run passes it, and does every reading name the program that held it.
 *
 * The parts of a program's reading are asserted one at a time (`priceProgram`) before the aggregate, because the
 * aggregate is a sum and a sum can be right for the wrong reason: a lattice walk charged to the wrong node, or a
 * transit program priced across a warp, would move the total without any single assertion noticing. The member
 * lines are asserted for the same reason - an aggregate that fails while naming the wrong program is a reading
 * a lane cannot act on.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nativeFloorMs, WALK_MS_PER_TILE } from "../lib/action-pace.mjs";
import {
  bundleDirectories,
  compareProgramPace,
  measureProgramPace,
  PROGRAM_PACE_CEILING,
  PROGRAM_PACE_MEMBERS,
  PROGRAM_PACE_POPULATION_FLOOR,
  PROGRAM_PACE_WALK,
  priceProgram,
  programsOf,
  renderProgramPace,
} from "../lib/program-pace.mjs";

const gatePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "gates", "data", "check-perf-budget.mjs");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LADDER = join(repositoryRoot, ".live-runs", "game-ladder");
const ROUND_99 = join(LADDER, "2026-11-24T09-55-06-982Z-multiday_routine");

const node = (nodeId, actionId, tile, state = "succeeded") => ({ nodeId, actionId, tile, state });
const program = (programId, nodes, wallMs) => ({
  programId,
  startMs: 0,
  wallMs,
  nodes: nodes.map((entry) => ({ nodeId: entry.nodeId, actionId: entry.actionId, tile: entry.tile ?? null })),
});

/** One bundle directory holding a `result.json` and a `programTrace.jsonl`, in a fresh temporary root. */
async function bundleOf(root, name, { programs, traceStrideMs = 100 }) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const programOutcomes = programs.map((entry) => ({
    programId: entry.programId,
    nodeOutcomes: entry.nodes.map((item, index) => ({
      nodeId: item.nodeId,
      actionId: item.actionId,
      state: item.state ?? "succeeded",
      ...(item.tile === null ? {} : { tile: item.tile }),
      order: index,
    })),
  }));
  const trace = [];
  for (const entry of programs) {
    entry.nodes.forEach((item, index) => {
      trace.push({
        programId: entry.programId,
        nodeId: item.nodeId,
        nodeAttempt: 1,
        atMs: traceStrideMs * index,
        settledAtMs: traceStrideMs * index + 1,
      });
    });
    // The wall clock belongs to the LAST node's settle, so it is stamped separately from the stride.
    trace[trace.length - 1].settledAtMs = entry.wallMs;
  }
  await writeFile(join(directory, "result.json"), `${JSON.stringify({ programOutcomes }, null, 2)}\n`);
  await writeFile(join(directory, "programTrace.jsonl"), trace.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return directory;
}

test("a priced program says which span held it: one slow node, or the idle between two of them", () => {
  const timed = (nodeId, actionId, tile, atMs, settledAtMs) => ({ nodeId, actionId, tile, atMs, settledAtMs });
  // 1.5 s of the 2.3 s is inside the last node: a slow NODE.
  const slowNode = priceProgram({
    programId: "plan_slow",
    startMs: 0,
    wallMs: 2_300,
    nodes: [
      timed("n01", "cut_weeds", { x: 1, y: 1 }, 0, 600),
      timed("n02", "cut_weeds", { x: 1, y: 2 }, 100, 700),
      timed("n03", "break_rock", { x: 1, y: 3 }, 800, 2_300),
    ],
  });
  assert.equal(slowNode.dominant.kind, "node");
  assert.equal(slowNode.dominant.nodeId, "n03");
  assert.equal(slowNode.dominant.actionId, "break_rock");
  assert.equal(slowNode.dominant.ms, 1_500);
  assert.equal(slowNode.dominant.first, false);
  // 1.2 s of the 1.5 s is BETWEEN two nodes: the Host round trip and the model thinking, not the game.
  const slowIdle = priceProgram({
    programId: "plan_idle",
    startMs: 0,
    wallMs: 1_500,
    nodes: [timed("n01", "cut_weeds", { x: 1, y: 1 }, 0, 200), timed("n02", "cut_weeds", { x: 1, y: 2 }, 1_400, 1_500)],
  });
  assert.equal(slowIdle.dominant.kind, "idle");
  assert.equal(slowIdle.dominant.afterNodeId, "n01");
  assert.equal(slowIdle.dominant.nodeId, "n02");
  assert.equal(slowIdle.dominant.ms, 1_200);
  // A program whose trace carries no per-node timing has no span to name, and that is `null` rather than a zero.
  const blind = priceProgram(
    program("plan_blind", [node("n01", "cut_weeds", { x: 1, y: 1 }), node("n02", "cut_weeds", { x: 2, y: 1 })], 900),
  );
  assert.equal(blind.excluded, null);
  assert.equal(blind.dominant, null);
});

test("the first node's span is marked, because the walk into a program is charged nowhere", () => {
  const priced = priceProgram({
    programId: "plan_walk_in",
    startMs: 0,
    wallMs: 1_000,
    nodes: [
      { nodeId: "n01", actionId: "move_to_tile", tile: { x: 20, y: 4 }, atMs: 0, settledAtMs: 900 },
      { nodeId: "n02", actionId: "cut_weeds", tile: { x: 20, y: 5 }, atMs: 950, settledAtMs: 1_000 },
    ],
  });
  assert.equal(priced.walkTiles, 1, "only the lattice BETWEEN nodes is charged");
  assert.deepEqual(
    { kind: priced.dominant.kind, nodeId: priced.dominant.nodeId, first: priced.dominant.first },
    { kind: "node", nodeId: "n01", first: true },
  );
});

test("the floor is one swing per node plus the lattice between the tiles the run recorded", () => {
  const priced = priceProgram(
    program(
      "plan_a",
      [
        node("n01", "cut_weeds", { x: 10, y: 10 }),
        node("n02", "cut_weeds", { x: 13, y: 10 }),
        node("n03", "break_rock", { x: 13, y: 11 }),
      ],
      10_000,
    ),
  );
  assert.equal(priced.excluded, null);
  assert.equal(priced.walkTiles, 4, "3 tiles then 1 tile: the first node's walk-in is not charged, and is not zero");
  assert.equal(
    priced.floorMs,
    Math.round(
      (nativeFloorMs({ action: "cut_weeds" }) * 2 + nativeFloorMs({ action: "break_rock" }) + 4 * WALK_MS_PER_TILE) *
        100,
    ) / 100,
  );
  assert.equal(priced.ratio, Math.round((10_000 / priced.floorMs) * 100) / 100);
});

test("a node with no tile holds the position where it was, because it does not move the actor", () => {
  const priced = priceProgram(
    program(
      "plan_b",
      [
        node("n01", "equip_tool", null),
        node("n02", "cut_weeds", { x: 4, y: 4 }),
        node("n03", "cut_weeds", { x: 6, y: 4 }),
      ],
      3_000,
    ),
  );
  assert.equal(priced.excluded, null, "an equip_tool names no target and must not cost the program its floor");
  assert.equal(priced.walkTiles, 2, "the two cut_weeds are two tiles apart; the equip adds a swing and no walk");
});

test("what cannot be priced is excluded by name, never dropped", () => {
  assert.equal(priceProgram(program("one", [node("n01", "cut_weeds", { x: 1, y: 1 })], 500)).excluded, "single_node");
  assert.equal(
    priceProgram(
      program("map", [node("n01", "cut_weeds", { x: 1, y: 1 }), node("n02", "enter_exit", { x: 1, y: 2 })], 900),
    ).excluded,
    "crossed_a_map",
  );
  assert.equal(
    priceProgram(program("sleepy", [node("n01", "cut_weeds", { x: 1, y: 1 }), node("n02", "sleep", null)], 900))
      .excluded,
    "unpriced:sleep",
  );
  assert.equal(
    priceProgram(program("blind", [node("n01", "cut_weeds", null), node("n02", "cut_weeds", null)], 900)).excluded,
    "no_tiled_node",
  );
});

test("a bundle's programs are priced from its own two artifacts, and the aggregate is their sum", async () => {
  const root = await mkdtemp(join(tmpdir(), "program-pace-"));
  try {
    await bundleOf(root, "2026-01-01T00-00-00-000Z-one", {
      programs: [
        program("plan_a", [node("n01", "cut_weeds", { x: 1, y: 1 }), node("n02", "cut_weeds", { x: 2, y: 1 })], 2_000),
        program(
          "plan_b",
          [node("n01", "move_to_tile", { x: 5, y: 5 }), node("n02", "cut_weeds", { x: 5, y: 6 })],
          1_000,
        ),
        program("plan_c", [node("n01", "cut_weeds", { x: 9, y: 9 })], 400),
      ],
    });
    const measurement = measureProgramPace({ bundleRoot: root });
    assert.equal(measurement.bundles, 1);
    assert.equal(measurement.programs, 3);
    assert.equal(measurement.examined, 2, "the one-node program is not a schedule and is excluded");
    assert.deepEqual(measurement.excluded, { single_node: 1 });
    assert.equal(measurement.wallMs, 3_000);
    assert.equal(measurement.ratio, Math.round((3_000 / measurement.floorMs) * 100) / 100);
    assert.deepEqual(measurement.readings.map((reading) => reading.programId).sort(), ["plan_a", "plan_b"]);
    assert.equal(
      measurement.readings.every((reading) => reading.walkTiles >= 0),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a schedule four times its floor fails, naming the ratio and the population", async () => {
  const root = await mkdtemp(join(tmpdir(), "program-pace-red-"));
  try {
    // Ten nodes of the same work on one tile: the floor is ten hoe/scythe swings plus no walking at all, so the
    // wall clock IS the multiple. 19,200 ms over 4,800 ms is exactly 4.0.
    const heavy = (programId) =>
      program(
        programId,
        Array.from({ length: 10 }, (_, index) => node(`n${String(index + 1)}`, "cut_weeds", { x: 3, y: 3 })),
        19_200,
      );
    await bundleOf(root, "2026-01-01T00-00-00-000Z-dense", {
      programs: [heavy("plan_a"), heavy("plan_b"), heavy("plan_c")],
    });
    const measurement = measureProgramPace({ bundleRoot: root });
    const verdict = compareProgramPace({ measurement });
    assert.equal(measurement.ratio, 4);
    assert.equal(verdict.kind, "above");
    const rendered = renderProgramPace({ measurement, verdict, bundleRoot: root });
    assert.equal(rendered.failed, true);
    const text = rendered.lines.join("\n");
    assert.match(text, /^program_pace_above_native_floor:4:0\.6 examined=3 /mu);
    assert.match(text, /^program_pace_population: .* programs examined 3 walk=lattice_lower_bound$/mu);
    // The verdict names its offender: an aggregate of 4 with no program under it is a number nobody can act on.
    // The 18.3 s sits inside the LAST node (the fixture's stride stamps only the final settle), so the line says
    // a slow node rather than the idle between nodes - the two have different fixes.
    assert.match(
      text,
      /^ {2}densest: plan_a nodes 10 walk 0 tiles · wall 19\.2s · floor 4\.8s · ratio 4 · held by node n10 cut_weeds 18\.3s \(95% of the wall\)$/mu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty population and a too-small one are blocked, not passed", async () => {
  const root = await mkdtemp(join(tmpdir(), "program-pace-blocked-"));
  try {
    await bundleOf(root, "2026-01-01T00-00-00-000Z-empty", { programs: [] });
    const empty = measureProgramPace({ bundleRoot: root });
    assert.equal(empty.status, "no_priced_program");
    assert.equal(compareProgramPace({ measurement: empty }).kind, "blocked");
    const rendered = renderProgramPace({
      measurement: empty,
      verdict: compareProgramPace({ measurement: empty }),
      bundleRoot: root,
    });
    assert.equal(rendered.failed, false, "nothing to price is a blocked reading, never a pass and never a failure");
    assert.match(rendered.lines.join("\n"), /^program_pace_blocked: no_priced_program /mu);

    await bundleOf(root, "2026-01-02T00-00-00-000Z-thin", {
      programs: [
        program("plan_a", [node("n01", "cut_weeds", { x: 1, y: 1 }), node("n02", "cut_weeds", { x: 2, y: 1 })], 900),
      ],
    });
    const thin = measureProgramPace({ bundleRoot: root });
    assert.equal(thin.examined, 1);
    const verdict = compareProgramPace({ measurement: thin });
    assert.equal(verdict.kind, "insufficient_population");
    assert.equal(PROGRAM_PACE_POPULATION_FLOOR > 1, true);
    assert.match(
      renderProgramPace({ measurement: thin, verdict, bundleRoot: root }).lines.join("\n"),
      /^program_pace_too_few_programs: programs examined 1 of 1 /mu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gate entry prints this section, and the walk's direction is on the line", async () => {
  const root = await mkdtemp(join(tmpdir(), "program-pace-cli-"));
  try {
    // Three schedules at about a third of their floor: a good day, and its members are named on it.
    await bundleOf(root, "2026-01-01T00-00-00-000Z-cli", {
      programs: [
        program("plan_a", [node("n01", "cut_weeds", { x: 1, y: 1 }), node("n02", "cut_weeds", { x: 2, y: 1 })], 450),
        program("plan_b", [node("n01", "cut_weeds", { x: 4, y: 4 }), node("n02", "cut_weeds", { x: 5, y: 4 })], 500),
        program("plan_c", [node("n01", "cut_weeds", { x: 8, y: 8 }), node("n02", "cut_weeds", { x: 9, y: 8 })], 400),
      ],
    });
    const stdout = execFileSync(process.execPath, [gatePath, "--program-pace-only", "--bundles", root], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(stdout, /^program_pace_population: bundleRoot=.* programs examined 3 walk=lattice_lower_bound/mu);
    assert.match(stdout, /^program_pace: 3 programs · wall /mu);
    assert.match(stdout, /\(ceiling, walk=lattice_lower_bound\)/u);
    // A GREEN RUN NAMES ITS MEMBERS TOO: the three densest are printed before the verdict, so a lane reads
    assert.match(
      stdout,
      /^ {2}densest: plan_b nodes 2 walk 1 tiles · wall 0\.5s · floor 1\.5s · ratio 0\.34 · held by node n02 cut_weeds 0\.4s \(80% of the wall\)$/mu,
    );
    assert.equal(stdout.split(/\r?\n/u).filter((line) => line.startsWith("  densest: ")).length, PROGRAM_PACE_MEMBERS);
    assert.match(stdout, /^program_pace_ok examined=3 ratio=/mu);
    assert.equal(PROGRAM_PACE_WALK, "lattice_lower_bound");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a doubled schedule is red at the tightened ceiling, while the same run at its measured pace is green", async () => {
  const root = await mkdtemp(join(tmpdir(), "program-pace-doubled-"));
  try {
    // Ten one-tile swings: the floor is 10 x 480 ms with no walk at all, so the wall clock IS the multiple.
    const paced = (programId, factor) =>
      program(
        programId,
        Array.from({ length: 10 }, (_, index) => node(`n${String(index + 1)}`, "cut_weeds", { x: 3, y: 3 })),
        Math.round(4_800 * factor),
      );
    await bundleOf(root, "2026-01-01T00-00-00-000Z-pace", {
      programs: [paced("plan_a", 0.34), paced("plan_b", 0.34), paced("plan_c", 0.34)],
    });
    const measured = measureProgramPace({ bundleRoot: root });
    assert.equal(measured.ratio, 0.34);
    assert.equal(compareProgramPace({ measurement: measured }).kind, "ok", "round99's own aggregate stays green");

    // The same run with every program taking twice as long: 0.68. This is the regression the old 1.0 line could
    // not see, and it is the one a doubled Host round trip would produce.
    await bundleOf(root, "2026-01-01T00-00-00-000Z-pace", {
      programs: [paced("plan_a", 0.68), paced("plan_b", 0.68), paced("plan_c", 0.68)],
    });
    const doubled = measureProgramPace({ bundleRoot: root });
    assert.equal(doubled.ratio, 0.68);
    const verdict = compareProgramPace({ measurement: doubled });
    assert.equal(verdict.kind, "above");
    assert.equal(renderProgramPace({ measurement: doubled, verdict, bundleRoot: root }).failed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("round99's own programs replay as a reading, not as a pass or a failure", { skip: !existsSync(ROUND_99) }, () => {
  const measurement = measureProgramPace({ bundleRoot: ROUND_99 });
  assert.equal(measurement.bundles, 1);
  assert.equal(measurement.programs, 36, "round99 dispatched 36 programs");
  assert.equal(measurement.examined, 10, "ten of them are priceable schedules; the rest are excluded by name");
  assert.deepEqual(measurement.excluded, { crossed_a_map: 8, single_node: 18 });
  assert.equal(measurement.ratio, 0.34);
  assert.equal(measurement.distribution.max, 1.41);
  const verdict = compareProgramPace({ measurement });
  assert.equal(verdict.kind, "ok");
  const rendered = renderProgramPace({ measurement, verdict, bundleRoot: ROUND_99 });
  assert.equal(rendered.failed, false);
  const text = rendered.lines.join("\n");
  assert.match(text, /^program_pace_ok examined=10 ratio=0\.34 ceiling=0\.6$/mu);
  // A GREEN READING NAMES ITS WORST THREE, and the worst of them is now read correctly. It was 4.47 and read as
  // "a slow node"; the node is the engine's own animation. Measured 2026-11-24: that node's `[game-thread-cost]`
  // line read `total_ms=12.02;dispatch_ms=12.02;admission_ms=0.01;approach_ms=0.00;floods=0` while its journal
  // span was 1465 ms of `MilkPail` (four 400 ms frames), which the floor was pricing as a generic 480 ms swing.
  // Corrected, the same program reads 1.41 - the milking IS the wall clock, and 1.41 is what the engine's own
  // floor says about it. The program below it loses 59% of its half-second to the idle BETWEEN two nodes.
  assert.match(
    text,
    /^ {2}densest: plan_133_e83871efb30f7844 nodes 3 walk 0 tiles · wall 2\.3s · floor 1\.6s · ratio 1\.41 · held by node n03 collect_animal_product 1\.5s \(64% of the wall\)$/mu,
  );
  assert.match(
    text,
    /^ {2}densest: plan_347_2b25eb5271eb2ae9 .* · held by the 0\.2s idle between n01 and n02 \(59% of the wall\), not by any node$/mu,
  );
  assert.equal(text.split(/\r?\n/u).filter((line) => line.startsWith("  densest: ")).length, PROGRAM_PACE_MEMBERS);
  // The programs the reading could not price are named, and their number is the difference to the
  // population: a run cannot lose its programs to an exclusion nobody can see.
  const priced = programsOf(ROUND_99);
  assert.equal(priced.length, 36);
  assert.equal(bundleDirectories(ROUND_99).length, 1);
});

test("the ceiling sits above every round94-99 reading and below a doubled one", () => {
  // The corpus the line was set from, derived from the artifacts rather than listed by hand: every bundle of
  // the last two recorded days. A population of zero is a blocked reading, not a pass.
  const recent = readdirSync(LADDER)
    .filter((name) => name.startsWith("2026-11-23") || name.startsWith("2026-11-24"))
    .map((name) => join(LADDER, name));
  const measured = recent
    .map((directory) => measureProgramPace({ bundleRoot: directory }))
    .filter(
      (measurement) => measurement.status === "measured" && measurement.examined >= PROGRAM_PACE_POPULATION_FLOOR,
    );
  assert.equal(measured.length, 5, "rounds 94-99 that priced a schedule: five of them");
  for (const measurement of measured)
    assert.equal(
      measurement.ratio < PROGRAM_PACE_CEILING,
      true,
      `${measurement.bundleRoot} reads ${String(measurement.ratio)} against the ${String(PROGRAM_PACE_CEILING)} ceiling`,
    );
  // The tightened line is placed by two readings, not by comfort: the pooled corpus is 0.45 and twice the worst
  // of rounds 94-99 is 0.80, so a ceiling anywhere in between catches a doubling while every good day passes.
  assert.equal(PROGRAM_PACE_CEILING, 0.6);
  assert.equal(PROGRAM_PACE_CEILING > 0.45, true, "the pooled corpus aggregate is 0.45");
  assert.equal(PROGRAM_PACE_CEILING < 0.68, true, "twice round99's 0.34 must cross the line, and it does at 0.68");
  const worst = Math.max(...measured.map((measurement) => measurement.ratio));
  assert.equal(worst * 2 > PROGRAM_PACE_CEILING, true, "twice the worst of rounds 94-99 must be red");
});
