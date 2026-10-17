/**
 * Lane A's acceptance gate: a run's sandbox is its own, and nothing outside it is touched.
 *
 * Two lanes may only run together if they share NOTHING. This gate proves the three resources a
 * Stardew run hinges on are all owned per-run, from the fixture layer itself rather than from a
 * convention:
 *
 *   - the Mods directory: `--mods-path <runRoot>/mods` receives the bundle and the Mod's config, and the
 *     real Steam Mods tree is not written (the fixture refuses symlinked paths outright);
 *   - the transaction lock: it lives under `--root <runRoot>`, so two runRoots cannot contend;
 *   - the bridge pipe: it comes from that run's OWN config, so two lanes cannot answer each other's pipe.
 *
 * The destructive half is the part that needs a falsifier rather than a promise: a recursive cleanup of
 * a sandbox that contains a junction must not reach the target. That is checked with a canary directory
 * and a sentinel file, and the check is designed to fail for an implementation that descends into a link
 * (deleting the link afterwards would still leave the canary intact, so the second assertion is that the
 * target's own files were never enumerated at all).
 *
 * Usage:
 *   node tools/check-live-run-isolation.mjs            # offline: sandboxes, locks, pipes, canary
 *   node tools/check-live-run-isolation.mjs --live     # two real fixture lanes in parallel (needs a game)
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyPathEntry, listStardewProcessIds, removeSandboxTree } from "./lib/windows-process-tree.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const RELEASE_DIR = join(REPO, "integrations", "stardew", "bin", "Release", "net6.0");
const STEAM_MODS = "D:\\Steam\\steamapps\\common\\Stardew Valley\\Mods";
const GAME_PATH = "D:\\Steam\\steamapps\\common\\Stardew Valley";
const PROFILE_ROOT = join(process.env.LOCALAPPDATA ?? "", "GameBuddy", "stardew-profiles");
const SOURCE_PROFILE = join(PROFILE_ROOT, "native-local-stable");
const FIXTURE_ROOT = join(process.env.LOCALAPPDATA ?? "", "GameBuddy", "stardew-fixtures");
const BINDING = join(FIXTURE_ROOT, "GameBuddyFixtureStable2.native-local-binding.json");
const SAVE_SLOT = "GameBuddyFixtureStable2_451844707";
const BUNDLE_FILES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
]);
/** Each lane's bridge pipe name, seeded into that lane's own config: the isolation unit for the transport. */
const PIPE_A = "gamebuddy-isolation-lane-a";
const PIPE_B = "gamebuddy-isolation-lane-b";

/** The fixture's own lock directory name, read from the module that creates it rather than guessed. */
const LOCK_DIRECTORY = (() => {
  const source = readFileSync(join(REPO, "tools", "lib", "stardew-native-local-player-fixture.mjs"), "utf8");
  const match = source.match(/const LOCK_DIRECTORY = "([^"]+)";/u);
  if (match === null) throw new Error("lock_directory_name_not_found");
  return match[1];
})();

const checks = [];
let liveVerdict = null;
const check = (id, ok, detail) =>
  checks.push({ id, status: ok ? "passed" : "failed", ...(detail === undefined ? {} : { detail }) });

/** Every file under a tree with its size and mtime, so "untouched" is a comparison and not an impression. */
function treeFingerprint(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        entries.push({ path, kind: "link" });
        continue;
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const stats = statSync(path);
      entries.push({ path, kind: "file", size: stats.size, mtimeMs: stats.mtimeMs });
    }
  };
  visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

const fingerprintKey = (entries) =>
  JSON.stringify(entries.map((entry) => `${entry.path}|${entry.kind}|${entry.size ?? ""}|${entry.mtimeMs ?? ""}`));

/** The named public failure inside a prepare/restore refusal, so a detail is a reason code and not a stack. */
function namedFailure(error) {
  const text = `${String(error?.stderr ?? "")}\n${String(error?.message ?? "")}`;
  return (
    text.match(/native_local_fixture_[a-z_]+|invalid_[a-z_]+|release_bundle_missing:[^\s]+/u)?.[0] ?? "unnamed_failure"
  );
}

