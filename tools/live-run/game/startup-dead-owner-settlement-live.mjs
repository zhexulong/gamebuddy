/*
 * Does the real settlement recover the durable Game state a force-killed Host left behind?
 *
 * Two layers are already proven and this file does not repeat them: the OS verdict (`owner-death-probe.mjs`
 * shows the real Windows query answering `proven_dead` for a taskkill'd PID), and the coordinator's branch
 * logic (seven unit tests with a fake verifier). The link between them is what only this machine can answer,
 * and it is the one that matters: a real process died holding a real SQLite lease, and the real settlement -
 * real store, real rows, real verifier - turns that into a recovered, ended session.
 *
 * Why the successor is NOT a second product startup: `known` mode refuses a root that carries no terminal
 * Chat selection (`chat_runtime_reentry_selection_invalid`), and it refuses before the settlement runs. The
 * only ways past that are to fabricate a Chat handoff the crash could never have written, or to leave the
 * Chat surface alone and drive the Game settlement directly. This file takes the second: Chat is not under
 * test here and must not be made to look tested. What that costs is stated below.
 *
 *   node tools/live-run/game/startup-dead-owner-settlement-live.mjs
 *
 * Proves: a real owner process leaves a real `close_pending` lease with a pending close intent; taskkill /F
 * of its exact PID; the real verifier says `proven_dead`; the real settlement recovers it; the durable rows
 * move to ended with the lease gone. Plus the control: a living owner is refused by name and nothing moves.
 *
 * Does NOT prove: that the product's startup shell calls the settlement at the right moment (that is the
 * coordinator's own test), anything about Chat, Stardew, Pi or the bridge, or any gameplay effect. It also
 * mints the recovery receipt in this file, mirroring `recoveryReceipt` in the coordinator - so the receipt
 * SHAPE is this probe's, not the product's; the store still validates it.
 */

import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const TMP = tmpdir();
/**
 * How long an owner child may stay alive at all. The parent waits at most `OWNER_READY` for 120 s, so anything
 * past that is a leak by definition; a hard cap makes it impossible rather than unlikely.
 */
const OWNER_MAX_LIFETIME_MS = 180_000;

async function artifactRoot() {
  const outputRoot = join(process.cwd(), "host", "dist");
  const pointer = JSON.parse(
    await (await import("node:fs/promises")).readFile(join(outputRoot, "current.json"), "utf8"),
  );
  return Object.freeze({
    generation: pointer.generation,
    artifactRoot: join(outputRoot, "generations", pointer.generation),
  });
}

const modules = (artifactRootPath) => {
  const at = (path) => pathToFileURL(join(artifactRootPath, path)).href;
  return Object.freeze({
    store: at("continuity-semantic-store/continuity-semantic-production-store.js"),
    coordinator: at("continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js"),
    ownerDeath: at(
      "continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.windows-owner-death.js",
    ),
    manifest: at("deployment-manifest.js"),
  });
};

function writeRunRoot(root, name) {
  const runtimeRoot = join(root, "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const manifestPath = join(root, "manifest.json");
  const principal = Object.freeze({
    continuityId: `continuity_${name}`,
    companionId: `companion_${name}`,
    playerId: `player_${name}`,
  });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal,
      bootstrapOperationId: `bootstrap_${name}`,
      authorityGeneration: 1,
    }),
    "utf8",
  );
  return Object.freeze({ runtimeRoot, manifestPath, principal });
}

/* ---------------------------------------------------------------- the owner child */

async function runOwner(artifactRootPath, manifestPath) {
  const { coordinator, manifest } = modules(artifactRootPath);
  const { createSharedSemanticProductionAuthorityFromDeploymentManifest } = await import(coordinator);
  const { loadHostDeploymentManifest } = await import(manifest);
  const loaded = await loadHostDeploymentManifest(manifestPath);
  const ownerPid = process.pid;
  const shared = await createSharedSemanticProductionAuthorityFromDeploymentManifest(loaded, "fresh");
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
  const receipt = Object.freeze({
    kind: "runtime_bootstrapped",
    operationId: permit.operationId,
    requestId: permit.requestId,
    gameSessionId: permit.gameSessionId,
    bindingDigest: permit.bindingDigest,
    world: permit.world,
    owner: permit.owner,
    fenceToken: permit.fenceToken,
    occurredAtMs: Date.now(),
  });
  const live = await shared.game.commitEnter(permit, receipt);
  const closing = await shared.game.prepareClose(live);
  process.stdout.write(
    `OWNER_READY pid=${ownerPid} session=${permit.gameSessionId} close_operation=${closing.operationId}\n`,
  );
  // A harness that keeps a child alive on an interval leaks one process per failed run, and on 2026-11-07
  // that reached 1,335 resident `node` processes holding ~50-75 MB of commit each. The owner must therefore
  // outlive its caller only as long as the caller can legitimately need it: the cap is a lifetime, not a
  // liveness probe, so a parent that dies cannot leave this process behind.
  const lifetime = setTimeout(() => process.exit(0), OWNER_MAX_LIFETIME_MS);
  lifetime.unref();
  setInterval(() => undefined, 1_000);
}

