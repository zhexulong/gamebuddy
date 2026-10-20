#!/usr/bin/env node
/**
 * `node tools/preflight-live-run.mjs` — every reason a live run fails before it starts, in about a second.
 *
 * See `tools/lib/live-run-preflight.mjs` for why each check exists (each one cost a run during the 2026-10-19/20
 * session). Exits 1 with the FIRST failing code on stderr, so a launcher or a shell can refuse to start on it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { preflightLiveRun } from "./lib/live-run-preflight.mjs";

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
});
for (const entry of result.checks)
  console.log(`${entry.ok ? "ok  " : "FAIL"}  ${entry.code.padEnd(38)} ${entry.detail}`);
if (fixtureRoot !== null && existsSync(fixtureRoot)) {
  const listing = readdirSync(fixtureRoot).slice(0, 12);
  console.log(`      fixture root: ${listing.join(", ")}`);
}
if (!result.ok) {
  console.error(`\npreflight_failed:${result.firstFailure.code}`);
  process.exit(1);
}
console.log("\npreflight_ok");
