/**
 * HOW MUCH A RUN WALKED, derived from the `BRIDGE_FACT` receipts that state a tile.
 *
 * WHY (measured 2026-11-17, `round66`). The run's own account carries `turns opened`, `bubbles delivered`, `traces` and
 * `receipts with provenance`, and nothing about distance. So a run can halve its world-changing actions and no reading
 * moves, which is why the packer had to argue its case from a docblock: "Walking is 93.6% of a node's time (76,473 ms of
 * 81,700 ms over 18 nodes); a native use is 0.05% (44 ms)" (`host/src/body-program-packing.ts`). The hand count of
 * `round66` that this module automates reads `37 positioned events · 647 tiles walked (Manhattan) · 1230 s · 17
 * world-changing actions = 38 tiles/action`, and its three crops `(60,10) → (58,14) → (60,9)` cost 13 tiles where 8
 * would do.
 *
 * THE UNIT, AND WHAT IT REFUSES TO SAY.
 *
 *   walked tiles W        the Manhattan sum between CONSECUTIVE BODY POSITIONS in log order (`|dx| + |dy|`).
 *   positioned events P   the facts that stated a body position, a repeat of the position the body was already at
 *                         collapsed - a fact that restates where the body stands has not moved it.
 *   tiles per action      W over the world-changing actions that SETTLED, so the reading answers "what does one piece of
 *                         work cost me in walking" instead of "how long is the log".
 *   longest single walk   the longest leg, because a mean over 37 events hides one 81-tile errand.
 *
 * THE THREE IT PRINTS SEPARATELY, because `walked 647` alone invites "compared to what":
 *
 *   bound   the Manhattan minimum spanning tree over the same multiset of positions. A visiting order IS a spanning
 *           tree with two ends left open, so no order can be shorter than this tree: it is a lower bound, and the
 *           three crops are the smallest case that matters - walked 13, tree 8, exactly the "8 would do" the hand count
 *           reported.
 *   excess  walked - bound. A lower bound on the walking a perfect order would not have had to do, not an estimate of
 *           it: if the tree says 163 for `round66` then at least 484 of the 647 tiles were order, not distance.
 *
 * A FACT'S POSITION IS NOT ALWAYS THE BODY'S, and that difference is the reading. `round66`'s fact stream carries 174
 * `BRIDGE_FACT` lines; 44 state where the body stood and 130 do not:
 *
 *   body position          `target_reached` (the arrival), `*_approach_completed` (the stand tile an approach chose),
 *                          and a settlement row naming the tile the work landed on (`crop_harvested`, `weeds_cut`,
 *                          `tree_source_chopped`, `rock_source_broken`, `item_shipped`).
 *   subject without a tile seven `tree_source_chopped`, one `weeds_cut`, one `rock_source_broken` name their subject by
 *                          identity (`target=tree_chop_source_c6…`, `target=weed_a359…`) and carry no coordinate: 9.
 *   not the body           every coordinate that is somewhere else: an `accepted` row's destination (17), an
 *                          `item_picked_up` row's ITEM tile (4 - the receipt's own `within_magnet`/`radius` say so, and
 *                          the body's stand tile arrived in the same execution's `item_pickup_approach_completed`), a
 *                          blocked step's stand tile, an item that hopped, a door's `nearest`. Counting these would
 *                          measure something else and call it walking: the four item tiles alone move `round66` from
 *                          647 to 651.
 *   no position            waiting-for-body rows, superseded directives, lifecycle marks, semantic events: 72.
 *
 * The 44 collapse to 37 positions because an approach that ended on the tile the body already stood on states the same
 * position twice - `restated 7` is printed beside the count, so the difference is visible rather than rounded away.
 *
 * THE THREE ZEROES ARE TOLD APART, because `walked 0` is the easiest lie in the file:
 *
 *   no `BRIDGE_FACT` line at all   BLOCKED (`walking_not_measured`): the file was not a run log.
 *   facts, no body position        BLOCKED (`walking_nothing_to_place`): measured nothing.
 *   positioned, and walked 0       the genuine zero, printed beside `positioned 1`: every position was the one before it.
 *
 * WHAT IT DOES NOT DO. It reads the positions the log writes down, and nothing else.
 *
 *   - a warp reports two tiles in two locations (`source=FarmHouse:3,12;target=Farm:64,15`); the tile is what a warp
 *     costs on the grid, not what it costs to walk;
 *   - a step refused before it chose a stand tile (`no_native_path`, `no_reachable_approach`) states tiles but not the
 *     body's, so it lands in `not the body` and never in the walk;
 *   - it cannot tell a position the run forgot to write (`tile_advanced` is not in this log) from a move that produced
 *     no position at all; both read as `no position`, and the gate prints the population so that gap keeps its size.
 */

