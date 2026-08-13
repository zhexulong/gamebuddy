import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern/tavern-paths.js";
import { validateTavernArtifact } from "./tavern/types.js";
import test from "node:test";
import { startDialogueWebServer as startDialogueWebServerProduction } from "./dialogue-web.js";
import { createProductionGameContinuity } from "./production-game-continuity.js";
import { continuityLedgerPath, selectContinuitySession } from "./continuity.js";
import { identityKey, resolveRuntimePaths } from "./runtime.js";
import { createChatThreadStore } from "./tavern/chat-thread-store.js";
import { SELECTED_L3_V1 } from "./tavern/selected-l3.v1.js";
import { SELECTED_SETTINGS_MANAGEMENT_V1 } from "./tavern/selected-settings-management.v1.js";
import { SELECTED_CHAT_MANAGEMENT_V1 } from "./tavern/selected-chat-management.v1.js";
import { SELECTED_PERSONA_MANAGEMENT_V1 } from "./tavern/selected-persona-management.v1.js";
import { SELECTED_CONTENT_MANAGEMENT_V1 } from "./tavern/selected-content-management.v1.js";
import { SELECTED_CHARACTER_DETAIL_V1 } from "./tavern/selected-character-detail.v1.js";
import { validateWorldBook, worldBookMetadata } from "./worldbook.js";
import { createWorldInfoManagementRepository } from "./tavern/world-info-management/world-info-management.js";
import { createManagedWorldInfoBindingResolver } from "./tavern/world-info-binding/managed-world-info-binding.js";
import { SELECTED_WORLD_INFO_MANAGEMENT_V1 } from "./tavern/selected-world-info-management.v1.js";

const identity = {
  playerId: "player_dialogue",
  companionId: "companion_dialogue",
  continuityId: "continuity_dialogue",
} as const;
/** Internal test adapter: every route still receives a real production bundle. */
const startDialogueWebServer = (options: Parameters<typeof startDialogueWebServerProduction>[0]) =>
  startDialogueWebServerProduction({
    ...options,
    continuity: options.continuity ?? createProductionGameContinuity(options.identity, options.runtimeRoot),
  });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

test("POST /message fails closed when its blocked player append loses an exact chat activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-message-switch-race-"));
  const appendBlocked = deferred();
  const appendEntered = deferred();
  const server = await startDialogueWebServer({
    identity,
    runtimeRoot: root,
    internalDialogueWebTestHooks: {
      beforeAppendPlayer: async () => {
        appendEntered.resolve();
        await appendBlocked.promise;
      },
    },
  });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf, session } = (await boot.json()) as { csrf: string; session: { id: string } };
    const headers = {
      Origin: base,
      Cookie: boot.headers.get("set-cookie")!.split(";")[0]!,
      "X-GameBuddy-CSRF": csrf,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(`${base}/new-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ opening: { kind: "blank" } }),
        })
      ).status,
      201,
    );
    const chats = (await (await fetch(`${base}/manage-chats`, { headers: { Cookie: headers.Cookie } })).json()) as {
      activeHandle: string;
      chats: Array<{ handle: string }>;
    };
    const targetHandle = chats.chats.find((chat) => chat.handle !== chats.activeHandle)!.handle;
    const message = fetch(`${base}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        clientMessageId: "blocked_source_message",
        text: "must not move threads",
        locale: "en-US",
      }),
    });
    await appendEntered.promise;
    assert.equal(
      (
        await fetch(`${base}/open-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ chatHandle: targetHandle }),
        })
      ).status,
      200,
    );
    appendBlocked.resolve();
    const rejected = await message;
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { error: "selection_changed" });
    const targetId = (await (await fetch(`${base}/refresh`, { headers: { Cookie: headers.Cookie } })).json()) as {
      session: { id: string };
      transcript: Array<{ text: string }>;
    };
    assert.equal(
      targetId.transcript.some((entry) => entry.text === "must not move threads"),
      false,
    );
    const threadStore = createChatThreadStore(join(root, "contexts", identityKey(identity)), identityKey(identity));
    for (const threadId of [session.id, targetId.session.id]) {
      const state = await threadStore.resumeThread(threadId, threadId);
      assert.equal(
        state.messages.some((entry) => entry.text === "must not move threads"),
        false,
      );
    }
  } finally {
    await server.close();
  }
});

test("chat presentation fails closed without an active Host-owned dialogue turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-unbound-presentation-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const textTool = server.runtime.session.agent.state.tools.find((tool) => tool.name === "companion_text");
    assert.ok(textTool);
    await assert.rejects(
      () => textTool.execute("model-tool-id", { text: "must not commit without a turn" }),
      /presentation_admission_unbound/,
    );
    const thread = await createChatThreadStore(
      join(root, "contexts", identityKey(identity)),
      identityKey(identity),
    ).resumeThread(server.surfaceSession.sessionId, server.surfaceSession.sessionId);
    assert.equal(thread.messages.some((entry) => entry.text === "must not commit without a turn"), false);
  } finally {
    await server.close();
  }
});

test("Dialogue web runtime is loopback-only and mounts only explicit chat presentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#boot=[A-Za-z0-9_-]{43}$/);
    assert.equal(server.runtime.session.agent.state.model?.id, "deepseek-v4-flash");
    assert.equal(server.runtime.session.agent.state.thinkingLevel, "high");
    assert.deepEqual(server.runtime.session.agent.state.tools.map((tool) => tool.name).sort(), [
      "companion_status",
      "companion_text",
      "todowrite",
    ]);
    assert.equal(
      server.runtime.session.agent.state.tools.some(
        (tool) => tool.name.startsWith("stardew_") || tool.name === "delegate_game_task",
      ),
      false,
    );
  } finally {
    await server.close();
  }
});

test("An old runtime companion_text after an exact switch cannot commit or publish into the target chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-stale-presentation-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const headers = {
      Origin: base,
      Cookie: bootstrap.headers.get("set-cookie")!.split(";")[0]!,
      "X-GameBuddy-CSRF": csrf,
      "Content-Type": "application/json",
    };
    const oldText = server.runtime.session.agent.state.tools.find((tool) => tool.name === "companion_text");
    assert.ok(oldText);
    assert.equal(
      (
        await fetch(`${base}/new-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ opening: { kind: "blank" } }),
        })
      ).status,
      201,
    );
    const chats = (await (await fetch(`${base}/manage-chats`, { headers: { Cookie: headers.Cookie } })).json()) as {
      activeHandle: string;
      chats: Array<{ handle: string }>;
    };
    const targetHandle = chats.chats.find((chat) => chat.handle !== chats.activeHandle)!.handle;
    assert.equal(
      (
        await fetch(`${base}/open-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ chatHandle: targetHandle }),
        })
      ).status,
      200,
    );
    const events = await fetch(`${base}/events`, { headers: { Cookie: headers.Cookie } });
    const reader = events.body!.getReader();
    await reader.read(); // the connection's required ready event

    await assert.rejects(
      () => oldText.execute("late-source-tool-call", { text: "Late source-only companion text" }),
      /stale after session replacement|stale/i,
    );
    const target = (await (await fetch(`${base}/refresh`, { headers: { Cookie: headers.Cookie } })).json()) as {
      transcript: Array<{ text: string }>;
    };
    assert.equal(
      target.transcript.some((message) => message.text === "Late source-only companion text"),
      false,
    );
    assert.equal(
      await Promise.race([
        reader
          .read()
          .then(
            ({ value }) =>
              value === undefined || !new TextDecoder().decode(value).includes("Late source-only companion text"),
          ),
        new Promise<true>((resolve) => setTimeout(() => resolve(true), 50)),
      ]),
      true,
    );
    await reader.cancel();
  } finally {
    await server.close();
  }
});

test("An accepted source send cannot clear the target draft after an exact switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-draft-switch-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const headers = {
      Origin: base,
      Cookie: bootstrap.headers.get("set-cookie")!.split(";")[0]!,
      "X-GameBuddy-CSRF": csrf,
      "Content-Type": "application/json",
    };
    const accepted = (await (
      await fetch(`${base}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({ clientMessageId: "accepted_source_send", text: "Source send", locale: "en-US" }),
      })
    ).json()) as { accepted: boolean; clearToken?: string };
    assert.equal(accepted.accepted, true);
    assert.match(accepted.clearToken!, /^[A-Za-z0-9_-]{43}$/);
    // The source turn has been accepted and owns the clear capability; stop
    // only makes the runtime idle enough for the exact chat switch.
    assert.equal(
      (
        await fetch(`${base}/stop`, {
          method: "POST",
          headers,
          body: JSON.stringify({ clientStopId: "source_turn_stop" }),
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await fetch(`${base}/new-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ opening: { kind: "blank" } }),
        })
      ).status,
      201,
    );
    const chats = (await (await fetch(`${base}/manage-chats`, { headers: { Cookie: headers.Cookie } })).json()) as {
      activeHandle: string;
      chats: Array<{ handle: string }>;
    };
    const targetHandle = chats.chats.find((chat) => chat.handle !== chats.activeHandle)!.handle;
    assert.equal(
      (
        await fetch(`${base}/open-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ chatHandle: targetHandle }),
        })
      ).status,
      200,
    );
    const targetDraft = (
      (await (await fetch(`${base}/refresh`, { headers: { Cookie: headers.Cookie } })).json()) as {
        draft: { revision: number; text: string | null };
      }
    ).draft;
    const saved = await fetch(`${base}/chat-draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: targetDraft.revision, text: "Target chat draft" }),
    });
    assert.equal(saved.status, 200);
    const targetSavedDraft = (await saved.json()) as { revision: number; text: string | null };
    assert.equal(targetSavedDraft.text, "Target chat draft");

    // The source-scoped clear remains consumable, but must resolve only its
    // captured source scope rather than the currently selected target scope.
    assert.equal(
      (
        await fetch(`${base}/chat-draft`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ expectedRevision: 0, clearToken: accepted.clearToken }),
        })
      ).status,
      200,
    );
    assert.deepEqual(
      (
        (await (await fetch(`${base}/refresh`, { headers: { Cookie: headers.Cookie } })).json()) as {
          draft: { revision: number; text: string | null };
        }
      ).draft,
      targetSavedDraft,
    );
  } finally {
    await server.close();
  }
});

test("Dialogue web mounts metadata-only chat title management with exact revision readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-title-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    assert.equal((await fetch(`${base}/chat-management`)).status, 401);
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const bootstrap = (await boot.json()) as {
      csrf: string;
      chatManagement: { profile: { id: string; schemaVersion: number }; routes: unknown[] };
    };
    assert.deepEqual(bootstrap.chatManagement.profile, {
      id: SELECTED_CHAT_MANAGEMENT_V1.id,
      schemaVersion: SELECTED_CHAT_MANAGEMENT_V1.schemaVersion,
    });
    assert.deepEqual(bootstrap.chatManagement.routes, SELECTED_CHAT_MANAGEMENT_V1.routes);
    const initial = await fetch(`${base}/chat-management`, { headers: { Cookie: cookie } });
    const metadata = (await initial.json()) as { title: string | null; revision: number };
    assert.deepEqual(Object.keys(metadata).sort(), ["revision", "title"]);
    assert.equal(metadata.title, null);
    const headers = {
      Cookie: cookie,
      Origin: base,
      "X-GameBuddy-CSRF": bootstrap.csrf,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(`${base}/chat-management/title`, {
          method: "PUT",
          headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ title: "A quiet morning", expectedRevision: metadata.revision }),
        })
      ).status,
      401,
    );
    for (const title of ["", "   ", "a".repeat(257), "bad\u0000title"]) {
      assert.equal(
        (
          await fetch(`${base}/chat-management/title`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ title, expectedRevision: metadata.revision }),
          })
        ).status,
        400,
      );
    }
    const renamed = await fetch(`${base}/chat-management/title`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: " A quiet morning ", expectedRevision: metadata.revision }),
    });
    assert.deepEqual(await renamed.json(), { title: "A quiet morning", revision: metadata.revision + 1 });
    const stale = await fetch(`${base}/chat-management/title`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ title: "Other title", expectedRevision: metadata.revision }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "chat_title_conflict" });
    const readback = await fetch(`${base}/chat-management`, { headers: { Cookie: cookie } });
    const stored = await createChatThreadStore(
      join(root, "contexts", identityKey(identity)),
      identityKey(identity),
    ).resumeThread(server.surfaceSession.sessionId, server.surfaceSession.sessionId);
    assert.deepEqual(await readback.json(), { title: stored.thread.title, revision: stored.thread.managementRevision });
  } finally {
    await server.close();
  }
});

test("Dialogue web exposes session-and-CSRF protected, exact-thread drafts without transcript or export leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-draft-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = (await boot.json()) as { csrf: string; draft: { revision: number; text: string | null } };
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Cookie: cookie, Origin: base, "X-GameBuddy-CSRF": body.csrf, "Content-Type": "application/json" };
    assert.deepEqual(body.draft, { revision: 0, text: null });
    assert.equal((await fetch(`${base}/chat-draft`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/chat-draft`, {
          method: "PUT",
          headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: 0, text: "private composer draft" }),
        })
      ).status,
      401,
    );
    const saved = await fetch(`${base}/chat-draft`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ expectedRevision: 0, text: "private composer draft" }),
    });
    assert.deepEqual(await saved.json(), { revision: 1, text: "private composer draft" });
    assert.equal(
      (
        await fetch(`${base}/chat-draft`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ expectedRevision: 0, text: "stale" }),
        })
      ).status,
      409,
    );
    const refreshed = (await (await fetch(`${base}/refresh`, { headers: { Cookie: cookie } })).json()) as {
      draft: { revision: number; text: string | null };
      transcript: unknown[];
    };
    assert.deepEqual(refreshed.draft, { revision: 1, text: "private composer draft" });
    assert.equal(JSON.stringify(refreshed.transcript).includes("private composer draft"), false);
    const exported = await (
      await fetch(`${base}/interchange/chat/export`, { method: "POST", headers, body: "{}" })
    ).text();
    assert.equal(exported.includes("private composer draft"), false);
    const discarded = await fetch(`${base}/chat-draft`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    assert.deepEqual(await discarded.json(), { revision: 2, text: null });
  } finally {
    await server.close();
  }
});