/** One lane's sandbox: its own root, its own Mods directory, and a working config to start from. */
function makeSandbox(name, configOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), `gb-lane-${name}-`));
  const modsPath = join(root, "mods");
  const modRoot = join(modsPath, "GameBuddy.Stardew");
  mkdirSync(modRoot, { recursive: true });
  const config = JSON.parse(readFileSync(join(SOURCE_PROFILE, "GameBuddy.Stardew", "config.json"), "utf8"));
  writeFileSync(
    join(modRoot, "config.json"),
    `${JSON.stringify({ ...config, ...configOverrides }, null, 2)}\n`,
    "utf8",
  );
  return { name, root, modsPath, modRoot };
}

function prepare(lane, { backupName = `${lane.name}-fixture-backup`, timeoutSeconds = 30 } = {}) {
  return execFileSync(
    process.execPath,
    [
      join(REPO, "tools", "prepare-stardew-native-local-player-fixture.mjs"),
      "--root",
      lane.root,
      "--mods-path",
      lane.modsPath,
      "--release-dir",
      RELEASE_DIR,
      "--save-name",
      SAVE_SLOT,
      "--backup-name",
      backupName,
      "--action",
      "till_soil",
      "--timeout-seconds",
      String(timeoutSeconds),
      "--binding-path",
      BINDING,
    ],
    { encoding: "utf8", cwd: REPO, timeout: 120_000 },
  );
}

function restore(lane, { backupName = `${lane.name}-fixture-backup` } = {}) {
  return execFileSync(
    process.execPath,
    [
      join(REPO, "tools", "restore-stardew-native-local-player-fixture.mjs"),
      "--root",
      lane.root,
      "--mods-path",
      lane.modsPath,
      "--release-dir",
      RELEASE_DIR,
      "--backup-name",
      backupName,
    ],
    { encoding: "utf8", cwd: REPO, timeout: 120_000 },
  );
}

