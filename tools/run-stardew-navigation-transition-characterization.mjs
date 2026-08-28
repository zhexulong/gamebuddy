#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readFixtureManifest } from "./run-stardew-navigation-p4-runtime-probe.mjs";
import { validateTransitionCharacterization } from "./stardew-navigation-transition-characterization-validator.mjs";

const loaderId = "zhexulong.GameBuddy.NavigationP4Loader";
const probeId = "zhexulong.GameBuddy.NavigationTransitionCharacterization";
const SHA256 = /^[a-f0-9]{64}$/;
const required = (value, error) => {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(error);
  return resolve(value);
};
const inside = (root, path) => {
  const value = relative(root, path);
  return value && !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const mac = (token, value) => createHmac("sha256", token).update(value).digest("hex");
const equalMac = (left, right) =>
  typeof left === "string" && SHA256.test(left) && SHA256.test(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

async function assertNoLink(path, io) {
  const meta = await io.lstat(path);
  if (meta.isSymbolicLink()) throw new Error("transition_fixture_link_or_reparse_forbidden");
  return meta;
}
async function listedFiles(root, io) {
  const files = [];
  async function walk(dir, prefix = "") {
    for (const name of (await io.readdir(dir)).sort()) {
      const path = join(dir, name);
      const meta = await assertNoLink(path, io);
      if (meta.isDirectory()) await walk(path, `${prefix}${name}/`);
      else if (meta.isFile()) files.push(`${prefix}${name}`);
      else throw new Error("transition_fixture_entry_not_regular");
    }
  }
  await walk(root);
  return files;
}

export function validateTransitionRunEnvironment(env = process.env) {
  return Object.freeze({
    gamePath: required(env.GAMEBUDDY_STARDEW_GAME_PATH, "transition_game_path_missing_or_relative"),
    probeBuildPath: required(
      env.GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_PROBE_BUILD_PATH,
      "transition_probe_build_missing_or_relative",
    ),
    loaderBuildPath: required(
      env.GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_LOADER_BUILD_PATH,
      "transition_loader_build_missing_or_relative",
    ),
    fixtureRoot: required(
      env.GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_FIXTURE_ROOT,
      "transition_fixture_root_missing_or_relative",
    ),
    saveRoot: required(
      env.GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_SAVE_ROOT,
      "transition_save_root_missing_or_relative",
    ),
    artifactPath: env.GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_ARTIFACT_PATH
      ? required(env.GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_ARTIFACT_PATH, "transition_artifact_path_invalid")
      : null,
  });
}

export function assertTransitionProfile(entries) {
  const allowed = new Set(["GameBuddy.NavigationP4Loader", "GameBuddy.NavigationTransitionCharacterization"]);
  if (!Array.isArray(entries) || entries.length !== 2 || entries.some((entry) => !allowed.has(entry)))
    throw new Error("transition_profile_not_exact");
  return true;
}
export function assertExactDirectory(entries, expected) {
  if (!Array.isArray(entries) || entries.length !== expected.length || entries.some((entry) => !expected.includes(entry)))
    throw new Error("transition_mod_directory_not_exact");
  return true;
}
export function assertExactSmapiLaunch(executable, args, gamePath, profileRoot) {
  if (
    resolve(executable) !== join(resolve(gamePath), "StardewModdingAPI.exe") ||
    args.length !== 2 ||
    args[0] !== "--mods-path" ||
    resolve(args[1]) !== resolve(profileRoot)
  ) throw new Error("transition_smapi_identity_or_mods_path_invalid");
}

const defaultListProcesses = () =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Process StardewValley,StardewModdingAPI -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"],
      { windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", () => resolvePromise(output.trim() ? output.trim().split(/\s+/) : []));
  });
const defaultLaunch = (script, args, env) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      env,
      windowsHide: false,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`transition_launcher_failed:${code}`))));
  });

async function verifyCopiedSave(root, fixture, io) {
  const actual = await listedFiles(root, io);
  const expected = [...fixture.files.keys()].map((path) => path.slice(fixture.saveDirectoryName.length + 1)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("transition_working_save_entries_mismatch");
  for (const [path, expectedHash] of fixture.files) {
    const actualHash = digest(await io.readFile(join(root, path.slice(fixture.saveDirectoryName.length + 1))));
    if (actualHash !== expectedHash) throw new Error("transition_working_save_hash_mismatch");
  }
}

function finalizeArtifact(observation, cleanup) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation))
    throw new Error("transition_observation_invalid");
  const artifact = { ...observation, fixtureCleanup: cleanup };
  const validation = validateTransitionCharacterization(artifact);
  if (!validation.valid) throw new Error(`transition_artifact_invalid:${validation.errors.join(",")}`);
  return Object.freeze({ artifact: Object.freeze(artifact), validation });
}