test("Dialogue web settings management is authenticated and read-only with an exact fixed-route manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-settings-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    assert.equal((await fetch(`${base}/settings/profiles`)).status, 401);
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const bootBody = (await boot.json()) as {
      settings: {
        profile: { id: string; schemaVersion: number };
        routes: Array<{ id: string; method: string; path: string; authentication: string }>;
      };
    };
    assert.deepEqual(bootBody.settings.profile, {
      id: SELECTED_SETTINGS_MANAGEMENT_V1.id,
      schemaVersion: SELECTED_SETTINGS_MANAGEMENT_V1.schemaVersion,
    });
    assert.deepEqual(bootBody.settings.routes, SELECTED_SETTINGS_MANAGEMENT_V1.routes);
    const initial = await fetch(`${base}/settings/profiles`, { headers: { Cookie: cookie } });
    assert.deepEqual(await initial.json(), {
      chat: { modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      game: { modelId: "deepseek-v4-flash", thinkingLevel: "high" },
    });
    const attempts = [
      fetch(`${base}/settings/profiles/chat`, {
        method: "PUT",
        headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" }),
      }),
      fetch(`${base}/settings/profiles/chat/activate`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: 0, active: false }),
      }),
    ];
    for (const attempt of attempts) assert.equal((await attempt).status, 404);
  } finally {
    await server.close();
  }
});

test("Dialogue web projects only Host-owned Game lifecycle status and defaults unavailable without a source", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-game-status-"));
  const server = await startDialogueWebServer({
    identity,
    runtimeRoot: root,
    gameStatusProvider: () => ({
      availability: "available",
      surface: "active",
      freshness: "current",
      availableCapabilities: { category: "available", count: 3 },
      activeExecution: "none",
      latestAuthoritativeReceipt: "succeeded",
    }),
  });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    assert.equal((await fetch(`${base}/game/status`)).status, 401);
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const connected = await (await fetch(`${base}/game/status`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(connected, {
      availability: "available",
      category: "ready",
      label: "Ready",
      surfaceStatus: "active",
      freshnessLabel: "Current game state",
      availableCapabilityCount: 3,
      availableCapabilityCategory: "available",
      activeExecutionCategory: "none",
      latestAuthoritativeReceiptOutcome: "succeeded",
    });
    assert.doesNotMatch(
      JSON.stringify(connected),
      /"(?:playerId|companionId|continuityId|worldId|saveId|requestId|executionId|receiptId)"/i,
    );
  } finally {
    await server.close();
  }

  const unavailable = await startDialogueWebServer({
    identity,
    runtimeRoot: await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-game-status-unavailable-")),
  });
  try {
    const base = unavailable.url.slice(0, unavailable.url.indexOf("/#"));
    const token = new URL(unavailable.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const status = await (
      await fetch(`${base}/game/status`, { headers: { Cookie: boot.headers.get("set-cookie")!.split(";")[0]! } })
    ).json();
    assert.deepEqual(status, {
      availability: "unavailable",
      category: "unavailable",
      label: "Game unavailable",
      surfaceStatus: "unavailable",
      freshnessLabel: "Game state unavailable",
      availableCapabilityCount: 0,
      availableCapabilityCategory: "none",
      activeExecutionCategory: "none",
      latestAuthoritativeReceiptOutcome: "none",
    });
  } finally {
    await unavailable.close();
  }
});

test("Dialogue web provides the exact safe Persona projection without artifact leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-persona-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    assert.equal((await fetch(`${base}/persona-management`)).status, 401);
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const bootstrap = (await boot.json()) as {
      csrf: string;
      personaManagement: { profile: { id: string; schemaVersion: number }; routes: unknown[] };
    };
    assert.deepEqual(bootstrap.personaManagement.profile, {
      id: SELECTED_PERSONA_MANAGEMENT_V1.id,
      schemaVersion: SELECTED_PERSONA_MANAGEMENT_V1.schemaVersion,
    });
    assert.deepEqual(bootstrap.personaManagement.routes, SELECTED_PERSONA_MANAGEMENT_V1.routes);
    assert.deepEqual(await (await fetch(`${base}/persona-management`, { headers: { Cookie: cookie } })).json(), {
      persona: null,
    });
    const headers = {
      Cookie: cookie,
      Origin: base,
      "X-GameBuddy-CSRF": bootstrap.csrf,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(`${base}/persona-management`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Player" }),
        })
      ).status,
      401,
    );
    const created = await fetch(`${base}/persona-management`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Player", description: "A careful farmer" }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      persona: { revision: 1, name: "Player", description: "A careful farmer" },
    });
    const readback = (await (await fetch(`${base}/persona-management`, { headers: { Cookie: cookie } })).json()) as {
      persona: unknown;
    };
    assert.deepEqual(readback, { persona: { revision: 1, name: "Player", description: "A careful farmer" } });
    assert.doesNotMatch(JSON.stringify(readback), /personaId|artifact|hash|path/i);
    assert.equal(
      (await fetch(`${base}/persona-management`, { method: "POST", headers, body: JSON.stringify({ name: "Other" }) }))
        .status,
      409,
    );
    for (const path of [
      "/persona-management/editor",
      "/persona-management/scenario",
      "/persona-management/greeting",
      "/persona-management/worldbook",
    ])
      assert.equal((await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).status, 404);
  } finally {
    await server.close();
  }
});