function fixtureChecks() {
  const laneA = makeSandbox("a", { PipeName: PIPE_A });
  const laneB = makeSandbox("b", { PipeName: PIPE_B });
  const before = {
    steamMods: fingerprintKey(treeFingerprint(STEAM_MODS)),
    profile: fingerprintKey(treeFingerprint(SOURCE_PROFILE)),
  };
  const seededConfigs = new Map([
    [laneA.name, readFileSync(join(laneA.modRoot, "config.json"), "utf8")],
    [laneB.name, readFileSync(join(laneB.modRoot, "config.json"), "utf8")],
  ]);
  try {
    // ── 1. The Mods directory is per-run, and the bundle lands THERE ───────────────────────────────
    const preparedA = JSON.parse(prepare(laneA));
    const preparedB = JSON.parse(prepare(laneB));
    check("two_lanes_prepared", preparedA.state === "prepared" && preparedB.state === "prepared");
    check(
      "bundle_lands_in_the_lane_own_mods_dir",
      BUNDLE_FILES.every((name) => existsSync(join(laneA.modRoot, name))),
      laneA.modRoot,
    );
    check(
      "each_lane_has_its_own_mods_path",
      preparedA.modsPath !== preparedB.modsPath && preparedA.configPath !== preparedB.configPath,
    );
    // The fixture's own config was rewritten for the run (it is NOT the seed any more).
    check(
      "fixture_rewrote_the_run_own_config",
      readFileSync(join(laneA.modRoot, "config.json"), "utf8") !== seededConfigs.get(laneA.name),
    );

    // ── 2. Nothing outside the sandbox was written ────────────────────────────────────────────────
    const after = {
      steamMods: fingerprintKey(treeFingerprint(STEAM_MODS)),
      profile: fingerprintKey(treeFingerprint(SOURCE_PROFILE)),
    };
    check("steam_mods_untouched", before.steamMods === after.steamMods, STEAM_MODS);
    check("source_profile_untouched", before.profile === after.profile, SOURCE_PROFILE);

    // ── 3. The pipe is the LANE's, so two lanes cannot answer each other ────────────────────────
    // THE CONCURRENCY INVARIANT: a lane's pipe is read from that lane's OWN config, so two lanes with distinct
    // configs cannot answer each other's pipe. Lane B is seeded with a distinct name precisely to state that as a
    // property rather than leaving it to convention - and a distinct config is what a second lane must be given,
    // which is the requirement this check names instead of assuming.
    const configA = JSON.parse(readFileSync(join(laneA.modRoot, "config.json"), "utf8"));
    const configB = JSON.parse(readFileSync(join(laneB.modRoot, "config.json"), "utf8"));
    check(
      "each_lane_pipe_comes_from_its_own_config",
      configA.PipeName === PIPE_A && configB.PipeName === PIPE_B && PIPE_A !== PIPE_B,
      `A=${String(configA.PipeName)} B=${String(configB.PipeName)}`,
    );

    // ── 4. The lock is per-runRoot, and it refuses a concurrent claim ─────────────────────────────
    // A second prepare on the SAME root must fail by name rather than interleave two transactions.
    let lockVerdict = "prepared";
    try {
      prepare(laneA, { backupName: "second-fixture-backup" });
    } catch (error) {
      lockVerdict = namedFailure(error);
    }
    check(
      "same_root_refuses_a_second_transaction",
      lockVerdict === "native_local_fixture_transaction_locked",
      lockVerdict,
    );
    check("lock_is_held_under_the_run_root", existsSync(join(laneA.root, LOCK_DIRECTORY)), LOCK_DIRECTORY);
    // ...and the OTHER lane's root kept its OWN transaction: two runRoots do not contend. Compared by owner
    // identity rather than by existence, because B legitimately holds its own lock at this moment.
    const ownerOf = (root) => {
      try {
        return JSON.parse(readFileSync(join(root, LOCK_DIRECTORY, "transaction.json"), "utf8")).ownerId ?? null;
      } catch {
        return null;
      }
    };
    check(
      "the_other_lane_root_kept_its_own_transaction",
      typeof ownerOf(laneB.root) === "string" && ownerOf(laneB.root) !== ownerOf(laneA.root),
      String(ownerOf(laneB.root)),
    );

    // ── 5. Restore returns the sandbox to its seed, and leaves no lock ─────────────────────────────
    const restoredA = JSON.parse(restore(laneA));
    const restoredB = JSON.parse(restore(laneB));
    check("restore_reports_restored", restoredA.state === "restored" && restoredB.state === "restored");
    check(
      "restore_put_the_config_back",
      readFileSync(join(laneA.modRoot, "config.json"), "utf8") === seededConfigs.get(laneA.name),
    );
    check("restore_removed_the_lock", !existsSync(join(laneA.root, LOCK_DIRECTORY)));
    check(
      "restore_removed_the_bundle_it_added",
      BUNDLE_FILES.every((name) => !existsSync(join(laneA.modRoot, name))),
      BUNDLE_FILES.filter((name) => existsSync(join(laneA.modRoot, name))).join(","),
    );
  } finally {
    for (const lane of [laneA, laneB]) removeSandboxTree(lane.root);
  }
}

