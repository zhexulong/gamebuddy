// The shots kit's CDP port is a shared resource with one claim: every run defaults to 9341, and the
// kit's only launcher - the pinned worktree's `tools/desktop-composition-launch.mjs` - accepts no CDP
// port, so a run cannot escape 9341 by asking for another one. Two runs told to debug the same port
// also do not fail loudly: the second Edge cannot bind it, the endpoint keeps answering from the first
// run's browser, and the second run then reads a page it never launched (the observed
// `page target: NONE` while `/json/list` served another run's product port). This lock is that
// resource's one claim, taken the way `scratch/run-mounted-spec.mjs` claims the mounted zone's 4173:
// a directory whose owner file names the holder, refused by name, recovered when the holder died,
// released on exit. It claims the port NUMBER, so `--cdp-port` runs contend correctly too.
//
// A held port is REFUSED, and the refusal names who holds it - the pid and the run directory read from
// that process's own command line. The claim used to wait an hour by name instead, and the shape that
// produced was measured on 2026-11-15: a failed run left `node …/phases/launch.mjs` (pid 32740) and its
// Edge alive on 9341, the next run printed `held by pid 32740 … waiting for it to release`, its parent
// gave up 360 s later, and the operator's one-line error was `phase launch failed (exit 2)` - a fact
// about a sibling's timeout that named neither the holder nor the reason. An orphan never releases;
// only a human did. So the default budget is zero and the message carries the remedy.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { KIT_ROOT } from "./config.mjs";
import { portListener, processRow } from "./process-table.mjs";

const POLL_MS = 2_000;
const DEFAULT_WAIT_MS = 0;
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

/** Split a Windows command line into its arguments, honouring double quotes. */
function commandLineArgs(commandLine) {
  const args = [];
  let current = "";
  let quoted = false;
  for (const character of commandLine) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === " " && !quoted) {
      if (current.length > 0) args.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.length > 0) args.push(current);
  return args;
}

const RUN_CONFIG_ARGUMENT = new RegExp(`[\\\\/]state[\\\\/]run\\.json$`, "u");
const PROFILE_ARGUMENT = "--user-data-dir=";

/** A path argument that crossed a space comes back as several tokens: try the joins, shortest first. */
function pathJoins(args, index, value) {
  const joins = [value];
  let joined = value;
  for (let next = index + 1; next < args.length && next <= index + 4; next += 1) {
    if (args[next].startsWith("--")) break;
    joined = `${joined} ${args[next]}`;
    joins.push(joined);
  }
  return joins;
}

/** The same, for the argument a path ENDS at (the launch driver's run config is its last argument). */
function trailingJoins(args, index) {
  const joins = [];
  for (let start = index; start >= 0 && start >= index - 4; start -= 1) {
    joins.push(args.slice(start, index + 1).join(" "));
  }
  return joins;
}

/**
 * The run directory a process belongs to, read from ITS OWN command line - the browser names its
 * profile (`--user-data-dir=<stage>/browser-profile`) and the launch driver names the run config
 * (`…/phases/launch.mjs <stage>/state/run.json`), so both resolve to the run's stage root.
 *
 * The candidate that EXISTS on disk is the one taken, which is what makes a space-split path recoverable
 * on the browser side and honest on the other: when nothing named on the command line exists, this says
 * `null` and the caller reports `unattributed` with the command line quoted, instead of printing a
 * truncated directory an operator would search for and not find.
 */
export function owningRunDir(commandLine) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return null;
  const args = commandLineArgs(commandLine);
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const argument = args[index];
    if (argument.startsWith(PROFILE_ARGUMENT)) {
      for (const candidate of pathJoins(args, index, argument.slice(PROFILE_ARGUMENT.length))) {
        if (existsSync(candidate)) return dirname(candidate);
      }
    }
    if (RUN_CONFIG_ARGUMENT.test(argument)) {
      for (const candidate of trailingJoins(args, index)) {
        if (existsSync(candidate)) return dirname(dirname(candidate));
      }
    }
  }
  return null;
}

/** Who holds `pid`, as `{ pid, runDir, commandLine }` - the facts a refusal has to carry. */
export function describePortHolder(pid) {
  const row = pid === null ? null : processRow(pid);
  if (row === null) return { pid, runDir: null, commandLine: null };
  return { pid: row.pid, runDir: owningRunDir(row.commandLine), commandLine: row.commandLine };
}

function namedFailure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * The refusal for a port this run may not take. The CODE carries the pid and the owning run directory,
 * because that is the line an operator reads in a parent's error before opening any log.
 */
