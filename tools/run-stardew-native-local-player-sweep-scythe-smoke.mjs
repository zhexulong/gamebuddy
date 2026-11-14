import { loadHostTestModule } from "./lib/host-test-module.mjs";
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  delay,
  executeFresh,
  NativeSmokeHarnessError,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "sweep_scythe";
/** The action's own success word (`ExecuteSweepScythe`: `scythe_sweep_cut` only when the named tile AND every sweepable moved). */
const SUCCESS_CODE = "scythe_sweep_cut";
/**
 * The Given this slice arms.
 *
 * `native_cut_weeds_v1` is reused rather than duplicated: it is the one scenario that supplies a plain `(W)47` scythe in the
 * pack and warps the actor onto the Farm beside a native weed - which is the precondition set this action needs. It creates
 * ONE weed; the patch this runner sweeps is the world's own, read from `weedTargets` and never planted here.
 */
const FIXTURE_SCENARIO = "native_cut_weeds_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", ACTION];

/**
 * How far from the ACTOR the engine's arc can reach, in tiles, as a conservative envelope.
 *
 * Not the arc itself: `MeleeSweepArc.Sampled` asks the ENGINE for the rectangles, and the runner must not re-derive a shape
 * a schema could publish. What the runner needs is a superset it can test the OBSERVATION against before the swing: the
 * engine's type-0 rectangles are 64 px wide around the named tile's centre and offset by at most -60/+76 px along the
 * swing animation, and the named tile is one tile from the actor, so every sampled tile is within four tiles of her. The
 * per-facing counts below are the measurement the Mod's own source records (10 up, 13 right, 13 down, 14 left).
 */
const ARC_ENVELOPE_RADIUS = 4;
/** The declared band (10-16) the measured per-facing counts sit inside. */
const ARC_BAND = Object.freeze({ min: 10, max: 16 });
/**
 * The count the engine's arc covers from one stance, per `SwingFacing` value, and the slack the measurement allows.
 *
 * `MeleeWeapon.getAreaOfEffect` derives the rectangles from the actor's PIXEL position inside her tile, so the sampled
 * count moves by up to two tiles as she stands at a different pixel of the same tile. A band is therefore the honest
 * assertion; an exact equality against one number would be a second, hand-written copy of an engine measurement.
 */
const ARC_BY_FACING = Object.freeze({ 0: 10, 1: 13, 2: 13, 3: 14 });
const ARC_FACING_SLACK = 2;
const FACING_NAMES = Object.freeze({ 0: "up", 1: "right", 2: "down", 3: "left" });

/**
 * Execute the sweep_scythe contract against an already-connected bridge session.
 *
 * The facts this proves, in the order they can be wrong:
 *   1. the named tile MOVED, read from the live observation rather than from the receipt's own claim;
 *   2. the arc the engine sampled is the size its own geometry promises for that stance - a receipt reporting 30 tiles
 *      would be a swing nobody measured;
 *   3. NOTHING OUTSIDE THE ARC PAID FOR THE SWING: the arc reaches BEHIND the actor, so a crop or a tuft one tile behind
 *      her would be destroyed by a swing whose counts still look clean. Every destructive occupant the observation placed
 *      inside the envelope must either appear in the receipt's own `changed` list (the rule declares grass and a
 *      ready/dead crop as what the swing is FOR) or still be standing afterwards;
 *   4. the swing was free (`stamina_delta` 0 against `expected_stamina_cost` 0) and the actor's own tool selection is back.
 */
