/**
 * 一个程序排得有多密：程序自己的墙钟，除以同样这些节点在引擎里本来就要求的时间。
 *
 * WHY THIS EXISTS. `tools/lib/action-pace.mjs` answers "how long did ONE action take against what the
 * engine forces for it", and it cannot answer where `round99` lost its day: the waste sat BETWEEN
 * actions - a plan refused in 372 µs whose 35 game minutes were spent thinking about it, four
 * `stardew_observe` rounds looking for a `targetId` her block never printed, five navigation refusals
 * whose `next_step` told her to observe again. None of those is an action, so no per-action ratio can
 * see them. A PROGRAM is the unit that does: it has a start, an end, and a list of nodes whose native
 * cost the engine fixes.
 *
 * WHAT IS MEASURED, and from which artifact:
 *
 *   wall    `programTrace.jsonl` - the Mod's own monotonic `atMs`/`settledAtMs` for every node it
 *           dispatched (`tools/live-run/game/execution-trace.mjs`). One program's wall clock is its
 *           first node's dispatch to its last node's settle, on one clock. It contains the walking,
 *           the Host round trips between nodes, the admission gate and the journal writes.
 *   floor   `result.json` -> `programOutcomes[].nodeOutcomes[]`: the action id and the tile each node
 *           worked, priced by `nativeFloorMs` (one swing of that action's own animation) plus the
 *           lattice distance from the previous node's tile at the engine's walk rate
 *           (`WALK_MS_PER_TILE`, from the decompiled tree - not a guess about this run's map).
 *
 * THE WALK TERM COMES FROM THE RUN'S OWN RECORDED TILES, AND IT IS A LOWER BOUND. The Mod no longer
 * mints a per-tile receipt (`tile_advanced` was removed as a fact - `design/fact-authority.md` names
 * it, and no run since 2026-11-11 carries one), so a program's walk is the distance between the tiles
 * its own nodes report. A real route can be longer than the lattice between two of them, so the floor
 * is a LOWER bound on what the engine demands and the ratio printed here is an UPPER bound - a
 * CEILING - on how many times the floor the program took. Every line says `walk=lattice_lower_bound`
 * for that reason: a bound whose direction is left unstated is read as exact within a week.
 *
 * WHAT DOES NOT BELONG IN THE POPULATION, each excluded and counted:
 *
 *   single_node                  a one-node program has no schedule to be dense or sparse.
 *   crossed_a_map                a transit node (`enter_exit`, `navigate_to_destination`, ...) moves
 *                                the actor to another map, where the two tiles are not two tiles
 *                                apart. `round99`'s 35 programs include 16 of these; a lattice
 *                                distance across a warp is not a distance.
 *   unpriced:<actions>           the engine declares no animation constant for that work
 *                                (`nativeFloorMs` is null), so no floor can be built.
 *   no_tiled_node                no node names a tile, so no walk can be charged at all.
 *
 * AND WHEN TOO FEW PROGRAMS ARE LEFT, IT SAYS SO instead of averaging what remains: a run whose whole
 * population is two programs has not measured a schedule, and the line says `too_few_programs` rather
 * than printing a ratio over a population that cannot support one.
 *
 * WHICH PROGRAM, ALWAYS. An aggregate ratio is a number nobody can act on, so every reading prints its
 * worst three programs with the piece of the wall clock that held them: `held by node n03
 * collect_animal_product 1.5s (64% of the wall)` is a slow node, `held by the 0.2s idle between n01 and
 * n02 (59% of the wall), not by any node` is the Host round trip and the model's thinking, and neither
 * is visible in the aggregate. Measured 2026-11-24 over the corpus: `plan_299` (17 nodes) took 127.7s
 * against a 34.4s floor - ratio 3.71 - while its run's aggregate read 0.86, so the offender was inside a
 * passing-looking number.
 *
 * THE THRESHOLD IS READ OFF THE DISTRIBUTION, NOT CHOSEN FOR COMFORT. Rounds 94-99 measured aggregate
 * ratios of 0.30, 0.40, 0.31, 0.25 and 0.34; the pooled corpus (682 priced programs) reads 0.45; and
 * of the 31 runs in the corpus with three or more priceable programs, 21 sit at or below 0.50 and the
 * ten above it are the 2026-11-18..11-21 runs that carried the 127-second and 101-second programs.
 * `PROGRAM_PACE_CEILING` is 0.6 - 1.5x the worst of rounds 94-99, 1.33x the corpus, and BELOW the
 * smallest doubling that has to be caught: a 2x regression of `round99` reads 0.68 and of the corpus
 * 0.90. The previous 1.0 line was 2.5x the worst run, which means a run could have doubled its
 * schedule and stayed green.
 *
 * WHAT IT CANNOT SEE, stated: the gaps BETWEEN programs are not in any program's wall clock, so a run
 * that spends an hour deciding what to do next reads as dense here and must be judged by the turn
 * account beside it (`tools/lib/turn-waste.mjs`). A program that is fast but WRONG - six refusals that
 * each cost nothing - also reads as dense: this module prices time, never outcome.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { animationClassOf, nativeFloorMs } from "./action-pace.mjs";

/**
 * The actions that MOVE THE ACTOR TO ANOTHER MAP. They are already `unpriced` in the animation
 * classes; they are named here because the reason a program containing one must leave the population
 * is stronger than "no floor": its tiles are not in one coordinate space, so the walk term between the
 * nodes on either side of it is meaningless rather than merely unrecorded.
 */
