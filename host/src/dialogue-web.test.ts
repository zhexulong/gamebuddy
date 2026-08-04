import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startDialogueWebServer } from "./dialogue-web.js";
import { validateWorldBook, worldBookMetadata } from "./worldbook.js";

const identity = { playerId: "player_dialogue", companionId: "companion_dialogue", continuityId: "continuity_dialogue" } as const;

test("Dialogue web runtime is loopback-only and mounts only explicit chat presentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#boot=[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(server.runtime.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status", "companion_text", "todowrite"]);
    assert.equal(server.runtime.session.agent.state.tools.some((tool) => tool.name.startsWith("stardew_") || tool.name === "delegate_game_task"), false);
  } finally { await server.close(); }
});

test("Dialogue web binds an audited WorldBook without exposing its body through bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const book = validateWorldBook({ schemaVersion: 1, worldBookId: "book_01", revision: 1, alwaysOnPremise: "premise", entries: [{ entryId: "entry_01", title: "Secret title", content: "never in bootstrap", scope: "companion", provenance: "authored", tokenBudget: "small" }] });
  const server = await startDialogueWebServer({ identity, runtimeRoot: root, worldBook: { book, metadata: worldBookMetadata(book) } });
  try {
    assert.deepEqual(server.runtime.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status", "companion_text", "companion_worldbook_catalog", "companion_worldbook_query", "todowrite"]);
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const body = await bootstrap.text();
    assert.match(body, /book_01/); assert.doesNotMatch(body, /Secret title|never in bootstrap/);
  } finally { await server.close(); }
});

test("Dialogue web resumes the same explicit chat surface with only player-visible transcript entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const first = await startDialogueWebServer({ identity, runtimeRoot: root });
  const surfaceSessionId = first.surfaceSession.sessionId;
  try {
    const base = first.url.slice(0, first.url.indexOf("/#"));
    const token = new URL(first.url).hash.slice("#boot=".length);
    const response = await fetch(`${base}/bootstrap`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const { csrf } = await response.json() as { csrf: string };
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    await fetch(`${base}/message`, { method: "POST", headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ clientMessageId: "visible_01", text: "visible player text", locale: "en-US" }) });
  } finally { await first.close(); }
  const resumed = await startDialogueWebServer({ identity, runtimeRoot: root, surfaceSessionId });
  try {
    const base = resumed.url.slice(0, resumed.url.indexOf("/#"));
    const token = new URL(resumed.url).hash.slice("#boot=".length);
    const response = await fetch(`${base}/bootstrap`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const body = await response.text();
    assert.match(body, /visible player text/); assert.doesNotMatch(body, /tool_result|thinking|receipt/);
  } finally { await resumed.close(); }
});

test("Dialogue web bootstrap is one-time and requires its loopback capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(bootstrap.status, 200);
    const replay = await fetch(`${base}/bootstrap`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(replay.status, 401);
    const foreign = await fetch(`${base}/message`, { method: "POST", headers: { Origin: "http://example.test", "Content-Type": "application/json" }, body: JSON.stringify({ clientMessageId: "x", text: "hello", locale: "en-US" }) });
    assert.equal(foreign.status, 401);
  } finally { await server.close(); }
});