import { census, formatCensus } from "./reading.mjs";

/** The shape of this record. A reading that changes what it counts says so, so old logs are not read as new ones. */
export const WALKING_VERSION = "run-walking/v1";

/**
 * The four readings a walking account has to carry, and the two that keep those four honest.
 *
 * This array IS the gate population. `a_run_does_not_report_its_walking` checks a rendered account against this
 * declaration, so a reading that exists here and not in the account fails by its id rather than by a list someone
 * remembered to update.
 */
export const WALKING_READINGS = Object.freeze([
  Object.freeze({
    id: "walked",
    field: "walked",
    unit: "tiles",
    says: "the Manhattan sum between consecutive body positions, in log order",
  }),
  Object.freeze({
    id: "positioned",
    field: "positioned events",
    unit: "positions",
    says: "the facts that stated a body position, a repeat of the previous one collapsed",
  }),
  Object.freeze({
    id: "perAction",
    field: "tiles per action",
    unit: "tiles per action",
    says: "walked over the world-changing actions that settled",
  }),
  Object.freeze({
    id: "longest",
    field: "longest walk",
    unit: "tiles",
    says: "the longest single leg between two consecutive positions",
  }),
  Object.freeze({
    id: "bound",
    field: "straight-line bound",
    unit: "tiles",
    says: "the Manhattan minimum spanning tree over the same positions - no visiting order can be shorter",
  }),
  Object.freeze({
    id: "excess",
    field: "excess",
    unit: "tiles",
    says: "walked minus the bound: the walking no visiting order would have had to do",
  }),
]);

/**
 * A reason that reaches the log without an entry here is counted under its own name as uncarried, never placed: a new
 * receipt kind has to say what its tile MEANS before it can move the walk.
 */
const CARRIERS = Object.freeze([
  Object.freeze({
    id: "arrival",
    match: /^target_reached$/u,
    position: "body",
    why: "the move finished; `tile=` (16 in `round66`) or `actor=` (7) is where the body stands",
  }),
  Object.freeze({
    id: "approach",
    match: /_approach_completed$/u,
    position: "body",
    why: "a tool or pickup approach finished; `tile=` is the stand tile the native pathfinder chose",
  }),
  Object.freeze({
    id: "settlement",
    match: /^(?:crop_harvested|weeds_cut|tree_source_chopped|rock_source_broken|item_shipped)$/u,
    position: "subject",
    why: "the work landed on a tile the body had to reach; a row naming only a subject id has no position",
  }),
  Object.freeze({
    id: "pickup",
    match: /^item_picked_up$/u,
    position: "object",
    why: "the ITEM's tile within magnet radius, not the body's - the stand tile came in the same execution's approach",
  }),
  Object.freeze({
    id: "destination",
    match: /^accepted$/u,
    position: "destination",
    why: "where the body is going; the arrival states where it got to",
  }),
  Object.freeze({
    id: "itemMoved",
    match: /^item_target_(?:moved|changed)$/u,
    position: "object",
    why: "the item hopped; the body did not",
  }),
]);

/**
 * The reasons that say the world changed: what a settled piece of work costs in walking is the quotient the reading
 * exists for. Counted as DISTINCT EXECUTIONS, so an execution that publishes two settlements still costs one walk - and
 * the population is read off the log, never listed: `round66` gives harvest 3, weeds 1, chop 7, rock 1, ship 1, pickup 4
 * = the 17 the hand count divided 647 by.
 */
const WORLD_CHANGING_SETTLEMENT =
  /^(?:crop_harvested|weeds_cut|tree_source_chopped|rock_source_broken|item_shipped|item_picked_up)$/u;

