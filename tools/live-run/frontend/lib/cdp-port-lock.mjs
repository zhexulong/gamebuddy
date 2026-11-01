// The shots kit's CDP port is a shared resource with no owner: every run defaults to 9341, and the
// kit's only launcher - the pinned worktree's `tools/desktop-composition-launch.mjs` - accepts no CDP
// port, so a run cannot escape 9341 by asking for another one. Two runs told to debug the same port
// also do not fail loudly: the second Edge cannot bind it, the endpoint keeps answering from the first
// run's browser, and the second run then reads a page it never launched (the observed
// `page target: NONE` while `/json/list` served another run's product port). This lock is that
// resource's one claim, taken the way `scratch/run-mounted-spec.mjs` claims the mounted zone's 4173:
// a directory whose owner file names the holder, waited for by name, recovered when the holder died,
// released on exit. It claims the port NUMBER, so `--cdp-port` runs contend correctly too.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { KIT_ROOT } from "./config.mjs";

const POLL_MS = 2_000;
// A run holds the port for its whole life: the mounted browser serves every capture driver until the
// stop flag. A waiting run therefore has to outlast a whole sibling run. The bound only exists so a
// live-but-stuck holder ends in a named failure instead of an unbounded hang; a dead holder is
// recovered on the next poll, not waited out.
const DEFAULT_WAIT_MS = 3_600_000;
const ENDPOINT_PROBE_MS = 2_000;

export function cdpPortLockDir(port) {
  return join(KIT_ROOT, ".tmp", `cdp-${port}.lock`);
}

function ownerFilePath(dir) {
  return join(dir, "owner.json");
}

function readOwner(dir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ownerFilePath(dir), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !Number.isInteger(parsed.pid)) return null;
  return { pid: parsed.pid, startedAtMs: Number.isFinite(parsed.startedAtMs) ? parsed.startedAtMs : null };
}

export function describeOwner(owner) {
  if (owner === null) return "an unnamed holder (the lock directory carries no readable owner record)";
  const started = owner.startedAtMs === null ? "start time unknown" : new Date(owner.startedAtMs).toISOString();
  return `pid ${owner.pid} (started ${started})`;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function cdpEndpointAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(ENDPOINT_PROBE_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function namedFailure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * Takes the one claim on `port`, waiting by name while a live run holds it and recovering the lock a
 * run that died left behind. Fails closed rather than mounting a page this run never launched.
 *
 * @returns {Promise<{ dir: string, release: () => void }>}
 */
export async function acquireCdpPortLock({ port, say = () => undefined, waitMs = DEFAULT_WAIT_MS }) {
  const dir = cdpPortLockDir(port);
  const deadline = Date.now() + waitMs;
  mkdirSync(join(KIT_ROOT, ".tmp"), { recursive: true });

  const release = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* nothing to release */
    }
  };
  const claim = () => {
    writeFileSync(ownerFilePath(dir), `${JSON.stringify({ pid: process.pid, startedAtMs: Date.now() })}\n`, "utf8");
    process.once("exit", release);
  };

  for (;;) {
    let held = false;
    try {
      mkdirSync(dir, { recursive: false });
    } catch {
      held = true;
    }

    if (!held) {
      claim();
      // A browser already answering the port would swallow this run's Edge into its own endpoint, so
      // fail closed before spawning rather than mount a page some other run launched.
      if (await cdpEndpointAnswers(port)) {
        release();
        throw namedFailure(
          "cdp_port_held_by_foreign_browser",
          `cdp port ${port} already answers but no run held the lock: a live browser this run did not start owns the port`,
        );
      }
      say(`shots-cdp-lock: claimed cdp port ${port} (lock ${dir}, owner pid ${process.pid})`);
      return { dir, release };
    }

    const owner = readOwner(dir);
    const mine = owner !== null && owner.pid === process.pid;
    if (owner !== null && !mine && isAlive(owner.pid)) {
      if (Date.now() >= deadline) {
        throw namedFailure(
          "cdp_port_lock_timeout",
          `cdp port ${port} is still held by ${describeOwner(owner)} after ${Math.round(waitMs / 1000)}s`,
        );
      }
      say(`shots-cdp-lock: cdp port ${port} is held by ${describeOwner(owner)}; waiting for it to release`);
      await sleep(POLL_MS);
      continue;
    }

    // The lock's holder is gone (or left no readable owner). If its browser is still on the port, the
    // run must not proceed - name that holder and fail closed instead of joining its endpoint.
    if (owner !== null && !mine && (await cdpEndpointAnswers(port))) {
      throw namedFailure(
        "cdp_port_held_by_dead_holder",
        `cdp port ${port} already answers, but the lock's holder ${describeOwner(owner)} is dead: a live browser this run did not start owns the port`,
      );
    }
    // Stale lock with nothing left on the port: reclaim it and try again.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the next iteration retries */
    }
  }
}
