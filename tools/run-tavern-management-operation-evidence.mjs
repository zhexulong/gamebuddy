#!/usr/bin/env node
/**
 * Tavern management UI-operation evidence runner.
 *
 * The `chat-tavern-live` release gate needs a `mounted_profile_operation_evidence`
 * mapping, and by contract that mapping may only come from REAL same-origin
 * execution of the mounted management surface - never from a static declaration
 * (tools/tavern-live-run-charter.md §2, tools/record-tavern-ui-operation-evidence.mjs).
 *
 * This runner mounts the real management composition on a fresh gate-owned root,
 * authenticates through its one-time bootstrap route, and performs each operation
 * the mounted `gamebuddy.tavern-management.chat-list-title` profile declares,
 * against the authenticated HTTP surface. It records only content-free outcomes
 * (operation id + passed/blocked + a revision), which is exactly the shape
 * `record-tavern-ui-operation-evidence.mjs` consumes.
 *
 * It never records titles, prompts, memory content, credentials, cookies, URLs or
 * operator identity.
 *
 * Maintenance contract: this is a runner for the REAL product surface. It may not
 * be replaced by a fixture that writes the sessionStorage key, by a mock fetch, or
 * by a hand-authored outcomes file - those would make the gate's operation
 * evidence a self-certification. If it cannot reach a real mounted session it
 * reports `blocked` and names the step that failed.
 */
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { launchDesktopCompositionGateChild } from "./desktop-composition-launch.mjs";
import { readMountedTavernManagementProfile } from "./lib/tavern-mounted-operation-vocabulary.mjs";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
const OUTPUT_ROOT = process.env.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT
  ? resolve(process.env.GAMEBUDDY_TAVERN_GATE_OUTPUT_ROOT)
  : join(HOST_ROOT, "dist");
const REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;

const IDENTITY = Object.freeze({
  playerId: "chat_audit_player",
  companionId: "chat_audit_companion",
  continuityId: "chat_audit_continuity",
});

function usage() {
  return "usage: node tools/run-tavern-management-operation-evidence.mjs --outcomes <path> [--report <path>]";
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag !== "--outcomes" && flag !== "--report") {
      if (flag === "--help") return Object.freeze({ help: true });
      throw new Error(`${usage()} (unknown flag: ${flag})`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(usage());
    if (values.has(flag)) throw new Error(`${usage()} (duplicate: ${flag})`);
    values.set(flag, resolve(value));
    index += 1;
  }
  const outcomes = values.get("--outcomes");
  if (outcomes === undefined) throw new Error(usage());
  return Object.freeze({ help: false, outcomesPath: outcomes, reportPath: values.get("--report") });
}

async function deadlineFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrap(origin, token) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.json().catch(() => undefined);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof body?.csrfToken !== "string")
    throw new Error(`bootstrap_failed:${response.status}`);
  return Object.freeze({ cookie, csrf: body.csrfToken });
}

async function readJson(origin, client, path) {
  const response = await deadlineFetch(`${origin}${path}`, {
    headers: { Cookie: client.cookie, Origin: origin },
  });
  if (!response.ok) throw new Error(`read_failed:${path}:${response.status}`);
  return response.json();
}

