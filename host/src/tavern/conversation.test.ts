import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  TavernExactContentError,
  createTavernConversation,
  createTavernSemanticChatContentPort,
  openTavernConversation,
  resumeExactTavernConversation,
} from "./conversation.js";
import type { ChatThreadStore } from "./chat-thread-store.js";

const state = Object.freeze({
  thread: Object.freeze({
    schemaVersion: 1 as const,
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    createdAtMs: 1,
    updatedAtMs: 1,
    openingSelection: Object.freeze({ kind: "blank" as const }),
    openingLockedAtEventId: null,
  }),
  messages: Object.freeze([]),
});
const binding = {
  chatThreadId: "thread_01",
  companionId: "companion_01",
  continuityId: "continuity_01",
  chatSurfaceSessionId: "surface_01",
} as const;
const selectionMethods = {
  async readActiveThreadSelection() {
    return null;
  },
  async selectActiveThread(chatThreadId: string, chatSurfaceSessionId: string) {
    return { schemaVersion: 1 as const, chatThreadId, chatSurfaceSessionId, selectedAtMs: 1 };
  },
};

test("Tavern conversation creates a blank exact-surface thread and durably orders player then response", async () => {
  const calls: string[] = [];
  const store: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread() {
      calls.push("resume");
      throw new Error("chat_thread_not_found");
    },
    async createThread(request) {
      calls.push(`create:${request.opening}`);
      return state;
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer(_thread, message) {
      calls.push(`player:${message.messageId}`);
      return state;
    },
    async commitResponse(_thread, message) {
      calls.push(`response:${message.messageId}`);
      return state;
    },
  };
  const conversation = await openTavernConversation(store, binding);
  await conversation.appendPlayer({ messageId: "player_01", text: "Hello", occurredAtMs: 2 });
  await conversation.commitResponse(
    { expressionId: "response_01", sessionId: "surface_01", sourceEventId: "tool_01", text: "Hi", locale: "en-US" },
    3,
  );
  assert.deepEqual(conversation.bootstrapTranscript(), []);
  assert.deepEqual(calls, ["resume", "create:blank", "player:player_01", "response:response_01"]);
});

test("Tavern retry reads the exact durable binding and permits only a safe no-effect response retry", async () => {
  const responseState = Object.freeze({
    ...state,
    messages: Object.freeze([
      {
        messageId: "response_01",
        role: "companion" as const,
        kind: "response" as const,
        text: "Hi",
        occurredAtMs: 2,
        greetingSource: null,
      },
    ]),
  });
  let resumeCount = 0;
  const store: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread() {
      resumeCount++;
      return responseState;
    },
    async createThread() {
      return responseState;
    },
    async commitOpening() {
      return responseState;
    },
    async appendPlayer() {
      return responseState;
    },
    async commitResponse() {
      return responseState;
    },
  };
  const conversation = await openTavernConversation(store, binding);
  const intent = {
    chatThreadId: binding.chatThreadId,
    chatSurfaceSessionId: binding.chatSurfaceSessionId,
    messageId: "response_01",
    expectedThreadRevision: 2,
    expectedMessageRevision: 1,
  } as const;
  assert.deepEqual(await conversation.retryResponse({ ...intent, effect: "none" }), {
    kind: "safe_no_effect_retry",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "surface_01",
    messageId: "response_01",
    threadRevision: 2,
    messageRevision: 1,
    effect: "none",
  });
  await assert.rejects(() => conversation.retryResponse({ ...intent, effect: "game" }), /tavern_retry_game_effect/);
  await assert.rejects(
    () => conversation.retryResponse({ ...intent, effect: "external" }),
    /tavern_retry_external_effect/,
  );
  await assert.rejects(
    () => conversation.retryResponse({ ...intent, chatSurfaceSessionId: "wrong_surface", effect: "none" }),
    /tavern_retry_binding_mismatch/,
  );
  assert.ok(resumeCount >= 3, "each accepted/effect check uses durable thread readback");
});

test("Tavern conversation fails closed for resume and append errors", async () => {
  const failingResume: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread() {
      throw new Error("chat_thread_surface_mismatch");
    },
    async createThread() {
      throw new Error("must_not_create");
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer() {
      return state;
    },
    async commitResponse() {
      return state;
    },
  };
  await assert.rejects(() => openTavernConversation(failingResume, binding), /chat_thread_surface_mismatch/);

  const failingAppend: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread() {
      return state;
    },
    async createThread() {
      return state;
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer() {
      throw new Error("storage_unavailable");
    },
    async commitResponse() {
      return state;
    },
  };
  const conversation = await openTavernConversation(failingAppend, binding);
  await assert.rejects(
    () => conversation.appendPlayer({ messageId: "player_01", text: "Hello", occurredAtMs: 2 }),
    /storage_unavailable/,
  );
});

test("strict semantic content resume opens only the specified existing exact binding", async () => {
  const calls: string[] = [];
  const store: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread(threadId, surfaceId) {
      calls.push(`resume:${threadId}:${surfaceId}`);
      return state;
    },
    async createThread() {
      calls.push("create");
      return state;
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer() {
      return state;
    },
    async commitResponse() {
      return state;
    },
  };
  const conversation = await resumeExactTavernConversation(store, binding);
  assert.deepEqual(conversation.bootstrapTranscript(), []);
  assert.deepEqual(calls, ["resume:thread_01:surface_01"]);
});