test("Dialogue web mounts only the versioned safe Scenario and Greeting management projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-content-management-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    assert.equal((await fetch(`${base}/scenario-management`)).status, 401);
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const bootstrap = (await boot.json()) as {
      csrf: string;
      contentManagement: { profile: { id: string; schemaVersion: number }; routes: unknown[] };
    };
    assert.deepEqual(bootstrap.contentManagement.profile, {
      id: SELECTED_CONTENT_MANAGEMENT_V1.id,
      schemaVersion: SELECTED_CONTENT_MANAGEMENT_V1.schemaVersion,
    });
    assert.deepEqual(bootstrap.contentManagement.routes, SELECTED_CONTENT_MANAGEMENT_V1.routes);
    const headers = {
      Cookie: cookie,
      Origin: base,
      "X-GameBuddy-CSRF": bootstrap.csrf,
      "Content-Type": "application/json",
    };
    assert.deepEqual(await (await fetch(`${base}/scenario-management`, { headers: { Cookie: cookie } })).json(), {
      scenario: null,
    });
    assert.equal(
      (
        await fetch(`${base}/scenario-management`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Rain", description: "Soft rain." }),
        })
      ).status,
      401,
    );
    const scenario = await fetch(`${base}/scenario-management`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Rain", description: "Soft rain." }),
    });
    assert.equal(scenario.status, 201);
    assert.deepEqual(await scenario.json(), {
      scenario: { revision: 1, name: "Rain", description: "Soft rain.", preview: "Soft rain." },
    });
    assert.deepEqual(await (await fetch(`${base}/scenario-management`, { headers: { Cookie: cookie } })).json(), {
      scenario: { revision: 1, name: "Rain", description: "Soft rain.", preview: "Soft rain." },
    });
    const greeting = await fetch(`${base}/greeting-management`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Welcome", variants: [{ label: "First", text: "Hello, farmer." }] }),
    });
    assert.equal(greeting.status, 201);
    assert.deepEqual(await greeting.json(), {
      greetingSet: { revision: 1, label: "Welcome", variants: [{ label: "First", text: "Hello, farmer." }] },
    });
    const readback = await (await fetch(`${base}/greeting-management`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(readback, {
      greetingSet: { revision: 1, label: "Welcome", variants: [{ label: "First", text: "Hello, farmer." }] },
    });
    assert.doesNotMatch(
      JSON.stringify({
        scenario: await (await fetch(`${base}/scenario-management`, { headers: { Cookie: cookie } })).json(),
        readback,
      }),
      /scenarioId|greetingSetId|variantId|artifact|hash|path|provenance|owner/i,
    );
    for (const path of [
      "/scenario-management/editor",
      "/scenario-management/1",
      "/greeting-management/editor",
      "/greeting-management/1",
      "/connection",
    ])
      assert.equal((await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).status, 404);
  } finally {
    await server.close();
  }
});

test("Dialogue web binds an audited WorldBook without exposing its body through bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const book = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "book_01",
    revision: 1,
    alwaysOnPremise: "premise",
    entries: [
      {
        entryId: "entry_01",
        title: "Secret title",
        content: "never in bootstrap",
        scope: "companion",
        provenance: "authored",
        tokenBudget: "small",
      },
    ],
  });
  const server = await startDialogueWebServer({
    identity,
    runtimeRoot: root,
    worldBook: { book, metadata: worldBookMetadata(book) },
  });
  try {
    assert.deepEqual(server.runtime.session.agent.state.tools.map((tool) => tool.name).sort(), [
      "companion_status",
      "companion_text",
      "companion_worldbook_catalog",
      "companion_worldbook_query",
      "todowrite",
    ]);
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = await bootstrap.text();
    assert.match(body, /book_01/);
    assert.doesNotMatch(body, /Secret title|never in bootstrap/);
    const thread = await createChatThreadStore(
      join(root, "contexts", identityKey(identity)),
      identityKey(identity),
    ).resumeThread(server.surfaceSession.sessionId, server.surfaceSession.sessionId);
    assert.deepEqual(thread.thread.stableArtifactBindings, []);
    assert.deepEqual(thread.thread.worldBookBinding, { ...worldBookMetadata(book), provenance: "authored" });
    const { csrf } = JSON.parse(body) as { csrf: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const metadata = await fetch(`${base}/worldbook`, { headers: { Cookie: cookie } });
    const view = (await metadata.json()) as {
      bindings: Array<{ bindingId: string; label: string; selected: boolean }>;
      activeChat: { chatThreadId: string; chatSurfaceSessionId: string; updatedAtMs: number };
    };
    assert.deepEqual(view.bindings, [{ bindingId: "active", label: "World Info", selected: true }]);
    assert.doesNotMatch(
      JSON.stringify(view),
      /Secret title|never in bootstrap|book_01|canonicalHash|revision|provenance/,
    );
    const deselect = await fetch(`${base}/worldbook`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({
        chatThreadId: view.activeChat.chatThreadId,
        chatSurfaceSessionId: view.activeChat.chatSurfaceSessionId,
        expectedUpdatedAtMs: view.activeChat.updatedAtMs,
        bindingId: null,
      }),
    });
    assert.equal(deselect.status, 200);
    const after = await createChatThreadStore(
      join(root, "contexts", identityKey(identity)),
      identityKey(identity),
    ).resumeThread(server.surfaceSession.sessionId, server.surfaceSession.sessionId);
    assert.equal(after.thread.worldBookBinding, undefined);
    const stale = await fetch(`${base}/worldbook`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({
        chatThreadId: view.activeChat.chatThreadId,
        chatSurfaceSessionId: view.activeChat.chatSurfaceSessionId,
        expectedUpdatedAtMs: view.activeChat.updatedAtMs,
        bindingId: "active",
      }),
    });
    assert.equal(stale.status, 409);
  } finally {
    await server.close();
  }
});

test("Dialogue web saves and reads back a full public managed World Info document through its declared routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-managed-world-info-save-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const boot = (await bootstrap.json()) as {
      csrf: string;
      worldInfoManagement: { profile: { id: string; schemaVersion: number }; routes: unknown[] };
    };
    assert.deepEqual(boot.worldInfoManagement.profile, {
      id: SELECTED_WORLD_INFO_MANAGEMENT_V1.id,
      schemaVersion: SELECTED_WORLD_INFO_MANAGEMENT_V1.schemaVersion,
    });
    assert.deepEqual(boot.worldInfoManagement.routes, SELECTED_WORLD_INFO_MANAGEMENT_V1.routes);
    const headers = { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": boot.csrf, "Content-Type": "application/json" };
    const created = await fetch(`${base}/managed-world-info`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        publicTitle: "Pelican Town",
        summary: "A valley town.",
        entries: [{ scope: "setting", publicTitle: "Square", summary: "Town square." }],
      }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      item: {
        revision: 1,
        publicTitle: "Pelican Town",
        summary: "A valley town.",
        entries: [{ scope: "setting", publicTitle: "Square", summary: "Town square." }],
      },
    });
    const updated = await fetch(`${base}/managed-world-info/Pelican%20Town`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        expectedRevision: 1,
        publicTitle: "Pelican Town",
        summary: "A revised valley town.",
        entries: [{ scope: "companion", publicTitle: "Mira", summary: "Lives here." }],
      }),
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), {
      item: {
        revision: 2,
        publicTitle: "Pelican Town",
        summary: "A revised valley town.",
        entries: [{ scope: "companion", publicTitle: "Mira", summary: "Lives here." }],
      },
    });
    const readback = await (await fetch(`${base}/managed-world-info`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(readback, {
      items: [
        {
          revision: 2,
          publicTitle: "Pelican Town",
          summary: "A revised valley town.",
          entries: [{ scope: "companion", publicTitle: "Mira", summary: "Lives here." }],
        },
      ],
    });
    assert.doesNotMatch(JSON.stringify(readback), /(?:hash|handle|artifact|premise|worldId|integrationId|editToken)/i);
  } finally {
    await server.close();
  }
});

