#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * Controlled live verification for GameBuddy's first ongoing-interaction Memory
 * gate. This is deliberately NOT a Host Memory API: it seeds an ephemeral,
 * GameBuddy-owned Magic Context SQLite fixture through sqlite3, then proves the
 * embedded Host/Pi runtime's native m[0]/m[1] renderer reaches a real provider
 * request and only the explicit companion_text result reaches the chat surface.
 *
 * It does not test historian promotion, auto-search, embedding, Dreamer,
 * Sidekick, cross-surface recall, or production Memory authoring.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSelectedHostProductionModule, selectHostProductionArtifact } from "./lib/host-production-module.mjs";

const selectedProductionArtifact = await selectHostProductionArtifact();
const [{ startDialogueWebServer }, { createProductionGameContinuity }] = await Promise.all([
  loadSelectedHostProductionModule(selectedProductionArtifact, "dialogue-web.js"),
  loadSelectedHostProductionModule(selectedProductionArtifact, "production-game-continuity.js"),
]);

const TIMEOUT_MS = 45_000;
const MEMORY_CONTENT =
  "For consequential decisions, explicitly offer the player the calm option keyword 月桂 before choosing.";
const PROMPT = "请只回答长期互动记忆中、在重要决定前需要提供给我的关键词；若没有相关长期互动记忆，只回答“无记录”。";

function redact(error) {
  return String(error)
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_\-.]+/g, "[redacted]")
    .slice(0, 300);
}

function databasePath(server) {
  return join(server.runtime.paths.runtimeCwd, "data", "cortexkit", "magic-context", "context.db");
}