export const TRANSIT_ACTIONS = Object.freeze([
  "enter_exit",
  "travel",
  "navigate_to_destination",
  "enter_mine",
  "use_mine_ladder",
  "select_mine_elevator_floor",
  "ride_minecart",
  "ride_bus",
  "use_obelisk",
  "use_raft",
  "mount_transport",
  "dismount_transport",
  "use_warp_item",
]);

const TRANSIT = new Set(TRANSIT_ACTIONS);

/**
 * How many times the native floor a run's programs may take before the schedule is a defect.
 *
 * MEASURED over rounds 94-99: 0.30 (19 programs), 0.40 (29), 0.31 (12), 0.25 (18) and 0.34 (10); over
 * the whole `game-ladder` corpus with 682 priced programs the pooled aggregate is 0.45. The line is 0.6:
 * 1.5x the worst of those five runs and 1.33x the corpus, while staying under the 0.68 a doubled
 * `round99` would read - the 1.0 it replaces was 2.5x the worst run and could not see a doubling at all.
 * The runs above it in the corpus (0.76, 0.86, 1.07) are the 2026-11-18..11-21 days whose worst programs
 * took 127.7s, 101.8s and 10.8s against floors of 34.4s, 58.8s and 2.6s: real defects, not noise.
 */
export const PROGRAM_PACE_CEILING = 0.6;

/** Below this many examined programs a run has not measured a schedule, whatever the ratio says. */
export const PROGRAM_PACE_POPULATION_FLOOR = 3;

/** The one line naming what the denominator is made of, printed beside every reading. */
export const PROGRAM_PACE_WALK = "lattice_lower_bound";

const round = (value) => (value === null || value === undefined ? null : Math.round(value * 100) / 100);

/** How many programs a reading names, always printed, so the number has an offender beside it. */
export const PROGRAM_PACE_MEMBERS = 3;

/** Every bundle under `root`: a directory holding a `result.json` is one run. */
export function bundleDirectories(root) {
  const directories = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "result.json")) {
      directories.push(directory);
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) walk(join(directory, entry.name));
  };
  walk(root);
  return directories.sort();
}