test("Dialogue web attaches managed World Info exactly without browser metadata leakage", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-managed-world-info-"));
  const repository = createWorldInfoManagementRepository(root);
  await repository.create({
    publicTitle: "Pelican Town",
    summary: "Private background.",
    entries: [{ scope: "setting", publicTitle: "Square", summary: "Private square." }],
  });
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const view = (await (
      await fetch(`${base}/managed-world-info/bindings`, { headers: { Cookie: cookie } })
    ).json()) as {
      items: Array<{ publicTitle: string }>;
      activeChat: { chatThreadId: string; chatSurfaceSessionId: string; updatedAtMs: number };
    };
    assert.deepEqual(
      view.items.map((item) => item.publicTitle),
      ["Pelican Town"],
    );
    const bound = await fetch(`${base}/managed-world-info/attach`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({
        chatThreadId: view.activeChat.chatThreadId,
        chatSurfaceSessionId: view.activeChat.chatSurfaceSessionId,
        expectedUpdatedAtMs: view.activeChat.updatedAtMs,
        publicTitle: "Pelican Town",
      }),
    });
    assert.equal(bound.status, 200);
    assert.doesNotMatch(await bound.text(), /revision|hash|private/i);
    const stored = await createChatThreadStore(
      join(root, "contexts", identityKey(identity)),
      identityKey(identity),
    ).resumeThread(view.activeChat.chatThreadId, view.activeChat.chatSurfaceSessionId);
    assert.equal(
      stored.thread.worldBookBinding !== undefined &&
        "source" in stored.thread.worldBookBinding &&
        stored.thread.worldBookBinding.source,
      "managed_world_info",
    );
    await repository.update("Pelican Town", {
      expectedRevision: 1,
      publicTitle: "Pelican Town",
      summary: "New latest.",
      entries: [],
    });
    const resolver = createManagedWorldInfoBindingResolver(repository);
    if (stored.thread.worldBookBinding === undefined || !("source" in stored.thread.worldBookBinding))
      throw new Error("missing_managed_binding");
    assert.match((await resolver.resolve(stored.thread.worldBookBinding)).content, /Private background/);
  } finally {
    await server.close();
  }
});

test("Dialogue web exact activation and reopen preserve a Host-matching WorldBook-bound thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const book = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "book_activation",
    revision: 2,
    alwaysOnPremise: "activation premise",
    entries: [
      {
        entryId: "entry",
        title: "Private",
        content: "bound content",
        scope: "companion",
        provenance: "authored",
        tokenBudget: "small",
      },
    ],
  });
  const metadata = worldBookMetadata(book);
  const first = await startDialogueWebServer({ identity, runtimeRoot: root, worldBook: { book, metadata } });
  const base = first.url.slice(0, first.url.indexOf("/#"));
  const token = new URL(first.url).hash.slice("#boot=".length);
  const bootstrap = await fetch(`${base}/bootstrap`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const { csrf } = (await bootstrap.json()) as { csrf: string };
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" };
  try {
    const created = await fetch(`${base}/new-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ opening: { kind: "blank" } }),
    });
    assert.equal(created.status, 201);
    const chat = ((await created.json()) as { chat: { handle: string } }).chat;
    const opened = await fetch(`${base}/open-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ chatHandle: chat.handle }),
    });
    assert.equal(opened.status, 200, await opened.text());
    const worldbook = await fetch(`${base}/worldbook`, { headers: { Cookie: cookie } });
    const view = (await worldbook.json()) as {
      activeChat: { chatThreadId: string; chatSurfaceSessionId: string; updatedAtMs: number };
      bindings: Array<{ bindingId: string }>;
    };
    const activeThreadId = view.activeChat.chatThreadId;
    const bound = await fetch(`${base}/worldbook`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chatThreadId: activeThreadId,
        chatSurfaceSessionId: activeThreadId,
        expectedUpdatedAtMs: view.activeChat.updatedAtMs,
        bindingId: "active",
      }),
    });
    assert.equal(bound.status, 200);
    const stored = await createChatThreadStore(
      join(root, "contexts", identityKey(identity)),
      identityKey(identity),
    ).resumeThread(activeThreadId, activeThreadId);
    assert.deepEqual(stored.thread.worldBookBinding, { ...metadata, provenance: "authored" });
  } finally {
    await first.close();
    first.closeAllConnections();
  }
  const reopened = await startDialogueWebServer({
    identity,
    runtimeRoot: root,
    surfaceSessionId: (await (async () => {
      const threads = createChatThreadStore(join(root, "contexts", identityKey(identity)), identityKey(identity));
      const selection = await threads.readActiveThreadSelection();
      if (selection === null) throw new Error("missing_active_thread");
      return selection.chatSurfaceSessionId;
    })())!,
    worldBook: { book, metadata },
  });
  try {
    assert.equal(reopened.runtime.session.agent.state.model?.id, "deepseek-v4-flash");
    assert.equal(reopened.runtime.session.agent.state.thinkingLevel, "high");
    const stored = await createChatThreadStore(
      join(root, "contexts", identityKey(identity)),
      identityKey(identity),
    ).resumeThread(reopened.surfaceSession.sessionId, reopened.surfaceSession.sessionId);
    assert.deepEqual(stored.thread.worldBookBinding, { ...metadata, provenance: "authored" });
  } finally {
    await reopened.close();
  }
});

test("Dialogue web exports and accepts only the CSRF-protected inert Tavern interchange subset", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const book = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "book_interchange",
    revision: 1,
    alwaysOnPremise: "private prompt",
    entries: [
      {
        entryId: "public",
        title: "Public",
        content: "safe lore",
        scope: "setting",
        provenance: "authored",
        tokenBudget: "small",
      },
      {
        entryId: "private",
        title: "Private",
        content: "save fact",
        scope: "world",
        provenance: "authored",
        tokenBudget: "small",
        integrationId: "game",
        saveId: "save",
        worldId: "world",
      },
    ],
  });
  const server = await startDialogueWebServer({
    identity,
    runtimeRoot: root,
    worldBook: { book, metadata: worldBookMetadata(book) },
  });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal(
      (
        await fetch(`${base}/interchange/worldbook/export`, {
          method: "POST",
          headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/interchange/chat/export`, {
          method: "POST",
          headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/interchange/import`, {
          method: "POST",
          headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ document: "{}" }),
        })
      ).status,
      401,
    );
    const chatExport = await fetch(`${base}/interchange/chat/export`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(chatExport.status, 200);
    const chatDocument = (
      (await chatExport.json()) as {
        document: { format: string; kind: string; canonicalHash: string; messages: unknown[] };
      }
    ).document;
    assert.deepEqual(
      {
        format: chatDocument.format,
        kind: chatDocument.kind,
        messageCount: chatDocument.messages.length,
        hashLength: chatDocument.canonicalHash.length,
      },
      { format: "tavern-interchange/v1", kind: "chat", messageCount: 0, hashLength: 64 },
    );
    const exported = await fetch(`${base}/interchange/worldbook/export`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(exported.status, 200);
    const document = ((await exported.json()) as { document: { entries: unknown[] } }).document;
    assert.deepEqual(document.entries, [
      { entryId: "public", title: "Public", content: "safe lore", scope: "setting", tokenBudget: "small" },
    ]);
    assert.doesNotMatch(JSON.stringify(document), /private prompt|save fact/);
    const imported = await fetch(`${base}/interchange/import`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ document: JSON.stringify(document) }),
    });
    assert.equal(imported.status, 201);
    assert.equal(((await imported.json()) as { imported: string }).imported, "inert_unbound");
  } finally {
    await server.close();
  }
});

