#!/usr/bin/env node
/**
 * `node tools/preflight-live-run.mjs` — every reason a live run fails before it starts, in about a second.
 *
 * See `tools/lib/live-run-preflight.mjs` for why each check exists (each one cost a run during the 2026-10-19/20
 * session). Exits 1 with the FIRST failing code on stderr, so a launcher or a shell can refuse to start on it. Pass
 * `--runtime-root` and `--agent-dir` to also ask the provider, which no file tree can answer for.
 *
 * Three verdicts are printed, and the third is the one that cost four launches on 2026-11-13: `n/m` is
 * `not_measured` - the prerequisite was absent, nothing was measured, and the run is refused because an unmeasured
 * prerequisite is not a passing one.
 *
 * red-proof: fixture  a mods directory holding `GameBuddy/` and the stale `GameBuddy.Stardew/` alias beside it, the
 *                    2026-10-19 shape SMAPI answers by refusing the mod -> `FAIL  mods_path_exactly_one_gamebuddy
 *                    GameBuddy+GameBuddy.Stardew` then `preflight_failed:mods_path_exactly_one_gamebuddy`, exit 1,
 *                    while the same tree with one folder prints `preflight_ok` (tools/preflight-live-run.mjs)
 *
 * red-proof: machine  2026-11-13, this checkout. Before the guardian check existed, the same command printed
 *                    `ok host_artifact_fresh`, `FAIL mod_bundle_fresh`, `ok mods_path_exactly_one_gamebuddy`,
 *                    `ok bridge_config_readable` and nothing else - the condition that had already killed four chat
 *                    runs (`dialogue_exited_before_ready:1:desktop_runtime_bootstrap_unavailable:
 *                    guardian_pipe_unreachable`, no capture phase) had no word in the preflight. After the check, the
 *                    FIRST line of the same command reads `n/m  guardian_pipe_reachable  guardian_pipe_unreachable:
 *                    251 named pipe(s) examined; no GameBuddy.HostGuardian.* endpoint is bound, ...`, followed by the
 *                    two operator routes and `preflight_not_measured:guardian_pipe_reachable:
 *                    guardian_pipe_unreachable`, exit 1. With a `GameBuddy.HostGuardian.<64 hex>` endpoint bound on
 *                    the same machine - a 60-second stand-in listener, nothing launched - the line reads
 *                    `ok  guardian_pipe_reachable  250 named pipe(s) examined; bound: GameBuddy.HostGuardian.<hex>`,
 *                    the rest of the tree passes, and the command ends `preflight_ok`, exit 0.
 *
 * The name count moves between runs because it is the machine's whole pipe namespace; that is why it is printed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import {
  preflightLiveRun,
  probeGuardianPipe,
  probeProviderReadiness,
  providerReadinessRefusal,
} from "./lib/live-run-preflight.mjs";

const value = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
};

const modsPath = value("--mods-path", process.env.GAMEBUDDY_STARDEW_MODS_DIR ?? null);
if (modsPath === null) {
  console.error("preflight_missing_argument:--mods-path");
  process.exit(2);
}
const fixtureRoot = value("--fixture-root", process.env.GAMEBUDDY_FIXTURE_ROOT ?? null);
const saveName = value("--save-name");
const action = value("--action");
const releaseDir = value("--release-dir", "integrations/stardew/bin/Release/net6.0");

/** Read-only count: a game already running is what makes the fixture lock ambiguous for the next launch. */
const runningGameProcesses = () => {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-Process -Name StardewModdingAPI,Stardew* -ErrorAction SilentlyContinue | Measure-Object).Count",
      ],
      { encoding: "utf8", timeout: 8_000 },
    ).trim();
    return Number.parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
};

const result = preflightLiveRun({
  modsPath,
  fixtureRoot,
  releaseDir,
  action,
  saveName,
  runningGameProcesses: runningGameProcesses(),
  guardian: probeGuardianPipe(),
});
const VERDICT = { passed: "ok  ", blocked: "FAIL", not_measured: "n/m " };
for (const entry of result.checks) console.log(`${VERDICT[entry.status]}  ${entry.code.padEnd(38)} ${entry.detail}`);
if (result.checks.some((entry) => entry.status === "not_measured"))
  console.log("      n/m = not_measured: the prerequisite was absent, so nothing was measured - never a pass");
if (fixtureRoot !== null && existsSync(fixtureRoot)) {
  const listing = readdirSync(fixtureRoot).slice(0, 12);
  console.log(`      fixture root: ${listing.join(", ")}`);
}
if (!result.ok) {
  const failure = result.firstFailure;
  if (failure.status === "not_measured") {
    // Same refusal shape as a failed check, with the check's own condition named beside it and the routes an
    // operator can take. Nothing starts until this reads `preflight_ok`.
    console.error(`\npreflight_not_measured:${failure.code}:${failure.condition}`);
    for (const route of failure.route ?? []) console.error(`  operator route: ${route}`);
  } else console.error(`\npreflight_failed:${failure.code}`);
  process.exit(1);
}
// The provider is the one thing a file tree cannot answer for, so it is asked only when the caller names the two
// directories the runtime reads: the root (its model profile) and the identity's agent dir (its catalog and
// credential). The live runner asks the same probe, so a dead provider is one name in both places.
const runtimeRoot = value("--runtime-root", process.env.GAMEBUDDY_RUNTIME_ROOT ?? null);
const agentDir = value("--agent-dir");
if (runtimeRoot !== null && agentDir !== null) {
  const readiness = await probeProviderReadiness({ runtimeRoot, agentDir });
  console.log(`${readiness.ok ? "ok  " : "FAIL"}  ${"provider_readiness".padEnd(38)} ${JSON.stringify(readiness)}`);
  if (!readiness.ok) {
    console.error(`\n${providerReadinessRefusal(readiness)}`);
    process.exit(1);
  }
} else console.log("      provider readiness: not asked (pass --runtime-root and --agent-dir)");
console.log("\npreflight_ok");
