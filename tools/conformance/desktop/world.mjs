/**
 * The world an installed launcher is driven in: the media it admits, the registration it reads,
 * the roots it derives, and the process facts a case asserts on.
 *
 * WHY A WORLD AND NOT A HARNESS INSIDE THE PRODUCT. Everything here happens on the OUTSIDE of
 * the launcher: a generation directory on disk, two registry values, and the process tree the
 * launcher starts. Nothing imports a C# type, patches a seam or runs the launcher's own test
 * hooks - so the same case runs unchanged against a rewrite, and a rewrite is "proven
 * equivalent" by pointing this suite at a different executable.
 *
 * WHAT IT INSTALLS. The registration is the one fact the launcher reads as its root authority.
 * The media is the publication layout the launcher admits (`current.json`, one `generations/<id>`
 * with the two admission sidecars, a runtime image, and the guardian pair). The harness replaces
 * the generation's `bootstrap/entry/desktop-host-entry.internal.js` with its own peer and rewrites
 * the two digests that name it, which is the same substitution the product's own desktop tests
 * make for the same reason: the Host is not the subject here, the launcher's protocol is.
 *
 * WHERE A GENERATION COMES FROM. A published generation is used when one is named - the door the
 * product's own desktop tests already use, so CI hands this suite the same media it hands them
 * (`GAMEBUDDY_DESKTOP_TEST_GENERATION_ROOT`). Otherwise the harness installs the same layout
 * itself from `process.execPath`, because a black-box launcher suite must not require the whole
 * Host closure to compile: measured 2026-11-22, the canonical publisher died in the dialogue-web
 * build (`browser_build_failed ... windows_reparse_inspection_cleanup_failed`) from a lane
 * unrelated to this one, and a suite that can only run when that build is green cannot tell
 * anyone what the launcher does.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FACTS, GUARDIAN_ATTEMPT_RECORD, HOST_TEARDOWN_RECORD, SCENARIO_FILE } from "./wire.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");

export class Blocked extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

/** The registration the launcher reads, as Setup writes it. The launcher only ever reads it. */
const REGISTRATION_KEY = "HKCU\\Software\\GameBuddy\\Registration\\v1";
const REGISTRATION_SCHEMA = "gamebuddy-windows-root-registration/v1";

function registrationProgramRoot() {
  try {
    const output = run("reg.exe", ["query", REGISTRATION_KEY, "/v", "programRoot"]);
    const match = /programRoot\s+REG_SZ\s+(.+)/u.exec(output);
    return match === null ? null : match[1].trim();
  } catch {
    return null;
  }
}

/**
 * Where the launcher executable is taken from: a named one, or a Release publish into the
 * harness's own temp root. The product ships this configuration, so the suite publishes it.
 */
