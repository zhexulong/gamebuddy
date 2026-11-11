/*
 * Does the real Host startup settle the Game state a force-killed Host left behind?
 *
 * The startup settlement itself is covered by tests with a fake owner-death verifier, and
 * `owner-death-probe.mjs` proves that the real Windows query answers `proven_dead` for a process this
 * machine killed. The link between those two is the one only this machine can answer: a Host process that
 * really died holding the durable Game lease, and a second Host that really starts and settles it.
 *
 * What this runs, all of it product code from one published generation (`host/dist/current.json`):
 *
 *   1. owner      `createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest, "fresh")` —
 *                 the same call the desktop composition makes on first launch — then the real Game enter
 *                 (`prepareEnter` → `commitEnter`) and the real close intent (`prepareClose`). The process
 *                 stops there, so the durable state is a live session whose close is in flight, owned by a
 *                 real PID with its real creation identity.
 *   2. kill       `taskkill /F /PID <that exact pid>`. Nothing is matched by image name.
 *   3. successor  the same product startup in `known` mode, which settles the pending recovery obligation
 *                 before admitting any Game work. The evidence is its stderr line plus the durable rows.
 *   4. control    an owner left running, and a successor started beside it: the settlement must refuse as
 *                 a single-instance conflict and recover nothing.
 *
 * What this does NOT prove: no Stardew process is launched and no Pi provider is called, so this says
 * nothing about gameplay, model output, or the bridge. It proves the durable Game authority's startup
 * settlement against real processes on this machine. It reads no credential and writes none.
 *
 * Run: node tools/live-run/game/startup-dead-owner-recovery-live.mjs [--host-production-root <abs>]
 *
 * Every reading is appended synchronously to `.tmp/sdr-readings.log` (override with `GAMEBUDDY_SDR_LOG`)
 * before it reaches stdout, and the child roles append to the same file: this run has died mid-flight
 * before, and a reading that only existed on a dead process's stdout was lost with it.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const LOG_PATH = resolve(process.env.GAMEBUDDY_SDR_LOG ?? join(process.cwd(), ".tmp", "sdr-readings.log"));
let logHandle;

/**
 * One reading, synchronously on disk before stdout. The sink must never be able to abort the run: this
 * file is opened while the caller may also be redirecting stdout to a file, and a diagnostic that kills
 * the instrument it diagnoses is worse than no diagnostic at all.
 */
function log(line) {
  process.stdout.write(`${line}\n`);
  try {
    logHandle ??= openSync(LOG_PATH, "a");
    writeSync(logHandle, `${line}\n`);
  } catch {
    logHandle ??= undefined;
  }
}

/** The published generation is the artifact the Host loads; its `native/` helpers are what path locks need. */
async function resolveArtifactRoot(explicit) {
  const outputRoot = resolve(explicit ?? join(process.cwd(), "host", "dist"));
  const pointer = JSON.parse(await readFile(join(outputRoot, "current.json"), "utf8"));
  return Object.freeze({
    outputRoot,
    generation: pointer.generation,
    artifactRoot: join(outputRoot, "generations", pointer.generation),
  });
}

const HOST_MODULES = Object.freeze({
  shared: "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
  manifest: "deployment-manifest.js",
});

async function load(artifactRoot, key) {
  return await import(pathToFileURL(join(artifactRoot, HOST_MODULES[key])).href);
}

