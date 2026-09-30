/**
 * Evidence runner for the path-predicate probe
 * (`integrations/stardew/PathPredicateProbe.cs`).
 *
 * The probe itself is Mod-side, game-thread and read-only: it never moves the
 * actor and never assigns a controller. This runner owns only the disposable
 * native-local transaction around it - prepare the fixture profile, restore
 * the working save from the external read-only template, launch exactly one
 * SMAPI process against that profile, wait for the probe's bounded evidence
 * file, then tear all of it down in reverse.
 *
 * It sends no bridge request and reads no receipt. The probe's evidence file is
 * the only product of the run; a missing file is a failure, not a measurement.
 *
 * Two seams are deliberately reused rather than re-implemented:
 * `lib/stardew-native-local-player-fixture.mjs` owns the profile/config/bundle
 * transaction and its byte-for-byte restore, and `lib/stardew-live-run.mjs`
 * owns the frozen window-mode vocabulary. The probe is activated through the
 * environment of the one process this runner spawns
 * (`GAMEBUDDY_STARDEW_PATH_PREDICATE_PROBE_LIVE` /
 * `..._PROBE_EVIDENCE`), mirroring the xUnit seam probes, so it adds nothing to
 * the profile and has no `ModConfig` surface to restore.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareNativeLocalPlayerFixture, restoreNativeLocalPlayerFixture } from "./lib/stardew-native-local-player-fixture.mjs";
import { normalizeLiveRunWindowMode, windowModeEnvironment } from "./lib/stardew-live-run.mjs";

const SCHEMA = "gamebuddy-path-predicate-probe/v1";
const WINDOW_MODES = Object.freeze(["visible", "foreground", "minimized", "hidden", "background"]);
const FIXTURE_PROFILE_FOLDER = "GameBuddy.Stardew";
const toolsRoot = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * Run the whole transaction. Resolves with the bounded result on success and
 * rejects with the primary error after teardown has been attempted either way.
 */