/** The keys a position is written under, in the order the producers of `round66` used them. */
const POSITION_KEYS = Object.freeze(["tile", "reached", "actor", "actual", "target", "stand_at"]);

/** The buckets every examined fact lands in exactly once, so `examined` and the buckets cannot disagree. */
export const PLACEMENT_BUCKETS = Object.freeze([
  Object.freeze({ id: "body position", says: "the fact stated where the body stood" }),
  Object.freeze({
    id: "subject without a tile",
    says: "a settlement or approach that named its subject and no coordinate",
  }),
  Object.freeze({
    id: "not the body",
    says: "a coordinate somewhere else: a destination, an item, a refused step, a door",
  }),
  Object.freeze({
    id: "location-bound position",
    says: "a position written with its location (`Farm:64,15`): a warp, not a walk",
  }),
  Object.freeze({ id: "no position", says: "the fact stated no coordinate at all" }),
  Object.freeze({ id: "unparseable", says: "a BRIDGE_FACT line whose payload is not JSON" }),
]);

const COORDINATE = /^-?\d+,-?\d+$/u;
const BOUND_COORDINATE = /^(?:[A-Za-z_][\w]*:)?-?\d+,-?\d+$/u;
const FACT_PREFIX = "BRIDGE_FACT";
const ACCOUNT_PREFIX = "GAME_TURN_ACCOUNT";

const DEFAULT_METHOD =
  "JSON parse of every BRIDGE_FACT line, position taken from evidence.detail by key; Manhattan |dx|+|dy|";

function fieldsOf(detail) {
  const out = new Map();
  for (const part of detail.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at), part.slice(at + 1));
  }
  return out;
}

function carrierOf(reason) {
  return CARRIERS.find((carrier) => carrier.match.test(reason)) ?? null;
}

function positionIn(fields) {
  const key = POSITION_KEYS.find((name) => COORDINATE.test(fields.get(name) ?? ""));
  if (key === undefined) return null;
  const [x, y] = fields.get(key).split(",").map(Number);
  return { x, y, key };
}

/** A position written with the location it belongs to - a warp's `Farm:64,15`. Readable, and not a walk. */
function boundPositionIn(fields) {
  return [...fields.values()].some(
    (value) => BOUND_COORDINATE.test(value) && !COORDINATE.test(value),
  );
}

/**
 * The Manhattan minimum spanning tree over a set of positions, O(n^2) Prim.
 *
 * It is the lower bound the account prints: a visiting order is a spanning tree with two ends left open, so its length
 * is at least this tree's weight. Ties are broken by scan order, which cannot change the weight.
 */
export function manhattanSpanningTree(positions) {
  if (positions.length === 0) return 0;
  const inTree = new Set([0]);
  let total = 0;
  while (inTree.size < positions.length) {
    let best = Number.POSITIVE_INFINITY;
    let bestNode = -1;
    for (const from of inTree) {
      for (let to = 0; to < positions.length; to += 1) {
        if (inTree.has(to)) continue;
        const distance = Math.abs(positions[from].x - positions[to].x) + Math.abs(positions[from].y - positions[to].y);
        if (distance < best) {
          best = distance;
          bestNode = to;
        }
      }
    }
    inTree.add(bestNode);
    total += best;
  }
  return total;
}

/** A leg's length: the only arithmetic in the file, in one place so the reading and the tests cannot disagree. */
export function manhattanLeg(from, to) {
  return Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
}

/**
 * One walking reading of one log.
 *
 * `source` is carried into the census so the number can be re-derived by the next reader.
 */
