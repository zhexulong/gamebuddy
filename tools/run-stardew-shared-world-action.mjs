import { readFile } from "node:fs/promises";
import { connectNativeLocalClient, waitForFreshSnapshot } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import {
  candidateStandingTiles,
  ensureActorAtLocation,
  ensureAdjacentToFreshTarget,
  ensureStandingTile,
} from "./lib/stardew-shared-world-navigation.mjs";
import { chooseOnlyShippingBinTarget } from "./run-stardew-native-local-player-ship-item-smoke.mjs";
import { chooseOnlyChestRetrieveTarget } from "./run-stardew-native-local-player-chest-retrieve-smoke.mjs";
import { chooseStationaryUnpettedPetTargets } from "./run-stardew-native-local-player-pet-animal-smoke.mjs";

/**
 * Shared-world action executor.
 *
 * The 43 native-local `run*Smoke` exports are already pure functions over an
 * already-connected bridge session: `(client, receipts, config, options)`. The
 * only thing that pinned them to one process was their `import.meta.main` block,
 * which reconnects through the immutable production loader. That loader is
 * currently unavailable (the release generation lacks the voice gateway
 * sidecar), so this executor performs the connection itself against the
 * compiled test artifact - the same carrier the native-local runners already
 * use - and then calls the very same exported contract function.
 *
 * It is an execution shim only. It selects no action semantics, weakens no
 * assertion, and produces no publish or closure decision.
 */
function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const clientConfigPath = option("--client-config");
const dumpSpatial = process.argv.includes("--dump-spatial");
const action = dumpSpatial ? null : option("--action");
if (!dumpSpatial && !/^[a-z][a-z0-9_]*$/.test(action)) throw new Error("invalid_action_id");

const config = JSON.parse((await readFile(clientConfigPath, "utf8")).replace(/^\uFEFF/, ""));

const runnerFile = dumpSpatial
  ? null
  : {
      machine_inspect: "run-stardew-native-local-player-machine-inspect-smoke.mjs",
      ship_item: "run-stardew-native-local-player-ship-item-smoke.mjs",
      chest_retrieve: "run-stardew-native-local-player-chest-retrieve-smoke.mjs",
      pet_animal: "run-stardew-native-local-player-pet-animal-smoke.mjs",
    }[action];
// The cross-day lifecycle is not a wire action: there is no execution request and
// no action receipt. The Mod on each side drives its own farmer through the
// native sleep path and writes its own evidence file; the driver only waits for
// that file and reports it. So it needs no runner and no target plan.
const isSleepLifecycle = !dumpSpatial && action === "sleep_lifecycle";
const lifecycleEvidence = isSleepLifecycle ? option("--lifecycle-evidence") : null;
if (isSleepLifecycle && !lifecycleEvidence) throw new Error("sleep_lifecycle_requires_lifecycle_evidence");
if (!dumpSpatial && !isSleepLifecycle && runnerFile === undefined)
  throw new Error(`shared_world_runner_not_wired:${action}`);

/**
 * How the driver reaches each wired action's target.
 *
 * The shared world's Farmhand starts in its Cabin, so the driver must first reach
 * the owning map. `standingTiles` then computes, from the arrival snapshot, the
 * ordered tiles the actor must stand on for the contract to pass. Every value
 * comes from the live snapshot rather than a pinned coordinate, so a changed
 * fixture cannot silently point the actor at a stale tile.
 *
 * A shared world is not an isolated fixture: the Farm legitimately carries a
 * dense machine block, so "exactly one machine adjacent" holds on only a few
 * tiles. Computing them directly is both correct and far cheaper than walking to
 * neighbouring tiles until one happens to qualify.
 */
function adjacentMachineCount(machines, tile) {
  return machines.filter((target) => Math.abs(target.x - tile.x) <= 1 && Math.abs(target.y - tile.y) <= 1).length;
}

/**
 * The eight tiles a contract's interaction radius accepts, nearest-first, with
 * the target's own occupied tile removed.
 *
 * Every contract here requires only Chebyshev-1 adjacency, so the target's own
 * tile is a legal standing position in principle; in practice a machine, chest
 * or building footprint occupies it, so routing there can only fail. Dropping
 * it keeps the walk bounded to tiles the actor can actually occupy, without
 * narrowing any contract's admission.
 */