test("Dialogue web resumes the same explicit chat surface with only player-visible transcript entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const first = await startDialogueWebServer({ identity, runtimeRoot: root });
  const surfaceSessionId = first.surfaceSession.sessionId;
  try {
    const base = first.url.slice(0, first.url.indexOf("/#"));
    const token = new URL(first.url).hash.slice("#boot=".length);
    const response = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf } = (await response.json()) as { csrf: string };
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const message = await fetch(`${base}/message`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ clientMessageId: "visible_01", text: "visible player text", locale: "en-US" }),
    });
    assert.equal(message.status, 202);
    const messagesPath = join(
      root,
      "contexts",
      identityKey(identity),
      "tavern",
      "v1",
      "continuities",
      identityKey(identity),
      "threads",
      surfaceSessionId,
      "messages.json",
    );
    assert.match(await readFile(messagesPath, "utf8"), /visible player text/);
  } finally {
    await first.close();
  }
  const resumed = await startDialogueWebServer({ identity, runtimeRoot: root, surfaceSessionId });
  try {
    const base = resumed.url.slice(0, resumed.url.indexOf("/#"));
    const token = new URL(resumed.url).hash.slice("#boot=".length);
    const response = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = await response.text();
    assert.match(body, /visible player text/);
    assert.doesNotMatch(body, /tool_result|thinking|receipt/);
  } finally {
    await resumed.close();
  }
});

test("Dialogue web exposes selected Tavern library routes only to its authenticated exact session", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    assert.equal((await fetch(`${base}/library`)).status, 401);
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf, session, tavern, companion } = (await bootstrap.json()) as {
      csrf: string;
      session: { id: string };
      tavern: { profile: { id: string; schemaVersion: number }; navigation: Array<{ routeId: string }> };
      companion: { name: string };
    };
    // The default comes from the approved player-readable identity profile.
    assert.deepEqual(companion, { name: "GameBuddy Companion" });
    assert.deepEqual(tavern.profile, { id: SELECTED_L3_V1.id, schemaVersion: SELECTED_L3_V1.schemaVersion });
    assert.deepEqual(
      tavern.navigation.map((item) => item.routeId),
      SELECTED_L3_V1.navigation.map((item) => item.routeId),
    );
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" };
    const activeBeforeCreation = await fetch(`${base}/new-companion`, { headers: { Cookie: cookie } });
    assert.equal(activeBeforeCreation.status, 200);
    const active = (await activeBeforeCreation.json()) as {
      activeCompanionId: string;
      activeProfileId: string;
      activeProfileRevision: number;
    };
    assert.equal(active.activeCompanionId, identity.companionId);
    const created = await fetch(`${base}/new-companion`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Tavern Buddy" }),
    });
    assert.equal(created.status, 201);
    const library = await fetch(`${base}/library`, { headers: { Cookie: cookie } });
    assert.equal(library.status, 200);
    const listedCompanions = (await library.json()) as {
      companions: Array<{ handle: string; rowRef: string; name: string }>;
    };
    assert.ok(
      listedCompanions.companions.every(
        (companion) => /^[A-Za-z0-9_-]{43}$/.test(companion.handle) && /^[A-Za-z0-9_-]{43}$/.test(companion.rowRef),
      ),
    );
    assert.ok(listedCompanions.companions.some((companion) => companion.name === "Tavern Buddy"));
    assert.doesNotMatch(
      JSON.stringify(listedCompanions),
      /companionId|continuityId|profileId|profileRevision|hash|path/i,
    );
    const target = listedCompanions.companions.find((companion) => companion.name === "Tavern Buddy")!;
    assert.equal((await fetch(`${base}/library/${target.handle}`)).status, 401);
    const detail = await fetch(`${base}/library/${target.handle}`, { headers: { Cookie: cookie } });
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), { name: "Tavern Buddy" });
    assert.equal((await fetch(`${base}/library/${target.handle}`, { headers: { Cookie: cookie } })).status, 400);
    // A consumed detail handle cannot be retried. The browser must obtain a
    // fresh library projection and capability before making another attempt.
    const refreshedLibrary = (await (await fetch(`${base}/library`, { headers: { Cookie: cookie } })).json()) as {
      companions: Array<{ handle: string; rowRef: string; name: string }>;
    };
    const refreshedTarget = refreshedLibrary.companions.find((companion) => companion.rowRef === target.rowRef)!;
    assert.notEqual(refreshedTarget.handle, target.handle);
    assert.deepEqual(
      await (await fetch(`${base}/library/${refreshedTarget.handle}`, { headers: { Cookie: cookie } })).json(),
      { name: "Tavern Buddy" },
    );
    // Same display names remain distinct UI rows. A fresh projection preserves
    // only the opaque row reference, never a raw domain identifier.
    assert.equal(
      (
        await fetch(`${base}/new-companion`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Duplicate Mira" }),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await fetch(`${base}/new-companion`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Duplicate Mira" }),
        })
      ).status,
      201,
    );
    const duplicateRows = (
      (await (await fetch(`${base}/library`, { headers: { Cookie: cookie } })).json()) as {
        companions: Array<{ handle: string; rowRef: string; name: string }>;
      }
    ).companions.filter((item) => item.name === "Duplicate Mira");
    assert.equal(duplicateRows.length, 2);
    assert.notEqual(duplicateRows[0]!.rowRef, duplicateRows[1]!.rowRef);
    const originalRow = duplicateRows[0]!;
    assert.deepEqual(
      await (await fetch(`${base}/library/${originalRow.handle}`, { headers: { Cookie: cookie } })).json(),
      { name: "Duplicate Mira" },
    );
    const duplicateRowsAfterRefresh = (
      (await (await fetch(`${base}/library`, { headers: { Cookie: cookie } })).json()) as {
        companions: Array<{ handle: string; rowRef: string; name: string }>;
      }
    ).companions.filter((item) => item.name === "Duplicate Mira");
    const originalRowAfterRefresh = duplicateRowsAfterRefresh.find((item) => item.rowRef === originalRow.rowRef);
    assert.ok(originalRowAfterRefresh);
    assert.notEqual(originalRowAfterRefresh.handle, originalRow.handle);
    assert.deepEqual(
      await (await fetch(`${base}/library/${originalRowAfterRefresh.handle}`, { headers: { Cookie: cookie } })).json(),
      { name: "Duplicate Mira" },
    );
    assert.equal((await fetch(`${base}/library/not-a-companion-id`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${base}/library/${"x".repeat(43)}`, { headers: { Cookie: cookie } })).status, 400);
    assert.deepEqual(SELECTED_CHARACTER_DETAIL_V1.routes, [
      { id: "character-detail-read", method: "GET", path: "/library/:handle", authentication: "session" },
    ]);
    // Library detail is read-only; it cannot alter the active runtime session.
    assert.equal(
      (
        await fetch(`${base}/refresh`, { headers: { Cookie: cookie } }).then(
          (response) => response.json() as Promise<{ session: { id: string } }>,
        )
      ).session.id,
      session.id,
    );
    const refresh = await fetch(`${base}/refresh`, { headers: { Cookie: cookie } });
    const refreshed = (await refresh.json()) as { session: { id: string } };
    assert.equal(refreshed.session.id, session.id);
    const catalog = await fetch(`${base}/new-chat/selections`, { headers: { Cookie: cookie } });
    assert.deepEqual(await catalog.json(), { personas: [], scenarios: [], greetings: [] });
    const worldbook = await fetch(`${base}/worldbook`, { headers: { Cookie: cookie } });
    assert.equal(worldbook.status, 200);
    assert.deepEqual(await worldbook.json(), {
      bindings: [],
      activeChat: {
        chatThreadId: session.id,
        chatSurfaceSessionId: session.id,
        updatedAtMs: (
          await createChatThreadStore(
            join(root, "contexts", identityKey(identity)),
            identityKey(identity),
          ).resumeThread(session.id, session.id)
        ).thread.updatedAtMs,
      },
    });
    const newChat = await fetch(`${base}/new-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ opening: { kind: "blank" } }),
    });
    assert.equal(newChat.status, 201);
    const newChatHandle = ((await newChat.json()) as { chat: { handle: string } }).chat.handle;
    // New Chat owns a distinct exact surface/Pi partition and activates in
    // this Host process without copying the old Pi transcript.
    const opened = await fetch(`${base}/open-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ chatHandle: newChatHandle }),
    });
    assert.equal(opened.status, 200);
    const activeRefresh = await fetch(`${base}/refresh`, { headers: { Cookie: cookie } });
    const activeBootstrap = (await activeRefresh.json()) as { session: { id: string }; transcript: unknown[] };
    const newThread = activeBootstrap.session.id;
    assert.deepEqual(activeBootstrap.transcript, []);
    assert.notEqual(server.runtime.session.sessionFile, undefined);
    const managed = await fetch(`${base}/manage-chats`, { headers: { Cookie: cookie } });
    const listed = (await managed.json()) as {
      activeHandle: string;
      chats: Array<{ handle: string; openingSelection: { kind: string } }>;
    };
    assert.equal(listed.chats.length, 2);
    assert.ok(listed.chats.every((chat) => /^[A-Za-z0-9_-]{43}$/.test(chat.handle)));
    assert.ok(listed.chats.some((chat) => chat.handle === listed.activeHandle));
    assert.doesNotMatch(
      JSON.stringify(listed),
      /chatThreadId|chatSurfaceSessionId|companionId|continuityId|personaId|scenarioId|revision|createdAtMs|updatedAtMs|provenance|owner|hash|path/i,
    );
    assert.equal(
      (
        await fetch(`${base}/open-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ chatThreadId: newThread, chatSurfaceSessionId: newThread }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/open-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ chatHandle: newChatHandle }),
        })
      ).status,
      400,
    );
    assert.equal((await fetch(`${base}/enter-game`, { headers: { Cookie: cookie } })).status, 404);
    for (const path of [
      "/response-regenerate",
      "/swipe",
      "/edit-message",
      "/branch",
      "/checkpoint",
      "/worldbook/editor",
      "/background",
      "/visual-novel",
      "/group-chat",
      "/extensions",
      "/scripts",
      "/macros",
      "/regex",
      "/html-runtime",
    ]) {
      assert.equal((await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).status, 404, path);
    }
  } finally {
    await server.close();
  }
});