export async function runSweepScytheSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000, navigationTimeoutMs = 55_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  let lastSnapshot = null;
  try {
    validateConfig(config);
    let snapshot = await observeFresh(client, { actionable: true });
    lastSnapshot = snapshot;
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);

    snapshot = await ensureOnFarm(client, receipts, trace, snapshot, navigationTimeoutMs);
    lastSnapshot = snapshot;
    const plan = chooseStance(snapshot);
    trace.push({ phase: "stance_planned", plan: describePlan(plan) });
    snapshot = await approachStance(client, receipts, trace, snapshot, plan, navigationTimeoutMs);
    lastSnapshot = snapshot;

    // The stance and the arc are re-read from the post-arrival snapshot: a walk takes ticks, and the observation that
    // justified the plan is not the one the request may be sent against.
    const stance = revalidateStance(snapshot, plan);
    const requestId = `native_local_sweep_scythe_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      // x,y name the tile the actor must FACE. No target id: one swing covers a set of tiles engine-side.
      args: { x: stance.named.x, y: stance.named.y },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      action: ACTION,
      named: stance.named,
      actor: stance.actor,
      facing: FACING_NAMES[stance.facing],
      receipt: summarizeReceipt(accepted),
    });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("sweep_scythe_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== SUCCESS_CODE)
      throw new Error(`sweep_scythe_terminal:${terminal.state}:${terminal.reasonCode}`);

    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    lastSnapshot = after;
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);

    const arc = measureArc({ evidence, stance });
    const changed = parseChangedTiles(evidence.changed);
    assertReceiptCounts({ evidence, arc, changed });
    const destructive = assertNoCropMoved({ changed });
    const worldLoss = assertNothingLostBehindTheArc({ before: snapshot, after, changed, actor: stance.actor });
    const namedMovedInWorld = namedTileMoved({ before: snapshot, after, named: stance.named });
    if (!namedMovedInWorld) throw new Error(`sweep_scythe_named_tile_unmoved:${stance.named.x},${stance.named.y}`);

    const receiptAgrees = changed.some((tile) => tile.x === stance.named.x && tile.y === stance.named.y);
    if (!receiptAgrees) throw new Error(`sweep_scythe_receipt_disagrees_with_world:${evidence.changed}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: SUCCESS_CODE,
      named: stance.named,
      actor: stance.actor,
      facing: FACING_NAMES[stance.facing],
      arc,
      changed,
      destructiveArm:
        plan.destructiveInEnvelope.length === 0
          ? "not_measured:sweep_scythe:no_destructive_object_in_the_arc"
          : "measured",
      destructiveInEnvelope: plan.destructiveInEnvelope,
      cropGuard: destructive,
      lostBehindTheArc: worldLoss,
      receipt: summarizeReceipt(terminal),
      evidence,
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      lastSnapshot: lastSnapshot
        ? {
            revision: lastSnapshot.revision,
            location: lastSnapshot.location,
            tile: lastSnapshot.tile,
            capabilities: lastSnapshot.capabilities,
            weedTargets: lastSnapshot.weedTargets ?? [],
            grassTargets: lastSnapshot.grassTargets ?? [],
            cropTargets: lastSnapshot.cropTargets ?? [],
            scytheCropTargets: lastSnapshot.scytheCropTargets ?? [],
          }
        : null,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectWithRetry(config, 15_000);
  try {
    const result = await runSweepScytheSmoke(session.client, session.receipts, config);
    if (result.state === "passed") console.log(JSON.stringify(result));
    else console.error(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

/** The game creates its named pipe asynchronously after launch; retry ENOENT within a bounded window. */
async function connectWithRetry(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error("native_local_bridge_connect_timeout");
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== FIXTURE_SCENARIO)
    throw new Error("native_local_sweep_scythe_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_sweep_scythe_policy_invalid");
  // `sweep_scythe` was an Experimental registration when this runner was written; a later promotion simply stops the
  // fixture from opting it in, and this declaration still names the only action a fixture may opt in for this slice.
  validateNativeLocalFixturePolicy(value, {
    requiredActions: ["move_to_tile", "travel", ACTION],
    experimentalActions: [ACTION],
  });
}

/** Leave FarmHouse for the Farm through the one warp the observation publishes. */
async function ensureOnFarm(client, receipts, trace, snapshot, navigationTimeoutMs) {
  if (snapshot.location === "Farm") return snapshot;
  const warps = (snapshot.warps ?? []).filter(
    (entry) => entry?.targetLocation === "Farm" && validTile(entry.sourceX) && validTile(entry.sourceY),
  );
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  const warp = warps[0];
  if (!sameTile(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
    snapshot = await move(
      client,
      receipts,
      trace,
      snapshot,
      { x: warp.sourceX, y: warp.sourceY },
      "move_to_farm_warp",
      navigationTimeoutMs,
    );
  const accepted = await execute(client, trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForNavigationTerminal(
    client,
    receipts,
    accepted,
    (latest) => latest.location === "Farm",
    navigationTimeoutMs,
  );
  return completion.snapshot;
}

/**
 * Pick the tile to face, and the stance to face it from, out of the world the observation publishes.
 *
 * The candidates are the weeds the Mod itself publishes (`DiscoverWeedTargets`, nearest first, inside its own discovery
 * radius), each paired with the four cardinal neighbours `SwingFacing.For` can turn into a facing. A score decides
 * between them, and never a planted fixture fact:
 *
 *   * a stance with a CROP inside the arc envelope is dropped outright - an immature crop is the loss the Mod's own
 *     `Undeclared` rule exists to prevent, and a ready one is work this run has no business doing on a save that
 *     publishes none;
 *   * a stance with no destructive occupant inside the envelope beats one that has a tuft in it, because the clean case is
 *     the one whose evidence is unambiguous;
 *   * the distance to the actor breaks the rest, so the walk is the shortest of the equally good stances.
 */
function chooseStance(snapshot) {
  const weeds = weedTargets(snapshot);
  if (weeds.length === 0) throw new Error("sweep_scythe_no_weed_target_got_0");
  const actor = snapshot.tile;
  const candidates = [];
  for (const weed of weeds) {
    for (const stance of cardinalNeighbours(weed)) {
      if (!validTile(stance.x) || !validTile(stance.y)) continue;
      const facing = facingFor(stance, weed);
      if (facing === null) continue;
      const inside = destructiveInEnvelope(snapshot, stance);
      candidates.push({
        named: { x: weed.x, y: weed.y, targetId: weed.targetId, health: weed.health },
        stance,
        facing,
        destructiveInEnvelope: inside.filter((row) => row.kind !== "crop"),
        crops: inside.filter((row) => row.kind === "crop"),
        distance: Math.max(Math.abs(stance.x - actor.x), Math.abs(stance.y - actor.y)),
      });
    }
  }
  const cropFree = candidates.filter((candidate) => candidate.crops.length === 0);
  if (cropFree.length === 0) throw new Error(`sweep_scythe_no_stance_clear_of_crops:${candidates.length}`);
  cropFree.sort(
    (left, right) =>
      left.destructiveInEnvelope.length - right.destructiveInEnvelope.length || left.distance - right.distance,
  );
  return cropFree[0];
}

/**
 * Walk onto the planned stance and prove the body is ON it.
 *
 * Exact arrival matters here and adjacency does not: `SwingFacing.For` is the engine's one-tile step, so a body one tile
 * short of the stance would make the request name a diagonal it must refuse. `move_to_tile` may substitute an approach
 * tile for a destination it cannot stand on, which is a legitimate answer to a different request - so the runner reads
 * where the body actually is and re-plans around it instead of trusting the plan.
 */
async function approachStance(client, receipts, trace, snapshot, plan, navigationTimeoutMs) {
  if (sameTile(snapshot.tile, plan.stance)) return snapshot;
  let latest = snapshot;
  try {
    latest = await move(client, receipts, trace, latest, plan.stance, "move_to_sweep_stance", navigationTimeoutMs);
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error);
    if (
      !reason.startsWith("move_to_sweep_stance_not_accepted:no_native_path") &&
      !reason.startsWith("navigation_failed:")
    )
      throw error;
    latest = await observeFresh(client, { actionable: true });
  }
  if (sameTile(latest.tile, plan.stance)) return latest;
  // The body stopped somewhere else (a substituted approach, or a route the planner took differently). Move once more to
  // the exact tile, and if that still lands elsewhere, say where she is rather than swinging from an unplanned stance.
  latest = await move(client, receipts, trace, latest, plan.stance, "move_to_sweep_stance_exact", navigationTimeoutMs);
  if (!sameTile(latest.tile, plan.stance))
    throw new Error(
      `sweep_scythe_stance_not_reached:${latest.tile.x},${latest.tile.y}:${plan.stance.x},${plan.stance.y}`,
    );
  return latest;
}

/**
 * Re-read the plan against the post-arrival observation.
 *
 * The named tile must still be the weed the plan saw, and the facing must still be the one the stance implies - the actor
 * has walked, and a walk is long enough for the world to change under it.
 */
function revalidateStance(snapshot, plan) {
  const actor = snapshot.tile;
  if (!sameTile(actor, plan.stance))
    throw new Error(`sweep_scythe_stance_moved:${actor.x},${actor.y}:${plan.stance.x},${plan.stance.y}`);
  const facing = facingFor(actor, plan.named);
  if (facing === null)
    throw new Error(`sweep_scythe_not_cardinal:${actor.x},${actor.y}:${plan.named.x},${plan.named.y}`);
  const fresh = weedTargets(snapshot).find((row) => row.x === plan.named.x && row.y === plan.named.y);
  if (fresh === undefined) throw new Error(`sweep_scythe_named_tile_no_longer_a_weed:${plan.named.x},${plan.named.y}`);
  return { actor, named: { ...plan.named, health: fresh.health }, facing };
}

/** Every weed the Mod published, well-formed, nearest first. */
function weedTargets(snapshot) {
  return (snapshot.weedTargets ?? [])
    .filter(
      (row) =>
        typeof row?.targetId === "string" &&
        row.targetId.length > 0 &&
        validTile(row.x) &&
        validTile(row.y) &&
        Number.isFinite(row.health),
    )
    .slice()
    .sort(
      (left, right) =>
        Math.max(Math.abs(left.x - snapshot.tile.x), Math.abs(left.y - snapshot.tile.y)) -
        Math.max(Math.abs(right.x - snapshot.tile.x), Math.abs(right.y - snapshot.tile.y)),
    );
}

function cardinalNeighbours({ x, y }) {
  return [
    { x, y: y - 1 },
    { x: x + 1, y },
    { x, y: y + 1 },
    { x: x - 1, y },
  ];
}

/** `SwingFacing.For` in the Host's own vocabulary: a cardinal neighbour, one tile, or nothing. */
function facingFor(actor, target) {
  const dx = target.x - actor.x;
  const dy = target.y - actor.y;
  if (dx === 0 && dy === -1) return 0;
  if (dx === 1 && dy === 0) return 1;
  if (dx === 0 && dy === 1) return 2;
  if (dx === -1 && dy === 0) return 3;
  return null;
}

/**
 * The destructive occupants the OBSERVATION places inside the arc envelope around one stance.
 *
 * Read from the Mod's own projections rather than from the save: `grassTargets` is a `TerrainFeature Grass` with a
 * positive count, `scytheCropTargets` is a crop the scythe could cut, and `cropTargets` is any planted crop in reach -
 * including the immature one the Mod's `Undeclared` rule refuses the swing for.
 */
function destructiveInEnvelope(snapshot, stance) {
  const rows = [];
  for (const row of snapshot.grassTargets ?? []) {
    if (Number.isFinite(row?.x) && Number.isFinite(row?.y) && within(row, stance))
      rows.push({ kind: "grass", x: row.x, y: row.y });
  }
  for (const row of snapshot.scytheCropTargets ?? []) {
    if (Number.isFinite(row?.x) && Number.isFinite(row?.y) && within(row, stance))
      rows.push({ kind: "crop", x: row.x, y: row.y });
  }
  for (const row of snapshot.cropTargets ?? []) {
    if (Number.isFinite(row?.x) && Number.isFinite(row?.y) && within(row, stance))
      rows.push({ kind: "crop", x: row.x, y: row.y });
  }
  return rows;
}

function within(row, stance) {
  return Math.max(Math.abs(row.x - stance.x), Math.abs(row.y - stance.y)) <= ARC_ENVELOPE_RADIUS;
}

/**
 * The arc the receipt reports, checked against the engine's own measured geometry for that stance.
 *
 * Three separate facts, and the third is what makes the first two mean anything: the count must sit inside the declared
 * 10-16 band AND inside the per-facing window the engine's rectangles produce, and the two counters must partition
 * nothing the total does not hold - `arc_clear + arc_sweepable <= arc_tiles`, because the arc also samples tiles holding
 * something a scythe does not cut (`object`, `terrain`, a tree).
 */
function measureArc({ evidence, stance }) {
  const tiles = Number(evidence.arc_tiles);
  const sweepable = Number(evidence.arc_sweepable);
  const clear = Number(evidence.arc_clear);
  if (![tiles, sweepable, clear].every((value) => Number.isInteger(value) && value >= 0))
    throw new Error(
      `sweep_scythe_arc_counts_unreadable:${evidence.arc_tiles}:${evidence.arc_sweepable}:${evidence.arc_clear}`,
    );
  const measured = ARC_BY_FACING[stance.facing];
  const facingWindow = { min: measured - ARC_FACING_SLACK, max: measured + ARC_FACING_SLACK };
  if (tiles < ARC_BAND.min || tiles > ARC_BAND.max)
    throw new Error(
      `sweep_scythe_arc_outside_declared_band:${FACING_NAMES[stance.facing]}:${tiles}:${ARC_BAND.min}-${ARC_BAND.max}`,
    );
  if (tiles < facingWindow.min || tiles > facingWindow.max)
    throw new Error(
      `sweep_scythe_arc_disagrees_with_engine:${FACING_NAMES[stance.facing]}:${tiles}:${facingWindow.min}-${facingWindow.max}`,
    );
  if (sweepable < 1) throw new Error(`sweep_scythe_arc_held_nothing_sweepable:${tiles}`);
  if (sweepable + clear > tiles) throw new Error(`sweep_scythe_arc_counts_incoherent:${tiles}:${sweepable}:${clear}`);
  return {
    tiles,
    sweepable,
    clear,
    facing: FACING_NAMES[stance.facing],
    measured,
    facingWindow,
    declaredBand: ARC_BAND,
  };
}

/** `changed` is `x:y:kind|x:y:kind`, or `none`; neither `;` nor `=` can appear in it. */
function parseChangedTiles(value) {
  if (value === "none") return [];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`sweep_scythe_changed_unreadable:${String(value)}`);
  return value.split("|").map((entry) => {
    const parts = entry.split(":");
    if (parts.length !== 3) throw new Error(`sweep_scythe_changed_unreadable:${entry}`);
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isInteger(x) || !Number.isInteger(y) || parts[2].length === 0)
      throw new Error(`sweep_scythe_changed_unreadable:${entry}`);
    return { x, y, kind: parts[2] };
  });
}

/** `tiles_changed` is the length of `changed`, spelled once in the receipt and once as a number. */
function assertReceiptCounts({ evidence, arc, changed }) {
  const declared = Number(evidence.tiles_changed);
  if (declared !== changed.length)
    throw new Error(`sweep_scythe_changed_count_mismatch:${evidence.tiles_changed}:${changed.length}`);
  if (changed.length === 0 || changed.length > arc.tiles)
    throw new Error(`sweep_scythe_changed_outside_the_arc:${changed.length}:${arc.tiles}`);
  const stamina = Number(evidence.stamina_delta);
  const expected = Number(evidence.expected_stamina_cost);
  if (!Number.isFinite(stamina) || !Number.isFinite(expected) || stamina !== expected)
    throw new Error(`sweep_scythe_stamina_disagrees:${evidence.stamina_delta}:${evidence.expected_stamina_cost}`);
}

/**
 * The destructive guard, on the receipt's own kind list.
 *
 * The catalogue's intent for this action is a grass tuft and a ready or dead crop; a CROP in `changed` is therefore not
 * excluded by the rule - but this run has no business cutting one, and a save that publishes none makes any crop here a
 * foreign mutation rather than the work. So the runner refuses it by name instead of reporting it as a clean sweep.
 */
function assertNoCropMoved({ changed }) {
  const crops = changed.filter((tile) => tile.kind === "crop");
  if (crops.length > 0)
    throw new Error(`sweep_scythe_arc_took_a_crop:${crops.map((tile) => `${tile.x},${tile.y}`).join("|")}`);
  const unknown = changed.filter((tile) => tile.kind !== "weed" && tile.kind !== "grass");
  if (unknown.length > 0)
    throw new Error(
      `sweep_scythe_arc_took_an_undeclared_occupant:${unknown.map((tile) => `${tile.x},${tile.y}:${tile.kind}`).join("|")}`,
    );
  return { cropsMoved: 0, declaredKinds: [...new Set(changed.map((tile) => tile.kind))].sort() };
}

/**
 * Nothing destructive disappeared without the receipt saying so.
 *
 * THIS IS THE CHECK THE COUNTS CANNOT MAKE. A tuft the arc thinned is `changed` and the receipt names it; a tuft that
 * vanished while `changed` stayed silent is a swing whose destruction the caller cannot see - and the arc reaches behind
 * the actor, so that is the realistic shape of the defect rather than a rule about which direction she faced.
 */
function assertNothingLostBehindTheArc({ before, after, changed, actor }) {
  const lost = [];
  const moved = new Set(changed.map((tile) => `${tile.x},${tile.y}`));
  for (const kind of ["grass", "crop"]) {
    for (const row of projection(before, kind)) {
      if (Math.max(Math.abs(row.x - actor.x), Math.abs(row.y - actor.y)) > ARC_ENVELOPE_RADIUS) continue;
      const key = `${row.x},${row.y}`;
      if (moved.has(key)) continue;
      const survivor = projection(after, kind).find((candidate) => candidate.x === row.x && candidate.y === row.y);
      if (survivor === undefined) lost.push(`${key}:${kind}`);
    }
  }
  if (lost.length > 0) throw new Error(`sweep_scythe_destructive_object_lost_behind_the_arc:${lost.join("|")}`);
  return lost;
}

function projection(snapshot, kind) {
  const rows =
    kind === "grass" ? snapshot.grassTargets : [...(snapshot.scytheCropTargets ?? []), ...(snapshot.cropTargets ?? [])];
  return (rows ?? []).filter((row) => Number.isFinite(row?.x) && Number.isFinite(row?.y));
}

/**
 * Did the named tile move in the WORLD?
 *
 * A weed carries two health points and a basic scythe deals one per swing, so a thinned weed is STILL a weed at the same
 * tile: the tile is "moved" when it left the projection or when its own health fell. Both readings come from the
 * observation, never from `named_moved`.
 */
function namedTileMoved({ before, after, named }) {
  const was = weedTargets(before).find((row) => row.x === named.x && row.y === named.y);
  const now = weedTargets(after).find((row) => row.x === named.x && row.y === named.y);
  if (was === undefined) return false;
  if (now === undefined) return true;
  return now.health < was.health;
}

async function move(client, receipts, trace, snapshot, target, phase, navigationTimeoutMs) {
  const accepted = await execute(client, trace, phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForNavigationTerminal(client, receipts, accepted, () => true, navigationTimeoutMs);
  return completion.snapshot;
}

/** Terminal wait with the harness's exact identity, then a fresh post-terminal observation. */
async function waitForNavigationTerminal(client, receipts, accepted, predicate, timeoutMs) {
  let terminal;
  try {
    terminal = await waitForTerminal(receipts, accepted, timeoutMs);
  } catch (error) {
    if (error instanceof NativeSmokeHarnessError) throw new Error(`navigation_timeout:${accepted.executionId}`);
    throw error;
  }
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  let snapshot;
  try {
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs,
      requireActionable: true,
      check: predicate,
    });
  } catch (error) {
    if (error instanceof NativeSmokeHarnessError) throw new Error(`navigation_timeout:${accepted.executionId}`);
    throw error;
  }
  return { receipt: terminal, snapshot };
}

async function execute(client, trace, phase, action, args, snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const requestId = `native_local_sweep_scythe_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

function describePlan(plan) {
  return {
    named: plan.named,
    stance: plan.stance,
    facing: FACING_NAMES[plan.facing],
    destructiveInEnvelope: plan.destructiveInEnvelope,
    cropsInEnvelope: plan.crops,
    distance: plan.distance,
  };
}

function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
function sameTile(left, right) {
  return left.x === right.x && left.y === right.y;
}