test("strict semantic content resume fails closed without creating missing or mismatched content", async () => {
  const missingCalls: string[] = [];
  const missing: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread() {
      missingCalls.push("resume");
      throw new Error("chat_thread_not_found");
    },
    async createThread() {
      missingCalls.push("create");
      return state;
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer() {
      return state;
    },
    async commitResponse() {
      return state;
    },
  };
  await assert.rejects(() => resumeExactTavernConversation(missing, binding), /chat_thread_not_found/);
  assert.deepEqual(missingCalls, ["resume"]);

  for (const record of [
    { ...binding, companionId: "wrong_companion" },
    { ...binding, continuityId: "wrong_continuity" },
    { ...binding, chatThreadId: "wrong_thread" },
    { ...binding, chatSurfaceSessionId: "wrong_surface" },
  ]) {
    const calls: string[] = [];
    const mismatched: ChatThreadStore = {
      ...selectionMethods,
      async resumeThread() {
        calls.push("resume");
        return state;
      },
      async createThread() {
        calls.push("create");
        return state;
      },
      async commitOpening() {
        return state;
      },
      async appendPlayer() {
        return state;
      },
      async commitResponse() {
        return state;
      },
    };
    await assert.rejects(
      () => resumeExactTavernConversation(mismatched, record),
      /tavern_exact_content_binding_mismatch/,
    );
    assert.deepEqual(calls, ["resume"]);
  }
});

test("semantic content port returns an immutable exact receipt only after durable readback", async () => {
  const calls: string[] = [];
  const store: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread(threadId, surfaceId) {
      calls.push(`resume:${threadId}:${surfaceId}`);
      return state;
    },
    async createThread(request) {
      calls.push(`create:${request.chatThreadId}`);
      return state;
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer() {
      return state;
    },
    async commitResponse() {
      return state;
    },
  };
  const port = createTavernSemanticChatContentPort(store);
  const opened = await port.createExplicit(binding);
  const canonicalBinding = JSON.stringify({
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
  });
  assert.deepEqual(opened.receipt, {
    ...binding,
    canonicalBindingDigest: createHash("sha256").update(canonicalBinding, "utf8").digest("hex"),
  });
  assert.ok(Object.isFrozen(opened));
  assert.ok(Object.isFrozen(opened.receipt));
  assert.deepEqual(opened.conversation.bootstrapTranscript(), []);
  assert.deepEqual(calls, ["create:thread_01", "resume:thread_01:surface_01"]);
});

test("semantic content port classifies exact missing and existing without conflating I/O", async () => {
  const missingCalls: string[] = [];
  const missing: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread() {
      missingCalls.push("resume");
      throw new Error("chat_thread_not_found");
    },
    async createThread() {
      missingCalls.push("create");
      return state;
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer() {
      return state;
    },
    async commitResponse() {
      return state;
    },
  };
  await assert.rejects(
    () => createTavernSemanticChatContentPort(missing).resumeExact(binding),
    (error: unknown) => error instanceof TavernExactContentError && error.code === "tavern_exact_content_not_found",
  );
  assert.deepEqual(missingCalls, ["resume"]);

  const existingCalls: string[] = [];
  const existing: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread() {
      existingCalls.push("resume");
      return state;
    },
    async createThread() {
      existingCalls.push("create");
      throw new Error("chat_thread_already_exists");
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer() {
      return state;
    },
    async commitResponse() {
      return state;
    },
  };
  await assert.rejects(
    () => createTavernSemanticChatContentPort(existing).createExplicit(binding),
    (error: unknown) =>
      error instanceof TavernExactContentError && error.code === "tavern_exact_content_already_exists",
  );
  assert.deepEqual(existingCalls, ["create"]);

  const unavailable: ChatThreadStore = {
    ...selectionMethods,
    async resumeThread() {
      throw new Error("storage_unavailable");
    },
    async createThread() {
      throw new Error("storage_unavailable");
    },
    async commitOpening() {
      return state;
    },
    async appendPlayer() {
      return state;
    },
    async commitResponse() {
      return state;
    },
  };
  await assert.rejects(
    () => createTavernSemanticChatContentPort(unavailable).resumeExact(binding),
    /storage_unavailable/,
  );
  await assert.rejects(
    () => createTavernSemanticChatContentPort(unavailable).createExplicit(binding),
    /storage_unavailable/,
  );
});

test("semantic content port rejects every mismatched exact binding after readback without creating", async () => {
  for (const record of [
    { ...binding, companionId: "wrong_companion" },
    { ...binding, continuityId: "wrong_continuity" },
    { ...binding, chatSurfaceSessionId: "wrong_surface" },
  ]) {
    const calls: string[] = [];
    const store: ChatThreadStore = {
      ...selectionMethods,
      async resumeThread() {
        calls.push("resume");
        return state;
      },
      async createThread() {
        calls.push("create");
        return state;
      },
      async commitOpening() {
        return state;
      },
      async appendPlayer() {
        return state;
      },
      async commitResponse() {
        return state;
      },
    };
    await assert.rejects(
      () => createTavernSemanticChatContentPort(store).resumeExact(record),
      (error: unknown) =>
        error instanceof TavernExactContentError && error.code === "tavern_exact_content_binding_mismatch",
    );
    assert.deepEqual(calls, ["resume"]);
  }
});