test("New Chat selection catalog uses latest canonical revisions, opaque handles, and exact greeting hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const headers = {
      Origin: base,
      Cookie: bootstrap.headers.get("set-cookie")!.split(";")[0]!,
      "X-GameBuddy-CSRF": csrf,
      "Content-Type": "application/json",
    };
    await fetch(`${base}/persona-management`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Player", description: "First" }),
    });
    await fetch(`${base}/scenario-management`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Scenario", description: "First scenario" }),
    });
    await fetch(`${base}/greeting-management`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Greetings", variants: [{ label: "First", text: "First greeting" }] }),
    });
    const tavernPaths = resolveTavernPaths({ root } as never, identity);
    const artifacts = new TavernArtifactStore(root);
    const personaId = (await readdir(join(tavernPaths.playerRoot, "personas")))[0]!;
    const scenarioId = (await readdir(join(tavernPaths.companionRoot, "scenarios")))[0]!;
    const greetingId = (await readdir(join(tavernPaths.companionRoot, "greetings")))[0]!;
    await artifacts.write(
      tavernRevisionPath(join(tavernPaths.playerRoot, "personas", personaId), 2),
      { schemaVersion: 1, revision: 2, personaId, name: "Player v2", description: "Second" },
      validateTavernArtifact,
    );
    await artifacts.write(
      tavernRevisionPath(join(tavernPaths.companionRoot, "scenarios", scenarioId), 2),
      {
        schemaVersion: 1,
        revision: 2,
        scenarioId,
        name: "Scenario v2",
        description: "Second scenario",
        text: "Second scenario",
        provenance: "authored",
        owner: "chat_override",
      },
      validateTavernArtifact,
    );
    const greetingV2 = await artifacts.write(
      tavernRevisionPath(join(tavernPaths.companionRoot, "greetings", greetingId), 2),
      {
        schemaVersion: 1,
        revision: 2,
        greetingSetId: greetingId,
        label: "Greetings v2",
        variants: [{ variantId: "greeting-1", label: "Second", text: "Second greeting" }],
      },
      validateTavernArtifact,
    );
    const catalog = (await (
      await fetch(`${base}/new-chat/selections`, { headers: { Cookie: headers.Cookie } })
    ).json()) as {
      personas: Array<{ handle: string; name: string }>;
      scenarios: Array<{ handle: string; preview: string }>;
      greetings: Array<{ handle: string; variants: Array<{ handle: string; preview: string }> }>;
    };
    assert.deepEqual(
      catalog.personas.map((item) => item.name),
      ["Player v2"],
    );
    assert.deepEqual(
      catalog.scenarios.map((item) => item.preview),
      ["Second scenario"],
    );
    assert.deepEqual(
      catalog.greetings[0]!.variants.map((item) => item.preview),
      ["Second greeting"],
    );
    assert.doesNotMatch(
      JSON.stringify(catalog),
      /personaId|scenarioId|greetingSetId|variantId|revision|canonicalHash|provenance|owner|path/i,
    );
    // Only opaque catalog capabilities are accepted; an altered handle and
    // canonical artifact-shaped browser input both fail closed.
    assert.equal(
      (
        await fetch(`${base}/new-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ personaHandle: `${catalog.personas[0]!.handle}x`, opening: { kind: "blank" } }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/new-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ personaId, opening: { kind: "blank" } }),
        })
      ).status,
      400,
    );
    const created = await fetch(`${base}/new-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        personaHandle: catalog.personas[0]!.handle,
        scenarioHandle: catalog.scenarios[0]!.handle,
        opening: { kind: "greeting", greetingHandle: catalog.greetings[0]!.variants[0]!.handle },
      }),
    });
    assert.equal(created.status, 201);
    const chatHandle = ((await created.json()) as { chat: { handle: string } }).chat.handle;
    assert.match(chatHandle, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      (await fetch(`${base}/open-chat`, { method: "POST", headers, body: JSON.stringify({ chatHandle }) })).status,
      200,
    );
    const threadId = (
      (await (await fetch(`${base}/refresh`, { headers: { Cookie: headers.Cookie } })).json()) as {
        session: { id: string };
      }
    ).session.id;
    const state = await createChatThreadStore(
      join(root, "contexts", identityKey(identity)),
      identityKey(identity),
    ).resumeThread(threadId, threadId);
    assert.equal(state.thread.stableArtifactBindings!.find((item) => item.kind === "persona")!.revision, 2);
    assert.equal(state.messages[0]!.greetingSource!.sourceRevision, 2);
    assert.equal(state.messages[0]!.greetingSource!.canonicalHash, greetingV2.canonicalHash);
  } finally {
    await server.close();
  }
});

test("New Chat compensates its prepared surface when durable thread creation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const headers = {
      Origin: base,
      Cookie: bootstrap.headers.get("set-cookie")!.split(";")[0]!,
      "X-GameBuddy-CSRF": csrf,
      "Content-Type": "application/json",
    };
    // `missing_persona` passes request-shape validation. It fails after
    // surface setup (whether at companion or exact artifact verification),
    // which must leave no resumable surface without a ChatThread.
    const failed = await fetch(`${base}/new-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ personaId: "missing_persona", opening: { kind: "blank" } }),
    });
    assert.equal(failed.status, 400);
    const ledger = JSON.parse(await readFile(continuityLedgerPath(resolveRuntimePaths(identity, root)), "utf8")) as {
      sessions: Array<{ sessionId: string; surface: string; state: string }>;
    };
    assert.deepEqual(
      ledger.sessions
        .filter((entry) => entry.surface === "chat" && entry.state !== "ended")
        .map((entry) => entry.sessionId),
      [server.surfaceSession.sessionId],
    );
    const chats = await fetch(`${base}/manage-chats`, { headers: { Cookie: headers.Cookie } });
    assert.equal(((await chats.json()) as { chats: unknown[] }).chats.length, 1);
  } finally {
    await server.close();
  }
});

test("Dialogue web authenticates a bound Tavern-only no-effect retry and rejects Game effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf, session } = (await bootstrap.json()) as { csrf: string; session: { id: string } };
    const headers = {
      Origin: base,
      Cookie: bootstrap.headers.get("set-cookie")!.split(";")[0]!,
      "X-GameBuddy-CSRF": csrf,
      "Content-Type": "application/json",
    };
    const threads = createChatThreadStore(join(root, "contexts", identityKey(identity)), identityKey(identity));
    await threads.commitResponse(session.id, {
      messageId: "response_01",
      text: "Durable response",
      occurredAtMs: Date.now(),
    });
    const retry = {
      chatThreadId: session.id,
      chatSurfaceSessionId: session.id,
      messageId: "response_01",
      expectedThreadRevision: 2,
      expectedMessageRevision: 1,
    };
    const allowed = await fetch(`${base}/retry-response`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...retry, effect: "none" }),
    });
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /safe_no_effect_retry/);
    const game = await fetch(`${base}/retry-response`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...retry, effect: "game" }),
    });
    assert.equal(game.status, 409);
    assert.match(await game.text(), /tavern_retry_game_effect/);
  } finally {
    await server.close();
  }
});

test("Dialogue web durably reviews an inert import before Host creates a distinct companion identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf } = (await bootstrap.json()) as { csrf: string };
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" };
    const card = JSON.stringify({
      spec: "chara_card_v3",
      data: { name: "Reviewed Rin", description: "calm", personality: "patient", extensions: { malicious: true } },
    });
    const imported = await fetch(`${base}/imports`, {
      method: "POST",
      headers,
      body: JSON.stringify({ importId: "review_01", card }),
    });
    assert.equal(imported.status, 201);
    const importMetadata = (await imported.json()) as {
      candidate: { reviewId: string; fields: Array<{ reviewKey: string; label: string; eligible: boolean }> };
      report: { reviewId: string; dispositions: Array<{ status: string }> };
    };
    assert.equal(importMetadata.candidate.reviewId, "review_01");
    assert.deepEqual(
      importMetadata.candidate.fields.filter((field) => field.eligible).map((field) => [field.reviewKey, field.label]),
      [
        ["field-1", "persona"],
        ["field-2", "interaction"],
        ["field-3", "style"],
      ],
    );
    assert.ok(importMetadata.report.dispositions.some((disposition) => disposition.status === "excluded"));
    assert.doesNotMatch(JSON.stringify(importMetadata), /Reviewed Rin|calm|patient|malicious/);
    const exported = await fetch(`${base}/imports/review_01/export`, { headers: { Cookie: cookie } });
    assert.equal(exported.status, 200);
    assert.deepEqual(await exported.json(), importMetadata);
    // Chat JSONL is outside the selected L3 profile, so no import endpoint is mounted.
    assert.equal(
      (
        await fetch(`${base}/imports/chat_jsonl`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            importId: "chat_jsonl",
            card: JSON.stringify({ mes: "unsupported transcript", swipes: ["unsupported"] }),
          }),
        })
      ).status,
      404,
    );
    assert.equal(
      (await fetch(`${base}/imports/review_01/confirm-new-companion`, { method: "POST", headers, body: "{}" })).status,
      400,
    );
    const review = await fetch(`${base}/imports/review_01/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewedFields: ["field-1"], approvedAtMs: 100 }),
    });
    assert.equal(review.status, 201);
    assert.deepEqual(
      (
        (await (await fetch(`${base}/imports/review_01/review`, { headers: { Cookie: cookie } })).json()) as {
          reviewedFields: string[];
        }
      ).reviewedFields,
      ["persona_core"],
    );
    const confirmation = await fetch(`${base}/imports/review_01/confirm-new-companion`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(confirmation.status, 201);
    const created = (await confirmation.json()) as { companion: { companionId: string; continuityId: string } };
    assert.notEqual(created.companion.companionId, identity.companionId);
    assert.notEqual(created.companion.continuityId, identity.continuityId);
    assert.match(
      await readFile(
        join(
          root,
          "contexts",
          identityKey({ playerId: identity.playerId, ...created.companion }),
          "identity-profile-binding.json",
        ),
        "utf8",
      ),
      /canonicalHash/,
    );
  } finally {
    await server.close();
  }
});

