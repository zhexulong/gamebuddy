#!/usr/bin/env node
/**
 * Clean-machine acceptance, runnable from CI or a developer shell.
 *
 * This is the host-side driver for `tools/sandbox/sandbox-verify.cmd`: it stages the share the
 * script reads, runs it against the machine's REAL per-user locations (the player's path, no
 * override), and reads back the JSON verdict the script writes. The Windows Sandbox run is the
 * authority on "no developer tooling installed"; this driver is the authority on "the acceptance
 * script passes on the artifact we just built", which is what makes that run repeatable.
 *
 * It refuses to run when the artifact is missing, and it always cleans the product locations it
 * created, so a red run cannot leave a machine looking installed.
 *
 * Usage:
 *   node tools/sandbox/run-sandbox-acceptance.mjs --setup <GameBuddy.Setup.exe> [--share <dir>]
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const scriptPath = fileURLToPath(import.meta.url);
const toolsRoot = dirname(scriptPath);
const repositoryRoot = resolve(toolsRoot, "..", "..");
const ACCEPTANCE_SCRIPT = resolve(toolsRoot, "sandbox-verify.cmd");
// The acceptance script reads its share from this fixed path because that is the path it is
// mounted at inside Windows Sandbox; staging anywhere else would test a different script.
const SHARE = "C:\\gamebuddy-share";

function parseArguments(argv) {
  const options = { setup: undefined, share: SHARE };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--setup") options.setup = argv[++index];
    else if (argv[index] === "--share") options.share = argv[++index];
    else throw new Error(`unknown_argument:${argv[index]}`);
  }
  if (typeof options.setup !== "string" || options.setup.length === 0) throw new Error("setup_path_required");
  return options;
}

/** The locations the acceptance run creates on the player's real account. */
function productLocations() {
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0) throw new Error("local_app_data_unavailable");
  return Object.freeze({
    programRoot: join(localAppData, "Programs", "GameBuddy"),
    productRoot: join(localAppData, "GameBuddy"),
    shortcut: join(homedir(), "Desktop", "星露谷AI伴侣.lnk"),
  });
}

async function cleanProductLocations(locations) {
  await rm(locations.programRoot, { recursive: true, force: true });
  await rm(locations.productRoot, { recursive: true, force: true });
  await rm(locations.shortcut, { force: true });
  spawnSync("reg", ["delete", "HKCU\\Software\\GameBuddy", "/f"], { stdio: "ignore", windowsHide: true });
  spawnSync("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GameBuddy", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function main() {
  if (process.platform !== "win32") throw new Error("windows_required");
  const options = parseArguments(process.argv.slice(2));
  const setupPath = resolve(repositoryRoot, options.setup);
  if (!existsSync(setupPath)) throw new Error(`setup_absent:${setupPath}`);
  if (!existsSync(ACCEPTANCE_SCRIPT)) throw new Error("acceptance_script_absent");

  const locations = productLocations();
  // A machine that already has the product installed would let this run "pass" on someone else's
  // install; the premise is a clean account, so the run starts from one and says so.
  await cleanProductLocations(locations);

  await mkdir(options.share, { recursive: true });
  await cp(setupPath, join(options.share, "GameBuddy.Setup.exe"));
  await cp(ACCEPTANCE_SCRIPT, join(options.share, "sandbox-verify.cmd"));

  const run = spawnSync("cmd.exe", ["/c", join(options.share, "sandbox-verify.cmd")], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    // A malformed or truncated Setup.exe makes Windows raise its own "not a valid Win32
    // application" dialog, and the waiting `cmd` never returns. Without a deadline the gate
    // would hang instead of failing - measured: an acceptance run against a truncated image sat
    // for minutes. A timeout is a harness limit, not a product verdict: the run is reported as
    // timed out and the artifact is judged failed.
    timeout: 15 * 60_000,
    killSignal: "SIGKILL",
  });
  const timedOut = run.error !== undefined && run.error.code === "ETIMEDOUT";

  const summaryPath = join(options.share, "sandbox-result.json");
  let summary;
  try {
    summary = JSON.parse((await readFile(summaryPath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch {
    await cleanProductLocations(locations);
    throw new Error(`acceptance_verdict_unreadable:${timedOut ? "timed_out" : `exit_${run.status}`}`);
  }
  const transcript = (await readFile(join(options.share, "sandbox-result.txt"), "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);

  await cleanProductLocations(locations);

  const report = Object.freeze({
    schema: "gamebuddy-sandbox-acceptance/v1",
    ok: summary.ok === true && timedOut === false,
    timedOut,
    productChecks: summary.productChecks,
    failingCount: summary.failingCount,
    failing: Object.freeze(summary.failing ?? []),
    checks: Object.freeze(transcript),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.ok !== true) process.exitCode = 1;
}

await main();