/** The programs one bundle's `programTrace.jsonl` recorded, joined with the tile each node worked. */
export function programsOf(bundleDirectory) {
  const tracePath = join(bundleDirectory, "programTrace.jsonl");
  const resultPath = join(bundleDirectory, "result.json");
  if (!existsSync(tracePath) || !existsSync(resultPath)) return [];
  let result;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return [];
  }
  const nodeInfo = new Map();
  for (const program of Array.isArray(result?.programOutcomes) ? result.programOutcomes : []) {
    for (const node of Array.isArray(program?.nodeOutcomes) ? program.nodeOutcomes : []) {
      nodeInfo.set(`${String(program.programId)}\u0000${String(node?.nodeId)}`, node);
    }
  }
  const byProgram = new Map();
  for (const line of readFileSync(tracePath, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row?.programId !== "string" || typeof row?.atMs !== "number") continue;
    if (!byProgram.has(row.programId)) byProgram.set(row.programId, []);
    byProgram.get(row.programId).push(row);
  }
  const programs = [];
  for (const [programId, rows] of byProgram) {
    rows.sort((left, right) => left.atMs - right.atMs);
    const startMs = rows[0].atMs;
    let endMs = startMs;
    for (const row of rows) if (typeof row.settledAtMs === "number" && row.settledAtMs > endMs) endMs = row.settledAtMs;
    programs.push(
      Object.freeze({
        programId,
        startMs,
        wallMs: endMs - startMs,
        nodes: Object.freeze(
          rows.map((row) => {
            const info = nodeInfo.get(`${programId}\u0000${String(row.nodeId)}`);
            return Object.freeze({
              nodeId: row.nodeId,
              actionId: typeof info?.actionId === "string" ? info.actionId : null,
              tile: isTile(info?.tile) ? info.tile : null,
              // The Mod's own clock for this node, kept so a reading can say WHERE the wall clock went.
              atMs: typeof row.atMs === "number" ? row.atMs : null,
              settledAtMs: typeof row.settledAtMs === "number" ? row.settledAtMs : null,
            });
          }),
        ),
      }),
    );
  }
  return programs.sort((left, right) => left.startMs - right.startMs);
}

const isTile = (tile) =>
  typeof tile?.x === "number" && typeof tile?.y === "number" && Number.isFinite(tile.x) && Number.isFinite(tile.y);

const lattice = (left, right) => Math.abs(right.x - left.x) + Math.abs(right.y - left.y);

/**
 * The single largest piece of a program's wall clock, and which side it came from.
 *
 * Two things can hold a schedule: a NODE's own service time (dispatch to settle, which includes the walk
 * in to that node's tile) or the IDLE between one node's settle and the next node's dispatch (the Mod's
 * result travelling back, the Host's turn, the model thinking about the next node). The aggregate ratio
 * cannot tell those apart and they have opposite fixes, so every priced program carries its dominant one.
 *
 * `first` marks a dominant node that is the program's first: its service time includes the walk into the
 * program, which the floor charges nowhere (`priceProgram` starts charging tiles at the second node).
 */
function dominantSpanOf(nodes) {
  const timeOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  let dominant = null;
  let settledBefore = null;
  let nodeBefore = null;
  nodes.forEach((node, index) => {
    const at = timeOf(node.atMs);
    const settled = timeOf(node.settledAtMs);
    if (settledBefore !== null && at !== null && at > settledBefore) {
      const idle = { kind: "idle", nodeId: node.nodeId, afterNodeId: nodeBefore, actionId: node.actionId, ms: at - settledBefore };
      if (dominant === null || idle.ms > dominant.ms) dominant = idle;
    }
    if (at !== null && settled !== null && settled >= at) {
      const service = { kind: "node", nodeId: node.nodeId, actionId: node.actionId, ms: settled - at, first: index === 0 };
      if (dominant === null || service.ms > dominant.ms) dominant = service;
    }
    if (settled !== null) {
      settledBefore = settled;
      nodeBefore = node.nodeId;
    }
  });
  return dominant;
}

/**
 * One program's reading, or the reason it cannot be priced.
 *
 * `null` is never zero: a program with no priced node, no tile or a crossing answers `{excluded}` and
 * the caller counts it, because a zero floor would read as an impossible ratio rather than as a gap.
 */
export function priceProgram(program) {
  if (program.nodes.length < 2) return { excluded: "single_node" };
  const transit = program.nodes.filter((node) => TRANSIT.has(node.actionId));
  if (transit.length > 0) return { excluded: "crossed_a_map", actions: transit.map((node) => node.actionId) };
  const unpriced = program.nodes.filter((node) => {
    const className = node.actionId === null ? null : animationClassOf(node.actionId);
    return className === null || className === "unpriced";
  });
  if (unpriced.length > 0)
    return { excluded: `unpriced:${[...new Set(unpriced.map((node) => node.actionId))].sort().join(",")}` };
  if (!program.nodes.some((node) => node.tile !== null)) return { excluded: "no_tiled_node" };
  let floorMs = 0;
  let walkTiles = 0;
  let previous = null;
  for (const node of program.nodes) {
    const tiles = node.tile !== null && previous !== null ? lattice(previous, node.tile) : 0;
    walkTiles += tiles;
    floorMs += nativeFloorMs({ action: node.actionId, tiles: 1, distance: tiles });
    if (node.tile !== null) previous = node.tile;
  }
  if (floorMs === 0) return { excluded: "no_tiled_node" };
  return {
    excluded: null,
    programId: program.programId,
    nodes: program.nodes.length,
    wallMs: program.wallMs,
    floorMs: round(floorMs),
    walkTiles,
    ratio: round(program.wallMs / floorMs),
    // Every priced program can be asked where its time went; the reading prints it for the worst.
    dominant: dominantSpanOf(program.nodes),
  };
}