test("Chat lifecycle archive uses only session-bound opaque handles and preserves durable non-lifecycle state", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-lifecycle-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const { csrf, session } = (await boot.json()) as { csrf: string; session: { id: string } };
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" };
    assert.equal((await fetch(`${base}/chat-lifecycle`)).status, 401);
    assert.equal((await fetch(`${base}/chat-lifecycle`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal(
      (
        await fetch(`${base}/chat-lifecycle/archive`, {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/chat-lifecycle/archive`, {
          method: "POST",
          headers,
          body: JSON.stringify({ handle: "x", expectedManagementRevision: 1 }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/new-chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({ opening: { kind: "blank" } }),
        })
      ).status,
      201,
    );
    const store = createChatThreadStore(join(root, "contexts", identityKey(identity)), identityKey(identity));
    const threads = await store.listThreads!();
    const activeThread = threads.find((thread) => thread.chatThreadId === session.id)!;
    const inactiveThread = threads.find((thread) => thread.chatThreadId !== session.id)!;
    await store.renameThreadTitle!({
      chatThreadId: activeThread.chatThreadId,
      chatSurfaceSessionId: activeThread.chatSurfaceSessionId,
      expectedManagementRevision: 1,
      title: "Active",
    });
    await store.renameThreadTitle!({
      chatThreadId: inactiveThread.chatThreadId,
      chatSurfaceSessionId: inactiveThread.chatSurfaceSessionId,
      expectedManagementRevision: 1,
      title: "Inactive",
    });
    const listed = (await (await fetch(`${base}/chat-lifecycle`, { headers: { Cookie: cookie } })).json()) as {
      chats: Array<{ handle: string; managementRevision: number; title: string | null }>;
    };
    assert.equal(listed.chats.length, 2);
    // The active row cannot be archived even with a genuine list capability.
    const active = listed.chats.find((row) => row.title === "Active")!;
    assert.equal(
      (
        await fetch(`${base}/chat-lifecycle/archive`, {
          method: "POST",
          headers,
          body: JSON.stringify({ handle: active.handle, expectedManagementRevision: active.managementRevision }),
        })
      ).status,
      409,
    );
    // Re-list because rejected archive handles are deliberately single-use.
    const fresh = (await (await fetch(`${base}/chat-lifecycle`, { headers: { Cookie: cookie } })).json()) as {
      chats: Array<{ handle: string; managementRevision: number; title: string | null }>;
    };
    const inactive = fresh.chats.find((row) => row.title === "Inactive")!;
    const forged = `${inactive.handle.slice(0, -1)}${inactive.handle.endsWith("A") ? "B" : "A"}`;
    assert.equal(
      (
        await fetch(`${base}/chat-lifecycle/archive`, {
          method: "POST",
          headers,
          body: JSON.stringify({ handle: forged, expectedManagementRevision: inactive.managementRevision }),
        })
      ).status,
      400,
    );
    const stale = await fetch(`${base}/chat-lifecycle/archive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ handle: inactive.handle, expectedManagementRevision: inactive.managementRevision + 1 }),
    });
    assert.equal(stale.status, 400);
    const replay = await fetch(`${base}/chat-lifecycle/archive`, {
      method: "POST",
      headers,
      body: JSON.stringify({ handle: inactive.handle, expectedManagementRevision: inactive.managementRevision }),
    });
    assert.equal(replay.status, 400);
    const finalList = (await (await fetch(`${base}/chat-lifecycle`, { headers: { Cookie: cookie } })).json()) as {
      chats: Array<{ handle: string; managementRevision: number; title: string | null }>;
    };
    const target = finalList.chats.find((row) => row.title === "Inactive")!;
    const archiveRequests = [target, target].map((row) =>
      fetch(`${base}/chat-lifecycle/archive`, {
        method: "POST",
        headers,
        body: JSON.stringify({ handle: row.handle, expectedManagementRevision: row.managementRevision }),
      }),
    );
    const [archived, concurrentLoser] = await Promise.all(archiveRequests);
    assert.deepEqual(
      [archived.status, concurrentLoser.status].sort((a, b) => a - b),
      [200, 400],
    );
    assert.deepEqual(await (archived.status === 200 ? archived : concurrentLoser).json(), {
      chat: { status: "archived", managementRevision: target.managementRevision + 1, title: "Inactive" },
    });
    assert.equal(
      (
        await fetch(`${base}/chat-lifecycle/archive`, {
          method: "POST",
          headers,
          body: JSON.stringify({ handle: target.handle, expectedManagementRevision: target.managementRevision }),
        })
      ).status,
      400,
    );
    const states = await Promise.all(
      (await store.listThreads!()).map((thread) =>
        store.resumeThread(thread.chatThreadId, thread.chatSurfaceSessionId),
      ),
    );
    const archivedState = states.find((state) => state.thread.lifecycleStatus === "archived")!;
    assert.equal(archivedState.messages.length, 0);
    assert.equal((await store.readActiveThreadSelection())!.chatThreadId, session.id);
  } finally {
    await server.close();
  }
});

test("Selected L3 memories expose read-only companion access while preserving player direct create", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-memories-"));
  const calls: Array<{ operation: string; continuityId: string }> = [];
  const server = await startDialogueWebServer({
    identity,
    runtimeRoot: root,
    magicContextMemoryFacade: {
      async createDelegatedInferredSemanticMemory(input) {
        calls.push({ operation: "delegated-create", continuityId: input.continuityId });
        return {
          stateToken: "memory_state_delegated",
          content: input.content,
          category: "semantic",
          status: "active",
          ...(input.sourceRefs === undefined ? {} : { sourceRefs: input.sourceRefs }),
        };
      },
      async listMemories(input) {
        calls.push({ operation: "list", continuityId: input.continuityId });
        return [
          {
            stateToken: "memory_state_01",
            content: "Likes rain",
            category: "semantic",
            status: "active",
            sourceRefs: ["message_01"],
          },
        ];
      },
      async getMemory(input) {
        calls.push({ operation: "get", continuityId: input.continuityId });
        return { stateToken: input.stateToken, content: "Likes rain", category: "semantic", status: "active" };
      },
      async createMemory(input) {
        calls.push({ operation: "create", continuityId: input.continuityId });
        return {
          stateToken: "memory_state_02",
          content: input.content,
          category: input.category,
          status: "active",
          ...(input.sourceRefs === undefined ? {} : { sourceRefs: input.sourceRefs }),
        };
      },
      async updateMemory(input) {
        calls.push({ operation: "update", continuityId: input.continuityId });
        if (input.stateToken === "stale_state") throw new Error("memory revision conflict");
        return { stateToken: "memory_state_03", content: input.content, category: "semantic", status: "active" };
      },
      async archiveMemory(input) {
        calls.push({ operation: "archive", continuityId: input.continuityId });
        if (input.stateToken === "lost_state") throw new Error("gamebuddy_memory_not_found");
        return { stateToken: "memory_state_04", content: "Archived memory", category: "semantic", status: "archived" };
      },
      async restoreMemory(input) {
        calls.push({ operation: "restore", continuityId: input.continuityId });
        return { stateToken: "memory_state_05", content: "Restored memory", category: "semantic", status: "active" };
      },
      async pinMemory(input) {
        calls.push({ operation: "pin", continuityId: input.continuityId });
        return { stateToken: "memory_state_06", content: "Pinned memory", category: "semantic", status: "permanent" };
      },
      async unpinMemory(input) {
        calls.push({ operation: "unpin", continuityId: input.continuityId });
        return { stateToken: "memory_state_07", content: "Unpinned memory", category: "semantic", status: "active" };
      },
      async mergeMemory(input) {
        calls.push({ operation: "merge", continuityId: input.continuityId });
        return { stateToken: input.targetStateToken, content: "Merged memory", category: "semantic", status: "active" };
      },
      async deleteEntry(input) {
        calls.push({ operation: "delete-entry", continuityId: input.continuityId });
      },
      async excludeSource(input) {
        calls.push({ operation: "exclude-source", continuityId: input.continuityId });
      },
    },
  });
  try {
    const initialMemoryTool = server.runtime.session.agent.state.tools.find((tool) => tool.name === "companion_memory");
    assert.ok(initialMemoryTool);
    await initialMemoryTool.execute("memory-initial-list", { operation: "list" }, new AbortController().signal);
    await initialMemoryTool.execute(
      "memory-get",
      { operation: "get", memoryId: "memory_state_01" },
      new AbortController().signal,
    );
    assert.deepEqual(
      (initialMemoryTool.parameters as { anyOf?: unknown[] }).anyOf?.map(
        (entry) => (entry as { properties?: { operation?: { const?: string } } }).properties?.operation?.const,
      ),
      ["list", "get", "create_inferred_semantic"],
    );
    await assert.rejects(
      () =>
        initialMemoryTool.execute(
          "memory-no-grant",
          { operation: "create_inferred_semantic", content: "No grant." },
          new AbortController().signal,
        ),
      /memory_delegation_unavailable/,
    );

    const base = server.url.slice(0, server.url.indexOf("/#"));
    assert.equal((await fetch(`${base}/memories`)).status, 401);
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const bootstrap = (await boot.json()) as { csrf: string; memoryManagement: { available: boolean } };
    const { csrf } = bootstrap;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    assert.deepEqual(bootstrap.memoryManagement, { available: true });
    assert.deepEqual(await (await fetch(`${base}/memories`, { headers: { Cookie: cookie } })).json(), {
      memories: [
        {
          stateToken: "memory_state_01",
          content: "Likes rain",
          category: "semantic",
          status: "active",
          sourceRefs: ["message_01"],
        },
      ],
    });
    assert.equal(
      (
        await fetch(`${base}/memories`, {
          method: "POST",
          headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Remembers tea", category: "interaction", continuityId: "forged" }),
        })
      ).status,
      401,
    );
    // Only a player turn which explicitly grants delegation can unlock one
    // Companion-inferred semantic create; a tool call before that remains denied.
    await assert.rejects(
      () =>
        initialMemoryTool.execute(
          "memory-no-grant",
          { operation: "create_inferred_semantic", content: "Must fail without a player grant." },
          new AbortController().signal,
        ),
      /memory_delegation_unavailable/,
    );
    const playerTurn = await fetch(`${base}/message`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({
        clientMessageId: "memory_delegated_turn",
        text: "Please remember a shared preference if useful.",
        locale: "en-US",
        memoryDelegation: true,
      }),
    });
    assert.equal(playerTurn.status, 202);
    const delegated = await initialMemoryTool.execute(
      "memory-delegated-create",
      { operation: "create_inferred_semantic", content: "The player and companion share a tea ritual." },
      new AbortController().signal,
    );
    assert.match(delegated.content[0]?.type === "text" ? delegated.content[0].text : "", /tea ritual/);
    const delegatedReplay = await initialMemoryTool.execute(
      "memory-delegated-create",
      { operation: "create_inferred_semantic", content: "A provider retry must receive its original receipt." },
      new AbortController().signal,
    );
    assert.deepEqual(delegatedReplay, delegated);
    await assert.rejects(
      () =>
        initialMemoryTool.execute(
          "memory-delegated-second",
          { operation: "create_inferred_semantic", content: "A second write must fail." },
          new AbortController().signal,
        ),
      /memory_delegation_consumed/,
    );
    const created = await fetch(`${base}/memories`, {
      method: "POST",
      headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Remembers tea", category: "interaction", sourceRefs: ["message_02"] }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      memory: {
        stateToken: "memory_state_02",
        content: "Remembers tea",
        category: "interaction",
        status: "active",
        sourceRefs: ["message_02"],
      },
    });
    const mutate = (path: string, body: object) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.deepEqual(
      await (await mutate("/memories/update", { stateToken: "memory_state_02", content: "Updated tea memory" })).json(),
      {
        memory: {
          stateToken: "memory_state_03",
          content: "Updated tea memory",
          category: "semantic",
          status: "active",
        },
      },
    );
    assert.deepEqual(
      await (
        await mutate("/memories/merge", { stateToken: "memory_state_03", targetStateToken: "memory_state_02" })
      ).json(),
      { memory: { stateToken: "memory_state_02", content: "Merged memory", category: "semantic", status: "active" } },
    );
    for (const [path, token] of [
      ["/memories/archive", "memory_state_03"],
      ["/memories/restore", "memory_state_04"],
      ["/memories/pin", "memory_state_05"],
      ["/memories/unpin", "memory_state_06"],
      ["/memories/delete-entry", "memory_state_07"],
    ] as const)
      assert.equal((await mutate(path, { stateToken: token })).status, 200);
    assert.deepEqual(
      await (
        await mutate("/memories/exclude-source", { stateToken: "memory_state_07", sourceRef: "message_02" })
      ).json(),
      { excluded: true },
    );
    assert.equal((await mutate("/memories/update", { stateToken: "stale_state", content: "Conflict" })).status, 409);
    // A token may become unresolvable after another request supersedes the
    // entry. It is a CAS conflict, not a storage outage.
    assert.equal((await mutate("/memories/archive", { stateToken: "lost_state" })).status, 409);
    assert.equal((await mutate("/memories/archive", { stateToken: "bad token" })).status, 400);
    assert.equal(
      (
        await fetch(`${base}/memories/pin`, {
          method: "POST",
          headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({ stateToken: "memory_state_05" }),
        })
      ).status,
      401,
    );
    assert.deepEqual(
      calls.map((call) => call.operation),
      [
        "list",
        "get",
        "list",
        "delegated-create",
        "create",
        "update",
        "merge",
        "archive",
        "restore",
        "pin",
        "unpin",
        "delete-entry",
        "exclude-source",
        "update",
        "archive",
      ],
    );
    assert.ok(calls.every((call) => call.continuityId === identity.continuityId));
  } finally {
    await server.close();
  }
});

