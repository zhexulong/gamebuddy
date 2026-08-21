import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { endContinuitySession, MAX_CONTINUITY_EVENTS, MAX_CONTINUITY_SESSIONS, selectContinuitySession } from "./continuity.js";
import { resolveRuntimePaths } from "./runtime-core.js";

const identity = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" } as const;

test("continuity surface ledger resumes the same chat session after an explicit game handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-continuity-"));
  const paths = resolveRuntimePaths(identity, root);
  const chat = await selectContinuitySession(paths, identity, { surface: "chat" }, () => 10);
  const game = await selectContinuitySession(paths, identity, { surface: "game", world: { integrationId: "stardew", saveId: "save_01", worldId: "world_01" } }, () => 20);
  const resumed = await selectContinuitySession(paths, identity, { surface: "chat", sessionId: chat.session.sessionId }, () => 30);
  assert.equal(resumed.session.sessionId, chat.session.sessionId);
  assert.equal(game.ledger.sessions.find((item) => item.sessionId === chat.session.sessionId)?.state, "suspended");
  assert.equal(resumed.session.state, "active");
  assert.equal(resumed.ledger.sessions.find((item) => item.sessionId === game.session.sessionId)?.state, "suspended");
  assert.deepEqual(resumed.ledger.events.map((event) => event.type), ["session_created", "surface_suspended", "session_created", "surface_suspended", "surface_resumed"]);
});

test("continuity ledger scopes game sessions to their declared world and never silently reuses an ended session", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-continuity-"));
  const paths = resolveRuntimePaths(identity, root);
  const game = await selectContinuitySession(paths, identity, { surface: "game", world: { integrationId: "stardew", saveId: "save_01", worldId: "world_01" } });
  await endContinuitySession(paths, identity, game.session.sessionId);
  const next = await selectContinuitySession(paths, identity, { surface: "game", world: { integrationId: "stardew", saveId: "save_01", worldId: "world_01" } });
  assert.notEqual(next.session.sessionId, game.session.sessionId);
  await assert.rejects(() => selectContinuitySession(paths, identity, { surface: "chat", sessionId: game.session.sessionId }), /surface_session_scope_mismatch/);
});

test("continuity ledger retains resumable sessions and bounds ended-session/event history", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-continuity-"));
  const paths = resolveRuntimePaths(identity, root);
  for (let index = 0; index < MAX_CONTINUITY_SESSIONS + 3; index++) {
    const created = await selectContinuitySession(paths, identity, { surface: "chat", sessionId: `chat_${index}` }, () => index * 2 + 1);
    await endContinuitySession(paths, identity, created.session.sessionId, () => index * 2 + 2);
  }
  const next = await selectContinuitySession(paths, identity, { surface: "chat", sessionId: "chat_active" }, () => 99_999);
  assert.equal(next.ledger.sessions.length, MAX_CONTINUITY_SESSIONS);
  assert.ok(next.ledger.events.length <= MAX_CONTINUITY_EVENTS);
  assert.equal(next.ledger.sessions.find((session) => session.sessionId === "chat_active")?.state, "active");
});

test("continuity ledger serializes concurrent surface selection and preserves the one-active-surface invariant", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-continuity-"));
  const paths = resolveRuntimePaths(identity, root);
  await Promise.all([
    selectContinuitySession(paths, identity, { surface: "chat", sessionId: "chat_01" }, () => 10),
    selectContinuitySession(paths, identity, { surface: "game", sessionId: "game_01", world: { integrationId: "stardew", saveId: "save_01", worldId: "world_01" } }, () => 20),
  ]);
  const resumed = await selectContinuitySession(paths, identity, { surface: "chat", sessionId: "chat_01" }, () => 30);
  assert.equal(resumed.ledger.sessions.length, 2);
  assert.equal(resumed.ledger.sessions.filter((session) => session.state === "active").length, 1);
  assert.equal(resumed.session.sessionId, "chat_01");
});