/** Nearest-rank percentile of a list; `null` for an empty one. */
function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return round(sorted[rank]);
}

/**
 * Every bundle's programs, priced: the one reading this module publishes.
 *
 * `programs examined` is the population the ratio rests on and `excluded` names why each remaining
 * program is not in it, by reason, so a run cannot lose its population silently.
 */
export function measureProgramPace({ bundleRoot } = {}) {
  const root = resolve(bundleRoot ?? "");
  if (!existsSync(root)) {
    return Object.freeze({
      bundleRoot: root,
      status: "no_bundle_root",
      bundles: 0,
      programs: 0,
      examined: 0,
      excluded: Object.freeze({}),
      readings: Object.freeze([]),
      wallMs: 0,
      floorMs: 0,
      ratio: null,
      distribution: Object.freeze({ min: null, p50: null, p90: null, max: null }),
    });
  }
  const directories = bundleDirectories(root);
  const excluded = new Map();
  const readings = [];
  let programs = 0;
  for (const directory of directories) {
    for (const program of programsOf(directory)) {
      programs += 1;
      const priced = priceProgram(program);
      if (priced.excluded !== null) {
        excluded.set(priced.excluded, (excluded.get(priced.excluded) ?? 0) + 1);
        continue;
      }
      readings.push(Object.freeze({ ...priced, bundle: directory }));
    }
  }
  const wallMs = readings.reduce((total, reading) => total + reading.wallMs, 0);
  const floorMs = readings.reduce((total, reading) => total + reading.floorMs, 0);
  const ratios = readings.map((reading) => reading.ratio);
  return Object.freeze({
    bundleRoot: root,
    status: readings.length === 0 ? "no_priced_program" : "measured",
    bundles: directories.length,
    programs,
    examined: readings.length,
    excluded: Object.freeze(Object.fromEntries([...excluded.entries()].sort(([left], [right]) => (left < right ? -1 : 1)))),
    readings: Object.freeze(readings),
    wallMs,
    floorMs: round(floorMs),
    ratio: floorMs === 0 ? null : round(wallMs / floorMs),
    distribution: Object.freeze({
      min: percentile(ratios, 0),
      p50: percentile(ratios, 0.5),
      p90: percentile(ratios, 0.9),
      max: percentile(ratios, 1),
    }),
  });
}