export function readWalking(text, { source = "the log", method = DEFAULT_METHOD } = {}) {
  const examined = [];
  const buckets = [];
  const bodyPositions = [];
  const worldChanging = new Map();
  const carriers = new Map();
  const accountLines = [];

  const tally = (key) => carriers.set(key, (carriers.get(key) ?? 0) + 1);

  for (const line of String(text).split(/\r?\n/u)) {
    const space = line.indexOf(" ");
    if (space >= 0 && line.slice(0, space) === ACCOUNT_PREFIX) {
      accountLines.push(line);
      continue;
    }
    if (space < 0 || line.slice(0, space) !== FACT_PREFIX) continue;
    examined.push(line.slice(0, 160));
    let fact;
    try {
      fact = JSON.parse(line.slice(space + 1));
    } catch {
      buckets.push("unparseable");
      tally("unparseable");
      continue;
    }
    const reason = fact.reasonCode ?? "";
    const fields = fieldsOf(fact.evidence?.detail ?? fact.worldFactPayload?.evidence?.detail ?? "");
    if (WORLD_CHANGING_SETTLEMENT.test(reason) && typeof fact.executionId === "string") {
      worldChanging.set(fact.executionId, fact.worldFactPayload?.actionId ?? "?");
    }
    const carrier = carrierOf(reason);
    if (carrier === null) {
      const plain = positionIn(fields) !== null;
      buckets.push(plain ? "not the body" : boundPositionIn(fields) ? "location-bound position" : "no position");
      tally(reason === "" ? "uncarried:no_reason" : `uncarried:${reason}`);
      continue;
    }
    tally(carrier.id);
    if (carrier.position !== "body" && carrier.position !== "subject") {
      buckets.push("not the body");
      continue;
    }
    const position = positionIn(fields);
    if (position === null) {
      buckets.push("subject without a tile");
      tally(`${carrier.id}:no_tile`);
      continue;
    }
    buckets.push("body position");
    tally(`${carrier.id}:placed`);
    bodyPositions.push(
      Object.freeze({
        ...position,
        reason,
        carrier: carrier.id,
        atMs: typeof fact.atMs === "number" ? fact.atMs : null,
        executionId: typeof fact.executionId === "string" ? fact.executionId : null,
      }),
    );
  }

  const positions = bodyPositions.filter(
    (position, index) =>
      index === 0 || position.x !== bodyPositions[index - 1].x || position.y !== bodyPositions[index - 1].y,
  );
  const legs = [];
  for (let index = 1; index < positions.length; index += 1) {
    legs.push(manhattanLeg(positions[index - 1], positions[index]));
  }
  const walked = legs.reduce((sum, leg) => sum + leg, 0);
  const bound = manhattanSpanningTree(positions);
  const actions = [...worldChanging.entries()].map(([id, action]) => Object.freeze({ id, action }));
  const examinedCount = examined.length;

  const examinedFacts = examined.map((line, index) => Object.freeze({ line, bucket: buckets[index] }));
  const placement =
    examinedFacts.length === 0
      ? null
      : census(examinedFacts, (fact) => fact.bucket, {
          unit: "facts",
          source,
          method,
          window: { wholeRun: true },
        });

  return Object.freeze({
    source,
    method,
    examined: examinedCount,
    placed: bodyPositions.length,
    unplaced: examinedCount - bodyPositions.length,
    restated: bodyPositions.length - positions.length,
    positioned: positions.length,
    positions: Object.freeze(positions),
    legs: Object.freeze(legs),
    walked,
    longest: legs.length === 0 ? 0 : Math.max(...legs),
    bound,
    excess: walked - bound,
    worldChanging: Object.freeze(actions),
    perAction: actions.length === 0 ? null : walked / actions.length,
    sessionAccount: Object.freeze({
      lines: accountLines.length,
      readings: WALKING_READINGS.filter((reading) =>
        accountLines.some((line) => line.includes(`${reading.field} `)),
      ).length,
    }),
    carriers: Object.freeze(Object.fromEntries([...carriers.entries()].sort())),
    placement,
    version: WALKING_VERSION,
  });
}

/** The carriers that placed a fact, as `arrival 23, approach 17, settlement 4`: which facts carried a position. */
function placedCarriers(record) {
  return Object.entries(record.carriers)
    .filter(([key]) => key.endsWith(":placed"))
    .map(([key, total]) => `${key.slice(0, -":placed".length)} ${String(total)}`)
    .join(", ");
}

/**
 * The reading as the account prints it: every declared field on a line with its number, and the bound on its own line
 * beside the number it qualifies.
 *
 * `guard` is what `a_run_does_not_report_its_walking` checks, and it is the rendered text itself rather than the record:
 * a reading that exists in the record and not in the sentence a player or a reviewer reads is not reported.
 */