async function sendJson(origin, client, method, path, body) {
  const response = await deadlineFetch(`${origin}${path}`, {
    method,
    headers: {
      Cookie: client.cookie,
      Origin: origin,
      "Content-Type": "application/json",
      "x-csrf-token": client.csrf,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`write_failed:${path}:${response.status}`);
  return response.json();
}

/** Record one real outcome. `blocked` carries a bounded reason, never content. */
function outcome(operationId, state, reason) {
  return state === "passed"
    ? Object.freeze({ operationId, outcome: "passed" })
    : Object.freeze({ operationId, outcome: "blocked", reason });
}

/**
 * Exercise the mounted management profile for real. Every step reads the current
 * revision it must CAS against from the live surface first, so a passing outcome
 * proves the operation actually round-tripped rather than the runner guessing a
 * revision. A step that cannot run is reported `blocked`; it is never skipped
 * silently and never upgraded.
 */
async function exerciseOperations(origin, client) {
  const results = [];
  const attempt = async (operationId, run) => {
    try {
      await run();
      results.push(outcome(operationId, "passed"));
    } catch (error) {
      const reason = error instanceof Error && /^[a-z_]+:[^\s]{0,120}$/.test(error.message)
        ? error.message
        : "operation_failed";
      results.push(outcome(operationId, "blocked", reason));
    }
  };

  // draft.save / draft.discard: CAS on the live draft revision, which the
  // snapshot exposes under `chat.draft.revision` (there is no top-level draft).
  const currentDraft = async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    const revision = snapshot?.chat?.draft?.revision;
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new Error("selection_generation_unavailable");
    if (!Number.isInteger(revision) || revision < 0) throw new Error("draft_revision_unavailable");
    return { generation, revision };
  };

  await attempt("draft.save", async () => {
    const { generation, revision } = await currentDraft();
    await sendJson(origin, client, "PUT", "/api/tavern/v1/draft", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
      text: "please be brief",
    });
  });

  await attempt("draft.discard", async () => {
    const { generation, revision } = await currentDraft();
    await sendJson(origin, client, "DELETE", "/api/tavern/v1/draft", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
    });
  });

  // chat.rename: the CAS revision is the SELECTED CHAT LIST ENTRY's
  // `managementRevision` (from `/chats`), not anything on the snapshot.
  await attempt("chat.rename", async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    const chatHandle = snapshot?.selection?.chatHandle;
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new Error("selection_generation_unavailable");
    if (typeof chatHandle !== "string" || chatHandle.length === 0) throw new Error("chat_handle_unavailable");
    const list = await readJson(origin, client, "/api/tavern/v1/chats?apiVersion=1");
    const entries = Array.isArray(list?.chats) ? list.chats : Array.isArray(list) ? list : [];
    const entry = entries.find((candidate) => candidate?.handle === chatHandle);
    if (entry === undefined) throw new Error("selected_chat_entry_unavailable");
    if (!Number.isInteger(entry.managementRevision) || entry.managementRevision < 0)
      throw new Error("management_revision_unavailable");
    await sendJson(origin, client, "PUT", "/api/tavern/v1/chat/title", {
      apiVersion: 1,
      selectionGeneration: generation,
      chatHandle,
      expectedManagementRevision: entry.managementRevision,
      title: "Live Run",
    });
  });

  await attempt("memory.mutate", async () => {
    const memory = await readJson(origin, client, "/api/tavern/v1/memory");
    if (typeof memory?.projectionRevision !== "string" || memory.projectionRevision.length === 0)
      throw new Error("projection_revision_unavailable");
    await sendJson(origin, client, "PUT", "/api/tavern/v1/memory", {
      apiVersion: 1,
      expectedProjectionRevision: memory.projectionRevision,
      operation: "create",
      content: "the player keeps a tidy ledger",
    });
  });

  await attempt("world-info.bind", async () => {
    const snapshot = await readJson(origin, client, "/api/tavern/v1/state");
    const generation = snapshot?.selection?.generation;
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new Error("selection_generation_unavailable");
    // The world-info CAS revision comes from its own read route; the snapshot
    // carries `chat.worldInfo` but the binding command CASes a revision string.
    const worldInfo = await readJson(origin, client, "/api/tavern/v1/world-info");
    const revision = worldInfo?.revision ?? worldInfo?.stateRevision;
    if (typeof revision !== "string" || revision.length === 0)
      throw new Error("world_info_revision_unavailable");
    await sendJson(origin, client, "PUT", "/api/tavern/v1/world-info", {
      apiVersion: 1,
      selectionGeneration: generation,
      expectedRevision: revision,
      sourceHandle: null,
    });
  });

  return results;
}

export async function runManagementOperationEvidence({ outcomesPath, reportPath } = {}) {
  if (typeof outcomesPath !== "string" || outcomesPath.length === 0)
    throw new Error("outcomes_path_required");
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-tavern-ui-evidence-"));
  await mkdir(root, { recursive: true });
  const nonceSha256 = createHash("sha256").update(randomBytes(32)).digest("hex");
  const manifestPath = join(root, "tavern-ui-evidence.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot: root,
        principal: { ...IDENTITY },
        bootstrapOperationId: `tavern_ui_evidence_${randomBytes(12).toString("hex")}`,
        authorityGeneration: 1,
      },
      null,
      2,
    ),
    "utf8",
  );

  let stderr = "";
  const launch = await launchDesktopCompositionGateChild({
    outputRoot: OUTPUT_ROOT,
    root,
    surface: "management",
    nonceSha256,
    manifestPath,
    readyTimeoutMs: START_TIMEOUT_MS,
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on?.("data", (chunk) => {
        if (stderr.length < 2_048) stderr = `${stderr}${chunk}`;
      });
      return child;
    },
  });

  let launchUrl;
  try {
    launchUrl = await launch.waitForReady();
  } catch (error) {
    launch.dispose?.();
    const diagnostic = stderr.trim();
    throw new Error(
      diagnostic.length > 0
        ? `${error?.message ?? "management_surface_unready"}:${diagnostic}`
        : (error?.message ?? "management_surface_unready"),
    );
  }

  try {
    const url = new URL(launchUrl);
    const origin = `${url.protocol}//${url.host}`;
    const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
    if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
    const client = await bootstrap(origin, bootstrapToken);
    const operations = await exerciseOperations(origin, client);
    // The WHOLE profile is derived from the composition source, never hand-written.
    // Writing `routeIds` by hand here while deriving `operationIds` from the shared
    // vocabulary produced a profile that declared six `settings.connection.*`
    // operations with no corresponding route, and the release gate correctly rejected
    // it with `mounted_profile_operation_route_membership`. A hand-maintained field is
    // the same failure mode as the transcription files that drifted three times; the
    // whole projection must come from one authority.
    const profile = readMountedTavernManagementProfile();
    const payload = Object.freeze({ profile, operations });
    await writeFile(outcomesPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    if (typeof reportPath === "string" && reportPath.length > 0)
      await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const passed = operations.filter((entry) => entry.outcome === "passed").length;
    process.stdout.write(
      `${JSON.stringify({ state: passed > 0 ? "collected" : "blocked", passed, total: operations.length, operations })}\n`,
    );
    return payload;
  } finally {
    launch.dispose?.();
    launch.child?.kill?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    await runManagementOperationEvidence({
      outcomesPath: parsed.outcomesPath,
      reportPath: parsed.reportPath,
    });
  }
}