/** The verdict: the ratio above the ceiling, or a population too small to say anything. */
export function compareProgramPace({ measurement, ceiling = PROGRAM_PACE_CEILING } = {}) {
  if (measurement.status === "no_bundle_root") return Object.freeze({ kind: "blocked", why: "no_bundle_root" });
  if (measurement.status === "no_priced_program")
    return Object.freeze({ kind: "blocked", why: "no_priced_program" });
  if (measurement.examined < PROGRAM_PACE_POPULATION_FLOOR)
    return Object.freeze({ kind: "insufficient_population", examined: measurement.examined });
  if (measurement.ratio > ceiling) return Object.freeze({ kind: "above", ratio: measurement.ratio, ceiling });
  return Object.freeze({ kind: "ok", ratio: measurement.ratio, ceiling });
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** The share of a program's wall clock that its dominant span held, as a whole percentage. */
const shareOf = (span, wallMs) => (wallMs <= 0 ? 0 : Math.round((span.ms / wallMs) * 100));

/**
 * The worst `PROGRAM_PACE_MEMBERS` programs by ratio, each with the span that held it.
 *
 * A program id alone is not an offender a reader can follow when the population spans bundles - the default
 * invocation pools every run under `.live-runs` - so the bundle is named as well whenever there is more than
 * one of them.
 */
function memberLines(measurement) {
  const bundles = new Set(measurement.readings.map((reading) => reading.bundle));
  const where = (reading) =>
    bundles.size > 1 && typeof reading.bundle === "string" ? `${reading.bundle.split(/[\\/]/u).pop()} ` : "";
  const held = (reading) => {
    const span = reading.dominant ?? null;
    if (span === null) return "held by no recorded span (the trace carries no node timing)";
    const share = `${String(shareOf(span, reading.wallMs))}% of the wall`;
    if (span.kind === "idle")
      return `held by the ${seconds(span.ms)} idle between ${String(span.afterNodeId)} and ${String(span.nodeId)} (${share}), not by any node`;
    const action = span.actionId === null ? "" : ` ${span.actionId}`;
    const first = span.first === true ? ", and it is the program's first node, whose walk in is charged nowhere" : "";
    return `held by node ${String(span.nodeId)}${action} ${seconds(span.ms)} (${share})${first}`;
  };
  return [...measurement.readings]
    .sort((left, right) => right.ratio - left.ratio)
    .slice(0, PROGRAM_PACE_MEMBERS)
    .map(
      (reading) =>
        `  densest: ${where(reading)}${reading.programId} nodes ${String(reading.nodes)} walk ${String(reading.walkTiles)} tiles · ` +
        `wall ${seconds(reading.wallMs)} · floor ${seconds(reading.floorMs)} · ratio ${String(reading.ratio)} · ${held(reading)}`,
    );
}

/** Everything the gate prints for this section, and whether it failed. */
export function renderProgramPace({ measurement, verdict, bundleRoot }) {
  const lines = [];
  const excluded = Object.entries(measurement.excluded)
    .map(([reason, count]) => `${reason} ${String(count)}`)
    .join(" · ");
  lines.push(
    `program_pace_population: bundleRoot=${bundleRoot} bundles=${String(measurement.bundles)} ` +
      `programs=${String(measurement.programs)} programs examined ${String(measurement.examined)} ` +
      `walk=${PROGRAM_PACE_WALK}` +
      `${excluded.length === 0 ? "" : ` · excluded: ${excluded}`}`,
  );
  if (verdict.kind === "blocked") {
    lines.push(
      `program_pace_blocked: ${verdict.why} at ${bundleRoot} - nothing was priced, and this line is not a pass`,
    );
    return { lines, failed: false };
  }
  if (verdict.kind !== "insufficient_population") {
    const { distribution, wallMs, floorMs } = measurement;
    lines.push(
      `program_pace: ${String(measurement.examined)} programs · wall ${seconds(wallMs)} · floor ${seconds(floorMs)} · ` +
        `ratio ${String(verdict.ratio)} (ceiling, walk=${PROGRAM_PACE_WALK}) · per program min ${String(distribution.min)} ` +
        `p50 ${String(distribution.p50)} p90 ${String(distribution.p90)} max ${String(distribution.max)}`,
    );
  }
  // The worst members are printed ALWAYS, on a green run too: an aggregate cannot say which program to fix,
  // and the three below this line are the whole reason the number moved. They are named, not gated - the
  // verdict rests on the aggregate - but a tail program that holds a schedule is a reading in its own right
  // (`round99`'s `plan_133` reads 4.47 over three barn chores whose 2.3s was one milking node and the walk
  // into the first node, which this floor charges nowhere).
  lines.push(...memberLines(measurement));
  if (verdict.kind === "insufficient_population") {
    lines.push(
      `program_pace_too_few_programs: programs examined ${String(verdict.examined)} of ${String(measurement.programs)} ` +
        `is below the ${String(PROGRAM_PACE_POPULATION_FLOOR)} this reading needs, so no ratio is published: the exclusions ` +
        "above are the reading, and averaging what is left would report a schedule nobody measured",
    );
    return { lines, failed: false };
  }
  if (verdict.kind === "ok") {
    lines.push(
      `program_pace_ok examined=${String(measurement.examined)} ratio=${String(verdict.ratio)} ceiling=${String(verdict.ceiling)}`,
    );
    return { lines, failed: false };
  }
  lines.push(
    `program_pace_above_native_floor:${String(verdict.ratio)}:${String(verdict.ceiling)} examined=${String(measurement.examined)} ` +
      `- the run spent ${String(verdict.ratio)}x the engine's own floor inside its programs, so everything past ` +
      `${String(verdict.ceiling)}x is our overhead and not the game`,
  );
  return { lines, failed: true };
}
