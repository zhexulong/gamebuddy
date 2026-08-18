#!/usr/bin/env node
/**
 * Bounded, Host-process live check for the player-managed Memory HTTP surface.
 *
 * This is evidence for the shipped Dialogue entrypoint, authenticated loopback
 * API and Magic Context facade. It deliberately does not claim a Tavern
 * operator observation, provider invocation, or a cross-surface Game run.
 *
 * Optional `--report <absolute-or-relative-path>` writes a create-only,
 * content-free report to an existing caller-owned directory. The runner never
 * writes bootstrap tokens, cookies, Memory text, prompts, raw HTTP bodies, or
 * child stdout/stderr into that report.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
const RUNNER_SCHEMA = "gamebuddy-player-managed-memory-http-live/v2";
const RUNNER_ID = "player-managed-memory-http-live";
const READY_PREFIX = "GameBuddy Dialogue is ready at ";
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 12_000;
const STOP_TIMEOUT_MS = 5_000;

function opaque(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("invalid_opaque_fixture_value");
  return value;
}

export function parseArguments(argv) {
  if (argv.length === 0) return Object.freeze({ reportPath: undefined });
  if (argv.length !== 2 || argv[0] !== "--report" || argv[1].length === 0)
    throw new Error("usage: node tools/run-player-managed-memory-http-live.mjs [--report <path>]");
  return Object.freeze({ reportPath: resolve(argv[1]) });
}

/** A report target must not overwrite evidence and must live below an existing,
 * real caller-selected directory. `realpath` prevents a final-directory link
 * from silently redirecting the write; create-only open prevents replacement. */
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
  const parentState = await lstat(canonicalParent);
  if (!parentState.isDirectory() || parentState.isSymbolicLink()) throw new Error("report_parent_not_real_directory");
  // Use the canonical parent for the write so a symlink in the supplied final
  // directory cannot redirect it after validation.
  return join(canonicalParent, basename(path));
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

function safeReasonCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  // Status-bearing coded failures are intentionally part of the report's
  // public taxonomy; never interpolate arbitrary request/child output.
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : "live_runner_internal_error";
}