export async function runNavigationTransitionCharacterization(options = {}) {
  const env = options.env ?? process.env;
  const input = validateTransitionRunEnvironment(env);
  const io = options.io ?? { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile };
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? 300_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10_000 || deadlineMs > 900_000)
    throw new Error("transition_deadline_invalid");
  const listProcesses = options.listProcesses ?? defaultListProcesses;
  if ((await listProcesses()).length) throw new Error("transition_existing_stardew_or_smapi_process");
  const fixture = await readFixtureManifest(input.fixtureRoot, io);
  if (resolve(input.saveRoot) !== join(resolve(env.APPDATA ?? ""), "StardewValley", "Saves"))
    throw new Error("transition_save_root_is_not_current_windows_appdata_saves");

  const tx = await io.mkdtemp(join(options.tempRoot ?? tmpdir(), "gamebuddy-navigation-transition-"));
  const profile = join(tx, "Mods");
  const observationPath = join(tx, "observation.json");
  const workingSavePath = join(input.saveRoot, fixture.saveDirectoryName);
  const stagingSavePath = join(input.saveRoot, `.${fixture.saveDirectoryName}.transition-stage-${randomBytes(16).toString("hex")}`);
  const stagingOwnerPath = `${stagingSavePath}.owner`;
  const stagingOwnerToken = randomBytes(32).toString("hex");
  let primaryError;
  let integrityError;
  let cleanupError;
  let observation;
  let workingSaveOwned = false;
  let stagingSaveOwned = false;
  try {
    try {
      await io.lstat(workingSavePath);
      throw new Error("transition_transaction_save_slot_already_exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await io.mkdir(input.saveRoot, { recursive: true });
    await io.writeFile(stagingOwnerPath, stagingOwnerToken, { encoding: "utf8", flag: "wx" });
    stagingSaveOwned = true;
    await io.cp(fixture.saveRoot, stagingSavePath, { recursive: true, errorOnExist: true });
    await assertNoLink(stagingOwnerPath, io);
    if ((await io.readFile(stagingOwnerPath, "utf8")) !== stagingOwnerToken) throw new Error("transition_stage_ownership_unproven");
    await verifyCopiedSave(stagingSavePath, fixture, io);
    await io.rename(stagingSavePath, workingSavePath);
    await io.rm(stagingOwnerPath, { force: false });
    stagingSaveOwned = false;
    workingSaveOwned = true;
    await verifyCopiedSave(workingSavePath, fixture, io);

    const loaderProfile = join(profile, "GameBuddy.NavigationP4Loader");
    const probeProfile = join(profile, "GameBuddy.NavigationTransitionCharacterization");
    await io.mkdir(loaderProfile, { recursive: true });
    await io.mkdir(probeProfile, { recursive: true });
    await io.cp(join(input.loaderBuildPath, "manifest.json"), join(loaderProfile, "manifest.json"), { errorOnExist: true });
    await io.cp(join(input.loaderBuildPath, "StardewNavigationP4Loader.dll"), join(loaderProfile, "StardewNavigationP4Loader.dll"), { errorOnExist: true });
    await io.cp(join(input.probeBuildPath, "manifest.json"), join(probeProfile, "manifest.json"), { errorOnExist: true });
    await io.cp(join(input.probeBuildPath, "StardewNavigationTransitionCharacterization.dll"), join(probeProfile, "StardewNavigationTransitionCharacterization.dll"), { errorOnExist: true });
    if (JSON.parse(await io.readFile(join(loaderProfile, "manifest.json"))).UniqueID !== loaderId) throw new Error("transition_loader_manifest_invalid");
    if (JSON.parse(await io.readFile(join(probeProfile, "manifest.json"))).UniqueID !== probeId) throw new Error("transition_probe_manifest_invalid");

    const token = randomBytes(32).toString("hex");
    const nonce = randomBytes(24).toString("hex");
    const deadlineUnixMs = now() + deadlineMs;
    const armCanonical = `arm|${nonce}|${tx}|${observationPath}|${deadlineUnixMs}`;
    await io.writeFile(join(probeProfile, "arm.json"), JSON.stringify({ nonce, transactionPath: tx, observationPath, deadlineUnixMs, integrityMac: mac(token, armCanonical) }), { encoding: "utf8", flag: "wx" });
    const loaderFiles = [...fixture.files].map(([path, sha256]) => ({ path, sha256 })).sort((left, right) => left.path.localeCompare(right.path));
    if (loaderFiles.length !== 2 || loaderFiles.some((file) => file.path.slice(fixture.saveDirectoryName.length + 1).includes("/")))
      throw new Error("transition_fixture_shape_not_supported_by_loader");
    const loadCanonical = `load|${fixture.saveDirectoryName}|${deadlineUnixMs}|${loaderFiles.map((file) => `${file.path}:${file.sha256}`).join("|")}`;
    await io.writeFile(join(loaderProfile, "fixture-load.json"), JSON.stringify({ observedSaveSlot: fixture.saveDirectoryName, deadlineUnixMs, files: loaderFiles, integrityMac: mac(token, loadCanonical) }), { encoding: "utf8", flag: "wx" });
    assertTransitionProfile(await io.readdir(profile));
    assertExactDirectory(await io.readdir(loaderProfile), ["manifest.json", "StardewNavigationP4Loader.dll", "fixture-load.json"]);
    assertExactDirectory(await io.readdir(probeProfile), ["manifest.json", "StardewNavigationTransitionCharacterization.dll", "arm.json"]);
    const script = options.launcherPath ?? join(dirname(fileURLToPath(import.meta.url)), "start-stardew-navigation-transition-characterization.ps1");
    assertExactSmapiLaunch(join(input.gamePath, "StardewModdingAPI.exe"), ["--mods-path", profile], input.gamePath, profile);
    await (options.launch ?? defaultLaunch)(script, ["-GamePath", input.gamePath, "-ModsPath", profile, "-ObservedSaveSlot", fixture.saveDirectoryName, "-ObservationPath", observationPath, "-DeadlineUnixMs", String(deadlineUnixMs)], {
      ...process.env,
      GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY: token,
      GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_TRANSACTION_KEY: token,
    });
    const record = JSON.parse(await io.readFile(observationPath, "utf8"));
    if (now() >= deadlineUnixMs || record?.nonce !== nonce || typeof record?.observation !== "string") throw new Error("transition_terminal_not_authenticated_to_arm");
    if (!equalMac(record.integrityMac, mac(token, `observation|${nonce}|${tx}|${observationPath}|${record.observation}`))) throw new Error("transition_terminal_mac_invalid");
    observation = JSON.parse(record.observation);
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await readFixtureManifest(input.fixtureRoot, io);
    } catch (error) {
      integrityError = error;
    }
    if (workingSaveOwned) {
      try {
        await verifyCopiedSave(workingSavePath, fixture, io);
        await io.rm(workingSavePath, { recursive: true, force: false });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (stagingSaveOwned) {
      try {
        await assertNoLink(stagingOwnerPath, io);
        if ((await io.readFile(stagingOwnerPath, "utf8")) !== stagingOwnerToken) throw new Error("transition_stage_ownership_unproven");
        await verifyCopiedSave(stagingSavePath, fixture, io);
        await io.rm(stagingSavePath, { recursive: true, force: false });
        await io.rm(stagingOwnerPath, { force: false });
      } catch (error) {
        cleanupError = error;
      }
    }
    if ((await listProcesses()).length) cleanupError ??= new Error("transition_stardew_process_still_running");
  }
  const errors = [primaryError, integrityError, cleanupError].filter(Boolean);
  if (errors.length) {
    await io.rm(tx, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    if (errors.length > 1) throw new AggregateError(errors, `transition_failed:${errors.map((error) => error.message).join(";")}`);
    throw errors[0];
  }
  if (input.artifactPath && inside(tx, input.artifactPath)) throw new Error("transition_artifact_must_not_be_inside_transaction");
  // The transaction contains the temporary Mods profile, authenticated arm,
  // and raw observation. Delete it before constructing or publishing the final
  // artifact so a later profile cleanup failure cannot leave completion output.
  await io.rm(tx, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  const cleanup = { restored: true, noStardewProcess: true, noSmapiProcess: true };
  const result = finalizeArtifact(observation, cleanup);
  if (input.artifactPath) {
    try {
      await io.lstat(input.artifactPath);
      throw new Error("transition_artifact_already_exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await io.writeFile(input.artifactPath, JSON.stringify(result.artifact), { encoding: "utf8", flag: "wx" });
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runNavigationTransitionCharacterization();
  console.log(JSON.stringify(result));
}