test("Selected L3 memory routes fail closed when no Magic Context facade is injected", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-memories-unavailable-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const boot = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const bootstrap = (await boot.json()) as { csrf: string; memoryManagement: { available: boolean } };
    const { csrf } = bootstrap;
    const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
    assert.deepEqual(bootstrap.memoryManagement, { available: false });
    assert.equal((await fetch(`${base}/memories`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal(
      (
        await fetch(`${base}/memories`, {
          method: "POST",
          headers: { Origin: base, Cookie: cookie, "X-GameBuddy-CSRF": csrf, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "No direct SQLite", category: "semantic" }),
        })
      ).status,
      404,
    );
  } finally {
    await server.close();
  }
});

test("Dialogue web bootstrap is one-time and requires its loopback capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-dialogue-web-"));
  const server = await startDialogueWebServer({ identity, runtimeRoot: root });
  try {
    const base = server.url.slice(0, server.url.indexOf("/#"));
    const token = new URL(server.url).hash.slice("#boot=".length);
    const bootstrap = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(bootstrap.status, 200);
    const replay = await fetch(`${base}/bootstrap`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(replay.status, 401);
    const foreign = await fetch(`${base}/message`, {
      method: "POST",
      headers: { Origin: "http://example.test", "Content-Type": "application/json" },
      body: JSON.stringify({ clientMessageId: "x", text: "hello", locale: "en-US" }),
    });
    assert.equal(foreign.status, 401);
    const gameControl = await fetch(`${base}/enter-game`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ clientTransitionId: "transition_01" }),
    });
    assert.equal(gameControl.status, 404);
  } finally {
    await server.close();
  }
});
