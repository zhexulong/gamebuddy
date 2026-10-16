#!/usr/bin/env node
/**
 * Isolated end-to-end sandbox for the desktop entry's pre-launch Mod step.
 *
 * The entry brings the player's own Stardew installation to the Mod package the
 * generation ships before the Host composition starts
 * (`host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts` ->
 * `deployCompanionGameMod`). This script proves that step against a disposable
 * generation without the real game, the real Steam library or the real GOG
 * registry:
 *
 *  - it installs the generation into a throwaway launcher-shaped root exactly
 *    like `tools/desktop-composition-launch.mjs` installs it for the Desktop gate;
 *  - it fabricates a Stardew installation and points the Host's OWN GOG proposal
 *    source at it through the `ProgramData` environment variable that source
 *    reads (`host/src/stardew-game-install/gog-source.ts`), so the entry's
 *    production discovery resolves a real `resolved` installation;
 *  - it spawns the real `desktop-host-entry.internal.js` over the private
 *    bootstrap wire, reads the announced status frames, and reports the
 *    `companion-mod-*` outcome the entry chose.
 *
 * The Guardian session and the Host composition that follow the Mod step are
 * deliberately not stood up: they are a different authority, and this sandbox is
 * about the Mod step. The run is torn down as soon as the entry has announced the
 * outcome and moved on to its next stage.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  admitDesktopCompositionGeneration,
  composeDesktopBootstrapFrame,
  composeDesktopChildEnvironment,
  createDesktopCompositionRootLayout,
  installDesktopCompositionGeneration,
  readProductionPointer,
} from "../../tools/desktop-composition-launch.mjs";

const STATUS_SCHEMA = "gamebuddy-desktop-host-bootstrap-status/v1";
const MOD_STEP_STAGE = "companion-mod";
const GUARDIAN_STAGE = "guardian-session";
const GAME_SESSION_MODE = "fresh";
const GAME_EXECUTABLE = "Stardew Valley.exe";
const SMAPI_EXECUTABLE = "StardewModdingAPI.exe";
const MODS_DIRECTORY = "Mods";
const COMPANION_MOD_DIRECTORY = "GameBuddy";
const ENTRY_RELATIVE_PATH = join("bootstrap", "entry", "desktop-host-entry.internal.js");
const RUNTIME_RELATIVE_PATH = join("runtime", "node.exe");
const OUTCOME_PREFIX = `${MOD_STEP_STAGE}-`;
const FRAME_TIMEOUT_MS = 60_000;
const EXIT_GRACE_MS = 10_000;

function parseArguments(argv) {
  const options = {
    generationOutput: "_devdist-mod-autodeploy",
    workRoot: undefined,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--generation-output") options.generationOutput = argv[++index];
    else if (argument === "--work-root") options.workRoot = argv[++index];
    else if (argument === "--keep") options.keep = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (typeof options.generationOutput !== "string" || options.generationOutput.length === 0)
    throw new Error("generation_output_required");
  return options;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function sha256File(path) {
  return sha256(await readFile(path));
}

/** One recursive measurement of a directory: per-file digest/size/mtime plus the directory's own mtime. */
async function snapshotTree(root) {
  const files = {};
  const visit = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile()) {
        const info = await stat(path);
        files[name] = Object.freeze({ sha256: await sha256File(path), size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  };
  let exists = true;
  let directoryMtimeMs;
  try {
    directoryMtimeMs = (await stat(root)).mtimeMs;
  } catch {
    exists = false;
  }
  if (exists) await visit(root, "");
  return Object.freeze({ exists, directoryMtimeMs, files: Object.freeze(files) });
}

/** The shipped Mod package: the published contract's destination/entries plus the bytes actually published. */
async function readShippedModPackage(generationRoot) {
  const contract = JSON.parse(await readFile(resolve(generationRoot, "stardew-mod-package-contract.json"), "utf8"));
  const root = resolve(generationRoot, contract.descriptor.destination.split("/").join(sep));
  const digests = {};
  for (const entry of contract.entries) digests[entry] = await sha256File(resolve(root, entry));
  return Object.freeze({
    entries: Object.freeze([...contract.entries]),
    digests: Object.freeze(digests),
    uniqueId: contract.manifestIdentity.UniqueID,
    version: contract.manifestIdentity.Version,
  });
}

/**
 * Fabricates the game the Host's own GOG proposal source can discover: a library
 * root holding `Stardew Valley` with the game executable, SMAPI and a `Mods`
 * directory, plus the GOG Galaxy config that names that library root.
 */
async function writeSandboxGameRoot({ libraryRoot }) {
  const gameRoot = join(libraryRoot, "Stardew Valley");
  await mkdir(join(gameRoot, MODS_DIRECTORY), { recursive: true });
  await writeFile(join(gameRoot, GAME_EXECUTABLE), "sandbox game executable placeholder\n");
  await writeFile(join(gameRoot, SMAPI_EXECUTABLE), "sandbox smapi placeholder\n");
  return gameRoot;
}

async function writeSandboxProgramData({ programDataRoot, libraryRoot }) {
  const configDirectory = join(programDataRoot, "GOG.com", "Galaxy", "config");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "config.json"), `${JSON.stringify({ libraryPath: libraryRoot })}\n`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit(value);
    };
    const timer = setTimeout(() => settle({ timedOut: true }), timeoutMs);
    // A child that already closed will never emit another event; report it instead
    // of waiting out the timeout for an event that cannot arrive.
    if (child.exitCode !== null || child.signalCode !== null) {
      settle({ timedOut: false, code: child.exitCode, signal: child.signalCode });
      return;
    }
    // `close` (not `exit`) so the child's stdout pipes have drained before the
    // frames are read: every status frame the entry announced is captured.
    child.once("close", (code, signal) => settle({ timedOut: false, code, signal }));
    child.once("error", () => settle({ timedOut: false, code: null, signal: null }));
  });
}