function resolveLauncherBinary({ tempRoot, explicit }) {
  const named = explicit ?? process.env.GAMEBUDDY_DESKTOP_CONFORMANCE_BINARY ?? null;
  if (named !== null && named.length > 0) {
    if (!existsSync(named)) throw new Blocked("desktop_conformance_binary_absent", named);
    return resolve(named);
  }
  const project = join(REPOSITORY_ROOT, "desktop", "GameBuddy.Desktop", "GameBuddy.Desktop.csproj");
  const output = join(tempRoot, "launcher");
  try {
    run("dotnet", ["publish", project, "-c", "Release", "-o", output, "--nologo", "-v", "quiet"], {
      timeout: 20 * 60 * 1000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "")
      .trim()
      .split("\n")
      .slice(-6)
      .join(" | ");
    throw new Blocked(
      "desktop_conformance_launcher_publish_failed",
      stderr.length > 0 ? stderr : String(error?.message ?? error),
    );
  }
  const binary = join(output, "GameBuddy.Desktop.exe");
  if (!existsSync(binary)) throw new Blocked("desktop_conformance_binary_absent", binary);
  return binary;
}

/** The guardian pair the generation admits: the native helper this repository builds and its manifest. */
function guardianPair() {
  const directory = join(REPOSITORY_ROOT, "host", "native", "windows-bootstrap-guardian", ".dist", "win-x64");
  const executable = join(directory, "GameBuddy.WindowsBootstrapGuardian.exe");
  if (!existsSync(executable)) {
    throw new Blocked(
      "desktop_conformance_guardian_image_absent",
      `${executable} (build it with: node host/scripts/build-windows-bootstrap-guardian.mjs)`,
    );
  }
  return { executable, bytes: readFileSync(executable) };
}

/** A published generation root, validated structurally the way the product's own fixture validates one. */
function publishedGenerationRoot() {
  const named =
    process.env.GAMEBUDDY_DESKTOP_TEST_GENERATION_ROOT ??
    process.env.GAMEBUDDY_DESKTOP_CONFORMANCE_GENERATION_ROOT ??
    null;
  if (named === null || named.trim().length === 0) return null;
  const root = resolve(named.trim());
  if (!existsSync(join(root, "current.json")))
    throw new Blocked("desktop_conformance_generation_pointer_missing", root);
  const generations = existsSync(join(root, "generations")) ? readdirSync(join(root, "generations")) : [];
  if (generations.length !== 1)
    throw new Blocked("desktop_conformance_generation_count", `${root}: ${generations.length}`);
  const generationRoot = join(root, "generations", generations[0]);
  for (const required of ["host-runtime-admission.json", join("runtime", "node.exe")]) {
    if (!existsSync(join(generationRoot, required)))
      throw new Blocked("desktop_conformance_generation_incomplete", join(generationRoot, required));
  }
  return root;
}

/** One payload file with the two facts an admission sidecar names it by. */
function payload(path) {
  const bytes = readFileSync(path);
  return { path: path.replace(/\\/gu, "/"), sha256: sha256(bytes), bytes: bytes.length };
}

/**
 * The files a launcher's admission actually reads out of a generation. A published generation is
 * a gigabyte of payload the Host would execute; this suite's Host is its own peer, so only the
 * media the launcher admits is installed - which keeps the suite's world the size of the
 * launcher's question instead of the size of the product's.
 */
const ADMISSION_FILES = [
  "host-runtime-admission.json",
  "production-inventory.json",
  "guardian-admission.json",
  "runtime/node.exe",
  "bootstrap/entry/desktop-host-entry.internal.js",
  "native/windows-bootstrap-guardian/win-x64/GameBuddy.WindowsBootstrapGuardian.exe",
  "native/windows-bootstrap-guardian/win-x64/windows-bootstrap-guardian.manifest.json",
];

/**
 * Install a generation into `programRoot` and put the harness's peer at its bootstrap entry.
 *
 * A published root supplies the media the launcher admits; otherwise the same layout is written
 * here from `process.execPath`. Either way the two digests that name the bootstrap entry are
 * rewritten, because the entry is this suite's peer.
 */
function installGeneration({ programRoot, publishedRoot, scratch }) {
  mkdirSync(programRoot, { recursive: true });
  const generationId = `g-conformance-1-${randomBytes(16).toString("hex")}`;
  const generationRoot = join(programRoot, "generations", generationId);
  if (publishedRoot !== null) {
    const source = join(publishedRoot, "generations", readdirSync(join(publishedRoot, "generations"))[0]);
    for (const relative of ADMISSION_FILES) {
      const from = join(source, relative);
      if (!existsSync(from)) throw new Blocked("desktop_conformance_generation_incomplete", from);
      const to = join(generationRoot, relative);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  } else {
    mkdirSync(join(generationRoot, "runtime"), { recursive: true });
    mkdirSync(join(generationRoot, "bootstrap", "entry"), { recursive: true });
    mkdirSync(join(generationRoot, "native", "windows-bootstrap-guardian", "win-x64"), { recursive: true });
    copyFileSync(process.execPath, join(generationRoot, "runtime", "node.exe"));
    const guardian = guardianPair();
    copyFileSync(
      guardian.executable,
      join(generationRoot, "native", "windows-bootstrap-guardian", "win-x64", "GameBuddy.WindowsBootstrapGuardian.exe"),
    );
  }

  // The peer, at the exact bootstrap entry path the admission names.
  const hostSource = readFileSync(join(HERE, "mock-host.cjs"), "utf8");
  const scenarioPath = join(scratch, SCENARIO_FILE);
  const installed = hostSource.replace('"__CONFORMANCE_SCENARIO_PATH__"', JSON.stringify(scenarioPath));
  const bootstrapPath = join(generationRoot, "bootstrap", "entry", "desktop-host-entry.internal.js");
  writeFileSync(bootstrapPath, installed);

  // The guardian manifest is the exact document the admission compares, and it names the helper
  // by digest; both are recomputed here so a published pair and an installed one are one shape.
  const guardianDirectory = join(generationRoot, "native", "windows-bootstrap-guardian", "win-x64");
  const guardianExecutable = join(guardianDirectory, "GameBuddy.WindowsBootstrapGuardian.exe");
  const guardianDigest = sha256(readFileSync(guardianExecutable));
  const guardianManifestPath = join(guardianDirectory, "windows-bootstrap-guardian.manifest.json");
  writeFileSync(
    guardianManifestPath,
    `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"GameBuddy.WindowsBootstrapGuardian.exe","sha256":"${guardianDigest}"}\n`,
  );

  // The runtime image: whatever the generation carries, by digest.
  const runtimePath = join(generationRoot, "runtime", "node.exe");
  const runtimeDigest = sha256(readFileSync(runtimePath));
  const bootstrapDigest = sha256(readFileSync(bootstrapPath));

  const inventory = {
    schema: "gamebuddy-host-production-inventory/v4",
    entries: [payload(runtimePath), payload(bootstrapPath), payload(guardianExecutable), payload(guardianManifestPath)],
    // This layout names no external runtime closure: the image the launcher starts is inside the
    // generation, and an empty closure is the product's own shape for exactly that.
    externalRuntimeClosure: { schema: "host-external-runtime-closure/v1", files: [] },
  };
  inventory.digest = sha256(
    Buffer.from(
      JSON.stringify({ entries: inventory.entries, externalRuntimeClosure: inventory.externalRuntimeClosure }),
    ),
  );
  writeFileSync(join(generationRoot, "production-inventory.json"), `${JSON.stringify(inventory)}\n`);

  const admission = {
    schema: "host-runtime-admission/v1",
    inventoryDigest: inventory.digest,
    generation: generationId,
    runtimePath: "runtime/node.exe",
    runtimeSha256: runtimeDigest,
    bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js",
    bootstrapSha256: bootstrapDigest,
    runtimeVersion: "v24.20.0",
    runtimePlatform: "win32",
    runtimeArch: "x64",
    runtimeClosure: { schema: "host-bundled-runtime-closure/v1", files: [] },
  };
  const admissionPath = join(generationRoot, "host-runtime-admission.json");
  writeFileSync(admissionPath, `${JSON.stringify(admission)}\n`);

  writeFileSync(
    join(generationRoot, "guardian-admission.json"),
    `${JSON.stringify({
      schema: "gamebuddy-host-guardian-admission/v1",
      inventoryDigest: inventory.digest,
      helperPath: "native/windows-bootstrap-guardian/win-x64/GameBuddy.WindowsBootstrapGuardian.exe",
      manifestPath: "native/windows-bootstrap-guardian/win-x64/windows-bootstrap-guardian.manifest.json",
      helperSha256: guardianDigest,
      manifestSha256: sha256(readFileSync(guardianManifestPath)),
      manifestSchemaVersion: 1,
      manifestProtocolVersion: 1,
      manifestRid: "win-x64",
      manifestHelperFileName: "GameBuddy.WindowsBootstrapGuardian.exe",
    })}\n`,
  );

  writeFileSync(
    join(programRoot, "current.json"),
    `${JSON.stringify({
      schema: "gamebuddy-host-production-current/v2",
      generation: generationId,
      inventoryDigest: inventory.digest,
      runtimeAdmissionSha256: sha256(readFileSync(admissionPath)),
    })}\n`,
  );

  return { generationId, generationRoot, bootstrapPath, scenarioPath };
}

/**
 * The pid, the instant it started and the image it runs, as the launcher's own record reader
 * computes them. One authority: the same .NET API the product reads, asked over the platform
 * rather than re-derived from a second reading of the same process.
 */
export function processIdentity(pid) {
  const script = [
    `$p = [Diagnostics.Process]::GetProcessById(${Number(pid)})`,
    "$ms = [DateTimeOffset]::new($p.StartTime.ToUniversalTime(), [TimeSpan]::Zero).ToUnixTimeMilliseconds()",
    "$image = $p.MainModule.FileName",
    'Write-Output ("{0}|{1}" -f $ms, $image)',
  ].join("; ");
  const output = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  const [startedAt, image] = output.trim().split("|");
  const identity = { pid: Number(pid), startedAtUnixMs: Number(startedAt), executablePath: image ?? "" };
  if (
    !Number.isFinite(identity.startedAtUnixMs) ||
    identity.startedAtUnixMs <= 0 ||
    identity.executablePath.length === 0
  ) {
    throw new Error(`process_identity_unreadable:${pid}`);
  }
  return identity;
}

/**
 * The same identity, or `null` when the process is not running at any point in the retry window.
 * A process the harness starts is alive when it is spawned and gone a moment later, so the ledger
 * entry has to be read inside that window rather than assumed.
 */
function processIdentityOrNull(pid, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return processIdentity(pid);
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return null;
}

/** A process that is alive and is nobody's: the harness's own stand-in for a foreign owner. */
export function startStandinProcess() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore", windowsHide: true });
  return child;
}

/**
 * End this exact process - the pid this suite started or read out of a transcript, never a name
 * and never a pattern - and do not report until the pid is gone or a bounded wait has expired.
 *
 * A kill that returned is not a process that left: a child killed together with its parent can be
 * reported as still running for a moment afterwards, so the answer this returns is a reading taken
 * after the wait, not the exit status of the tool that asked.
 */
export function killExactProcess(pid, boundMs = 6_000) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch {
      // Already gone is the answer a kill is allowed to receive.
    }
    const deadline = Date.now() + boundMs / 2;
    while (Date.now() < deadline) {
      if (!isRunning(pid)) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  return !isRunning(pid);
}

/** Whether this exact pid is still running. The pid is ours: the suite started it. */
export function isRunning(pid) {
  try {
    const output = run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) -ne $null`,
      ],
      {
        windowsHide: true,
      },
    );
    return output.trim() === "True";
  } catch {
    return false;
  }
}

/**
 * Prepare the installed world: refuse to stand on an existing installation, install the media,
 * write the registration, and take the per-user layout for the run.
 */
export function prepareWorld({ tempRoot, explicitBinary }) {
  const occupied = registrationProgramRoot();
  if (occupied !== null) {
    throw new Blocked(
      "desktop_conformance_registration_occupied",
      `${REGISTRATION_KEY} already names ${occupied}; this suite needs the registration for itself and will not overwrite an installation's`,
    );
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0)
    throw new Blocked("desktop_conformance_local_app_data_absent", "LOCALAPPDATA");
  const binary = resolveLauncherBinary({ tempRoot, explicit: explicitBinary });
  const programRoot = join(localAppData, "GameBuddy", "Programs", "GameBuddy");
  const layout = {
    programRoot,
    dataRoot: join(localAppData, "GameBuddy", "data"),
    operationalRoot: join(localAppData, "GameBuddy", "operational"),
    presentationRoot: join(localAppData, "GameBuddy", "presentation"),
  };
  const scratch = join(tempRoot, "world");
  mkdirSync(scratch, { recursive: true });
  const publishedRoot = publishedGenerationRoot();
  const generation = installGeneration({ programRoot, publishedRoot, scratch });
  for (const root of [layout.dataRoot, layout.operationalRoot, layout.presentationRoot])
    mkdirSync(root, { recursive: true });

  run("reg.exe", ["add", REGISTRATION_KEY, "/v", "schema", "/t", "REG_SZ", "/d", REGISTRATION_SCHEMA, "/f"], {
    windowsHide: true,
  });
  run("reg.exe", ["add", REGISTRATION_KEY, "/v", "programRoot", "/t", "REG_SZ", "/d", programRoot, "/f"], {
    windowsHide: true,
  });

  return {
    binary,
    layout,
    scratch,
    generation,
    media: publishedRoot === null ? "installed by this suite" : publishedRoot,
    /** Remove everything this run put on the machine. The product's three mutable roots stay. */
    dispose() {
      try {
        run("reg.exe", ["delete", REGISTRATION_KEY, "/f"], { windowsHide: true });
      } catch {
        // A registration already gone is the state this teardown wanted.
      }
      try {
        rmSync(programRoot, { recursive: true, force: true });
        // The parent is this suite's too: the product never creates it, and an empty directory left
        // beside an installation is debris the next launch would have to explain.
        const programs = dirname(programRoot);
        if (existsSync(programs) && readdirSync(programs).length === 0)
          rmSync(programs, { recursive: true, force: true });
      } catch {
        // A media tree still held open is reported by the next run's registration guard, not hidden.
      }
    },
  };
}