function portHeldFailure({ port, holder, holderState, waitedMs, waitMs, staleOwner }) {
  const pid = holder.pid ?? staleOwner ?? null;
  const runDir = holder.runDir ?? (pid === null ? null : describePortHolder(pid).runDir);
  const code = `cdp_port_held_by_pid:${pid ?? "unknown"}:${runDir ?? "unattributed"}`;
  const who =
    pid === null ? "a process this machine could not name" : `pid ${pid} (${runDir ?? "run directory unattributed"})`;
  const state =
    holderState === "dead"
      ? `; the lock's holder ${describeOwner(staleOwner)} is gone but its browser still answers the port`
      : "";
  const budget =
    waitMs > 0
      ? `; waited ${Math.round(waitedMs / 1000)}s of a ${Math.round(waitMs / 1000)}s budget`
      : "; refused immediately (wait budget 0s)";
  const remedy =
    pid === null
      ? `remedy: find what answers cdp port ${port}, stop it, then re-run`
      : `remedy: stop the run at ${runDir ?? "that pid"} (taskkill /PID ${pid} /T /F for this exact pid if it is orphaned), then re-run; --wait-for-cdp=<seconds> waits for it to finish instead`;
  const commandLine =
    holder.commandLine === null || holder.commandLine === undefined
      ? ""
      : `; its command line: ${String(holder.commandLine).slice(0, 300)}`;
  return namedFailure(code, `cdp port ${port} is held by ${who}${state}${budget}${commandLine}. ${remedy}`);
}

/**
 * Takes the one claim on `port`, refusing a held port by name instead of waiting silently for it, and
 * recovering the lock a run that died left behind. Fails closed rather than mounting a page this run
 * never launched.
 *
 * `waitMs` is the operator's explicit choice (`--wait-for-cdp`), never a default: it exists so a run
 * that starts while a sibling is finishing can wait instead of failing, and the wait is announced with
 * the holder named and the whole budget printed.
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

  let announcedWait = false;
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
        const listener = portListener(port);
        throw portHeldFailure({
          port,
          holder: describePortHolder(listener.status === "listening" ? listener.pid : null),
          holderState: "live",
          waitedMs: 0,
          waitMs: 0,
          staleOwner: null,
        });
      }
      say(`shots-cdp-lock: claimed cdp port ${port} (lock ${dir}, owner pid ${process.pid})`);
      return { dir, release };
    }

    const owner = readOwner(dir);
    const mine = owner !== null && owner.pid === process.pid;
    if (owner !== null && !mine) {
      if (isAlive(owner.pid)) {
        if (Date.now() >= deadline) {
          throw portHeldFailure({
            port,
            holder: describePortHolder(owner.pid),
            holderState: "live",
            waitedMs: Date.now() - (deadline - waitMs),
            waitMs,
            staleOwner: owner,
          });
        }
        if (!announcedWait) {
          const holder = describePortHolder(owner.pid);
          say(
            `shots-cdp-lock: cdp port ${port} is held by pid ${owner.pid} (run ${holder.runDir ?? "unattributed"}); waiting up to ${Math.round(waitMs / 1000)}s for it to finish`,
          );
          announcedWait = true;
        }
        await sleep(POLL_MS);
        continue;
      }
      // The lock's holder is gone. If its browser is still on the port, the run must not proceed - name
      // that browser and fail closed instead of joining its endpoint.
      if (await cdpEndpointAnswers(port)) {
        const listener = portListener(port);
        throw portHeldFailure({
          port,
          holder: describePortHolder(listener.status === "listening" ? listener.pid : owner.pid),
          holderState: "dead",
          waitedMs: 0,
          waitMs: 0,
          staleOwner: owner,
        });
      }
    }
    // Stale lock with nothing left on the port: reclaim it and try again.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the next iteration retries */
    }
  }
}

/**
 * Releases the lock on `port` when the process in `pids` owns it - the run-scoped teardown's half of
 * the claim. A holder that is not in `pids` and is still alive keeps its lock: a force-killed process
 * runs no exit hook, so this is who releases its claim, and only for the pids this run tore down.
 *
 * `"released"` and `"held_by_another"` are different answers, and so is `"no_owner_record"`: the first
 * is this run's lock removed, the second is somebody else's claim left alone, the third is a lock whose
 * holder wrote no record (a run in its first millisecond, or a dead one) - `acquireCdpPortLock` already
 * reclaims that shape, so nothing is deleted on a guess.
 */
export function releaseCdpPortLockHeldBy(port, pids) {
  const dir = cdpPortLockDir(port);
  const owner = readOwner(dir);
  if (owner === null) return existsSync(dir) ? "no_owner_record" : "no_lock";
  if (!pids.has(owner.pid) && isAlive(owner.pid)) return "held_by_another";
  rmSync(dir, { recursive: true, force: true });
  return "released";
}
