#!/usr/bin/env node
/**
 * Windows-only P0b transaction-to-target-version launch seam.
 *
 * This runner arms an already-owned Portfolio transaction, verifies the
 * resulting non-secret producer config, and launches exactly one SMAPI
 * process. It deliberately does not restore/commit, create evidence, choose
 * a save, or send input. The signing key is never read as a CLI argument and
 * is inherited only through the named parent-process environment variable.
 */
import { execFile, spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { preparePortfolioP0bLifecycleProducer, PORTFOLIO_TOPOLOGY } from "./lib/stardew-portfolio-profile.mjs";

const execFileAsync = promisify(execFile);
const STARDEW_PROCESS_NAMES = Object.freeze(["StardewModdingAPI.exe", "Stardew Valley.exe"]);
const PHASE = "P0b_transaction_to_launch";
const DEFAULT_KEY_ENVIRONMENT_NAME = "GAMEBUDDY_PORTFOLIO_START_MANIFEST_KEY";
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export function parsePortfolioP0bCliArgs(argv = []) {
  const values = {};
  const flags = new Map([
    ["--game-path", "gamePath"],
    ["--profile-root", "profileRoot"],
    ["--data-root", "dataRoot"],
    ["--save-root", "saveRoot"],
    ["--release-dir", "releaseDir"],
    ["--backup-name", "backupName"],
    ["--save-name", "logicalSaveName"],
    ["--observed-save-slot", "observedSaveSlot"],
    ["--start-manifest", "startManifestPath"],
    ["--signing-key-environment-name", "signingKeyEnvironmentVariableName"],
    ["--timeout-seconds", "timeoutSeconds"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags.get(argv[index]);
    if (!key || index + 1 >= argv.length || argv[index + 1].startsWith("--"))
      throw new Error("portfolio_p0b_cli_argument_invalid");
    values[key] = argv[++index];
  }
  return Object.freeze(values);
}

export async function runPortfolioP0bLifecycle(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("portfolio_p0b_windows_only");
  const env = options.env ?? process.env;
  const input = validateInputs(options, env);
  const prepare = options.prepare ?? preparePortfolioP0bLifecycleProducer;
  const spawnProcess = options.spawnProcess ?? options.spawn ?? spawn;
  const wait = options.wait ?? options.delay ?? delay;
  const timeoutMs = options.timeoutMs ?? input.timeoutSeconds * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("portfolio_p0b_timeout_invalid");

  // All checks that can fail without touching the owned transaction happen
  // before prepare. A live Stardew process or an ambiguous process query must
  // never allow profile mutation or launch.
  await assertNoStardewProcesses(options.processList ?? defaultProcessList);
  await validateLaunchTarget(input.gamePath, input.gameExecutable, options.stat ?? lstat, options.realpath ?? realpath);
  if (typeof env[input.signingKeyEnvironmentVariableName] !== "string" || env[input.signingKeyEnvironmentVariableName].length === 0)
    throw new Error("portfolio_p0b_signing_key_environment_value_missing");

  const prepared = await prepare({
    ...input,
    processNames: options.processNames,
  });
  if (prepared?.state !== "p0b_lifecycle_producer_prepared")
    throw new Error("portfolio_p0b_prepare_state_invalid");
  await verifyArmedConfig(input);

  const childEnvironment = { ...env };
  const child = spawnProcess(input.gameExecutable, ["--mods-path", input.profileRoot], {
    cwd: input.gamePath,
    env: childEnvironment,
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: options.stdio ?? "ignore",
  });
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    await terminatePortfolioProcessTree(child, { platform, spawnProcess, wait, processExists: options.processExists });
    throw new Error("portfolio_p0b_child_identity_invalid");
  }

  let childClosed = false;
  try {
    const result = await waitForChild(child, timeoutMs, wait);
    childClosed = true;
    return Object.freeze({
      state: "completed",
      phase: PHASE,
      topology: PORTFOLIO_TOPOLOGY,
      profileRoot: input.profileRoot,
      processId: child.pid,
      exitCode: result.code ?? null,
      signal: result.signal ?? null,
      timedOut: false,
      transaction: "retained",
    });
  } catch (error) {
    throw error;
  } finally {
    // A naturally closed process needs no kill. Timeout and child errors are
    // explicitly tree-terminated and awaited.
    if (!childClosed)
      await terminatePortfolioProcessTree(child, {
        platform,
        spawnProcess,
        wait,
        processExists: options.processExists,
      });
  }
}

export async function terminatePortfolioProcessTree(
  child,
  {
    platform = process.platform,
    spawnProcess = spawn,
    wait = delay,
    graceMs = 250,
    processExists = defaultProcessExists,
  } = {},
) {
  if (!child?.pid) return;
  if (platform !== "win32") throw new Error("portfolio_p0b_windows_only");
  const killer = spawnProcess("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  await waitForChild(killer, Math.max(graceMs, 1000), wait).catch(() => undefined);
  await waitForProcessGone(child.pid, processExists, wait, Math.max(graceMs, 1000));
}

function validateInputs(options, env) {
  const get = (key, environmentName) => options[key] ?? env[environmentName];
  const gamePath = requireAbsolute(get("gamePath", "GAMEBUDDY_STARDEW_GAME_PATH"));
  const profileRoot = requireAbsolute(get("profileRoot", "GAMEBUDDY_PORTFOLIO_PROFILE_ROOT"));
  const dataRoot = requireAbsolute(get("dataRoot", "GAMEBUDDY_PORTFOLIO_DATA_ROOT"));
  const saveRoot = requireAbsolute(get("saveRoot", "GAMEBUDDY_PORTFOLIO_SAVE_ROOT"));
  const releaseDir = requireAbsolute(get("releaseDir", "GAMEBUDDY_PORTFOLIO_RELEASE_DIR"));
  const logicalSaveName = requireValue(get("logicalSaveName", "GAMEBUDDY_PORTFOLIO_SAVE_NAME"), "portfolio_p0b_save_name_missing");
  const observedSaveSlot = requireValue(
    get("observedSaveSlot", "GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT"),
    "portfolio_p0b_observed_save_slot_missing",
  );
  const backupName = requireValue(get("backupName", "GAMEBUDDY_PORTFOLIO_BACKUP_NAME"), "portfolio_p0b_backup_name_missing");
  const startManifestPath = requireAbsolute(
    get("startManifestPath", "GAMEBUDDY_PORTFOLIO_START_MANIFEST"),
    "portfolio_p0b_start_manifest_path_missing",
  );
  const signingKeyEnvironmentVariableName = get(
    "signingKeyEnvironmentVariableName",
    "GAMEBUDDY_PORTFOLIO_SIGNING_KEY_ENVIRONMENT_VARIABLE_NAME",
  ) ?? DEFAULT_KEY_ENVIRONMENT_NAME;
  const timeoutSeconds = Number(get("timeoutSeconds", "GAMEBUDDY_PORTFOLIO_P0B_TIMEOUT_SECONDS") ?? 180);
  if (!ENVIRONMENT_NAME.test(signingKeyEnvironmentVariableName))
    throw new Error("portfolio_p0b_signing_key_environment_name_invalid");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900)
    throw new Error("portfolio_p0b_timeout_invalid");
  if (!SAFE_NAME.test(backupName)) throw new Error("portfolio_p0b_backup_name_invalid");
  return Object.freeze({
    gamePath,
    gameExecutable: join(gamePath, "StardewModdingAPI.exe"),
    profileRoot,
    dataRoot,
    saveRoot,
    releaseDir,
    backupName,
    saveName: logicalSaveName,
    logicalSaveName,
    observedSaveSlot,
    startManifestPath,
    signingKeyEnvironmentVariableName,
    timeoutSeconds,
  });
}

async function validateLaunchTarget(gamePath, executable, stat, resolveRealPath) {
  await validateRealPath(gamePath, "directory", stat, resolveRealPath, "portfolio_p0b_game_path");
  await validateRealPath(executable, "file", stat, resolveRealPath, "portfolio_p0b_smapi_executable");
}

async function validateRealPath(target, kind, stat, resolveRealPath, errorPrefix) {
  if (typeof target !== "string" || !isAbsolute(target)) throw new Error(`${errorPrefix}_not_absolute`);
  let info;
  try {
    info = await stat(target);
    await resolveRealPath(target);
  } catch {
    throw new Error(`${errorPrefix}_missing`);
  }
  const matchesKind = kind === "file" ? info?.isFile?.() : info?.isDirectory?.();
  if (!matchesKind || info.isSymbolicLink?.()) throw new Error(`${errorPrefix}_invalid`);
  let current = resolve(target);
  while (true) {
    let parentInfo;
    try {
      parentInfo = await stat(current);
    } catch {
      throw new Error(`${errorPrefix}_missing`);
    }
    if (parentInfo.isSymbolicLink?.()) throw new Error(`${errorPrefix}_reparse`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function assertNoStardewProcesses(processList) {
  let result;
  try {
    result = await processList(STARDEW_PROCESS_NAMES);
  } catch {
    throw new Error("portfolio_p0b_process_query_failed");
  }
  if (
    !Array.isArray(result) ||
    result.some((name) => typeof name !== "string" || !STARDEW_PROCESS_NAMES.includes(name)) ||
    new Set(result).size !== result.length
  )
    throw new Error("portfolio_p0b_process_query_ambiguous");
  if (result.length > 0) throw new Error(`portfolio_p0b_stardew_process_running:${result.join(",")}`);
}

async function defaultProcessList(processNames) {
  if (process.platform !== "win32") throw new Error("portfolio_p0b_windows_only");
  const requested = Array.isArray(processNames) ? processNames : STARDEW_PROCESS_NAMES;
  const found = [];
  for (const imageName of requested) {
    try {
      const result = await execFileAsync(
        "tasklist.exe",
        ["/FI", `IMAGENAME eq ${imageName}`, "/NH", "/FO", "CSV"],
        { windowsHide: true },
      );
      const lines = String(result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) throw new Error("portfolio_p0b_process_query_ambiguous");
      for (const line of lines) {
        if (/^INFO:\s+No tasks are running/i.test(line)) continue;
        const match = /^\"([^\"]+)\",/.exec(line);
        if (!match) throw new Error("portfolio_p0b_process_query_ambiguous");
        if (match[1].toLowerCase() === imageName.toLowerCase()) found.push(imageName);
      }
    } catch (error) {
      // tasklist uses exit code 1 when the filter has no matching process.
      if (error?.code === 1) continue;
      throw error;
    }
  }
  return Object.freeze(found);
}

async function verifyArmedConfig(input) {
  let config;
  try {
    config = JSON.parse(await readFile(join(input.profileRoot, "GameBuddy", "config.json"), "utf8"));
  } catch {
    throw new Error("portfolio_p0b_config_reread_failed");
  }
  const portfolio = config?.Portfolio;
  const producer = portfolio?.P0bLifecycleProducer;
  const expected = {
    Enable: true,
    LogicalSaveName: input.logicalSaveName,
    ObservedSaveSlot: input.observedSaveSlot,
    TimeoutSeconds: input.timeoutSeconds,
    StartManifestPath: resolve(input.startManifestPath),
    SigningKeyEnvironmentVariableName: input.signingKeyEnvironmentVariableName,
  };
  if (!producer || JSON.stringify(producer) !== JSON.stringify(expected))
    throw new Error("portfolio_p0b_config_reread_mismatch");
  for (const key of ["SigningKey", "SigningKeyValue", "HostAutomation", "EnableLocalBridge"])
    if (Object.prototype.hasOwnProperty.call(config, key) || Object.prototype.hasOwnProperty.call(portfolio, key))
      throw new Error("portfolio_p0b_config_nonsecret_boundary_violation");
}

async function waitForProcessGone(pid, processExists, wait, timeoutMs) {
  const started = Date.now();
  while (await processExists(pid)) {
    if (Date.now() - started >= timeoutMs) throw new Error("portfolio_p0b_child_remains_after_cleanup");
    await wait(Math.min(50, timeoutMs));
  }
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function requireAbsolute(value, missingCode = "portfolio_p0b_path_missing_or_not_absolute") {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) throw new Error(missingCode);
  return resolve(value);
}

function requireValue(value, code) {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function waitForChild(child, timeoutMs, wait) {
  const controller = new AbortController();
  return new Promise((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      controller.abort();
      fn(value);
    };
    child.once("error", (error) => finish(rejectResult, error));
    child.once("close", (code, signal) => finish(resolveResult, { code, signal }));
    // The injectable wait is the timeout clock so tests can prove teardown
    // without sleeping. It carries no secret or process details.
    void wait(timeoutMs, undefined, { signal: controller.signal }).then(() => {
      const error = new Error("portfolio_p0b_launch_timeout");
      error.code = "portfolio_p0b_launch_timeout";
      finish(rejectResult, error);
    }, (error) => {
      if (!settled && error?.name !== "AbortError") finish(rejectResult, error);
    });
  });
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function environmentOptions(env = process.env) {
  return {
    env,
    gamePath: env.GAMEBUDDY_STARDEW_GAME_PATH,
    profileRoot: env.GAMEBUDDY_PORTFOLIO_PROFILE_ROOT,
    dataRoot: env.GAMEBUDDY_PORTFOLIO_DATA_ROOT,
    saveRoot: env.GAMEBUDDY_PORTFOLIO_SAVE_ROOT,
    releaseDir: env.GAMEBUDDY_PORTFOLIO_RELEASE_DIR,
    backupName: env.GAMEBUDDY_PORTFOLIO_BACKUP_NAME,
    logicalSaveName: env.GAMEBUDDY_PORTFOLIO_SAVE_NAME,
    observedSaveSlot: env.GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT,
    startManifestPath: env.GAMEBUDDY_PORTFOLIO_START_MANIFEST,
    signingKeyEnvironmentVariableName: env.GAMEBUDDY_PORTFOLIO_SIGNING_KEY_ENVIRONMENT_VARIABLE_NAME,
    timeoutSeconds: env.GAMEBUDDY_PORTFOLIO_P0B_TIMEOUT_SECONDS,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runPortfolioP0bLifecycle({ ...environmentOptions(), ...parsePortfolioP0bCliArgs(process.argv.slice(2)) });
    emit({ ...result });
  } catch (error) {
    emit({ state: "BLOCKED", phase: PHASE, topology: PORTFOLIO_TOPOLOGY, reasons: [error?.message ?? "portfolio_p0b_launch_failed"] });
    process.exitCode = 2;
  }
}