/**
 * Starts the installed desktop entry over the private bootstrap wire and records
 * every status frame it announces until the announced outcome, the next stage, or
 * the child's own exit. The child is always torn down.
 */
async function runDesktopEntry({ installedRoot, generation, pointer, localAppDataRoot, manifestPath, programDataRoot }) {
  const rootLayout = createDesktopCompositionRootLayout(localAppDataRoot, generation);
  const bootstrapId = randomBytes(32).toString("hex");
  const frame = composeDesktopBootstrapFrame({ bootstrapId, ...pointer, rootLayout });
  const env = {
    ...composeDesktopChildEnvironment({ base: process.env, localAppDataRoot, manifestPath, gameSessionMode: GAME_SESSION_MODE }),
    // The Host's GOG proposal source reads this variable; pointing it at the sandbox
    // is what makes the fabricated installation discoverable without touching the
    // machine's real ProgramData, registry, Steam library or GOG entries.
    ProgramData: programDataRoot,
  };
  delete env.GAMEBUDDY_D0_BOOTSTRAP_TEST;
  delete env.GAMEBUDDY_LIVE_SUPERVISOR;

  const child = spawn(resolve(installedRoot, RUNTIME_RELATIVE_PATH), [resolve(installedRoot, ENTRY_RELATIVE_PATH)], {
    cwd: installedRoot,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
    env,
  });

  const frames = [];
  let stdout = "";
  let stderr = "";
  let finished = false;
  let resolveSettled;
  const settled = new Promise((resolveSettledValue) => {
    resolveSettled = resolveSettledValue;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    resolveSettled();
  };
  const observe = (value) => {
    frames.push(value);
    // The entry has announced the outcome and moved on to its next stage, so the
    // Mod step is proven and this run is torn down instead of waiting out the
    // Guardian/composition stages this sandbox deliberately does not stand up.
    if (value.stage === GUARDIAN_STAGE) finish();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (line.trim().length === 0) continue;
      try {
        const value = JSON.parse(line);
        if (value !== null && typeof value === "object" && value.schema === STATUS_SCHEMA) observe(value);
      } catch {
        // Not a status frame; the wire's other outputs are not this sandbox's subject.
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4_096) stderr += chunk;
  });
  child.once("close", finish);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    finish();
  }, FRAME_TIMEOUT_MS);
  child.stdin.end(`${JSON.stringify(frame)}\n`);
  await settled;
  clearTimeout(timeout);
  child.kill();
  await waitForExit(child, EXIT_GRACE_MS);

  const stages = frames.map((value) => value.stage);
  const outcome = stages.find((stage) => typeof stage === "string" && stage.startsWith(OUTCOME_PREFIX));
  return Object.freeze({
    stages: Object.freeze(stages),
    outcome,
    stderr: stderr.trim(),
    exitCode: child.exitCode,
    timedOut,
    reachedModStep: stages.includes(MOD_STEP_STAGE),
    reachedNextStage: stages.includes(GUARDIAN_STAGE),
  });
}

function assertNamedOutcome(run, expected, label) {
  if (run.outcome !== expected)
    throw new Error(
      `${label}: expected the entry to announce ${expected}, it announced ${String(run.outcome)} ` +
        `(stages ${run.stages.join(",")}; stderr ${run.stderr || "<empty>"})`,
    );
  if (!run.reachedModStep) throw new Error(`${label}: the entry never announced the ${MOD_STEP_STAGE} step`);
  if (!run.reachedNextStage)
    throw new Error(`${label}: the Mod step did not let startup continue to ${GUARDIAN_STAGE} (never blocked)`);
}