export async function runPathPredicateProbe(options) {
  const input = validateInput(options);
  await assertNoStardewProcesses("input");
  const stage = { prepared: false, workingSaveRestored: false, child: null };
  let primaryError = null;
  let result = null;
  try {
    await prepareNativeLocalPlayerFixture({
      root: input.fixtureRoot,
      modsPath: input.modsPath,
      releaseDir: input.releaseDir,
      saveName: input.saveName,
      backupName: input.backupName,
      timeoutSeconds: input.timeoutSeconds,
      action: "move_to_tile",
      binding: input.binding,
      stardewSaveRoot: input.stardewSaveRoot,
    });
    stage.prepared = true;

    await restoreWorkingSave(input);
    stage.workingSaveRestored = true;

    // The staged bundle and the deployed copy must be byte-identical
    // immediately before launch. The shared bin/Release directory is writable
    // by other work in this tree, so a stale deployed DLL would silently make
    // this run measure a different build than the one it reports.
    const releaseSha256 = await hashFile(join(input.releaseDir, "GameBuddy.Stardew.dll"));
    const deployedSha256 = await hashFile(join(input.modsPath, FIXTURE_PROFILE_FOLDER, "GameBuddy.Stardew.dll"));
    if (releaseSha256 !== deployedSha256) throw new Error("deployed_mod_bundle_hash_mismatch");

    await rm(input.evidencePath, { force: true });
    stage.child = spawnSmapi(input.gamePath, input.modsPath, input.windowMode, input.evidencePath);
    const launchIdentity = stage.child.identity;
    const evidence = await waitForEvidence(input, stage.child);

    result = {
      state: evidence.state,
      reasonCode: evidence.reasonCode,
      evidencePath: input.evidencePath,
      releaseSha256,
      deployedSha256,
      launchIdentity,
      measurement: evidence.measurement,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    // A Mod-side rejection writes no evidence file, so the only place its
    // reason code appears is the SMAPI log. Capture it before teardown, while
    // it still describes this run.
    const smapiLogTail = await readSmapiLogTail(input);
    if (stage.child !== null) {
      try {
        await stage.child.close();
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (stage.prepared) {
      try {
        await restoreNativeLocalPlayerFixture({
          root: input.fixtureRoot,
          modsPath: input.modsPath,
          releaseDir: input.releaseDir,
          backupName: input.backupName,
        });
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (stage.workingSaveRestored) {
      try {
        await runFixtureSaveHarness(input, ["-Cleanup"]);
      } catch (error) {
        primaryError ??= error;
      }
    }
    try {
      await assertNoStardewProcesses("teardown");
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (primaryError !== null) throw new Error(`${primaryError.message}${smapiLogTail}`, { cause: primaryError });
  return result;
}

/**
 * The tail of this run's SMAPI log, as an appended diagnostic string. The Mod
 * reports a rejected probe configuration only through the log, since it writes
 * no evidence file in that case; without this the failure would be an
 * unexplained timeout.
 */
async function readSmapiLogTail(input) {
  const path = join(input.stardewSaveRoot, "..", "ErrorLogs", "SMAPI-latest.txt");
  try {
    const raw = await readFile(path, "utf8");
    return `; smapi_log_tail=${raw.slice(-6_000)}`;
  } catch {
    return "; smapi_log_tail=unavailable";
  }
}

function validateInput(options) {
  const absolute = (value, name) => {
    if (typeof value !== "string" || !value.length || !isAbsolute(value)) throw new Error(`invalid_${name}`);
    return resolve(value);
  };
  const fixtureRoot = absolute(options.fixtureRoot, "fixture_root");
  const modsPath = absolute(options.modsPath, "mods_path");
  const releaseDir = absolute(options.releaseDir, "release_dir");
  const gamePath = absolute(options.gamePath, "game_path");
  const stardewSaveRoot = absolute(options.stardewSaveRoot, "stardew_save_root");
  const evidencePath = absolute(options.evidencePath, "evidence_path");
  const saveName = options.saveName;
  if (typeof saveName !== "string" || !/^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$/.test(saveName))
    throw new Error("invalid_fixture_observed_save_slot");
  const backupName = options.backupName;
  if (typeof backupName !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}-fixture-backup$/.test(backupName))
    throw new Error("invalid_fixture_backup_name");
  const binding = options.binding;
  if (!binding || typeof binding !== "object" || binding.observedSaveSlot !== saveName)
    throw new Error("invalid_fixture_binding");
  const timeoutSeconds = options.timeoutSeconds ?? 180;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300)
    throw new Error("invalid_timeout_seconds");
  if (options.windowMode !== undefined && !WINDOW_MODES.includes(options.windowMode)) throw new Error("invalid_window_mode");
  return Object.freeze({
    gamePath,
    modsPath,
    releaseDir,
    fixtureRoot,
    saveName,
    backupName,
    binding,
    stardewSaveRoot,
    evidencePath,
    timeoutSeconds,
    windowMode: normalizeLiveRunWindowMode(options.windowMode ?? "background"),
    clientConfigPath: join(modsPath, FIXTURE_PROFILE_FOLDER, "config.json"),
    searchRadius: options.searchRadius ?? 14,
    maxCandidateTargets: options.maxCandidateTargets ?? 6,
    maxRecordedPathTiles: options.maxRecordedPathTiles ?? 128,
  });
}



async function restoreWorkingSave(input) {
  await runFixtureSaveHarness(input, []);
  const workingSave = join(input.stardewSaveRoot, input.saveName);
  for (const name of [input.saveName, "SaveGameInfo"]) {
    const metadata = await stat(join(workingSave, name));
    if (!metadata.isFile()) throw new Error(`working_save_member_invalid:${name}`);
  }
}

function runFixtureSaveHarness(input, extraArguments) {
  return runPowerShellFile(join(toolsRoot, "prepare-stardew-action-fixture.ps1"), [
    "-FixtureRoot",
    input.fixtureRoot,
    "-TemplateName",
    input.saveName,
    "-SaveName",
    input.saveName,
    "-StardewSaveRoot",
    input.stardewSaveRoot,
    ...extraArguments,
  ]);
}

/**
 * Spawn exactly one SMAPI process against the fixture profile. The executable,
 * the argument shape, the working directory and the window-mode environment
 * mirror `lib/stardew-live-run.mjs`; this runner needs its own handle only
 * because pipe readiness is irrelevant to a Mod-side probe.
 */
function spawnSmapi(gamePath, modsPath, windowMode, evidencePath) {
  const child = spawn(join(gamePath, "StardewModdingAPI.exe"), ["--mods-path", modsPath], {
    cwd: gamePath,
    env: {
      ...process.env,
      ...windowModeEnvironment(windowMode),
      // Env-gated activation, exactly like the xUnit seam probes: the probe is
      // a reusable measurement, not a product capability, so it has no
      // ModConfig surface at all.
      GAMEBUDDY_STARDEW_PATH_PREDICATE_PROBE_LIVE: "1",
      GAMEBUDDY_STARDEW_PATH_PREDICATE_PROBE_EVIDENCE: evidencePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: windowMode === "hidden" || windowMode === "background",
  });
  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4096);
  });
  const exit = new Promise((resolvePromise) => {
    child.on("exit", (code) => resolvePromise(code));
    child.on("error", () => resolvePromise(null));
  });
  return Object.freeze({
    identity: Object.freeze({
      pid: child.pid ?? 0,
      executable: join(gamePath, "StardewModdingAPI.exe"),
      args: Object.freeze(["--mods-path", modsPath]),
      windowMode,
    }),
    onExit: () => exit,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        // SMAPI hosts the game in this one process tree, so terminate the tree
        // rather than only the launcher handle; otherwise a surviving child
        // would make the post-teardown process check fail for the wrong reason.
        await terminateProcessTree(child.pid);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await exit;
    },
    getStderrTail: () => stderrTail,
  });
}

function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    killer.on("error", () => resolvePromise(undefined));
    killer.on("exit", () => resolvePromise(undefined));
  });
}

