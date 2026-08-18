#!/usr/bin/env node
/** One-shot, probe-only SMAPI transaction runner. It never alters the owned fixture. */
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateRuntimeAttestation } from "./stardew-navigation-p4-runtime-validator.mjs";

const probeId = "zhexulong.GameBuddy.NavigationRuntimeProbe";
const SHA256 = /^[a-f0-9]{64}$/;
const required = (value, error) => {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(error);
  return resolve(value);
};
const inside = (root, path) => {
  const value = relative(root, path);
  return value && !value.startsWith(".." + sep) && value !== ".." && !isAbsolute(value);
};
const hashFile = async (path, io) =>
  createHash("sha256")
    .update(await io.readFile(path))
    .digest("hex");
async function assertNoLink(path, io) {
  const meta = await io.lstat(path);
  if (meta.isSymbolicLink()) throw new Error("p4_runtime_fixture_link_or_reparse_forbidden");
  return meta;
}
async function listedFiles(root, io) {
  const files = [];
  async function walk(dir, prefix = "") {
    for (const name of (await io.readdir(dir)).sort()) {
      const path = join(dir, name),
        item = await assertNoLink(path, io),
        child = `${prefix}${name}`;
      if (item.isDirectory()) await walk(path, `${child}/`);
      else if (item.isFile()) files.push(child);
      else throw new Error("p4_runtime_fixture_entry_not_regular");
    }
  }
  await walk(root);
  return files;
}
export async function readFixtureManifest(fixtureRoot, io = { lstat, readFile, readdir }) {
  await assertNoLink(fixtureRoot, io);
  const manifestPath = join(fixtureRoot, "fixture-manifest.json");
  await assertNoLink(manifestPath, io);
  let manifest;
  try {
    manifest = JSON.parse(await io.readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("p4_runtime_fixture_manifest_invalid");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.saveDirectoryName !== "string" ||
    !/^[^./\\]+$/.test(manifest.saveDirectoryName) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw new Error("p4_runtime_fixture_manifest_invalid");
  const saveRoot = join(fixtureRoot, manifest.saveDirectoryName);
  if (!inside(fixtureRoot, saveRoot)) throw new Error("p4_runtime_fixture_manifest_invalid");
  const expected = new Map();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256) ||
      !entry.path.startsWith(`${manifest.saveDirectoryName}/`) ||
      entry.path.includes("\\") ||
      entry.path.split("/").some((x) => !x || x === "." || x === "..") ||
      expected.has(entry.path)
    )
      throw new Error("p4_runtime_fixture_manifest_invalid");
    expected.set(entry.path, entry.sha256);
  }
  const rootEntries = await io.readdir(fixtureRoot);
  if (
    rootEntries.length !== 2 ||
    !rootEntries.includes("fixture-manifest.json") ||
    !rootEntries.includes(manifest.saveDirectoryName)
  )
    throw new Error("p4_runtime_fixture_not_owned");
  const actual = await listedFiles(saveRoot, io);
  const expectedRelative = [...expected.keys()].map((x) => x.slice(manifest.saveDirectoryName.length + 1)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedRelative))
    throw new Error("p4_runtime_fixture_entries_mismatch");
  for (const [path, sha256] of expected)
    if ((await hashFile(join(fixtureRoot, path), io)) !== sha256) throw new Error("p4_runtime_fixture_hash_mismatch");
  return Object.freeze({ fixtureRoot, saveDirectoryName: manifest.saveDirectoryName, saveRoot, files: expected });
}
export function validateProbeRunEnvironment(env = process.env) {
  return Object.freeze({
    gamePath: required(env.GAMEBUDDY_STARDEW_GAME_PATH, "p4_runtime_game_path_missing_or_relative"),
    probeBuildPath: required(
      env.GAMEBUDDY_NAVIGATION_P4_PROBE_BUILD_PATH,
      "p4_runtime_probe_build_missing_or_relative",
    ),
    loaderBuildPath: required(
      env.GAMEBUDDY_NAVIGATION_P4_LOADER_BUILD_PATH,
      "p4_runtime_loader_build_missing_or_relative",
    ),
    fixtureRoot: required(env.GAMEBUDDY_NAVIGATION_P4_FIXTURE_ROOT, "p4_runtime_fixture_root_missing_or_relative"),
    saveRoot: required(env.GAMEBUDDY_NAVIGATION_P4_SAVE_ROOT, "p4_runtime_save_root_missing_or_relative"),
  });
}
export function assertProbeOnlyProfile(entries) {
  const allowed = new Set(["GameBuddy.NavigationP4Loader", "GameBuddy.NavigationRuntimeProbe"]);
  if (!Array.isArray(entries) || entries.length !== 2 || entries.some((entry) => !allowed.has(entry)))
    throw new Error("p4_runtime_probe_profile_not_exact");
  return true;
}
export function assertExactModDirectory(entries, exact) {
  if (!Array.isArray(entries) || entries.length !== exact.length || entries.some((entry) => !exact.includes(entry)))
    throw new Error("p4_runtime_probe_mod_directory_not_exact");
  return true;
}
export function assertExactSmapiLaunch(executable, args, gamePath, profileRoot) {
  if (
    resolve(executable) !== join(resolve(gamePath), "StardewModdingAPI.exe") ||
    args.length !== 2 ||
    args[0] !== "--mods-path" ||
    resolve(args[1]) !== resolve(profileRoot)
  )
    throw new Error("p4_runtime_smapi_identity_or_mods_path_invalid");
}
export function verifyLaunchedProcess(process, gamePath, profileRoot) {
  if (
    !process ||
    resolve(process.imagePath ?? "") !== join(resolve(gamePath), "StardewModdingAPI.exe") ||
    !Array.isArray(process.commandLine) ||
    process.commandLine.length !== 2 ||
    process.commandLine[0] !== "--mods-path" ||
    resolve(process.commandLine[1]) !== resolve(profileRoot)
  )
    throw new Error("p4_runtime_launched_process_identity_or_mods_path_invalid");
}
const mac = (token, text) => createHmac("sha256", token).update(text).digest("hex");
const equal = (left, right) =>
  typeof left === "string" && SHA256.test(left) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const defaultListProcesses = () =>
  new Promise((ok, fail) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Process StardewValley,StardewModdingAPI -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
      ],
      { windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.on("error", fail);
    child.on("exit", () => ok(output.trim() ? output.trim().split(/\s+/) : []));
  });
