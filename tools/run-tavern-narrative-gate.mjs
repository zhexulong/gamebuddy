#!/usr/bin/env node
/**
 * Automated, content-free Tavern narrative gate.
 *
 * The runner talks only to a fresh checked Host production artifact through its
 * authenticated loopback HTTP API. It creates direct Semantic and Interaction
 * Memory rows, exercises archive/delete/exclude-source, and submits one real
 * Dialogue turn. It never opens SQLite, invokes a fake provider, or drives UI.
 *
 * Prompt materialization is intentionally not inferred from the model's answer.
 * A one-shot provider-boundary marker is received over child IPC; it proves
 * only pre-send serialization. The real turn outcome remains a separate gate.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
const RUNNER_SCHEMA = "gamebuddy-tavern-narrative-gate/v1";
const RUNNER_ID = "tavern-narrative-gate";
const READY_PREFIX = "GameBuddy Dialogue is ready at ";
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;
const TURN_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 5_000;

export function parseArguments(argv) {
  if (argv.length === 0) return Object.freeze({ reportPath: undefined });
  if (argv.length !== 2 || argv[0] !== "--report" || argv[1].length === 0)
    throw new Error("usage: node tools/run-tavern-narrative-gate.mjs [--report <path>]");
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
  const parent = dirname(path);
  let canonicalParent;
  try {
    canonicalParent = await realpath(parent);
  } catch {
    throw new Error("report_parent_missing_or_unresolvable");
  }
  const state = await lstat(canonicalParent);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("report_parent_not_real_directory");
  return join(canonicalParent, basename(path));
}

function contentFree(serialized) {
  return !/(?:The player prefers|private dialogue|private prompt|csrf|cookie|stateToken|bootstrap|raw provider output|prompt text)/i.test(
    serialized,
  );
}

export async function writeReport(path, report) {
  if (path === undefined) return;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (!contentFree(serialized)) throw new Error("evidence_report_content_guard_rejected");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
  } finally {
    await handle.close();
  }
}

function safeReasonCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : "live_runner_internal_error";
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The marker is an intentionally narrow provider-boundary contract. It proves
 * only that Pi serialized a request before the provider call; it does not
 * prove provider acceptance or a semantic response.
 */
export function evaluateNarrativeGateRuntime(value) {
  if (
    value?.schema !== "gamebuddy-tavern-narrative-gate-runtime/v1" ||
    typeof value.piSessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(value.piSessionId)
  ) return { observed: false, reasonCode: "provider_runtime_session_unavailable" };
  return { observed: true, piSessionId: value.piSessionId };
}

export function evaluateNarrativeGateMarker(value, expectedDigest, expectedSessionId) {
  if (value === undefined) return { observed: false, reasonCode: "provider_marker_unavailable" };
  if (
    value?.schema !== "gamebuddy-tavern-narrative-gate-marker/v1" ||
    typeof value.sessionId !== "string" ||
    typeof value.nonceSha256 !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(value.sessionId) ||
    !/^[a-f0-9]{64}$/.test(value.nonceSha256)
  )
    return { observed: false, reasonCode: "provider_marker_schema_invalid" };
  if (value.sessionId !== expectedSessionId || value.nonceSha256 !== expectedDigest)
    return { observed: false, reasonCode: "provider_marker_digest_mismatch" };
  return { observed: true, preSendSerialized: true };
}


function deadlineFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

async function request(origin, client, pathname, body) {
  const response = await deadlineFetch(`${origin}${pathname}`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: client.cookie,
      "X-GameBuddy-CSRF": client.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

async function list(origin, client) {
  const response = await deadlineFetch(`${origin}/memories`, { headers: { Cookie: client.cookie } });
  return Object.freeze({ status: response.status, body: await response.json() });
}

async function waitForReady(child, readStdout) {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      fn(value);
    };
    const check = () => {
      const escaped = READY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = readStdout().match(new RegExp(`${escaped}(\\S+)`));
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
  if (child === undefined || child.exitCode !== null) return "not_running";
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveStop) => child.once("exit", () => resolveStop(true))),
    new Promise((resolveStop) => setTimeout(() => resolveStop(false), STOP_TIMEOUT_MS)),
  ]);
  if (exited) return "terminated";
  child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolveStop) => child.once("exit", () => resolveStop(undefined))),
    new Promise((resolveStop) => setTimeout(resolveStop, 1_000)),
  ]);
  return "killed_after_stop_timeout";
}