function neighbourTiles(target) {
  return candidateStandingTiles(target).filter((tile) => tile.x !== target.x || tile.y !== target.y);
}

/**
 * Standing tiles beside the first candidate, or none when there is no candidate.
 *
 * Returning empty rather than throwing separates "nothing is acceptable at this
 * instant" from "this can never work". A moving target is momentarily
 * unacceptable and will settle; the caller's bounded wait turns that into a
 * retry, whereas an error here would end the attempt on whichever instant the
 * driver happened to look, making the outcome depend on sampling luck.
 */
function neighbourTilesOfFirst(candidates) {
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  return first === undefined ? [] : neighbourTiles(first);
}

/**
 * Sample the pet targets repeatedly and report what actually changed.
 *
 * Distinguishes a pet that is genuinely wandering from one that reports a moving
 * behaviour but is physically stuck: the first changes tile over time, the second
 * keeps the same tile with `stationary: false` forever. Those two cases need
 * opposite responses, and only observed positions can tell them apart.
 */
async function samplePetMotion(client, { samples = 6, intervalMs = 700 } = {}) {
  const observations = [];
  for (let i = 0; i < samples; i++) {
    try {
      const snapshot = await client.observe();
      const pets = Array.isArray(snapshot?.petTargets) ? snapshot.petTargets : [];
      observations.push({
        revision: snapshot?.revision ?? null,
        actorTile: snapshot?.tile ?? null,
        pets: pets.map((pet) => ({
          targetId: pet?.targetId ?? null,
          x: pet?.x ?? null,
          y: pet?.y ?? null,
          stationary: pet?.stationary ?? null,
        })),
      });
    } catch (error) {
      observations.push({ observeError: String(error?.message ?? error) });
    }
    if (i < samples - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const seen = new Map();
  let movingSamples = 0;
  let stillSamples = 0;
  for (const sample of observations) {
    for (const pet of sample.pets ?? []) {
      const key = pet.targetId ?? `${pet.x},${pet.y}`;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(`${pet.x},${pet.y}`);
      if (pet.stationary === true) stillSamples++;
      else movingSamples++;
    }
  }

  const distinctTiles = [...seen].map(([targetId, tiles]) => ({ targetId, tiles: [...tiles] }));
  return {
    samples: observations,
    // `observedTiles > 1` is real movement; `1` with stationary=false throughout is
    // a pet that cannot move despite its behaviour wanting to.
    distinctTiles,
    realMovement: distinctTiles.some((entry) => entry.tiles.length > 1),
    movingSamples,
    stillSamples,
    petVisible: distinctTiles.length > 0,
  };
}

const ACTION_TARGETS = {
  machine_inspect: {
    location: "Farm",
    // The contract proceeds only when exactly one machine is adjacent, so stand
    // on a tile touching exactly one machine. Tiles are ordered nearest-first to
    // keep the walk short, with deterministic tie-breaking.
    standingTiles: (snapshot) => {
      const machines = (snapshot?.machineTargets ?? []).filter(
        (target) => target?.targetId && Number.isInteger(target.x) && Number.isInteger(target.y),
      );
      if (machines.length === 0) return [];
      const origin = snapshot?.tile ?? { x: 0, y: 0 };
      const candidates = new Map();
      for (const machine of machines) {
        for (const tile of candidateStandingTiles({ x: machine.x, y: machine.y })) {
          if (tile.x < 0 || tile.y < 0) continue;
          if (adjacentMachineCount(machines, tile) !== 1) continue;
          candidates.set(`${tile.x},${tile.y}`, tile);
        }
      }
      const distance = (tile) => Math.max(Math.abs(tile.x - origin.x), Math.abs(tile.y - origin.y));
      return [...candidates.values()].sort(
        (left, right) => distance(left) - distance(right) || left.y - right.y || left.x - right.x,
      );
    },
  },
  ship_item: {
    location: "Farm",
    // `shippingBinTargets` is the native Farm Shipping Bin building with the
    // first shippable backpack slot the contract would hand to Farm.shipItem.
    standingTiles: (snapshot) => neighbourTiles(chooseOnlyShippingBinTarget(snapshot)),
  },
  chest_retrieve: {
    location: "Farm",
    // `chestRetrieveTargets` is the player-owned ordinary Chest holding the
    // item the contract would take.
    standingTiles: (snapshot) => neighbourTiles(chooseOnlyChestRetrieveTarget(snapshot)),
  },
  pet_animal: {
    location: "Farm",
    // `petTargets` is a live native Pet. A Pet walks -- its own native behaviour
    // decides when -- so unlike the frozen machine/chest/bin targets the tile must
    // be re-read from a fresh observation on every attempt instead of planned
    // once.
    //
    // Only stationary pets are offered, and "none right now" is an empty set rather
    // than an error so the helper's bounded wait can retry (see
    // `neighbourTilesOfFirst`). Walking to a pet that is mid-wander is a race the
    // driver cannot win: the pet picks a new facing every tick, so it leaves the
    // tile before the walk finishes, and while it moves it also blocks the tiles
    // the actor would use. Measured before this change: 20 moves accepted, 18
    // ending native_path_ended, actor never leaving its arrival tile. Preferring a
    // pet that is holding still is not a weakened contract -- pet_animal re-reads
    // and re-admits the target itself, and range is still Chebyshev 1 at dispatch
    // time -- it is choosing when to attempt, which is exactly what the published
    // `stationary` fact is for.
    freshTargetTiles: (snapshot) => neighbourTilesOfFirst(chooseStationaryUnpettedPetTargets(snapshot)),
  },
};

const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
try {
  if (dumpSpatial) {
    // Optionally walk to a location first, so the dump reports what the actor
    // can actually perceive once it is standing there rather than only what the
    // Cabin start position exposes.
    const reachLocation = process.argv.includes("--reach-location") ? option("--reach-location") : null;
    let reachTrace = null;
    let reachDiagnostic = null;
    if (reachLocation !== null) {
      try {
        const arrived = await ensureActorAtLocation(session.client, session.receipts, reachLocation, {});
        reachTrace = arrived.trace;
      } catch (error) {
        reachDiagnostic = { phase: "ensure_actor_at_location", error: String(error?.message ?? error) };
      }
    }
    let snapshot = null;
    let observeError = null;
    let pollTrace = null;
    if (process.argv.includes("--poll-trace")) {
      // Distinguish "the actor really is not actionable" from "no new snapshot
      // is being admitted" by recording each attempt's observable outcome.
      pollTrace = [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && pollTrace.length < 15) {
        try {
          const raw = await session.client.observe();
          pollTrace.push({
            revision: raw?.revision,
            location: raw?.location,
            tile: raw?.tile,
            actionable: raw?.actionable,
            activeExecution: raw?.activeExecution ?? null,
          });
          if (raw?.actionable === true) {
            snapshot = raw;
            break;
          }
        } catch (error) {
          pollTrace.push({ observeError: String(error?.message ?? error) });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (snapshot === null) {
      try {
        snapshot = await waitForFreshSnapshot(session.client, { requireActionable: true, timeoutMs: 20_000 });
      } catch (error) {
        observeError = String(error?.message ?? error);
        // Report the raw cached projection so a failed admission is diagnosable
        // instead of collapsing into a bare timeout.
        snapshot = session.client.state?.snapshot ?? null;
      }
    }
    console.log(
      JSON.stringify(
        {
          state: "spatial_dumped",
          topology: "shared_world_farmhand",
          reachTrace,
          reachDiagnostic,
          observeError,
          pollTrace,
          revision: snapshot?.revision,
          location: snapshot?.location,
          tile: snapshot?.tile,
          actionable: snapshot?.actionable,
          capabilityCount: Array.isArray(snapshot?.capabilities) ? snapshot.capabilities.length : null,
          hasMoveToTile: Array.isArray(snapshot?.capabilities) ? snapshot.capabilities.includes("move_to_tile") : null,
          warps: Array.isArray(snapshot?.warps) ? snapshot.warps : null,
          machineTargets: snapshot?.machineTargets ?? null,
          shippingBinTargets: snapshot?.shippingBinTargets ?? null,
          chestRetrieveTargets: snapshot?.chestRetrieveTargets ?? null,
          petTargets: snapshot?.petTargets ?? null,
          // Sample the pet several times so a single frame cannot be mistaken for
          // motion or for stillness. The `stationary` fact is the Mod projecting
          // the pet's native WalkInDirection flag, NOT a measurement of whether it
          // actually moved: a pet whose behaviour says "Walk" but which is blocked
          // by terrain would report stationary=false forever while never changing
          // tile. Recording the real tiles alongside the flag is what tells those
          // two apart, which decides whether waiting for stillness is a sound
          // strategy or an unwinnable one.
          petMotion: await samplePetMotion(session.client, { samples: 6, intervalMs: 700 }),
        },
        null,
        2,
      ),
    );
  } else if (isSleepLifecycle) {
    // Wait, bounded, for the AI client's own Mod-side lifecycle to reach its
    // terminal state. The file is written once, by the Mod, on the game thread.
    const deadline = Date.now() + 120_000;
    let evidence = null;
    while (Date.now() < deadline) {
      try {
        evidence = JSON.parse((await readFile(lifecycleEvidence, "utf8")).replace(/^\uFEFF/, ""));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (evidence === null) {
      console.log(JSON.stringify({ state: "blocked", reasonCode: "lifecycle_evidence_absent", evidencePath: lifecycleEvidence }));
      process.exitCode = 2;
    } else {
      console.log(JSON.stringify({ ...evidence, topologyAssertion: "shared_world_farmhand", evidencePath: lifecycleEvidence }));
      if (evidence.state !== "passed") process.exitCode = 2;
    }
  } else {
    const runner = await import(`./${runnerFile}`);
    const runSmoke = Object.entries(runner).find(([name]) => /^run[A-Za-z]*Smoke$/.test(name))?.[1];
    if (typeof runSmoke !== "function") throw new Error("shared_world_runner_export_missing");
    // A shared world's Farmhand starts in its own Cabin interior, while the
    // scenario target lives on another map. Native-local fixtures hide that
    // distance by warping their actor during setup; a real companion must walk
    // there itself using only published actions. Do that here, before the
    // action under test, so the action keeps its own contract unchanged.
    const approachTrace = [];
    let approachDiagnostic = null;
    const plan = ACTION_TARGETS[action];
    if (plan !== undefined) {
      // The contract under test decides where the actor must stand; the driver
      // only walks it there, using published actions across locations. A target
      // that can move re-reads its tile per attempt.
      //
      // Failing to position is a result, not a crash. The action under test has
      // its own contract and its own rejection vocabulary; if the driver cannot
      // get the actor in place it must say so, so the caller can distinguish
      // "the action refused" from "we never got there". Throwing here would
      // surface as an unhandled error and hide which of the two happened.
      try {
        const positioned =
          plan.freshTargetTiles !== undefined
            ? await ensureAdjacentToFreshTarget(session.client, session.receipts, plan.location, plan.freshTargetTiles, {
                attempts: 3,
              })
            : await ensureStandingTile(session.client, session.receipts, plan.location, plan.standingTiles, {});
        approachTrace.push(...positioned.trace.map((entry) => ({ ...entry, phase: "reach_standing_tile" })));
      } catch (error) {
        // The helper attaches its trace to the failure; surface it, because the
        // trace is the only place the per-move state and receipt evidence exist.
        approachTrace.push(...(Array.isArray(error?.trace) ? error.trace : []).map((entry) => ({ ...entry, phase: "reach_standing_tile" })));
        approachDiagnostic = { phase: "reach_standing_tile", error: String(error?.message ?? error) };
      }
    }
    // A target the game moves on its own is located by re-observing, not by
    // chasing: the driver reports position for the runner to act on, and the
    // runner re-reads the target itself. So a positioning failure is reported
    // alongside the action's own outcome rather than replacing it.
    const result = await runSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify({ ...result, approachTrace, approachDiagnostic }));
    if (result?.state !== "passed") process.exitCode = 2;
  }
} finally {
  await session.close();
}