async function waitForEvidence(input, child) {
  const deadline = Date.now() + input.timeoutSeconds * 1_000;
  let exited = null;
  child.onExit().then((code) => {
    exited = code;
  });
  for (;;) {
    const evidence = await readEvidenceIfPresent(input.evidencePath);
    if (evidence !== null) return evidence;
    if (exited !== null) throw new Error(`smapi_exited_before_probe_wrote_evidence:${exited}:${child.getStderrTail().trim()}`);
    if (Date.now() >= deadline) throw new Error("probe_wrote_no_evidence_before_timeout");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

async function readEvidenceIfPresent(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Poll again rather than failing the run: a read can still catch the file
    // mid-flush even though the Mod writes it in one call.
    return null;
  }
  if (parsed?.schema !== SCHEMA) throw new Error(`probe_evidence_schema_invalid:${parsed?.schema}`);
  return parsed;
}

function assertNoStardewProcesses(phase) {
  // `Get-Process` sets a failing $? when it finds nothing, which makes
  // `powershell -Command` exit 1 for the *successful* case of "no processes".
  // Exit explicitly and read the answer from stdout emptiness instead.
  return runPowerShellCommand(
    "Get-Process -Name 'StardewModdingAPI','Stardew Valley','StardewValley' -ErrorAction SilentlyContinue | " +
      "Select-Object -ExpandProperty Id; exit 0",
  ).then((output) => {
    if (output.trim().length) throw new Error(`existing_stardew_or_smapi_process:${phase}`);
  });
}

function runPowerShellFile(file, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2048);
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise(undefined) : reject(new Error(`fixture_save_harness_failed:${code}:${stderr.trim()}`)),
    );
  });
}

function runPowerShellCommand(command) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise(stdout) : reject(new Error(`powershell_failed:${code}`)),
    );
  });
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) throw new Error("invalid_arguments");
    values.set(key, value);
  }
  return values;
}

async function cliMain(argv) {
  const values = parseCli(argv);
  const required = (name) => {
    const value = values.get(name);
    if (!value) throw new Error(`missing_${name.slice(2)}`);
    return value;
  };
  const optionalInteger = (name) => (values.has(name) ? Number(required(name)) : undefined);
  const fixtureRoot = required("--fixture-root");
  const saveName = required("--save-name");
  const binding = JSON.parse(await readFile(join(fixtureRoot, required("--binding-name")), "utf8"));
  if (binding.observedSaveSlot !== saveName) throw new Error("binding_observed_slot_mismatch");
  const modsPath = required("--mods-path");
  const releaseDir = required("--release-dir");
  // The fixture transaction only rewrites a config that already exists and only
  // deploys into an existing Mod folder; creating them empty is what makes the
  // "no pre-existing profile" case an honest fresh start rather than a failure.
  await mkdir(join(modsPath, FIXTURE_PROFILE_FOLDER), { recursive: true });
  await mkdir(releaseDir, { recursive: true });
  await mkdir(fixtureRoot, { recursive: true });
  const result = await runPathPredicateProbe({
    gamePath: required("--game-path"),
    modsPath,
    releaseDir,
    fixtureRoot,
    saveName,
    backupName: required("--backup-name"),
    stardewSaveRoot: required("--stardew-save-root"),
    evidencePath: required("--evidence-path"),
    binding,
    timeoutSeconds: optionalInteger("--timeout-seconds"),
    windowMode: values.get("--window-mode"),
    searchRadius: optionalInteger("--search-radius"),
    maxCandidateTargets: optionalInteger("--max-candidate-targets"),
    maxRecordedPathTiles: optionalInteger("--max-recorded-path-tiles"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isCli =
  process.argv[1] !== undefined &&
  process.argv[1].replaceAll("\\", "/").endsWith("run-stardew-native-local-path-predicate-probe.mjs");
if (isCli) {
  cliMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
