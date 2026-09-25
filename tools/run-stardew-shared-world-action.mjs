import { readFile } from "node:fs/promises";
import { connectNativeLocalClient, waitForFreshSnapshot } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { candidateStandingTiles, ensureActorAtLocation, ensureStandingTile } from "./lib/stardew-shared-world-navigation.mjs";

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
    }[action];
if (!dumpSpatial && runnerFile === undefined) throw new Error(`shared_world_runner_not_wired:${action}`);

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
          chestTargets: snapshot?.chestTargets ?? null,
        },
        null,
        2,
      ),
    );
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
    const plan = ACTION_TARGETS[action];
    if (plan !== undefined) {
      // The contract under test decides where the actor must stand; the driver
      // only walks it there, using published actions across locations.
      const positioned = await ensureStandingTile(
        session.client,
        session.receipts,
        plan.location,
        plan.standingTiles,
        {},
      );
      approachTrace.push(...positioned.trace.map((entry) => ({ ...entry, phase: "reach_standing_tile" })));
    }
    const result = await runSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify({ ...result, approachTrace }));
    if (result?.state !== "passed") process.exitCode = 2;
  }
} finally {
  await session.close();
}
