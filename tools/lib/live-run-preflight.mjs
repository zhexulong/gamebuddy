/**
 * Live-run preflight: everything that killed a run during the 2026-10-19/20 session, checked in about a second, before
 * a game process exists.
 *
 * Measured from that session's 144 result files: 23 runs ended `blocked` with ZERO wall clock - they never started - and
 * every cause was knowable from the file system:
 *
 *   - a mods directory holding two GameBuddy folders (SMAPI refuses the mod, starts the game WITHOUT it, and the run dies
 *     120 s later as `stardew_pipe_not_listening`);
 *   - a launcher pipe name that does not match the Mod's own config (the same symptom, one line of cause);
 *   - a host test artifact older than `host/src`;
 *   - a Mod bundle older than its C# sources - the worst of the four, because the run then measures code that is not the
 *     code under test and can still pass;
 *   - leftover fixture transactions and orphaned backups;
 *   - a save name whose template directory was never created.
 *
 * Each check reports a stable code, and the FIRST failure is what the caller prints: one line instead of a 25-minute
 * discovery cycle. Every check is read-only and spawns nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bridgeConfigPath, bridgePipeNameFor } from "./stardew-bridge-pipe.mjs";

const check = (code, ok, detail) => ({ code, ok, detail });

const newestUnder = (root, match, skipDirectory) => {
  let newest = null;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirectory(entry.name)) continue;
        walk(path, depth + 1);
      } else if (match(entry.name)) {
        const mtimeMs = statSync(path).mtimeMs;
        if (newest === null || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
      }
    }
  };
  walk(root, 0);
  return newest;
};

const stamp = (entry) => (entry === null ? "(missing)" : `${entry.path} @${new Date(entry.mtimeMs).toISOString()}`);
const freshnessDetail = (input, output, missingOutput, missingInput) => {
  if (output === null) return missingOutput;
  if (input === null) return missingInput;
  return `newest input ${stamp(input)} vs output ${stamp(output)}`;
};

const hostArtifactCheck = (hostRoot) => {
  const input = newestUnder(
    join(hostRoot, "src"),
    (name) => /\.(ts|json)$/u.test(name),
    (name) => /^(node_modules|dist-test|\.git)$/u.test(name),
  );
  const artifact = newestUnder(
    join(hostRoot, "dist-test"),
    (name) => name.endsWith(".js"),
    (name) => /^node_modules$/u.test(name),
  );
  const ok = input !== null && artifact !== null && artifact.mtimeMs >= input.mtimeMs;
  return check(
    "host_artifact_fresh",
    ok,
    freshnessDetail(input, artifact, "host/dist-test is missing — build it", "no host/src inputs found"),
  );
};

const modBundleCheck = (modRoot, releaseDir) => {
  const input = newestUnder(
    modRoot,
    (name) => name.endsWith(".cs"),
    (name) => /^(bin|obj|node_modules|\.git)$/u.test(name),
  );
  const dll = join(releaseDir, "GameBuddy.Stardew.dll");
  const output = existsSync(dll) ? { path: dll, mtimeMs: statSync(dll).mtimeMs } : null;
  const ok = input !== null && output !== null && output.mtimeMs >= input.mtimeMs;
  return check(
    "mod_bundle_fresh",
    ok,
    freshnessDetail(input, output, `no ${dll} — build the Mod`, "no C# inputs found"),
  );
};

const gameBuddyFoldersIn = (modsPath) => {
  try {
    return readdirSync(modsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^GameBuddy[.]/u.test(`${entry.name}.`))
      .map((entry) => entry.name);
  } catch (error) {
    return [`(unreadable:${String(error?.code ?? error)})`];
  }
};

const bridgeConfigCheck = (modsPath) => {
  const configPath = bridgeConfigPath(modsPath);
  if (!existsSync(configPath)) return check("bridge_config_readable", false, `no config at ${configPath}`);
  try {
    return check("bridge_config_readable", true, `PipeName=${bridgePipeNameFor(modsPath)}`);
  } catch (error) {
    return check("bridge_config_readable", false, String(error instanceof Error ? error.message : error));
  }
};

const fixtureChecks = (fixtureRoot, saveName) => {
  if (fixtureRoot === null || fixtureRoot === undefined) return [];
  let entries = [];
  try {
    entries = readdirSync(fixtureRoot);
  } catch {
    entries = [];
  }
  const orphans = entries.filter((name) => name.includes(".orphaned-"));
  const lock = entries.some((name) => name.startsWith(".stardew-native-local-player-fixture.lock"));
  const checks = [
    check("fixture_root_has_no_orphan_backups", orphans.length === 0, `${String(orphans.length)} orphaned entr(ies)`),
    check("fixture_lock_free", !lock, lock ? "a fixture transaction is still held" : "free"),
  ];
  if (saveName !== null && saveName !== undefined) {
    const template = join(fixtureRoot, "templates", saveName);
    checks.push(check("fixture_template_present", existsSync(template), template));
  }
  return checks;
};

const ACTION_RUNNERS = Object.freeze({
  respond_level_up: "run-stardew-native-local-player-respond-level-up-smoke.mjs",
  respond_level_up_branch: "run-stardew-native-local-player-respond-level-up-branch-smoke.mjs",
  hold_absorption: "run-stardew-native-local-player-hold-absorption-smoke.mjs",
});

const runnerCheck = (action) => {
  const runner = ACTION_RUNNERS[action];
  if (runner === undefined) return [check("smoke_runner_resolves", false, `no runner known for ${action}`)];
  const path = join("tools", runner);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return [
    check("smoke_runner_resolves", existsSync(path), path),
    check(
      "smoke_runner_has_cli",
      /import\.meta\.main/u.test(text),
      "the driver refuses a runner whose import would start the session",
    ),
  ];
};

/** Runs every check in order; `ok` is true only when all pass, and `firstFailure` is what a caller prints. */
export function preflightLiveRun(options) {
  const {
    modsPath,
    fixtureRoot = null,
    releaseDir,
    action = null,
    saveName = null,
    runningGameProcesses = 0,
    hostRoot = "host",
    modRoot = "integrations/stardew",
  } = options;

  const folders = gameBuddyFoldersIn(modsPath);
  const oneFolder = folders.length === 1 && !folders[0].startsWith("(");
  const checks = [
    hostArtifactCheck(hostRoot),
    modBundleCheck(modRoot, releaseDir),
    check(
      "mods_path_exactly_one_gamebuddy",
      oneFolder,
      folders.length === 0 ? "no GameBuddy folder" : folders.join("+"),
    ),
    ...(oneFolder ? [bridgeConfigCheck(modsPath)] : []),
    ...fixtureChecks(fixtureRoot, saveName),
    ...(runningGameProcesses > 0
      ? [check("no_game_process_running", false, `${String(runningGameProcesses)} process(es)`)]
      : []),
    ...(action === null ? [] : runnerCheck(action)),
  ];
  return Object.freeze({
    ok: checks.every((entry) => entry.ok),
    checks: Object.freeze(checks),
    firstFailure: checks.find((entry) => !entry.ok) ?? null,
  });
}