function readStartIdentity(pid) {
  return new Promise((resolve, reject) => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$r = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + ${pid})`,
      "if ($null -eq $r) { exit 17 }",
      "[Console]::Out.WriteLine([string]([datetime]$r.CreationDate).ToUniversalTime().Ticks)",
    ].join("; ");
    execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });
}

/* ---------------------------------------------------------------- the harness */

const findings = [];
function record(question, ok, reading) {
  findings.push({ question, ok, reading });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${question}: ${reading}`);
}

function startOwner(artifactRootPath, manifestPath) {
  const child = spawn(
    process.execPath,
    [
      SELF,
      "--role",
      "owner",
      "--child-of",
      String(process.pid),
      "--artifact",
      artifactRootPath,
      "--manifest",
      manifestPath,
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GAMEBUDDY_LIVE_CHILD: "1" },
    },
  );
  // Best effort containment for the parent's own death: the child has its own lifetime cap, so this only
  // shortens the tail.
  process.once("exit", () => {
    try {
      spawn("taskkill", ["/F", "/PID", String(child.pid)], {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch {
      // The cap in the child is the guarantee; this is tidying.
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  return Object.freeze({
    pid: child.pid,
    stdout: () => stdout,
    stderr: () => stderr,
    async awaitLine(prefix, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (stdout.split(/\r?\n/u).some((line) => line.startsWith(prefix))) return true;
        if (child.exitCode !== null) return false;
        await new Promise((done) => setTimeout(done, 50));
      }
      return false;
    },
    async kill() {
      await new Promise((resolve) => {
        spawn("taskkill", ["/F", "/PID", String(child.pid)], { windowsHide: true }).once("exit", resolve);
      });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (child.exitCode !== null) return true;
        await new Promise((done) => setTimeout(done, 100));
      }
      return child.exitCode !== null;
    },
  });
}

async function settle(artifactRootPath, runRoot) {
  const { store, coordinator, ownerDeath, manifest } = modules(artifactRootPath);
  const { openProductionContinuityStore } = await import(store);
  const { createWindowsOwnerDeathVerifier } = await import(ownerDeath);
  const { loadHostDeploymentManifest } = await import(manifest);
  /**
   * The published generation predates the settlement: it is an immutable artifact built before this code
   * existed, so it has no `settleDurableGameRecoveryOnStartup` and driving it would prove nothing about HEAD.
   * The harness falls back to the build of the tree it runs in and names the artifact in its own reading -
   * an artifact under test must be stated, never assumed.
   */
  const candidate = await import(coordinator);
  let settleFn = candidate.settleDurableGameRecoveryOnStartup;
  let artifactUnderTest = "published-generation";
  /**
   * The settlement is exported from the coordinator's `internal` module, which is where the file that holds
   * it lives - `continuity-semantic-production-coordinator.internal.ts`. Looking only at the barrel found it
   * in neither artifact and the harness refused, which is the correct outcome for an unresolvable seam.
   */
  if (typeof settleFn !== "function") {
    for (const root of [artifactRootPath, join(process.cwd(), "host", "dist-test")]) {
      const internal = await import(
        pathToFileURL(join(root, "continuity-semantic-production-coordinator", "continuity-semantic-production-coordinator.internal.js")).href,
      );
      if (typeof internal.settleDurableGameRecoveryOnStartup === "function") {
        settleFn = internal.settleDurableGameRecoveryOnStartup;
        artifactUnderTest =
          root === artifactRootPath ? "published-generation (internal module)" : "dist-test (the published generation predates the settlement)";
        break;
      }
    }
  }
  if (typeof settleFn !== "function") throw new Error("settleDurableGameRecoveryOnStartup is absent from both artifacts");
  console.log(`  artifact under test: ${artifactUnderTest}`);
  const loaded = await loadHostDeploymentManifest(runRoot.manifestPath);
  const principal = loaded.principal ?? loaded.value?.principal ?? runRoot.principal;
  const verifier = createWindowsOwnerDeathVerifier();
  const continuity = openProductionContinuityStore({ runtimeRoot: runRoot.runtimeRoot });
  const stderrLines = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    stderrLines.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  let readback = null;
  let error = null;
  try {
    readback = await settleFn(
      async () => continuity.readPendingGameRecoveryTarget(),
      async (operationId) => {
        const target = continuity.readGameRecoveryTarget({ principal, operationId });
        if (target === null) throw new Error("recovery_target_missing");
        const proof = await verifier.verify(target.owner);
        const permit = target.permit;
        return continuity.recoverGame({
          request: "recover_dead_owner",
          principal,
          permit,
          proof,
          receipt: Object.freeze({
            kind: "recovery_completed",
            operationId: permit.operationId,
            requestId: permit.requestId,
            gameSessionId: permit.gameSessionId,
            bindingDigest: permit.bindingDigest,
            world: permit.world,
            owner: permit.owner,
            fenceToken: permit.fenceToken,
            occurredAtMs: Date.now(),
          }),
        });
      },
      verifier,
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    process.stderr.write = originalWrite;
    try {
      continuity.close?.();
    } catch {
      // A store that was never opened past a refusal has nothing to close.
    }
  }
  return Object.freeze({ readback, error, stderr: stderrLines.join("") });
}

/* ---------------------------------------------------------------- the two phases */

async function deadOwnerPhase(artifactRootPath) {
  const root = mkdtempSync(join(TMP, "gamebuddy-dead-owner-"));
  const runRoot = writeRunRoot(root, "deadowner");
  const owner = startOwner(artifactRootPath, runRoot.manifestPath);
  const ready = await owner.awaitLine("OWNER_READY", 120_000);
  record(
    "the owner Host completed a real Game enter and opened a close intent",
    ready,
    ready ? "OWNER_READY" : `no OWNER_READY (stderr=${owner.stderr().trim()})`,
  );
  if (!ready) {
    await owner.kill();
    return root;
  }
  const killed = await owner.kill();
  record("taskkill /F removed exactly that owner PID", killed, `pid=${String(owner.pid)} gone=${String(killed)}`);

  const settled = await settle(artifactRootPath, runRoot);
  record(
    "the settlement recovered the abandoned lease",
    settled.error === null && settled.readback !== null,
    settled.error ?? `operation=${settled.readback?.operationId ?? "none"}`,
  );
  record(
    "the evidence line names a proven-dead owner",
    /owner=proven_dead/u.test(settled.stderr),
    settled.stderr.trim().split(/\r?\n/u).filter(Boolean).join(" | ") || "(no stderr line)",
  );

  const state = readDurableState(runRoot.runtimeRoot);
  record("the durable session ended", state.session === "ended", `session=${String(state.session)}`);
  record("the abandoned lease is gone", state.lease === null, `lease=${JSON.stringify(state.lease)}`);
  return root;
}

async function livingOwnerPhase(artifactRootPath) {
  const root = mkdtempSync(join(TMP, "gamebuddy-living-owner-"));
  const runRoot = writeRunRoot(root, "livingowner");
  const owner = startOwner(artifactRootPath, runRoot.manifestPath);
  const ready = await owner.awaitLine("OWNER_READY", 120_000);
  record(
    "the control owner Host reached the same durable state",
    ready,
    ready ? "OWNER_READY" : `no OWNER_READY (stderr=${owner.stderr().trim()})`,
  );
  if (!ready) {
    await owner.kill();
    return root;
  }
  const settled = await settle(artifactRootPath, runRoot);
  record(
    "the settlement refused a living owner by name",
    settled.error === "game_recovery_blocked_owner_alive",
    `error=${String(settled.error)}`,
  );
  const state = readDurableState(runRoot.runtimeRoot);
  record(
    "the refusal recovered nothing",
    state.session !== "ended" || state.lease !== null,
    `session=${String(state.session)} lease=${JSON.stringify(state.lease)}`,
  );
  await owner.kill();
  return root;
}

function readDurableState(runtimeRoot) {
  const path = join(runtimeRoot, ".gamebuddy-semantic-continuity-v1", "gamebuddy-continuity-v1.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const session = db.prepare("select state from production_game_session limit 1").get();
    const lease = db.prepare("select state, lease_revision from production_game_lease limit 1").get();
    return Object.freeze({ session: session?.state ?? null, lease: lease ?? null });
  } finally {
    db.close();
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
  const role = option("--role");
  const explicit = option("--artifact");
  const resolved =
    explicit === undefined ? await artifactRoot() : Object.freeze({ generation: "explicit", artifactRoot: explicit });

  if (role === "owner") return await runOwner(resolved.artifactRoot, option("--manifest"));
  /**
   * This file spawns itself, so a child that fails to recognize its role must NOT fall through to the parent
   * branch: that child would spawn two more, each of which would spawn two more. The witness is the
   * environment, not an argument - on 2026-11-07 the argument-based witness was not observed to arrive at all,
   * and the harness spawned owner children that outlived it (1,335 resident `node` processes, ~50-75 MB of
   * commit each, pagefile exhausted). An environment variable is passed by the spawn call itself and cannot
   * be lost to argument quoting, so it is the witness this guard relies on.
   */
  const childOf = option("--child-of");
  if (process.env.GAMEBUDDY_LIVE_CHILD === "1" || childOf !== undefined) {
    console.error(
      `startup_dead_owner_settlement_blocked: refusing to run the parent branch in a child (role=${String(role)}, childOf=${String(childOf ?? "env")})`,
    );
    process.exitCode = 2;
    return;
  }
  if (process.platform !== "win32") {
    console.log("startup_dead_owner_settlement_skipped: the verifier answers `unavailable` off Windows");
    return;
  }

  console.log(`startup_dead_owner_settlement: generation=${resolved.generation} artifactRoot=${resolved.artifactRoot}`);
  const roots = [];
  try {
    roots.push(await deadOwnerPhase(resolved.artifactRoot));
    roots.push(await livingOwnerPhase(resolved.artifactRoot));
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  const failed = findings.filter((finding) => !finding.ok);
  console.log(
    `startup_dead_owner_settlement: examined ${String(findings.length)} reading(s) on this machine, ${String(failed.length)} disagreement(s)`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(
    `startup_dead_owner_settlement_blocked: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
}