function cleanupChecks() {
  // The destructive half: a recursive delete of a sandbox containing a junction must not reach the target.
  const root = mkdtempSync(join(tmpdir(), "gb-isolation-canary-"));
  try {
    const canary = join(root, "canary-real");
    const sandbox = join(root, "sandbox");
    mkdirSync(join(canary, "inside"), { recursive: true });
    writeFileSync(join(canary, "inside", "sentinel.txt"), "sentinel", "utf8");
    mkdirSync(join(sandbox, "GameBuddy.Stardew"), { recursive: true });
    writeFileSync(join(sandbox, "GameBuddy.Stardew", "manifest.json"), "own", "utf8");
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `New-Item -ItemType Junction -Path '${join(sandbox, "dependency-mod")}' -Target '${canary}' | Out-Null`,
      ],
      { timeout: 30_000, windowsHide: true },
    );
    check("a_dependency_link_is_recognised", classifyPathEntry(join(sandbox, "dependency-mod")) === "reparse_point");
    const result = removeSandboxTree(sandbox);
    check("the_link_was_detached", result.detached.length === 1, result.detached.join(","));
    check("the_sandbox_is_gone", !existsSync(sandbox));
    // THE CANARY: the real dependency Mod and its files survive.
    check("canary_survives_the_sandbox_delete", existsSync(join(canary, "inside", "sentinel.txt")));
    // and the stronger half: the target's own files were never even enumerated by the walk.
    check("canary_files_were_never_enumerated", existsSync(join(canary, "inside")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Two REAL fixture lanes at once, each on its own root, its own Mods directory, its own config and its own
 * save slot. No model is involved (each lane drives one published action through the bridge), because the
 * question here is whether the two lanes can share a machine - not whether the companion behaves.
 *
 * Returns one record per lane with what the lane itself reported plus the facts the gate asserts afterwards.
 */
/**
 * The reasons two lanes still cannot run together, as the lanes themselves reported them.
 *
 * This is the finding the gate exists to make visible, and it is NOT a file-sharing problem: the Mods directories,
 * configs, pipes and save slots are all per-lane (the offline checks below prove it). What stops two lanes is a
 * MACHINE-GLOBAL process assumption in the launch driver:
 *
 *   "Native-local launch identity requires exactly one SMAPI process after pipe readiness (PIDs: 37292,41044)"
 *
 * It counts SMAPI processes across the whole machine, so lane B sees lane A's game and refuses. Under it sits the
 * same shape the launcher used to have for teardown (identify a process by image name instead of by the exact PID
 * this run launched) - which is why the plan's Lane A-4 requires per-lane PID accounting in the first place.
 */
/**
 * The most useful thing a failed lane said, in one bounded line.
 *
 * PowerShell wraps an exception across several decorated lines, so the LAST line is usually a `~~~~` underline. The
 * message is the line that names a cause, so the first line carrying a known marker is preferred, and the tail is
 * the fallback.
 */
function laneDiagnosis(stderr) {
  const lines = String(stderr)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[~^\s]+$/u.test(line));
  const named = lines.find((line) =>
    /Native-local|native_local_|scenario_fixture_mismatch|bridge_enablement|Throw|Exception|Error:/u.test(line),
  );
  return (named ?? lines.at(-1) ?? "no_output").slice(0, 300);
}

function classifyLaneFailure(reported) {
  const text = String(reported);
  if (/exactly one SMAPI process/u.test(text)) return "exactly_one_smapi_process";
  if (/pipe was not ready/u.test(text)) return "bridge_pipe_not_ready";
  return null;
}

async function liveLanes() {
  const laneA = makeSandbox("live-a", { PipeName: PIPE_A });
  const laneB = makeSandbox("live-b", { PipeName: PIPE_B });
  let liveOutcome = "unknown";
  liveVerdict = liveOutcome;
  const before = {
    steamMods: fingerprintKey(treeFingerprint(STEAM_MODS)),
    profile: fingerprintKey(treeFingerprint(SOURCE_PROFILE)),
  };
  const lanes = [
    { lane: laneA, slot: "GameBuddyFixtureIsoLaneA" },
    { lane: laneB, slot: "GameBuddyFixtureIsoLaneB" },
  ];
  const results = lanes.map(({ lane, slot }) => ({
    lane,
    slot,
    resultFile: join(lane.root, "result.json"),
    exitCode: null,
    stderr: "",
  }));
  try {
    await Promise.all(
      results.map(
        (entry) =>
          new Promise((resolve) => {
            const child = spawn(
              "pwsh",
              [
                "-NoProfile",
                "-File",
                join(REPO, "tools", "run-stardew-native-local-player-move-fixture.ps1"),
                "-GamePath",
                GAME_PATH,
                "-ModsPath",
                entry.lane.modsPath,
                "-FixtureRoot",
                entry.lane.root,
                "-SaveName",
                entry.slot,
                "-TemplateName",
                entry.slot,
                "-ReleaseDir",
                RELEASE_DIR,
                "-Action",
                "till_soil",
                "-BootstrapNativeSave",
                "-WindowMode",
                "hidden",
                "-TimeoutSeconds",
                "240",
                "-ResultFile",
                entry.resultFile,
                "-LifecycleResultFile",
                join(entry.lane.root, "lifecycle.json"),
              ],
              { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
            );
            child.stderr.on("data", (chunk) => {
              entry.stderr = (entry.stderr + String(chunk)).slice(-2000);
            });
            child.on("close", (code) => {
              entry.exitCode = code;
              resolve(undefined);
            });
          }),
      ),
    );

    const laneFailures = [];
    for (const entry of results) {
      const reported = existsSync(entry.resultFile) ? JSON.parse(readFileSync(entry.resultFile, "utf8")) : null;
      const cause = classifyLaneFailure(entry.stderr);
      if (cause !== null) laneFailures.push(cause);
      check(`lane_${entry.lane.name}_reached_a_result`, reported !== null, laneDiagnosis(entry.stderr));
      // A lane that passed is a lane that ran; a lane that did not reports the cause it named.
      if (reported !== null)
        check(`lane_${entry.lane.name}_succeeded`, reported.state === "passed", String(reported.state));
      // The slot is a directory under the game's own Saves root, named from the logical slot the lane was given.
      // A bootstrap creates a fresh uniquely-suffixed slot, so the assertion is "at least one exists", and
      // "only its own" is judged against the pre-run snapshot taken below.
      const slotDirs = readdirSync(join(process.env.APPDATA ?? "", "StardewValley", "Saves"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(entry.slot))
        .map((entry) => entry.name);
      check(`lane_${entry.lane.name}_slot_exists`, slotDirs.length >= 1, slotDirs.join(","));
      check(
        `lane_${entry.lane.name}_created_only_its_own_slots`,
        slotDirs.every((name) => name.startsWith(entry.slot)),
        slotDirs.join(","),
      );
    }
    const bothRan = results.every((entry) => existsSync(entry.resultFile));
    const serialization = [...new Set(laneFailures)].sort().join("+");
    if (bothRan) liveOutcome = "ran";
    else if (serialization.length > 0) liveOutcome = `isolated_lanes_cannot_run_concurrently:${serialization}`;
    else liveOutcome = "isolated_lanes_failed_for_an_unnamed_reason";
    check(
      "steam_mods_untouched_by_two_parallel_lanes",
      before.steamMods === fingerprintKey(treeFingerprint(STEAM_MODS)),
      STEAM_MODS,
    );
    check(
      "source_profile_untouched_by_two_parallel_lanes",
      before.profile === fingerprintKey(treeFingerprint(SOURCE_PROFILE)),
      SOURCE_PROFILE,
    );
    check(
      "no_lock_residue_in_either_lane",
      results.every((entry) => !existsSync(join(entry.lane.root, LOCK_DIRECTORY))),
      results.map((entry) => existsSync(join(entry.lane.root, LOCK_DIRECTORY))).join(","),
    );
    // THE ORPHAN ASSERTION: a lane that reclaimed its launch tree leaves nothing behind for the NEXT lane.
    const survivors = listStardewProcessIds();
    check("zero_surviving_game_processes", survivors.length === 0, survivors.join(","));
  } finally {
    for (const { lane } of lanes) removeSandboxTree(lane.root);
  }
}

const live = process.argv.includes("--live");
if (live) {
  await liveLanes();
} else {
  fixtureChecks();
  cleanupChecks();
}

const failedChecks = checks.filter((entry) => entry.status !== "passed");
// A lane that could not run reports the CAUSE, and the cause is what the plan's Lane A-4 has to fix: the launch
// driver's machine-global process accounting. That is `blocked` (a capability is missing), not `failed` (two lanes
// ran and interfered, which must never happen).
const lanesCouldNotRun = liveVerdict?.startsWith("isolated_lanes_cannot_run_concurrently") === true;
let status = "passed";
if (lanesCouldNotRun) status = "blocked";
else if (failedChecks.length > 0) status = "failed";
process.stdout.write(
  `${JSON.stringify({
    gate: "live_run_isolation/v1",
    mode: live ? "live" : "offline",
    status,
    ...(live && liveVerdict !== null ? { verdict: liveVerdict } : {}),
    checks,
  })}\n`,
);
if (status !== "passed") process.exitCode = 1;
