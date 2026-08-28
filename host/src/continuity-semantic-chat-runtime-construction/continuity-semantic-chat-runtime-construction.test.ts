import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type ChatRuntimeBindingExecution,
  withConsumedChatRuntimeBinding,
} from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { createTestChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.test-support.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { identityKey } from "../runtime.js";
import { createChatThreadStore } from "../tavern/chat-thread-store.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { prepareExactChatRuntimeConstruction } from "./continuity-semantic-chat-runtime-construction.internal.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

function permit(execution: ChatRuntimeBindingExecution): ProductionChatRuntimePermit {
  return Object.freeze({
    principal: execution.principal,
    operationId: "operation_01",
    requestId: "request_01",
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "chat_session_01",
    runtimeBindingDigest: execution.bindingFacts.runtimeBindingDigest,
    owner: execution.bindingFacts.owner,
    deadlineAtMs: Date.now() + 5_000,
    expected: Object.freeze({ partitionRevision: 1, fenceEpoch: 1, selectionRevision: 1 }),
    payloadDigest: "b".repeat(64),
    fenceToken: "fence_01",
    prepared: Object.freeze({ partitionRevision: 2, fenceEpoch: 2, selectionRevision: 1 }),
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chat-runtime-construction-"));
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  const manifest = Object.freeze({
    schemaVersion: 2 as const,
    topology: "independent_chat_and_game_surfaces" as const,
    runtimeRoot,
    principal,
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
  const binding = createTestChatRuntimeBinding({
    manifest,
    ownerProof: Object.freeze({ processId: 42, creationTime100ns: "123456" }),
  });
  const threads = createChatThreadStore(runtimeRoot, identityKey(principal));
  await threads.createThread({
    chatThreadId: "thread_01",
    chatSurfaceSessionId: "chat_session_01",
    companionId: principal.companionId,
    continuityId: principal.continuityId,
    opening: "blank",
  });
  return Object.freeze({ root, runtimeRoot, binding, threads });
}

test("Chat construction derives model and exact stable Tavern snapshot from the binding-owned root", async () => {
  const value = await fixture();
  try {
    const prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    assert.deepEqual(prepared.identity, principal);
    assert.equal(prepared.runtimeRoot, value.runtimeRoot);
    assert.equal(prepared.surfaceSessionId, "chat_session_01");
    assert.equal(prepared.modelConfig.provider, "cpa-oai");
    assert.equal(prepared.modelConfig.modelId, "deepseek-v4-flash");
    assert.equal(prepared.modelProfileRevision, 0);
    // Chat mounts no speaking pseudo-tool or presentation callback. Native
    // assistant content is observed privately by the bound provider invocation.
    assert.equal(prepared.presentation.admissionProvider, undefined);
    assert.equal(prepared.presentation.textPort, undefined);
    const stableContext = await prepared.materializeStableContextForPiSession("pi_session_genuine");
    assert.equal(stableContext.continuityId, principal.continuityId);
    assert.equal(stableContext.sessionId, "pi_session_genuine");
    assert.notEqual(stableContext.sessionId, prepared.surfaceSessionId);
    assert.deepEqual(stableContext.sources, []);
    assert.match(stableContext.canonicalHash, /^[a-f0-9]{64}$/);
  } finally {
    await value.binding.close();
    await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Chat construction regenerates the canonical hash for each actual Pi session", async () => {
  const value = await fixture();
  try {
    const prepared = await value.binding.executeWithBinding((token) =>
      withConsumedChatRuntimeBinding(token, (execution) =>
        prepareExactChatRuntimeConstruction(execution, permit(execution)),
      ),
    );
    const first = await prepared.materializeStableContextForPiSession("pi_session_one");
    const second = await prepared.materializeStableContextForPiSession("pi_session_two");
    assert.notEqual(first.canonicalHash, second.canonicalHash);
    assert.equal(first.sessionId, "pi_session_one");
    assert.equal(second.sessionId, "pi_session_two");
  } finally {
    await value.binding.close();
    await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Chat construction rejects a missing exact Tavern thread rather than creating or selecting one", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      value.binding.executeWithBinding((token) =>
        withConsumedChatRuntimeBinding(token, (execution) =>
          prepareExactChatRuntimeConstruction(
            execution,
            Object.freeze({ ...permit(execution), chatThreadId: "thread_missing" }),
          ),
        ),
      ),
      /chat_runtime_exact_content_unavailable/,
    );
  } finally {
    await value.binding.close();
    await rm(value.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
