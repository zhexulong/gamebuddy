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
 * THE THRESHOLD IS THE ENGINE'S OWN LINE, NOT A ROUND NUMBER. Rounds 94-99 measured aggregate ratios
 * of 0.30, 0.40, 0.31, 0.25 and 0.34 over 19, 29, 12, 18 and 10 programs, so the worst of them spent
 * 40% of the time the engine itself forces. `PROGRAM_PACE_CEILING` is 1.0: above it the run spent
 * MORE time inside its programs than the engine forces for the same work, and everything above 1.0
 * is our own overhead. That is 2.5x the worst reading in the distribution, and it is the boundary
 * the metric means rather than a value that looked comfortable.
 *
 * WHAT IT CANNOT SEE, stated: the gaps BETWEEN programs are not in any program's wall clock, so a run
 * that spends an hour deciding what to do next reads as dense here and must be judged by the turn
 * account beside it (`tools/lib/turn-waste.mjs`).
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
 * the whole 402-bundle `game-ladder` corpus with 682 priced programs the aggregate is 0.45. The line
 * is 1.0 - the point where the time spent INSIDE programs exceeds the time the engine itself forces
 * for that work - which is 2.2x the corpus aggregate and 2.5x the worst single run in the
 * distribution, and it is the boundary the metric means rather than a value that looked comfortable.
 */
export const PROGRAM_PACE_CEILING = 1;

/** Below this many examined programs a run has not measured a schedule, whatever the ratio says. */
export const PROGRAM_PACE_POPULATION_FLOOR = 3;

/** The one line naming what the denominator is made of, printed beside every reading. */
export const PROGRAM_PACE_WALK = "lattice_lower_bound";

const round = (value) => (value === null || value === undefined ? null : Math.round(value * 100) / 100);

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
  if (verdict.kind === "insufficient_population") {
    lines.push(
      `program_pace_too_few_programs: programs examined ${String(verdict.examined)} of ${String(measurement.programs)} ` +
        `is below the ${String(PROGRAM_PACE_POPULATION_FLOOR)} this reading needs, so no ratio is published: the exclusions ` +
        "above are the reading, and averaging what is left would report a schedule nobody measured",
    );
    return { lines, failed: false };
  }
  const { distribution, wallMs, floorMs } = measurement;
  lines.push(
    `program_pace: ${String(measurement.examined)} programs · wall ${(wallMs / 1000).toFixed(1)}s · floor ${(floorMs / 1000).toFixed(1)}s · ` +
      `ratio ${String(verdict.ratio)} (ceiling, walk=${PROGRAM_PACE_WALK}) · per program min ${String(distribution.min)} ` +
      `p50 ${String(distribution.p50)} p90 ${String(distribution.p90)} max ${String(distribution.max)}`,
  );
  // The tail is printed and NOT gated: a small program's ceiling is dominated by the walk INTO its first
  // node, which no artifact records (measured `round99`: `plan_133` reads 4.47 over three one-swing nodes
  // whose 2.3 s was almost all approach). A reader can see them; the verdict rests on the aggregate.
  for (const reading of [...measurement.readings].sort((left, right) => right.ratio - left.ratio).slice(0, 5))
    lines.push(
      `  densest: ${reading.programId} nodes ${String(reading.nodes)} walk ${String(reading.walkTiles)} tiles · ` +
        `wall ${(reading.wallMs / 1000).toFixed(1)}s · floor ${(reading.floorMs / 1000).toFixed(1)}s · ratio ${String(reading.ratio)}`,
    );
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