function sameSnapshot(left, right) {
  if (left.exists !== right.exists || left.directoryMtimeMs !== right.directoryMtimeMs) return false;
  const leftNames = Object.keys(left.files).sort();
  const rightNames = Object.keys(right.files).sort();
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) return false;
  return leftNames.every((name) => {
    const a = left.files[name];
    const b = right.files[name];
    return a.sha256 === b.sha256 && a.size === b.size && a.mtimeMs === b.mtimeMs;
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputRoot = resolve(options.generationOutput);
  const pointer = await readProductionPointer({ outputRoot });
  const admitted = await admitDesktopCompositionGeneration({ outputRoot, pointer });
  const shipped = await readShippedModPackage(admitted.artifactRoot);

  const workRoot = options.workRoot === undefined
    ? await mkdtemp(join(tmpdir(), "gamebuddy-mod-autodeploy-"))
    : resolve(options.workRoot);
  if (options.workRoot !== undefined) {
    await rm(workRoot, { recursive: true, force: true });
    await mkdir(workRoot, { recursive: true });
  }

  const localAppDataRoot = join(workRoot, "localappdata");
  const programDataRoot = join(workRoot, "ProgramData");
  const libraryRoot = join(workRoot, "gog-library");
  const manifestPath = join(workRoot, "deployment-manifest.json");

  const rootLayout = createDesktopCompositionRootLayout(localAppDataRoot, pointer.generation);
  await installDesktopCompositionGeneration({ artifactRoot: admitted.artifactRoot, rootLayout });
  const installedRoot = rootLayout.generationRoot;
  const modsRoot = join(await writeSandboxGameRoot({ libraryRoot }), MODS_DIRECTORY);
  const installedModRoot = join(modsRoot, COMPANION_MOD_DIRECTORY);
  await writeSandboxProgramData({ programDataRoot, libraryRoot });
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: rootLayout.dataRoot,
      principal: { continuityId: "sandbox-continuity", companionId: "sandbox-companion", playerId: "sandbox-player" },
      bootstrapOperationId: "sandbox-bootstrap",
      authorityGeneration: 1,
    })}\n`,
  );

  const report = {
    generation: pointer.generation,
    artifactRoot: admitted.artifactRoot,
    installedRoot,
    sandboxRoot: workRoot,
    gameRoot: resolve(join(libraryRoot, "Stardew Valley")),
    shippedMod: { uniqueId: shipped.uniqueId, version: shipped.version, entries: shipped.entries },
    runs: {},
  };

  const runOptions = {
    installedRoot,
    generation: pointer.generation,
    pointer,
    localAppDataRoot,
    manifestPath,
    programDataRoot,
  };

  // Run 1: the fabricated game is installed and Mods is empty -> the entry installs
  // the shipped Mod and its bytes must match the published package exactly.
  const first = await runDesktopEntry(runOptions);
  assertNamedOutcome(first, `${MOD_STEP_STAGE}-installed`, "run 1");
  const installed = await snapshotTree(installedModRoot);
  if (!installed.exists) throw new Error(`run 1: ${installedModRoot} was not created`);
  const installedNames = Object.keys(installed.files).sort();
  if (JSON.stringify(installedNames) !== JSON.stringify([...shipped.entries].sort()))
    throw new Error(`run 1: installed Mod file set ${installedNames.join(",")} != shipped ${shipped.entries.join(",")}`);
  const mismatched = shipped.entries.filter((entry) => installed.files[entry].sha256 !== shipped.digests[entry]);
  if (mismatched.length > 0)
    throw new Error(`run 1: installed Mod bytes differ from the published package for ${mismatched.join(",")}`);
  report.runs.install = Object.freeze({ outcome: first.outcome, stages: first.stages, stderr: first.stderr, digestsMatch: true });

  // Run 2: the installed Mod already carries the shipped bytes -> `current`, and
  // the launch must write NOTHING (content, size and mtime all unchanged).
  const before = await snapshotTree(installedModRoot);
  const second = await runDesktopEntry(runOptions);
  assertNamedOutcome(second, `${MOD_STEP_STAGE}-current`, "run 2");
  const after = await snapshotTree(installedModRoot);
  if (!sameSnapshot(before, after)) throw new Error("run 2: the idempotent launch wrote to the installed Mod");
  report.runs.current = Object.freeze({
    outcome: second.outcome,
    stages: second.stages,
    stderr: second.stderr,
    wroteNothing: true,
  });

  // Run 3: the game root is gone -> the entry must still start and name the
  // outcome it chose instead of blocking the launch, and must not write anything
  // back to an installation it could not find.
  await rm(libraryRoot, { recursive: true, force: true });
  const third = await runDesktopEntry(runOptions);
  assertNamedOutcome(third, `${MOD_STEP_STAGE}-game-not-found`, "run 3");
  if ((await snapshotTree(libraryRoot)).exists)
    throw new Error("run 3: the game-less launch recreated the removed installation root");
  report.runs.gameRemoved = Object.freeze({
    outcome: third.outcome,
    stages: third.stages,
    stderr: third.stderr,
    wroteNothing: true,
  });

  if (!options.keep && options.workRoot === undefined) await rm(workRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ schema: "gamebuddy-stardew-mod-autodeploy-sandbox/v1", ...report }, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
