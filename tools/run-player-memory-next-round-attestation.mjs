#!/usr/bin/env node
/**
 * Content-free evidence collector for one exact next provider round following
 * a direct player Memory mutation. It uses only the immutable Host production
 * artifact and its authenticated loopback API. Child-process IPC is untrusted
 * evidence input and is validated here; it is never sent to the child.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
const RUNNER_SCHEMA = "gamebuddy-chat-player-memory-exact-next-provider-attestation/v1";
const HOST_ATTESTATION_SCHEMA = "gamebuddy-player-memory-next-round-host-attestation/v1";
const READY_PREFIX = "GameBuddy Dialogue is ready at ";
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MARKER_TIMEOUT_MS = 90_000;
const DIAGNOSTIC_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

export function parseArguments(argv) {
  if (argv.length === 0) return Object.freeze({ reportPath: undefined });
  if (argv.length !== 2 || argv[0] !== "--report" || argv[1].length === 0)
    throw new Error("usage: node tools/run-player-memory-next-round-attestation.mjs [--report <path>]");
  return Object.freeze({ reportPath: resolve(argv[1]) });
}

export async function prepareReportTarget(path) {
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || relative(path, dirname(path)) === "") throw new Error("invalid_report_path");
  try {
    await lstat(path);
    throw new Error("report_target_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let canonicalParent;
  try {
    canonicalParent = await realpath(dirname(path));
  } catch {
    throw new Error("report_parent_missing_or_unresolvable");
  }
  const state = await lstat(canonicalParent);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("report_parent_not_real_directory");
  return join(canonicalParent, basename(path));
}

export function isContentFreeReport(serialized) {
  return !/(?:"(?:content|prompt|cookie|csrf|token|stateToken|providerResponse|rawResponse)"\s*:|private\s+(?:prompt|content)|authorization:\s*bearer)/i.test(
    serialized,
  );
}

export async function writeReport(path, report) {
  if (path === undefined) return;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (!isContentFreeReport(serialized)) throw new Error("evidence_report_content_guard_rejected");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
  } finally {
    await handle.close();
  }
}

function validSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}
function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The Host emits this after its private coordinator accepts the source-owned
 * plugin marker against its live session, nonce, opaque operation correlation,
 * committed mutation receipt, and frozen rendered-entry coverage. The runner
 * intentionally receives only this redacted derived attestation.
 */
export function evaluateExactNextProviderAttestation(value, expected) {
  if (value === undefined) return { observed: false, reasonCode: "provider_attestation_unavailable" };
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6 ||
    value.schema !== HOST_ATTESTATION_SCHEMA ||
    !validSessionId(value.sessionId) ||
    !validDigest(value.nonceSha256) ||
    value.surface !== "chat" ||
    !positiveInteger(value.providerRoundGeneration) ||
    value.exactSelectedCoverage !== true
  )
    return { observed: false, reasonCode: "provider_attestation_schema_invalid" };
  if (
    (expected.sessionId !== undefined && value.sessionId !== expected.sessionId) ||
    value.nonceSha256 !== expected.nonceSha256
  )
    return { observed: false, reasonCode: "provider_attestation_binding_mismatch" };
  return Object.freeze({
    observed: true,
    providerInvocation: true,
    providerRoundGeneration: value.providerRoundGeneration,
  });
}

/** One Host-accepted source attestation can prove one provider attempt only. */
export function createExactNextProviderAttestationCollector(expected) {
  let consumed = false;
  return Object.freeze({
    collect(value) {
      if (consumed) return { observed: false, reasonCode: "provider_attestation_replayed" };
      const result = evaluateExactNextProviderAttestation(value, expected);
      if (result.observed) consumed = true;
      return result;
    },
  });
}

export function createDeploymentManifest(runtimeRoot, principal, bootstrapOperationId) {
  return Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot,
    principal: Object.freeze({ ...principal }),
    bootstrapOperationId,
    authorityGeneration: 1,
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function safeReasonCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : "live_runner_internal_error";
}
function deadlineFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function productionArtifactIdentity() {
  try {
    const pointer = JSON.parse(await readFile(join(HOST_ROOT, "dist", "current.json"), "utf8"));
    if (!validSessionId(pointer.generation) || !validDigest(pointer.inventoryDigest)) throw new Error("invalid");
    return Object.freeze({ generation: pointer.generation, inventoryDigest: pointer.inventoryDigest });
  } catch {
    throw new Error("production_artifact_identity_unavailable");
  }
}