export function renderWalking(record) {
  if (record.placement === null) {
    return `walking: not measured (${record.source} holds no BRIDGE_FACT line, so this was not a run)\n`;
  }
  const perAction =
    record.perAction === null
      ? "not measured (no world-changing action settled)"
      : `${String(Math.round(record.perAction))} (${String(record.worldChanging.length)} world-changing actions)`;
  const lines = [
    `walking: ${fieldOf("walked")} ${String(record.walked)} tiles · ` +
      `${fieldOf("positioned")} ${String(record.positioned)} (${String(record.placed)} facts stated a body position, ` +
      `${String(record.restated)} restated the position before) · ` +
      `${fieldOf("perAction")} ${perAction} · ` +
      `${fieldOf("longest")} ${String(record.longest)} tiles`,
    `walking bound: ${fieldOf("bound")} ${String(record.bound)} tiles (Manhattan spanning tree over the same ` +
      `${String(record.positioned)} positions: no visiting order can be shorter) · ` +
      `${fieldOf("excess")} ${String(record.excess)} tiles`,
    `walking placement: ${formatCensus(record.placement)} · restated ${String(record.restated)} of ` +
      `${String(record.placed)} · body position carried by ${placedCarriers(record)}`,
    `walking in the run's own account: ${String(record.sessionAccount.readings)} of ` +
      `${String(WALKING_READINGS.length)} readings over ${String(record.sessionAccount.lines)} GAME_TURN_ACCOUNT ` +
      "line(s) - this reader is where the distance is measured",
  ];
  return lines.join("\n");
}

/** The label a declared reading prints under. One lookup, so the record, the renderer and the gate cannot drift. */
export function fieldOf(id) {
  const declared = WALKING_READINGS.find((reading) => reading.id === id);
  if (declared === undefined) throw new Error(`no walking reading declared as ${id}`);
  return declared.field;
}

/**
 * The gate over a rendered account: every declared reading, by name, or the account does not report its walking.
 *
 * The population is `WALKING_READINGS` - the declaration the product's own account would adopt - and not a list of the
 * fields this function happens to know, so adding a reading without rendering it fails here the first time.
 */
export function auditWalkingAccount(rendered) {
  const text = String(rendered);
  const findings = [];
  for (const reading of WALKING_READINGS) {
    if (!text.includes(`${reading.field} `)) {
      findings.push({
        code: `a_run_does_not_report_its_walking:${reading.id}`,
        detail: `the account printed no \`${reading.field}\`; it is declared as "${reading.says}" (${reading.unit})`,
      });
    }
  }
  return findings;
}

/**
 * The partition gate: `unplaced 0` is a measurement only when every examined fact was read, and a log with no body
 * position is BLOCKED rather than green.
 *
 * Returns `{ verdict, findings }` where the verdict is `measured`, `blocked` or `abbreviated`.
 */
export function auditWalkingMeasurement(record, label = record.source) {
  const findings = [];
  if (record.examined === 0) {
    return {
      verdict: "blocked",
      code: "walking_not_measured",
      findings: [
        { code: `walking_not_measured:${label}`, detail: "the log holds no BRIDGE_FACT line: this was not a run" },
      ],
    };
  }
  if (record.positioned === 0) {
    return {
      verdict: "blocked",
      code: "walking_nothing_to_place",
      findings: [
        {
          code: `walking_nothing_to_place:${label}`,
          detail:
            `${String(record.examined)} facts and not one body position: nothing was measured, ` +
            "which is not walked 0",
        },
      ],
    };
  }
  if (record.placement.counted !== record.placement.examined) {
    findings.push({
      code: `walking_is_measured_not_abbreviated:${label}`,
      detail:
        `examined ${String(record.placement.examined)} facts but accounted for ${String(record.placement.counted)}: ` +
        "every fact has to land in a named bucket, or the unplaced reading is an abbreviation",
    });
  }
  if (record.examined !== record.placed + record.unplaced) {
    findings.push({
      code: `walking_is_measured_not_abbreviated:${label}`,
      detail:
        `${String(record.examined)} examined, ${String(record.placed)} placed + ` +
        `${String(record.unplaced)} unplaced`,
    });
  }
  return { verdict: findings.length === 0 ? "measured" : "abbreviated", code: null, findings };
}
