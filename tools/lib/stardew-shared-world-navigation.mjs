import { executeFresh, waitForFreshSnapshot, waitForTerminal } from "./stardew-native-smoke-harness-v1.mjs";

/**
 * Shared-world actor locomotion built only from already published actions.
 *
 * A shared world's acting Farmhand starts in its own Cabin interior, while a
 * scenario target usually lives on another map. Native-local fixtures hide that
 * distance by warping their actor during setup, but in a real shared world the
 * companion must walk there itself: discover, move, arrive, act. These helpers
 * express exactly that using `move_to_tile` plus `travel`, so no fixture-only
 * capability and no Host-side teleport is involved.
 *
 * They produce ordinary execution receipts and change no action contract.
 */

const MAX_ROUTE_HOPS = 4;
const DEFAULT_STEP_TIMEOUT_MS = 20_000;

// Bounded wait for a target whose acceptable set is momentarily empty because the
// target is moving. A Pet's still behaviours last about 1.7s on average
// (RandomChance 0.01 per tick), so 20 polls a second apart covers it several
// times over without letting a permanently-moving target hang the driver.
const WAIT_FOR_TARGET_POLLS = 20;
const WAIT_FOR_TARGET_INTERVAL_MS = 1000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Observe a fresh actionable snapshot, tolerating an equal-revision projection.
 *
 * A native transition mints one new revision and publishes its terminal receipt.
 * The bridge admits that revision once and then clears its placeholder, so every
 * later solicited observation carrying the *same* revision is refused. Passive
 * field changes such as `CanMove` settling after a warp do not mint a revision,
 * so a strict "wait for a newly admitted actionable snapshot" loop can never
 * complete here.
 *
 * This is not a weakening of any gate. The snapshot's `actionable` flag is only
 * a projection; every execution request is re-admitted on the game thread
 * against the live `Game1.activeClickableMenu`/`eventUp`/`CanMove`/tool state,
 * so a stale projection can never authorize a request that the Mod would reject.
 * The fallback is bounded and only accepts a projection that describes a real
 * placement rather than the unloaded placeholder.
 */
async function freshActionable(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await waitForFreshSnapshot(client, { requireActionable: true, timeoutMs: Math.max(1, deadline - Date.now()) });
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/native_fresh_snapshot_timeout/.test(error.message)) throw error;
    }
    const cached = client.state?.snapshot ?? null;
    if (cached !== null && typeof cached.location === "string" && cached.location.length > 0 && cached.location !== "unknown" && Number.isSafeInteger(cached.tile?.x) && cached.tile.x >= 0) {
      return cached;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("native_fresh_snapshot_timeout");
}

/** Human-readable tile used in reason codes and trace entries. */
function tileOf(value) {
  return value && Number.isInteger(value.x) && Number.isInteger(value.y) ? value : null;
}

/** Chebyshev adjacency, matching the Mod's interaction radius. */
export function isAdjacent(left, right) {
  return Number.isInteger(left?.x) && Number.isInteger(left?.y) && Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}

/** The eight tiles within Chebyshev 1 of a tile, plus the tile itself. */
export function candidateStandingTiles(target) {
  const tiles = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) tiles.push({ x: target.x + dx, y: target.y + dy });
  }
  // Prefer the tile itself, then orthogonal neighbours, then diagonals: a
  // diagonal is a legitimate Chebyshev-1 standing position but is a worse
  // default when an orthogonal one is free.
  return tiles.sort((left, right) => rank(left, target) - rank(right, target));
}

function rank(tile, target) {
  const distance = Math.max(Math.abs(tile.x - target.x), Math.abs(tile.y - target.y));
  const orthogonal = (tile.x === target.x) !== (tile.y === target.y) ? 0 : 1;
  return distance * 10 + orthogonal;
}

/**
 * Walk the actor onto one exact tile in its current location.
 * Returns the terminal receipt, or null when the tile is not reachable.
 */