async function waitForReady(child, readStdout) {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        child.off("exit", onExit);
        child.off("error", onError);
        fn(value);
      }
    };
    const check = () => {
      const match = readStdout().match(new RegExp(`${READY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\S+)`));
      if (match) settle(resolveReady, match[1]);
    };
    const onExit = (code) => settle(rejectReady, new Error(`dialogue_exited_before_ready:${code ?? "unknown"}`));
    const onError = () => settle(rejectReady, new Error("dialogue_spawn_failed"));
    const interval = setInterval(check, 25);
    const timeout = setTimeout(() => settle(rejectReady, new Error("dialogue_start_timeout")), START_TIMEOUT_MS);
    child.once("exit", onExit);
    child.once("error", onError);
    check();
  });
}

async function stop(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (
    await Promise.race([
      new Promise((resolveStop) => child.once("exit", () => resolveStop(true))),
      new Promise((resolveStop) => setTimeout(() => resolveStop(false), STOP_TIMEOUT_MS)),
    ])
  )
    return;
  child.kill("SIGKILL");
}

async function bootstrap(origin, token) {
  const response = await deadlineFetch(`${origin}/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const body = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof body.csrf !== "string")
    throw new Error(`bootstrap_failed:${response.status}`);
  return Object.freeze({ cookie, csrf: body.csrf });
}
async function post(origin, client, path, body) {
  const response = await deadlineFetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: client.cookie,
      "X-GameBuddy-CSRF": client.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  // Responses are intentionally parsed only to control the next call; none is retained.
  return Object.freeze({ status: response.status, body: await response.json() });
}
function waitForAttestation(attestation) {
  return new Promise((resolveAttestation) => {
    const timeout = setTimeout(() => resolveAttestation(undefined), MARKER_TIMEOUT_MS);
    attestation.then((value) => {
      clearTimeout(timeout);
      resolveAttestation(value);
    });
  });
}
function waitForDiagnostic(diagnostic) {
  return new Promise((resolveDiagnostic) => {
    const timeout = setTimeout(() => resolveDiagnostic(undefined), DIAGNOSTIC_TIMEOUT_MS);
    diagnostic.then((value) => {
      clearTimeout(timeout);
      resolveDiagnostic(value);
    });
  });
}

/**
 * The Magic Context hook keeps its source marker process-local and delivers it
 * only to the registered Host callback. After independently validating that
 * marker against its private committed receipt, Dialogue emits a separately
 * redacted Host attestation. The reviewed production launcher forwards that
 * child IPC message unchanged to this runner; no raw source marker crosses the
 * process boundary.
 */
export async function assertExternalMarkerPathAvailable() {
  const artifact = await productionArtifactIdentity();
  const entry = join(HOST_ROOT, "dist", "generations", artifact.generation, "dialogue-web-main.js");
  const launcher = join(HOST_ROOT, "scripts", "start-production-artifact.mjs");
  let entrySource;
  let launcherSource;
  try {
    [entrySource, launcherSource] = await Promise.all([readFile(entry, "utf8"), readFile(launcher, "utf8")]);
  } catch {
    throw new Error("production_artifact_entry_or_launcher_unavailable");
  }
  if (!entrySource.includes("GAMEBUDDY_PLAYER_MEMORY_NEXT_ROUND_NONCE_SHA256"))
    throw new Error("player_memory_next_round_opt_in_unavailable");
  if (!entrySource.includes(HOST_ATTESTATION_SCHEMA))
    throw new Error("player_memory_next_round_host_attestation_unavailable");
  if (!/child\.on\(["']message["'][\s\S]{0,500}process\.send/.test(launcherSource))
    throw new Error("production_launcher_child_ipc_forwarding_unavailable");
  return artifact;
}

function reportBase(runId, startedAt, artifact) {
  return {
    schema: RUNNER_SCHEMA,
    runner: { id: "player-memory-next-round-attestation", version: 1 },
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    artifact,
    state: "blocked",
    providerInvocation: false,
    providerAcceptedOrSemanticAnswer: false,
    scope: "chat_player_memory_exact_next_provider_attestation_not_game_gate",
    note: "Create-only redacted evidence. It does not claim Game evidence or provider acceptance, semantic output, or response.",
  };
}

export async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  const reportTarget = await prepareReportTarget(arguments_.reportPath);
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-player-memory-next-round-"));
  const runId = randomBytes(12).toString("hex");
  const startedAt = new Date().toISOString();
  const nonceSha256 = sha256(randomBytes(32).toString("hex"));
  const identity = Object.freeze({
    playerId: "memory_next_player",
    companionId: "memory_next_companion",
    continuityId: "memory_next_continuity",
  });
  let child;
  let artifact;
  let report;
  let markerResult;
  try {
    artifact = await assertExternalMarkerPathAvailable();
    const configPath = join(root, "dialogue.json");
    await writeFile(
      configPath,
      JSON.stringify(
        createDeploymentManifest(root, identity, `memory_next_bootstrap_${randomBytes(12).toString("hex")}`),
      ),
      "utf8",
    );
    child = spawn(
      process.execPath,
      [join(HOST_ROOT, "scripts", "start-production-artifact.mjs"), "dialogue-web-main.js", configPath],
      {
        cwd: HOST_ROOT,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        env: { ...process.env, GAMEBUDDY_PLAYER_MEMORY_NEXT_ROUND_NONCE_SHA256: nonceSha256 },
      },
    );
    let stdout = "";
    let resolveAttestation;
    let resolveDiagnostic;
    const nextAttestation = new Promise((resolveObserved) => {
      resolveAttestation = resolveObserved;
    });
    const sourceDiagnostic = new Promise((resolveObserved) => {
      resolveDiagnostic = resolveObserved;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => undefined);
    child.on("message", (value) => {
      if (value?.schema === HOST_ATTESTATION_SCHEMA) resolveAttestation?.(value);
      else if (value?.schema === "gamebuddy-player-memory-next-round-source-diagnostic/v1") resolveDiagnostic?.(value);
    });
    const ready = await waitForReady(child, () => stdout);
    const url = new URL(ready);
    const origin = `${url.protocol}//${url.host}`;
    const client = await bootstrap(origin, url.hash.slice("#boot=".length));
    // One direct semantic mutation arms the source-owned exact-next slot.
    const mutation = await post(origin, client, "/memories", {
      content: `memory-next-${randomBytes(18).toString("hex")}`,
      category: "semantic",
    });
    if (mutation.status !== 201) throw new Error(`memory_mutation_failed:${mutation.status}`);
    const attempt = await post(origin, client, "/message", {
      clientMessageId: `memory_next_${randomBytes(12).toString("hex")}`,
      // Content-free with respect to the created Memory: exact selected m[1]
      // visibility is proven structurally, not by a model echoing a secret.
      text: "Please respond with a brief greeting.",
      locale: "en-US",
    });
    if (attempt.status !== 202) throw new Error(`provider_attempt_not_accepted:${attempt.status}`);
    const collector = createExactNextProviderAttestationCollector({ nonceSha256 });
    markerResult = collector.collect(await waitForAttestation(nextAttestation));
    const diagnostic = markerResult.observed ? undefined : await waitForDiagnostic(sourceDiagnostic);
    const passed = markerResult?.observed === true;
    report = {
      ...reportBase(runId, startedAt, artifact),
      state: passed ? "passed" : "blocked",
      providerInvocation: markerResult?.observed === true,
      assertions: {
        directSemanticMutation: mutation.status === 201,
        nextRealProviderAttempt: attempt.status === 202,
        hostAcceptedSourceMarkerBoundToCommittedMutation: markerResult?.observed === true,
        exactSelectedCoverage: markerResult?.observed === true,
        providerAcceptedOrSemanticAnswer: false,
      },
      ...(passed
        ? {}
        : {
            reasonCode:
              typeof diagnostic?.reasonCode === "string" && /^[a-z0-9_:.-]{1,160}$/i.test(diagnostic.reasonCode)
                ? diagnostic.reasonCode
                : (markerResult?.reasonCode ?? "provider_attestation_unavailable"),
          }),
    };
  } catch (error) {
    report = { ...reportBase(runId, startedAt, artifact ?? null), reasonCode: safeReasonCode(error) };
  } finally {
    await stop(child).catch(() => undefined);
    await writeReport(reportTarget, report);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
  console.log(JSON.stringify(report));
  return report.state === "passed" ? 0 : 2;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ schema: RUNNER_SCHEMA, state: "blocked", reasonCode: safeReasonCode(error) }));
      process.exitCode = 2;
    });
