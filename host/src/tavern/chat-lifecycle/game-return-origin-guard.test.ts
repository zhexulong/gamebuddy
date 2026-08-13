import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { continuityLedgerPath } from "../../continuity.js";
import { resolveRuntimePaths } from "../../runtime.js";
import { createGameReturnOriginGuard, type GameReturnOriginThread } from "./game-return-origin-guard.js";

const identity = Object.freeze({ playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" });
const input = Object.freeze({
  chatThreadId: "thread_01",
  chatSurfaceSessionId: "chat_01",
  companionId: "companion_01",
  continuityId: "continuity_01",
});
const thread: GameReturnOriginThread = input;

async function fixture(ledger: unknown, lookup: () => Promise<GameReturnOriginThread | null> = async () => thread) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-return-origin-guard-"));
  const paths = resolveRuntimePaths(identity, root);
  await mkdir(paths.runtimeCwd, { recursive: true });
  await writeFile(continuityLedgerPath(paths), JSON.stringify(ledger), "utf8");
  return createGameReturnOriginGuard({ identity, runtimeRoot: root, lookupThread: async () => lookup() });
}

function ledger(sessions: readonly unknown[]) {
  return { schemaVersion: 3, continuityId: "continuity_01", sessions, events: [] };
}
function chat(sessionId = "chat_01", state = "suspended") {
  return { sessionId, surface: "chat", state, world: null, origin: null };
}
function game(state: "active" | "returning" | "recovery_required" = "active", origin: string | null = "chat_01") {
  return {
    sessionId: "game_01",
    surface: "game",
    state,
    world: { integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    origin: origin === null ? null : { ...input, chatSurfaceSessionId: origin, playerId: "player_01" },
  };
}

test("Game return-origin guard protects exactly the active and returning Game origin", async () => {
  for (const state of ["active", "returning"] as const) {
    const guard = await fixture(ledger([chat(), chat("chat_other"), game(state)]));
    assert.equal(await guard(input), false, state);
    const other = { ...input, chatThreadId: "thread_other", chatSurfaceSessionId: "chat_other" };
    const safeGuard = await fixture(ledger([chat(), chat("chat_other"), game(state)]), async () => other);
    assert.equal(await safeGuard(other), true, state);
  }
});

test("Game return-origin guard fails closed for recovery, malformed, unavailable, scope-mismatched, and unavailable thread state", async () => {
  assert.equal(await (await fixture(ledger([chat(), game("recovery_required", null)])))(input), false);
  assert.equal(
    await (await fixture({ schemaVersion: 2, continuityId: "continuity_01", sessions: [], events: [] }))(input),
    false,
  );
  assert.equal(
    await (await fixture(ledger([chat(), game("active"), game("returning", "chat_other")])))({
      ...input,
      chatSurfaceSessionId: "chat_other",
      chatThreadId: "thread_other",
    }),
    false,
  );
  assert.equal(
    await (await fixture({ schemaVersion: 3, continuityId: "continuity_01", sessions: [{ bad: true }], events: [] }))(
      input,
    ),
    false,
  );

  const missingRoot = await mkdtemp(join(tmpdir(), "gamebuddy-return-origin-missing-"));
  const unavailable = createGameReturnOriginGuard({
    identity,
    runtimeRoot: missingRoot,
    lookupThread: async () => thread,
  });
  assert.equal(await unavailable(input), false);

  const mismatchedLookup = await fixture(ledger([chat()]));
  assert.equal(await mismatchedLookup({ ...input, companionId: "companion_other" }), false);
  const unavailableThread = await fixture(ledger([chat()]), async () => null);
  assert.equal(await unavailableThread(input), false);
});

test("Game return-origin guard validates durable exact thread-to-surface binding before allowing lifecycle mutation", async () => {
  const guard = await fixture(ledger([chat("chat_01", "active")]), async () => ({
    ...thread,
    chatSurfaceSessionId: "chat_forged",
  }));
  assert.equal(await guard(input), false);
  const safe = await fixture(ledger([chat("chat_01", "active")]));
  assert.equal(await safe(input), true);
});