/** The same query the product's owner-death verifier makes, so the identity recorded is the one it compares. */
async function readStartIdentity(pid) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$processRecord = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + ${pid})`,
    "if ($null -eq $processRecord) { exit 17 }",
    "[Console]::Out.WriteLine([string]([datetime]$processRecord.CreationDate).ToUniversalTime().Ticks)",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  return stdout.trim();
}

async function processGone(pid) {
  try {
    await readStartIdentity(pid);
    return false;
  } catch {
    return true;
  }
}

async function forceKill(pid) {
  await execFileAsync("taskkill", ["/F", "/PID", String(pid)]).catch(() => {});
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await processGone(pid)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

function gameReceipt(kind, permit) {
  return Object.freeze({
    kind,
    operationId: permit.operationId,
    requestId: permit.requestId,
    gameSessionId: permit.gameSessionId,
    bindingDigest: permit.bindingDigest,
    world: permit.world,
    owner: permit.owner,
    fenceToken: permit.fenceToken,
    occurredAtMs: Date.now(),
  });
}

/**
 * The owner Host: product startup, a real Game enter, a real close intent, then nothing. It never closes
 * the authority, so whatever the durable state holds at the moment it is killed is what the successor
 * must settle — this process cannot tidy anything up on its way out.
 */
async function runOwner(artifactRoot, manifestPath) {
  const { createSharedSemanticProductionAuthorityFromDeploymentManifest } = await load(artifactRoot, "shared");
  const { loadHostDeploymentManifest } = await load(artifactRoot, "manifest");
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const ownerPid = process.pid;
  const shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest, "fresh");
  log(`  owner: product startup (fresh) opened the runtime root`);
  const permit = await shared.game.prepareEnter(
    Object.freeze({
      world: Object.freeze({ integrationId: "stardew", saveId: "save_dead_owner", worldId: "world_dead_owner" }),
      bindingDigest: "b".repeat(64),
      owner: Object.freeze({
        ownerToken: `owner_${ownerPid}`,
        runtimeInstanceId: `runtime_${ownerPid}`,
        ownerPid,
        ownerProcessStartIdentity: await readStartIdentity(ownerPid),
      }),
    }),
  );
  const live = await shared.game.commitEnter(permit, gameReceipt("runtime_bootstrapped", permit));
  log(`  owner: Game enter committed session=${permit.gameSessionId} operation=${permit.operationId}`);
  const closing = await shared.game.prepareClose(live);
  log(`OWNER_READY pid=${ownerPid} session=${permit.gameSessionId} close_operation=${closing.operationId}`);
  // A harness that keeps a child alive on an interval leaks one process per failed run; on 2026-11-07 that
  // reached 1,335 resident `node` processes. The cap is a lifetime, not a liveness probe, so a parent that
  // dies cannot leave this process behind.
  const lifetime = setTimeout(() => process.exit(0), 180_000);
  lifetime.unref();
  setInterval(() => undefined, 1_000);
}

/** The successor Host: the same product startup in `known` mode, which settles before admitting Game work. */
async function runSuccessor(artifactRoot, manifestPath) {
  const { createSharedSemanticProductionAuthorityFromDeploymentManifest } = await load(artifactRoot, "shared");
  const { loadHostDeploymentManifest } = await load(artifactRoot, "manifest");
  const manifest = await loadHostDeploymentManifest(manifestPath);
  const shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(manifest, "known");
  await shared.close();
  log("SUCCESSOR_CLOSED");
}

function startHost(artifactRoot, role, manifestPath) {
  const child = spawn(
    process.execPath,
    [SELF, "--role", role, "--manifest", manifestPath, "--artifact", artifactRoot],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((done) => child.once("exit", (code) => done({ code })));
  child.once("exit", (code) => log(`  host role=${role} pid=${String(child.pid)} exited code=${String(code)}`));
  return Object.freeze({
    pid: child.pid,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    async awaitLine(prefix, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stdout.split(/\r?\n/u).some((line) => line.startsWith(prefix))) return true;
        if (child.exitCode !== null) return false;
        await new Promise((done) => setTimeout(done, 50));
      }
      return false;
    },
    async awaitExit(timeoutMs) {
      return await Promise.race([exited, new Promise((done) => setTimeout(() => done({ code: null }), timeoutMs))]);
    },
  });
}

function databasePath(runtimeRoot) {
  return join(runtimeRoot, ".gamebuddy-semantic-continuity-v1", "gamebuddy-continuity-v1.sqlite");
}

/** The durable rows the assertions read: intent status/kind, session state, lease state, game surface state. */
function readDurableGameState(runtimeRoot) {
  const db = new DatabaseSync(databasePath(runtimeRoot), { readOnly: true });
  try {
    const intent = db
      .prepare(
        "SELECT operation_id, status, session_id, recovery_reason, request_json FROM production_game_intent ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    const session = db.prepare("SELECT session_id, state FROM production_game_session").get();
    const lease = db.prepare("SELECT session_id, state, owner_json FROM production_game_lease").get();
    const surface = db.prepare("SELECT session_id, state FROM production_surface_session WHERE surface='game'").get();
    return Object.freeze({
      intent:
        intent === undefined
          ? null
          : Object.freeze({
              operationId: intent.operation_id,
              status: intent.status,
              kind: JSON.parse(intent.request_json).kind,
              recoveryReason: intent.recovery_reason,
            }),
      session: session === undefined ? null : Object.freeze({ id: session.session_id, state: session.state }),
      lease: lease === undefined ? null : Object.freeze({ state: lease.state, owner: JSON.parse(lease.owner_json) }),
      surface: surface === undefined ? null : Object.freeze({ state: surface.state }),
    });
  } finally {
    db.close();
  }
}

const findings = [];
function record(question, ok, reading) {
  findings.push({ question, ok, reading });
  log(`  ${ok ? "ok  " : "FAIL"} ${question}: ${reading}`);
}

async function writeManifest(root, name) {
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot,
        principal: Object.freeze({
          continuityId: `continuity_${name}`,
          companionId: `companion_${name}`,
          playerId: `player_${name}`,
        }),
        bootstrapOperationId: `bootstrap_${name}`,
        authorityGeneration: 1,
      },
      null,
      2,
    ),
    "utf8",
  );
  return Object.freeze({ runtimeRoot, manifestPath });
}

/** Owner starts, enters, opens a close intent, and is force-killed; the successor must settle it. */
async function runDeadOwnerPhase(artifactRoot) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dead-owner-"));
  const { runtimeRoot, manifestPath } = await writeManifest(root, "deadowner");
  const owner = startHost(artifactRoot, "owner", manifestPath);
  try {
    const ready = await owner.awaitLine("OWNER_READY", 120_000);
    record(
      "the owner Host completed the real Game enter and close intent",
      ready,
      ready ? "OWNER_READY" : "no OWNER_READY line",
    );
    if (!ready) {
      record("owner diagnostics", false, `stdout=${owner.stdout().trim()} stderr=${owner.stderr().trim()}`);
      return;
    }

    // The owner's own connection must be gone before this reads: opening the same database read-only while
    // the live owner still holds the write connection is a lock conflict, not a durable reading.
    const killed = await forceKill(owner.pid);
    record("taskkill /F removed exactly that owner PID", killed, `pid=${owner.pid} gone=${killed}`);
    if (!killed) return;

    const left = readDurableGameState(runtimeRoot);
    record(
      "the dead owner left a live session whose lease is not terminal",
      left.session?.state === "active" && left.lease?.state === "close_pending" && left.intent?.kind === "close",
      `session=${left.session?.state} lease=${left.lease?.state} intent=${left.intent?.status}/${left.intent?.kind}`,
    );
    record(
      "the durable lease names the owner's real PID",
      left.lease?.owner?.ownerPid === owner.pid,
      `recorded=${left.lease?.owner?.ownerPid} spawned=${owner.pid}`,
    );

    const successor = startHost(artifactRoot, "successor", manifestPath);
    const { code } = await successor.awaitExit(180_000);
    const stderr = successor.stderr();
    record(
      "the successor Host reports it recovered the dead owner's Game state",
      /^\[game-recovery\] startup recovered the Game state its dead owner left behind operation=/mu.test(stderr),
      stderr
        .trim()
        .split(/\r?\n/u)
        .find((line) => line.startsWith("[game-recovery]")) ?? "<no [game-recovery] line>",
    );
    record(
      "the settlement verdict came from the real Windows query",
      /owner=proven_dead/u.test(stderr),
      `owner=proven_dead in stderr: ${/owner=proven_dead/u.test(stderr)}`,
    );
    record(
      "the successor did not refuse",
      !/game_recovery_blocked_owner_/u.test(stderr),
      `blocked line present: ${/game_recovery_blocked_owner_/u.test(stderr)}`,
    );
    record("the successor Host exited 0", code === 0, `exit=${String(code)}`);

    const after = readDurableGameState(runtimeRoot);
    record(
      "the session it settled is ended and its lease is gone",
      after.session?.state === "ended" && after.lease === null && after.surface?.state === "ended",
      `session=${after.session?.state} lease=${after.lease === null ? "none" : after.lease.state} surface=${after.surface?.state} intent=${after.intent?.status}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Control: the owner is still alive, so the successor must refuse and recover nothing. */