const defaultLaunch = (script, args, env) =>
  new Promise((ok, fail) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      env,
      windowsHide: false,
      stdio: "inherit",
    });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`p4_runtime_launcher_failed:${code}`))));
  });
export async function runNavigationP4RuntimeProbe(options = {}) {
  const env = options.env ?? process.env,
    io = options.io ?? { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile };
  const input = validateProbeRunEnvironment(env),
    now = options.now ?? Date.now,
    deadlineMs = options.deadlineMs ?? 300_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10_000 || deadlineMs > 900_000)
    throw new Error("p4_runtime_deadline_invalid");
  if ((await (options.listProcesses ?? defaultListProcesses)()).length)
    throw new Error("p4_runtime_existing_stardew_or_smapi_process");
  const fixture = await readFixtureManifest(input.fixtureRoot, io);
  if (resolve(input.saveRoot) !== join(resolve(env.APPDATA ?? ""), "StardewValley", "Saves"))
    throw new Error("p4_runtime_save_root_is_not_current_windows_appdata_saves");
  const tx = await io.mkdtemp(join(options.tempRoot ?? tmpdir(), "gamebuddy-p4-probe-")),
    profile = join(tx, "Mods"),
    resultPath = join(tx, "terminal.json"),
    workingSavePath = join(input.saveRoot, fixture.saveDirectoryName),
    stagingSavePath = join(input.saveRoot, `.${fixture.saveDirectoryName}.p4-stage-${randomBytes(16).toString("hex")}`),
    stagingOwnerPath = join(
      input.saveRoot,
      `.${fixture.saveDirectoryName}.p4-stage-${randomBytes(16).toString("hex")}.owner`,
    ),
    stagingOwnerToken = randomBytes(32).toString("hex");
  let primaryError,
    integrityError,
    cleanupError,
    stagingError,
    workingSaveOwned = false,
    stagingSaveOwned = false,
    success;
  const verifyCopiedSave = async (root, errorPrefix) => {
    const actual = await listedFiles(root, io);
    const expected = [...fixture.files.keys()].map((path) => path.slice(fixture.saveDirectoryName.length + 1)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${errorPrefix}_entries_mismatch`);
    for (const [path, sha256] of fixture.files)
      if ((await hashFile(join(root, path.slice(fixture.saveDirectoryName.length + 1)), io)) !== sha256)
        throw new Error(`${errorPrefix}_hash_mismatch`);
  };
  const verifyWorkingSave = () => verifyCopiedSave(workingSavePath, "p4_runtime_transaction_slot");
  const verifyStagingOwnership = async () => {
    await assertNoLink(stagingOwnerPath, io);
    if ((await io.readFile(stagingOwnerPath, "utf8")) !== stagingOwnerToken)
      throw new Error("p4_runtime_staging_ownership_unproven");
  };
  const verifyStagingSave = async () => {
    await verifyStagingOwnership();
    await verifyCopiedSave(stagingSavePath, "p4_runtime_staging_slot");
  };
  try {
    try {
      await io.lstat(workingSavePath);
      throw new Error("p4_runtime_transaction_save_slot_already_exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await io.mkdir(input.saveRoot, { recursive: true });
    // The owner receipt is reserved before copy. A failed or replaced staging
    // tree is deliberately retained for inspection rather than guessed-owned
    // and force-deleted; only an exact manifest match permits cleanup.
    await io.writeFile(stagingOwnerPath, stagingOwnerToken, { encoding: "utf8", flag: "wx" });
    stagingSaveOwned = true;
    await io.cp(fixture.saveRoot, stagingSavePath, { recursive: true, errorOnExist: true });
    await verifyStagingSave();
    await io.rename(stagingSavePath, workingSavePath);
    await io.rm(stagingOwnerPath, { force: false });
    stagingSaveOwned = false;
    workingSaveOwned = true;
    await verifyWorkingSave();
    const loaderProfile = join(profile, "GameBuddy.NavigationP4Loader"),
      probeProfile = join(profile, "GameBuddy.NavigationRuntimeProbe");
    await io.mkdir(profile, { recursive: true });
    await io.mkdir(loaderProfile);
    await io.mkdir(probeProfile);
    for (const name of ["manifest.json", "StardewNavigationRuntimeProbe.dll"])
      await io.cp(join(input.probeBuildPath, name), join(probeProfile, name), { errorOnExist: true });
    for (const name of ["manifest.json", "StardewNavigationP4Loader.dll"])
      await io.cp(join(input.loaderBuildPath, name), join(loaderProfile, name), { errorOnExist: true });
    if (JSON.parse(await io.readFile(join(probeProfile, "manifest.json"), "utf8"))?.UniqueID !== probeId)
      throw new Error("p4_runtime_probe_manifest_invalid");
    if (
      JSON.parse(await io.readFile(join(loaderProfile, "manifest.json"), "utf8"))?.UniqueID !==
      "zhexulong.GameBuddy.NavigationP4Loader"
    )
      throw new Error("p4_runtime_loader_manifest_invalid");
    const token = randomBytes(32).toString("hex"),
      nonce = randomBytes(24).toString("hex"),
      deadlineUnixMs = now() + deadlineMs;
    const armBase = `arm|${nonce}|${tx}|${resultPath}|${deadlineUnixMs}`;
    const arm = { nonce, transactionPath: tx, resultPath, deadlineUnixMs, integrityMac: mac(token, armBase) };
    await io.writeFile(join(probeProfile, "arm.json"), JSON.stringify(arm), { encoding: "utf8", flag: "wx" });
    const loaderFiles = [...fixture.files]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path));
    if (
      loaderFiles.length !== 2 ||
      loaderFiles.some((file) => file.path.slice(fixture.saveDirectoryName.length + 1).includes("/"))
    )
      throw new Error("p4_runtime_fixture_shape_not_supported_by_loader");
    const loaderCanonical = `load|${fixture.saveDirectoryName}|${deadlineUnixMs}|${loaderFiles.map((file) => `${file.path}:${file.sha256}`).join("|")}`;
    await io.writeFile(
      join(loaderProfile, "fixture-load.json"),
      JSON.stringify({
        observedSaveSlot: fixture.saveDirectoryName,
        deadlineUnixMs,
        files: loaderFiles,
        integrityMac: mac(token, loaderCanonical),
      }),
      { encoding: "utf8", flag: "wx" },
    );
    assertProbeOnlyProfile(await io.readdir(profile));
    assertExactModDirectory(await io.readdir(probeProfile), [
      "manifest.json",
      "StardewNavigationRuntimeProbe.dll",
      "arm.json",
    ]);
    assertExactModDirectory(await io.readdir(loaderProfile), [
      "manifest.json",
      "StardewNavigationP4Loader.dll",
      "fixture-load.json",
    ]);
    const script =
        options.launcherPath ??
        join(dirname(fileURLToPath(import.meta.url)), "start-stardew-navigation-p4-runtime-probe.ps1"),
      args = [
        "-GamePath",
        input.gamePath,
        "-ModsPath",
        profile,
        "-ObservedSaveSlot",
        fixture.saveDirectoryName,
        "-ResultPath",
        resultPath,
        "-DeadlineUnixMs",
        String(deadlineUnixMs),
      ];
    assertExactSmapiLaunch(
      join(input.gamePath, "StardewModdingAPI.exe"),
      ["--mods-path", profile],
      input.gamePath,
      profile,
    );
    await (options.launch ?? defaultLaunch)(script, args, {
      ...process.env,
      // The transaction secret is inherited by the exact launched SMAPI process,
      // but is never serialized into either Mod profile. Both probe and loader
      // must authenticate their profile inputs with it; the runner uses it to
      // authenticate the terminal independently of readable profile files.
      GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY: token,
    });
    const record = JSON.parse(await io.readFile(resultPath, "utf8"));
    if (now() >= deadlineUnixMs) throw new Error("p4_runtime_terminal_after_deadline");
    if (!record?.attestation || record.attestation.state !== "world_map_completed")
      throw new Error("p4_runtime_terminal_not_successful_attestation");
    if (
      !record ||
      record.nonce !== nonce ||
      !record.attestation ||
      !equal(
        record.integrityMac,
        mac(token, `result|${nonce}|${tx}|${resultPath}|${JSON.stringify(record.attestation)}`),
      )
    )
      throw new Error("p4_runtime_terminal_not_authenticated_to_arm");
    const validation = validateRuntimeAttestation(record.attestation);
    if (!validation.valid) throw new Error(`p4_runtime_terminal_invalid:${validation.errors.join(",")}`);
    success = Object.freeze({ state: record.attestation.state, validation });
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
        await verifyWorkingSave();
        await io.rm(workingSavePath, { recursive: true, force: false });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (stagingSaveOwned) {
      try {
        await verifyStagingSave();
        await io.rm(stagingSavePath, { recursive: true, force: false });
        await io.rm(stagingOwnerPath, { force: false });
      } catch (error) {
        stagingError = error;
      }
    }
    // Windows can retain a loaded Mod DLL briefly after SMAPI's root process
    // exits. Retry cleanup before surfacing it; the transaction never succeeds
    // while any private profile file remains.
    await io.rm(tx, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
  const errors = [primaryError, integrityError, cleanupError, stagingError].filter(Boolean);
  if (errors.length > 1)
    throw new AggregateError(errors, `p4_runtime_failed:${errors.map((error) => error.message).join(";")}`);
  if (errors.length) throw errors[0];
  return success;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await runNavigationP4RuntimeProbe()));