function seedFixtureThroughMagicContext(dbPath, projectPath) {
  // Test-only fixture. It uses Node's SQLite backend because this DB's guard
  // trigger requires the connection-local mc_privileged_writer() function;
  // Bun 1.3 exposes no scalar-function registration API. This code is never
  // linked into Host production code and is unavailable to model/browser.
  const fixture = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.env.GAMEBUDDY_MEMORY_DB);
    db.function("mc_privileged_writer", () => 1);
    const now = Date.now();
    const content = process.env.GAMEBUDDY_MEMORY_CONTENT;
    const hash = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    db.prepare(\`INSERT INTO memories (
      project_path, category, content, normalized_hash, importance, scope,
      shareable, source_session_id, source_type, seen_count, retrieval_count,
      first_seen_at, created_at, updated_at, last_seen_at, status,
      verification_status
    ) VALUES (?, 'SEMANTIC_MEMORY', ?, ?, 100, 'project', 0, NULL, 'historian', 1, 0, ?, ?, ?, ?, 'active', 'unverified')\`)
      .run(process.env.GAMEBUDDY_MEMORY_PROJECT, content, hash, now, now, now, now);
    db.close();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", fixture], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      GAMEBUDDY_MEMORY_DB: dbPath,
      GAMEBUDDY_MEMORY_PROJECT: projectPath,
      GAMEBUDDY_MEMORY_CONTENT: MEMORY_CONTENT,
    },
  });
  if (result.error) throw new Error(`memory_fixture_spawn_failed:${redact(result.error)}`);
  if (result.status !== 0) {
    throw new Error(`memory_fixture_failed:${redact(`${result.stdout}\n${result.stderr}`)}`);
  }
}

function projectIdentityForRuntime(server) {
  const canonical = resolve(server.runtime.paths.runtimeCwd);
  const md5 = createHash("md5").update(canonical, "utf8").digest("hex").slice(0, 12);
  return `dir:${md5}`;
}

function seedSemanticMemory(server) {
  const dbPath = databasePath(server);
  // Same deterministic directory identity used by Magic Context when this
  // GameBuddy-owned runtime root has no .git metadata. The fixture never asks
  // Host to query or write Memory at product runtime.
  const projectPath = projectIdentityForRuntime(server);
  seedFixtureThroughMagicContext(dbPath, projectPath);
  return projectPath;
}

async function bootstrap(server) {
  const origin = server.url.slice(0, server.url.indexOf("/#"));
  const token = new URL(server.url).hash.slice("#boot=".length);
  const response = await fetch(`${origin}/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error(`bootstrap_http_${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = await response.json();
  if (typeof cookie !== "string" || typeof body.csrf !== "string") throw new Error("bootstrap_shape_invalid");
  return { origin, cookie, csrf: body.csrf };
}

async function sendAndObserve(server, client, messageId) {
  const lifecycle = [];
  const unsubscribe = server.runtime.session.subscribe((event) => {
    if (
      ["agent_start", "agent_end", "agent_settled", "tool_execution_start", "tool_execution_end"].includes(event.type)
    )
      lifecycle.push(event.type);
  });
  const eventsAbort = new AbortController();
  const eventsResponse = await fetch(`${client.origin}/events`, {
    headers: { Cookie: client.cookie },
    signal: eventsAbort.signal,
  });
  if (!eventsResponse.ok || eventsResponse.body === null) throw new Error(`events_http_${eventsResponse.status}`);
  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const timeout = setTimeout(() => {
    // A provider turn can otherwise keep Pi's queue alive after the browser
    // observation deadline. Abort only this ephemeral probe session.
    void server.runtime.session.abort().catch(() => undefined);
    server.runtime.session.clearQueue();
    resolveResult({ type: "timeout" });
  }, TIMEOUT_MS);
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let separator;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const event = /^event: ([^\n]+)\ndata: (.+)$/m.exec(frame);
          if (!event) continue;
          const payload = JSON.parse(event[2]);
          if (payload.type === "presentation_text") {
            resolveResult({ type: "presentation_text", text: payload.text, lifecycle });
            return;
          }
          if (payload.type === "turn_failed") {
            resolveResult({ type: "turn_failed", lifecycle });
            return;
          }
        }
      }
    } catch (error) {
      resolveResult({ type: "events_error", reason: redact(error), lifecycle });
    }
  })();
  const response = await fetch(`${client.origin}/message`, {
    method: "POST",
    headers: {
      Origin: client.origin,
      Cookie: client.cookie,
      "X-GameBuddy-CSRF": client.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ clientMessageId: messageId, text: PROMPT, locale: "zh-CN" }),
  });
  if (response.status !== 202) {
    clearTimeout(timeout);
    eventsAbort.abort();
    unsubscribe();
    await reader.cancel().catch(() => undefined);
    throw new Error(`message_http_${response.status}`);
  }
  const observed = await result;
  clearTimeout(timeout);
  // reader.cancel() alone does not reliably release Node fetch's keep-alive
  // connection. Abort the originating request before closing the local server.
  eventsAbort.abort();
  unsubscribe();
  await reader.cancel().catch(() => undefined);
  // Do not await a possibly stalled fetch stream after cancellation; all
  // observable outcome is already captured in `observed`.
  void pump.catch(() => undefined);
  return { ...observed, lifecycle };
}

async function removeRoot(root) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

const root = await mkdtemp(join(tmpdir(), "gamebuddy-ongoing-memory-live-"));
const controlIdentity = {
  playerId: "memory_probe_player",
  companionId: "memory_probe_companion",
  continuityId: "memory_probe_control",
};
const seededIdentity = {
  playerId: "memory_probe_player",
  companionId: "memory_probe_companion",
  continuityId: "memory_probe_seeded",
};
let seeded;
let control;
try {
  // First establish that this CPA/Grok route completes a normal embedded
  // Chat turn under the exact same tool surface and temporary root.
  control = await startDialogueWebServer({
    identity: controlIdentity,
    runtimeRoot: root,
    continuity: createProductionGameContinuity(controlIdentity, root),
  });
  const controlResult = await sendAndObserve(control, await bootstrap(control), "control_memory_turn");

  // If the baseline cannot settle, a Memory comparison would be meaningless.
  let projectIdentity = null;
  const seededResult =
    controlResult.type !== "presentation_text"
      ? { type: "skipped_after_control_failure", lifecycle: [] }
      : await (async () => {
          seeded = await startDialogueWebServer({
            identity: seededIdentity,
            runtimeRoot: root,
            continuity: createProductionGameContinuity(seededIdentity, root),
          });
          projectIdentity = seedSemanticMemory(seeded);
          return sendAndObserve(seeded, await bootstrap(seeded), "seeded_memory_turn");
        })();

  const passed =
    seededResult.type === "presentation_text" &&
    seededResult.text.includes("月桂") &&
    controlResult.type === "presentation_text" &&
    !controlResult.text.includes("月桂") &&
    seeded !== undefined &&
    seeded.runtime.session.agent.state.tools.every((tool) => !tool.name.startsWith("ctx_")) &&
    control.runtime.session.agent.state.tools.every((tool) => !tool.name.startsWith("ctx_"));
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "failed",
      provider: "cpa-oai",
      model: "deepseek-v4-flash",
      thinkingLevel: "high",
      memoryDomain: "ongoing-interaction",
      memoryMode: "native_read_only_injection",
      seededProjectIdentity: projectIdentity,
      seeded: seededResult,
      control: controlResult,
      ctxToolsExposed: [
        ...(seeded?.runtime.session.agent.state.tools ?? []),
        ...(control?.runtime.session.agent.state.tools ?? []),
      ]
        .filter((tool) => tool.name.startsWith("ctx_"))
        .map((tool) => tool.name),
      note: "Ephemeral fixture only: validates native injected Semantic Memory, not promotion, authoring, auto-search, embedding, Dreamer, Sidekick, or cross-surface recall.",
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: redact(error) }));
  process.exitCode = 2;
} finally {
  // Node's server.close() otherwise waits for a held SSE keep-alive socket or
  // a provider turn. This ephemeral probe never has another client, so abort
  // and force-close are safe. Deliberately do not await a provider that has
  // ignored abort: the probe's observable deadline is authoritative.
  void control?.runtime.session.abort().catch(() => undefined);
  control?.runtime.session.clearQueue();
  void seeded?.runtime.session.abort().catch(() => undefined);
  seeded?.runtime.session.clearQueue();
  control?.closeAllConnections();
  seeded?.closeAllConnections();
  // Do not await Windows cleanup: SQLite/provider handles can hold the
  // ephemeral directory past the observation deadline. Best-effort cleanup
  // continues independently and must never extend this diagnostic process.
  void removeRoot(root).catch(() => undefined);
  // This script is a bounded diagnostic CLI. A stalled provider can retain an
  // undici handle even after Agent abort; do not let that hide the outcome.
  process.exit(process.exitCode ?? 0);
}