async function runLivingOwnerPhase(artifactRoot) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-living-owner-"));
  const { manifestPath } = await writeManifest(root, "livingowner");
  const owner = startHost(artifactRoot, "owner", manifestPath);
  try {
    const ready = await owner.awaitLine("OWNER_READY", 120_000);
    record(
      "the control owner Host reached the same durable state",
      ready,
      ready ? "OWNER_READY" : "no OWNER_READY line",
    );
    if (!ready) {
      record("control owner diagnostics", false, `stdout=${owner.stdout().trim()} stderr=${owner.stderr().trim()}`);
      return;
    }

    // Nothing here reads the durable rows: the owner is alive and still holds them, and the question this
    // control asks is answered entirely by the successor's own refusal.
    const successor = startHost(artifactRoot, "successor", manifestPath);
    const { code } = await successor.awaitExit(180_000);
    const stderr = successor.stderr();
    record(
      "a living owner is a single-instance conflict, not a recovery",
      /another GameBuddy is already running/u.test(stderr),
      stderr
        .trim()
        .split(/\r?\n/u)
        .find((line) => line.startsWith("[game-recovery]")) ?? "<no [game-recovery] line>",
    );
    record(
      "the refusal names the living owner",
      /game_recovery_blocked_owner_alive/u.test(stderr),
      `blocked_owner_alive present: ${/game_recovery_blocked_owner_alive/u.test(stderr)}`,
    );
    record(
      "the settlement recovered nothing",
      !/startup recovered the Game state/u.test(stderr),
      `recovered line present: ${/startup recovered the Game state/u.test(stderr)}`,
    );
    record("the refused successor exited non-zero", code !== 0, `exit=${String(code)}`);
  } finally {
    await forceKill(owner.pid);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(argv) {
  // The flag is spelled in two places - the caller and this helper - so the helper accepts it either way.
  // On 2026-11-07 every caller passed `--role` while this prepended `--`, so every option read as undefined:
  // the child fell through to the parent branch and the harness forked until the pagefile was gone.
  const option = (name) => {
    const flag = name.startsWith("--") ? name : `--${name}`;
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined;
  };
  const artifactRoot =
    option("--artifact") ?? (await resolveArtifactRoot(option("--host-production-root"))).artifactRoot;
  const role = option("--role");
  if (role === "owner") return await runOwner(artifactRoot, option("--manifest"));
  if (role === "successor") return await runSuccessor(artifactRoot, option("--manifest"));
  /**
   * This file spawns itself, so a child that fails to recognize its role must NOT fall through to the parent
   * branch: it would spawn two more, each of which would spawn two more. The witness is the environment, not an
   * argument - on 2026-11-07 the argument witness was not observed to arrive, the harness spawned owner children
   * that outlived it, and 1,335 resident `node` processes exhausted the pagefile.
   */
  const childOf = option("--child-of");
  if (process.env.GAMEBUDDY_LIVE_CHILD === "1" || childOf !== undefined) {
    log(
      `startup_dead_owner_recovery_blocked: refusing to run the parent branch in a child (role=${String(role)}, childOf=${String(childOf ?? "env")})`,
    );
    process.exitCode = 2;
    return;
  }
  if (process.platform !== "win32") {
    console.log("startup_dead_owner_recovery_skipped: the owner-death verifier answers `unavailable` off Windows");
    return;
  }
  const resolvedArtifact = await resolveArtifactRoot(option("--host-production-root"));
  try {
    writeFileSync(LOG_PATH, "");
  } catch {
    // The caller may have redirected stdout onto this same path; stdout still carries every reading.
  }
  log(
    `startup_dead_owner_recovery: generation=${resolvedArtifact.generation} artifactRoot=${resolvedArtifact.artifactRoot}`,
  );
  for (const phase of [runDeadOwnerPhase, runLivingOwnerPhase]) {
    try {
      await phase(resolvedArtifact.artifactRoot);
    } catch (error) {
      log(`  FAIL ${phase.name} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const failed = findings.filter((finding) => !finding.ok);
  log(
    `startup_dead_owner_recovery: examined ${String(findings.length)} reading(s) on this machine, ${String(failed.length)} disagreement(s)`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  log(
    `startup_dead_owner_recovery_blocked: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  if (logHandle !== undefined) closeSync(logHandle);
}