export async function moveToTile(client, receipts, tile, trace, { timeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  const snapshot = await freshActionable(client, timeoutMs);
  const requestId = `shared_world_move_${Date.now()}_${tile.x}_${tile.y}`;
  const args = { x: tile.x, y: tile.y };
  let accepted;
  try {
    accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: "move_to_tile",
      args,
      snapshot,
      timeoutMs,
    });
  } catch (error) {
    // A refusal here names a reason the receipt never will, because no execution
    // was ever created. Record exactly what was sent alongside it: the request is
    // rejected for its own shape, so the shape is the evidence.
    throw new Error(
      `${String(error?.message ?? error)} [request={action=move_to_tile,args=${JSON.stringify(args)},expectedRevision=${snapshot?.revision},actionable=${snapshot?.actionable}}]`,
      { cause: error },
    );
  }
  const terminal = await waitForTerminal(receipts, accepted, timeoutMs);
  trace.push({
    step: "move_to_tile",
    tile,
    state: terminal.state,
    reasonCode: terminal.reasonCode,
    // Carry the receipt's own evidence. A native path that ends short of its
    // target reports where it stopped and where it was told to go; without that
    // the only visible fact is "it failed", which cannot distinguish an
    // unreachable tile from an occupied one or from a path that ran out of time.
    evidence: terminal.evidence ?? null,
  });
  return terminal.state === "succeeded" && terminal.reasonCode === "target_reached" ? terminal : null;
}