async function sendTurn(origin, client) {
  const events = [];
  const abort = new AbortController();
  const response = await fetch(`${origin}/events`, { headers: { Cookie: client.cookie }, signal: abort.signal });
  if (!response.ok || response.body === null) throw new Error(`events_failed:${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome;
  const observed = new Promise((resolveOutcome) => {
    const timer = setTimeout(() => resolveOutcome("timeout"), TURN_TIMEOUT_MS);
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator;
          while ((separator = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const match = /^event: ([^\n]+)\ndata: (.+)$/m.exec(frame);
            if (!match) continue;
            const payload = JSON.parse(match[2]);
            if (["agent_start", "agent_end", "agent_settled"].includes(payload.type)) events.push(payload.type);
            if (payload.type === "presentation_text") return resolveOutcome("presentation_text");
            if (payload.type === "turn_failed") return resolveOutcome("turn_failed");
          }
        }
      } catch {
        resolveOutcome("events_error");
      } finally {
        clearTimeout(timer);
      }
    })();
  });
  const message = await fetch(`${origin}/message`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: client.cookie,
      "X-GameBuddy-CSRF": client.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientMessageId: `tavern_gate_${randomBytes(8).toString("hex")}`, text: "Please respond naturally.", locale: "en-US" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (message.status !== 202) throw new Error(`message_failed:${message.status}`);
  outcome = await observed;
  abort.abort();
  await reader.cancel().catch(() => undefined);
  return Object.freeze({ outcome, lifecycle: events });
}

async function productionArtifactIdentity() {
  try {
    const pointer = JSON.parse(await readFile(join(HOST_ROOT, "dist", "current.json"), "utf8"));
    if (typeof pointer.generation !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(pointer.generation) || typeof pointer.inventoryDigest !== "string" || !/^[a-f0-9]{64}$/.test(pointer.inventoryDigest)) throw new Error("invalid");
    return Object.freeze({ generation: pointer.generation, inventoryDigest: pointer.inventoryDigest });
  } catch {
    throw new Error("production_artifact_identity_unavailable");
  }
}

function reportBase(runId, startedAt, artifact) {
  return {
    schema: RUNNER_SCHEMA,
    runner: { id: RUNNER_ID, version: 1 },
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    artifact,
    scope: "authenticated_dialogue_memory_api_and_real_provider",
    providerInvocation: false,
    note: "Create-only content-free evidence; no Memory text, prompt, credential, revision token, or provider response is retained.",
  };
}

export async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  const reportTarget = await prepareReportTarget(arguments_.reportPath);
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-narrative-gate-"));
  const runId = randomBytes(12).toString("hex");
  const startedAt = new Date().toISOString();
  const nonce = randomBytes(18).toString("hex");
  const nonceSha256 = sha256(nonce);
  const values = Object.freeze({
    semantic: `semantic_${nonce}`,
    interaction: `interaction_${nonce}`,
    archived: `archived_${nonce}`,
    deleted: `deleted_${nonce}`,
    excluded: `excluded_${nonce}`,
    // Magic Context's production facade accepts only typed opaque provenance
    // references.  `source_${nonce}` reaches the facade's validation boundary
    // and is correctly rejected as an invalid source reference (HTTP 503).
    sourceRef: `host-receipt:${nonce}`,
  });
  const identity = Object.freeze({ playerId: "tavern_gate_player", companionId: "tavern_gate_companion", continuityId: "tavern_gate_continuity" });
  let child;
  let artifact;
  let report;
  try {
    artifact = await productionArtifactIdentity();
    const configPath = join(root, "dialogue.json");
    await writeFile(configPath, JSON.stringify({ ...identity, runtimeRoot: root, tavernNarrativeGateNonceSha256: nonceSha256 }), "utf8");
    child = spawn(process.execPath, [join(HOST_ROOT, "scripts", "start-production-artifact.mjs"), "dialogue-web-main.js", configPath], {
      cwd: HOST_ROOT,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", () => undefined);
    let marker;
    let runtimeMarker;
    child.on("message", (value) => {
      if (value?.schema === "gamebuddy-tavern-narrative-gate-runtime/v1" && runtimeMarker === undefined) runtimeMarker = value;
      else if (value?.schema === "gamebuddy-tavern-narrative-gate-marker/v1" && marker === undefined) marker = value;
    });
    const ready = await waitForReady(child, () => stdout);
    const url = new URL(ready);
    const origin = `${url.protocol}//${url.host}`;
    const client = await bootstrap(origin, url.hash.slice("#boot=".length));
    const initial = await list(origin, client);
    if (initial.status !== 200 || !Array.isArray(initial.body.memories)) throw new Error("initial_memory_list_failed");

    const created = {};
    for (const [key, content, category, sourceRefs] of [
      ["semantic", values.semantic, "semantic"],
      ["interaction", values.interaction, "interaction"],
      ["archived", values.archived, "semantic"],
      ["deleted", values.deleted, "semantic"],
      ["excluded", values.excluded, "semantic", [values.sourceRef]],
    ]) {
      const body = { content, category, ...(sourceRefs === undefined ? {} : { sourceRefs }) };
      const result = await request(origin, client, "/memories", body);
      if (result.status !== 201 || typeof result.body.memory?.stateToken !== "string") throw new Error(`memory_create_failed:${key}:${result.status}`);
      created[key] = result.body.memory.stateToken;
    }
    const archived = await request(origin, client, "/memories/archive", { stateToken: created.archived });
    const archivedStateToken = archived.body.memory?.stateToken;
    const deleted = await request(origin, client, "/memories/delete-entry", { stateToken: created.deleted });
    const excluded = await request(origin, client, "/memories/exclude-source", { stateToken: created.excluded, sourceRef: values.sourceRef });
    const final = await list(origin, client);
    if (final.status !== 200 || !Array.isArray(final.body.memories)) throw new Error("final_memory_list_failed");
    const hasToken = (token) => final.body.memories.some((memory) => memory.stateToken === token);
    // The archive transition changes the opaque state token (status is part of
    // its CAS identity), so inspect the token returned by the checked facade
    // rather than the pre-transition token.
    const archivedListed = archived.status === 200 && typeof archivedStateToken === "string" && hasToken(archivedStateToken) && final.body.memories.find((memory) => memory.stateToken === archivedStateToken)?.status === "archived";
    const deletedAbsent = !hasToken(created.deleted);
    const excludedListed = hasToken(created.excluded);
    const turn = await sendTurn(origin, client);
    await stop(child);
    child = undefined;
    const runtimeSession = evaluateNarrativeGateRuntime(runtimeMarker);
    const prompt = evaluateNarrativeGateMarker(
      marker,
      nonceSha256,
      runtimeSession.observed ? runtimeSession.piSessionId : undefined,
    );
    const realTurn = turn.outcome === "presentation_text" || turn.outcome === "turn_failed" || turn.lifecycle.includes("agent_end");
    const passed = archived.status === 200 && deleted.status === 200 && excluded.status === 200 && archivedListed && deletedAbsent && excludedListed && runtimeSession.observed && prompt.observed && realTurn;
    report = {
      ...reportBase(runId, startedAt, artifact),
      state: passed ? "passed" : "blocked",
      providerInvocation: prompt.observed,
      assertions: {
        authenticatedMemoryApi: initial.status === 200 && final.status === 200,
        semanticCreated: created.semantic !== undefined,
        interactionCreated: created.interaction !== undefined,
        archiveListedArchived: archivedListed,
        deleteAbsent: deletedAbsent,
        excludeSourceEndpointAndPersistence: excluded.status === 200 && excludedListed,
        excludeSourceInjectionBehaviorAsserted: false,
        realDialogueTurnAttempted: turn.lifecycle.includes("agent_start") || turn.outcome !== "events_error",
        providerRuntimeSessionBound: runtimeSession.observed,
        providerPreSendSerialized: prompt.preSendSerialized === true,
        realTurnOutcomeObserved: realTurn,
        providerAcceptedOrSemanticAnswer: false,
      },
      statuses: { initial: initial.status, archive: archived.status, delete: deleted.status, excludeSource: excluded.status, final: final.status, turn: turn.outcome },
      ...(passed ? {} : { reasonCode: runtimeSession.reasonCode ?? prompt.reasonCode ?? "narrative_gate_assertion_failed" }),
    };
  } catch (error) {
    report = { ...reportBase(runId, startedAt, artifact ?? null), state: "blocked", reasonCode: safeReasonCode(error) };
  } finally {
    await stop(child).catch(() => undefined);
    try {
      // Requested evidence is part of the gate contract. Never report a passed
      // live run when the create-only, content-free report could not be written.
      await writeReport(reportTarget, report);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
    }
  }
  console.log(JSON.stringify(report));
  return report.state === "passed" ? 0 : 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(JSON.stringify({ schema: RUNNER_SCHEMA, state: "blocked", reasonCode: safeReasonCode(error) })); process.exitCode = 2; });
}