function isContentFreeReport(serialized) {
  // Only reject values that could have come from a request/session surface;
  // the public schema description may legitimately name the classes of data
  // it excludes (for example “csrf token”).
  return !/(?:The player prefers|This stale mutation|"csrf"\s*:|"cookie"\s*:|"stateToken"\s*:|"bootstrap"\s*:|"dialogue\.json"\s*:)/i.test(
    serialized,
  );
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
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
      callback(value);
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

async function productionArtifactIdentity() {
  try {
    const pointer = JSON.parse(await readFile(join(HOST_ROOT, "dist", "current.json"), "utf8"));
    if (
      typeof pointer.generation !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(pointer.generation) ||
      typeof pointer.inventoryDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(pointer.inventoryDigest)
    )
      throw new Error("invalid");
    return Object.freeze({ generation: pointer.generation, inventoryDigest: pointer.inventoryDigest });
  } catch {
    throw new Error("production_artifact_identity_unavailable");
  }
}

function reportBase({ runId, startedAt, artifact, identity }) {
  return {
    schema: RUNNER_SCHEMA,
    runner: { id: RUNNER_ID, version: 2 },
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    artifact,
    providerInvocation: false,
    identity: { continuityId: identity.continuityId },
    scope: "authenticated_host_api_and_magic_context_facade",
    note: "Not a provider-invocation, Tavern-operator, or cross-surface Game live gate. No Memory content, token, cookie, prompt, raw HTTP body, child stdout, or child stderr is retained.",
  };
}

export async function main(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  const reportTarget = await prepareReportTarget(arguments_.reportPath);
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-player-memory-http-live-"));
  const runId = randomBytes(12).toString("hex");
  const startedAt = new Date().toISOString();
  const identity = Object.freeze({
    playerId: opaque("memory_live_player"),
    companionId: opaque("memory_live_companion"),
    continuityId: opaque("memory_live_continuity"),
  });
  let child;
  let stdout = "";
  let stderr = "";
  let artifact;
  let report;
  let processTermination;
  try {
    artifact = await productionArtifactIdentity();
    const configPath = join(root, "dialogue.json");
    await writeFile(configPath, JSON.stringify({ ...identity, runtimeRoot: root }), "utf8");
    // Run the checked production launcher directly rather than a shell/pnpm
    // wrapper. It pins one immutable generation before spawning Dialogue Web.
    child = spawn(
      process.execPath,
      [join(HOST_ROOT, "scripts", "start-production-artifact.mjs"), "dialogue-web-main.js", configPath],
      { cwd: HOST_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const started = await waitForReady(child, () => stdout);
    const url = new URL(started);
    const origin = `${url.protocol}//${url.host}`;
    const client = await bootstrap(origin, url.hash.slice("#boot=".length));
    const initial = await list(origin, client);
    if (initial.status !== 200 || !Array.isArray(initial.body.memories)) throw new Error("initial_memory_list_failed");
    const created = await request(origin, client, "/memories", {
      content: "The player prefers calm, concise planning before important farm decisions.",
      category: "semantic",
    });
    if (created.status !== 201 || typeof created.body.memory?.stateToken !== "string")
      throw new Error(`memory_create_failed:${created.status}`);
    const originalToken = created.body.memory.stateToken;
    const updated = await request(origin, client, "/memories/update", {
      stateToken: originalToken,
      content:
        "The player prefers calm, concise planning and an explicit priority check before important farm decisions.",
    });
    if (updated.status !== 200 || typeof updated.body.memory?.stateToken !== "string")
      throw new Error(`memory_update_failed:${updated.status}`);
    const stale = await request(origin, client, "/memories/update", {
      stateToken: originalToken,
      content: "This stale mutation must be rejected.",
    });
    const archived = await request(origin, client, "/memories/archive", { stateToken: updated.body.memory.stateToken });
    const restored =
      archived.status === 200
        ? await request(origin, client, "/memories/restore", { stateToken: archived.body.memory.stateToken })
        : { status: 0, body: {} };
    const pinned =
      restored.status === 200
        ? await request(origin, client, "/memories/pin", { stateToken: restored.body.memory.stateToken })
        : { status: 0, body: {} };
    const unpinned =
      pinned.status === 200
        ? await request(origin, client, "/memories/unpin", { stateToken: pinned.body.memory.stateToken })
        : { status: 0, body: {} };
    const final = await list(origin, client);
    const passed =
      stale.status === 409 &&
      archived.status === 200 &&
      restored.status === 200 &&
      pinned.status === 200 &&
      unpinned.status === 200 &&
      final.status === 200;
    processTermination = await stop(child);
    child = undefined;
    report = {
      ...reportBase({ runId, startedAt, artifact, identity }),
      state: passed ? "passed" : "failed",
      assertions: {
        hostBoundContinuity: true,
        authenticatedRead: initial.status === 200,
        playerCreate: created.status === 201,
        update: updated.status === 200,
        compareAndSwapRejectsStaleRevision: stale.status === 409 && stale.body.error === "memory_revision_conflict",
        archiveRestore: archived.status === 200 && restored.status === 200,
        pinUnpin: pinned.status === 200 && unpinned.status === 200,
        finalRead: final.status === 200,
      },
      statuses: {
        initial: initial.status,
        create: created.status,
        update: updated.status,
        stale: stale.status,
        archive: archived.status,
        restore: restored.status,
        pin: pinned.status,
        unpin: unpinned.status,
        final: final.status,
      },
      processTermination,
    };
  } catch (error) {
    report = {
      ...reportBase({ runId, startedAt, artifact: artifact ?? null, identity }),
      state: "blocked",
      reasonCode: safeReasonCode(error),
    };
  } finally {
    processTermination ??= await stop(child).catch(() => "stop_failed");
    report = { ...report, processTermination };
    await writeReport(reportTarget, report).catch((error) => {
      report = { ...report, state: "blocked", reasonCode: "evidence_report_write_failed" };
      console.error(JSON.stringify({ schema: RUNNER_SCHEMA, state: "blocked", reasonCode: safeReasonCode(error) }));
    });
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
  console.log(JSON.stringify(report));
  return report.state === "passed" ? 0 : 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(JSON.stringify({ schema: RUNNER_SCHEMA, state: "blocked", reasonCode: safeReasonCode(error) }));
      process.exitCode = 2;
    });
}