/** Traverse one location warp from an adjacent standing tile. */
async function traverseWarp(client, receipts, warp, trace, { timeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  const source = { x: warp.sourceX, y: warp.sourceY };
  const arrived = await moveToTile(client, receipts, source, trace, { timeoutMs });
  if (arrived === null) return null;
  const snapshot = await freshActionable(client, timeoutMs);
  // `enter_exit` resolves the door form of the warp and `travel` the plain map
  // warp form. A Cabin door is reachable both ways, so try the door form first
  // and fall back to the map form rather than guessing from location type.
  for (const action of ["enter_exit", "travel"]) {
    const requestId = `shared_world_warp_${action}_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action,
      args: { x: warp.sourceX, y: warp.sourceY },
      snapshot,
      timeoutMs,
    });
    const terminal = await waitForTerminal(receipts, accepted, timeoutMs);
    trace.push({ step: action, source, state: terminal.state, reasonCode: terminal.reasonCode });
    if (terminal.state !== "succeeded") continue;
    const after = await freshActionable(client, timeoutMs);
    if (after.location === warp.targetLocation) return after;
  }
  return null;
}

/**
 * Move the actor into `targetLocationName`, following location warps only as far
 * as the bounded hop limit allows. Fails closed when no advertised route exists.
 */
export async function ensureActorAtLocation(client, receipts, targetLocationName, { timeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  const trace = [];
  for (let hop = 0; hop < MAX_ROUTE_HOPS; hop++) {
    const snapshot = await freshActionable(client, timeoutMs);
    if (snapshot.location === targetLocationName) return { snapshot, trace };
    const warp = (snapshot.warps ?? []).find((candidate) => candidate?.targetLocation === targetLocationName);
    if (warp === undefined) throw new Error(`no_advertised_route:${snapshot.location}->${targetLocationName}`);
    const arrived = await traverseWarp(client, receipts, warp, trace, { timeoutMs });
    if (arrived === null) throw new Error(`warp_traversal_failed:${snapshot.location}->${targetLocationName}`);
  }
  throw new Error(`location_route_hop_limit:${targetLocationName}`);
}

/**
 * Move the actor to a standing tile that satisfies the contract.
 *
 * `standingTiles(snapshot)` returns the ordered acceptable positions. The helper
 * walks to the first reachable one and verifies arrival against that same set; it
 * never weakens the contract's own precondition, only chooses where to stand so
 * that precondition can hold.
 */
export async function ensureStandingTile(client, receipts, targetLocationName, standingTiles, { timeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  const { snapshot, trace } = await ensureActorAtLocation(client, receipts, targetLocationName, { timeoutMs });
  const usable = new Map(standingTiles(snapshot).map((tile) => [`${tile.x},${tile.y}`, tile]));
  if (usable.size === 0) throw new Error("no_usable_standing_tile");
  if (usable.has(`${snapshot.tile.x},${snapshot.tile.y}`)) return { snapshot, trace };
  for (const [key, tile] of usable) {
    const terminal = await moveToTile(client, receipts, tile, trace, { timeoutMs });
    if (terminal === null) continue;
    const after = await freshActionable(client, timeoutMs);
    if (usable.has(`${after.tile.x},${after.tile.y}`)) return { snapshot: after, trace };
  }
  throw new Error("no_reachable_standing_tile");
}

/**
 * Ensure the actor stands ON one of the tiles `targets` reports for a target in
 * `targetLocationName`, re-reading the target after arriving.
 *
 * `targets(snapshot)` returns the tiles the actor must occupy for the contract to
 * hold -- for a moving target, the neighbours of where it is now.
 *
 * A shared world is a live world, not a frozen fixture: a Pet walks, so the tile
 * set read before the walk is evidence about where the target *was*. Each attempt
 * therefore re-derives the set from a fresh observation after arriving, and the
 * walk is planned against the tile the actor must stand on rather than against
 * proximity to it. Being merely near an acceptable tile is not the contract: from
 * a target's neighbour's neighbour the actor is two tiles from the target, which
 * is outside the action's own range. The helper never widens an action's own
 * interaction range - it only chooses where to stand, and the contract under test
 * re-reads and re-admits the target itself.
 */
export async function ensureAdjacentToFreshTarget(
  client,
  receipts,
  targetLocationName,
  targets,
  { attempts = 1, timeoutMs = DEFAULT_STEP_TIMEOUT_MS, waitPolls = WAIT_FOR_TARGET_POLLS, waitIntervalMs = WAIT_FOR_TARGET_INTERVAL_MS } = {},
) {
  const trace = [];
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { snapshot } = await ensureActorAtLocation(client, receipts, targetLocationName, { timeoutMs });
      // Waiting is the whole point for a target that moves on its own. A Pet
      // wanders continuously and settles only for a while (its "SitDown"/
      // "SitSide" behaviours, each about 1.7s on average at RandomChance 0.01 per
      // tick), so at any given instant the acceptable set may be empty through no
      // fault of the caller. Giving up on the first empty set would make the
      // outcome depend on the sampling instant; retrying forever would hang. So
      // each attempt observes again after a short pause, within a bounded budget,
      // and the last observation's failure is what gets reported.
      let usable = new Map(targets(snapshot).map((tile) => [`${tile.x},${tile.y}`, tile]));
      for (let wait = 0; usable.size === 0 && wait < waitPolls; wait++) {
        await delay(waitIntervalMs);
        const polled = await freshActionable(client, timeoutMs);
        usable = new Map(targets(polled).map((tile) => [`${tile.x},${tile.y}`, tile]));
        if (usable.size > 0) {
          const settled = usable.get(`${polled.tile.x},${polled.tile.y}`);
          if (settled !== undefined) return { snapshot: polled, trace, target: settled };
          break;
        }
      }
      if (usable.size === 0) throw new Error("no_usable_target_tile");
      const here = usable.get(`${snapshot.tile.x},${snapshot.tile.y}`);
      if (here !== undefined) return { snapshot, trace, target: here };

      let lastCandidateError = null;
      for (const [key, tile] of usable) {
        const terminal = await moveToTile(client, receipts, tile, trace, { timeoutMs });
        if (terminal === null) {
          lastCandidateError = new Error(`target_tile_unreachable:${key}`);
          continue;
        }
        // Between reading the target and arriving it may have moved, so the set
        // that was valid when the walk started says nothing about where it is now.
        const after = await freshActionable(client, timeoutMs);
        const nowUsable = new Map(targets(after).map((t) => [`${t.x},${t.y}`, t]));
        const arrived = nowUsable.get(`${after.tile.x},${after.tile.y}`);
        if (arrived !== undefined) return { snapshot: after, trace, target: arrived };
        lastCandidateError = new Error("target_moved_before_arrival");
      }
      throw lastCandidateError ?? new Error("no_reachable_target_tile");
    } catch (error) {
      lastError = error;
    }
  }
  // Attach the trace to the failure. The trace holds one entry per attempt with
  // each move's state and its receipt evidence, which is the only record of WHERE
  // the walk stopped and WHERE it was told to go. Throwing it away leaves
  // "target_tile_unreachable:28,34" as the whole story, which cannot distinguish
  // an unreachable tile from an occupied one from a path that ran out of time.
  const failure = lastError ?? new Error("no_reachable_target_tile");
  failure.trace = trace;
  throw failure;
}

/**
 * Ensure the actor stands within Chebyshev 1 of `target.tile` in
 * `target.location`, walking across locations first when necessary.
 */
export async function ensureAdjacentTo(client, receipts, target, { timeoutMs = DEFAULT_STEP_TIMEOUT_MS } = {}) {
  const tile = tileOf(target?.tile);
  if (tile === null) throw new Error("invalid_target_tile");
  if (typeof target?.location !== "string" || target.location.length === 0) throw new Error("invalid_target_location");
  const { snapshot, trace } = await ensureActorAtLocation(client, receipts, target.location, { timeoutMs });
  if (isAdjacent(snapshot.tile, tile)) return { snapshot, trace };
  for (const candidate of candidateStandingTiles(tile)) {
    if (candidate.x < 0 || candidate.y < 0) continue;
    const terminal = await moveToTile(client, receipts, candidate, trace, { timeoutMs });
    if (terminal === null) continue;
    const after = await freshActionable(client, timeoutMs);
    if (isAdjacent(after.tile, tile)) return { snapshot: after, trace };
  }
  throw new Error("no_reachable_adjacent_tile");
}