/**
 * Every process this suite started or found started by the launcher, with the identity it was
 * started with. The runner confirms each exact pair is gone before it reports: a pid alone is not
 * a process, and "no leftovers" is a claim the suite makes about these pairs and no others.
 */
const startedProcesses = [];

export function startedProcessLedger() {
  return startedProcesses;
}

/** Where the launcher's own records live under a layout's operational root. */
function operationalPath(world, ...segments) {
  return join(world.layout.operationalRoot, ...segments);
}

/**
 * Start the launcher once, on one scenario, and come back with everything a case may assert on:
 * the exit status, the one bounded code it wrote, whether it was still alive at the read, and the
 * facts the peer recorded.
 */
export async function launchDesktop(world, scenario) {
  writeFileSync(world.generation.scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);
  if (existsSync(scenario.transcript)) rmSync(scenario.transcript, { force: true });
  writeFileSync(scenario.transcript, "");

  const startedAt = Date.now();
  const child = spawn(world.binary, [], {
    cwd: world.scratch,
    env: { ...process.env, ...scenario.environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = [];
  const stdout = [];
  const launcherProcess = processIdentityOrNull(child.pid);
  if (launcherProcess !== null) startedProcesses.push({ role: "launcher", ...launcherProcess });
  // The Host is the launcher's child, not this suite's: its start instant is only readable while
  // it is running, so the transcript is watched for its own announcement and the identity is read
  // the moment it appears.
  let hostProcess = null;
  const hostWatch = setInterval(() => {
    if (hostProcess !== null || !existsSync(scenario.transcript)) return;
    const announced = readTranscript(scenario.transcript).find(
      (entry) => entry.fact === FACTS.hostStarted && typeof entry.pid === "number",
    );
    if (announced === undefined) return;
    const identity = processIdentityOrNull(announced.pid, 1);
    if (identity === null) return;
    hostProcess = identity;
    startedProcesses.push({ role: "host", ...identity });
    clearInterval(hostWatch);
  }, 200);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(...chunk.split(/\r?\n/u).filter((line) => line.length > 0)));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(...chunk.split(/\r?\n/u).filter((line) => line.length > 0)));

  // A launch that failed shows its player a window and waits for the click on that window's own
  // control - deliberately, for as long as it takes. A harness cannot click, so a case whose
  // launch ends by naming a bounded code is read from that code and stopped here: the window is
  // what the launcher does next, not a second fact about the launch.
  const settled = await new Promise((resolveSettled) => {
    const bound = setTimeout(() => resolveSettled("bound"), scenario.launchBoundMs);
    child.once("exit", () => {
      clearTimeout(bound);
      resolveSettled("exit");
    });
    if (scenario.stopOnBoundedCodeMs > 0) {
      const watch = setInterval(() => {
        if (exited) {
          clearInterval(watch);
          return;
        }
        if (!stderr.some((line) => /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)?$/u.test(line.split(" ")[0]))) return;
        clearInterval(watch);
        setTimeout(() => resolveSettled("bounded-code"), scenario.stopOnBoundedCodeMs);
      }, 100);
    }
  });
  const elapsedMs = Date.now() - startedAt;
  clearInterval(hostWatch);
  const pid = child.pid;
  let killed = false;
  if (settled !== "exit") {
    killExactProcess(pid);
    killed = true;
    await new Promise((resolveWaited) => {
      const timer = setTimeout(resolveWaited, 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveWaited();
      });
    });
  }
  const exitCode = child.exitCode;

  const transcript = readTranscript(scenario.transcript);

  const hostPid = transcript.find((entry) => entry.fact === FACTS.hostStarted)?.pid ?? null;
  const hostAlive = hostPid === null ? false : !killExactProcess(hostPid);

  return {
    pid,
    launcherProcess,
    hostProcess,
    elapsedMs,
    exited,
    killed,
    exitCode,
    stderr,
    stdout,
    transcript,
    hostPid,
    hostStillAliveAfterRead: hostAlive,
    facts: transcript.filter((entry) => typeof entry.fact === "string"),
  };
}

/** The transcript a peer wrote, one JSON document per line, or nothing when there is no file yet. */
function readTranscript(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { fact: "unparsable_transcript_line", line };
      }
    });
}

/** One fact name as a reading helper, so a case says what it looks for and not how it scans. */
export function factsNamed(reading, name) {
  return reading.facts.filter((entry) => entry.fact === name);
}

/** The launcher's own teardown records: the two numbers a quit is allowed to spend. */
export function teardownRecords(world) {
  const directory = operationalPath(world, HOST_TEARDOWN_RECORD.directory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith("host-teardown-") && name.endsWith(".json"))
    .map((name) => {
      try {
        return { name, record: JSON.parse(readFileSync(join(directory, name), "utf8")) };
      } catch {
        return { name, record: null };
      }
    });
}

/** The one attempt record the next launch recovers from, or `null` when there is none. */
function attemptRecordPath(world) {
  return operationalPath(world, GUARDIAN_ATTEMPT_RECORD.directory, GUARDIAN_ATTEMPT_RECORD.file);
}

export function writeAttemptRecord(world, record) {
  const path = attemptRecordPath(world);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`);
  return path;
}

export function readAttemptRecord(world) {
  const path = attemptRecordPath(world);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { unreadable: true };
  }
}
