import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createChatThreadStore,
  createInitialChatExactContentCapability,
  type CreateChatThreadRequest,
} from "./chat-thread-store.js";
import {
  TavernInitialChatExactContentPortError,
  createInitialChatExactContentPort,
  isTrustedTavernExactContentReceipt,
} from "./initial-chat-exact-content-port.js";

const binding = Object.freeze({
  chatThreadId: "thread_01",
  companionId: "companion_01",
  continuityId: "continuity_01",
  chatSurfaceSessionId: "surface_01",
});
const request: CreateChatThreadRequest = Object.freeze({ ...binding, opening: "blank" });
function stateDigest(state: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical({ binding, state })), "utf8")
    .digest("hex");
}

async function capability() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-exact-content-"));
  const store = createChatThreadStore(
    root,
    "a".repeat(64),
    (() => {
      let now = 10;
      return () => now++;
    })(),
  );
  return { root, store, capability: createInitialChatExactContentCapability(store) };
}
function expectCode(code: TavernInitialChatExactContentPortError["code"]): (error: unknown) => boolean {
  return (error): boolean => error instanceof TavernInitialChatExactContentPortError && error.code === code;
}
async function assertNoDurableThreadArtifacts(root: string, rejectedResult: unknown): Promise<void> {
  assert.deepEqual(await readdir(root, { recursive: true }), []);
  assert.equal(isTrustedTavernExactContentReceipt(rejectedResult), false);
}

test("genuine ChatThreadStore exact missing creates then durably reads back a trusted receipt", async () => {
  const fixture = await capability();
  try {
    const port = createInitialChatExactContentPort(fixture.capability);
    const receipt = await port.ensureExactContent(binding, request);
    const durableState = await fixture.store.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId);
    assert.deepEqual(receipt, { ...binding, digest: stateDigest(durableState) });
    assert.ok(isTrustedTavernExactContentReceipt(receipt));
    assert.deepEqual(
      durableState,
      await fixture.store.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("genuine exact capability resumes an existing thread", async () => {
  const fixture = await capability();
  try {
    await fixture.store.createThread(request);
    const receipt = await createInitialChatExactContentPort(fixture.capability).resumeExact(
      binding.chatThreadId,
      binding.companionId,
      binding.continuityId,
      binding.chatSurfaceSessionId,
    );
    assert.ok(isTrustedTavernExactContentReceipt(receipt));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("receipt digest covers complete durable state and changes for binding-preserving metadata or message changes", async () => {
  const fixture = await capability();
  try {
    const port = createInitialChatExactContentPort(fixture.capability);
    await fixture.store.createThread(request);
    const initial = await port.resumeExact(
      binding.chatThreadId,
      binding.companionId,
      binding.continuityId,
      binding.chatSurfaceSessionId,
    );
    const renamed = await fixture.store.renameThreadTitle!({
      chatThreadId: binding.chatThreadId,
      chatSurfaceSessionId: binding.chatSurfaceSessionId,
      expectedManagementRevision: 1,
      title: "A durable title",
    });
    const afterMetadata = await port.resumeExact(
      binding.chatThreadId,
      binding.companionId,
      binding.continuityId,
      binding.chatSurfaceSessionId,
    );
    assert.notEqual(afterMetadata.digest, initial.digest);
    assert.equal(afterMetadata.digest, stateDigest({ thread: renamed, messages: [] }));

    await fixture.store.appendPlayer(binding.chatThreadId, {
      messageId: "player_01",
      text: "Hello",
      occurredAtMs: 100,
    });
    const afterMessage = await port.resumeExact(
      binding.chatThreadId,
      binding.companionId,
      binding.continuityId,
      binding.chatSurfaceSessionId,
    );
    assert.notEqual(afterMessage.digest, afterMetadata.digest);
    assert.equal(
      afterMessage.digest,
      stateDigest(await fixture.store.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId)),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("collision does not fall back and broad not-found Error text cannot create", async () => {
  const fixture = await capability();
  try {
    const port = createInitialChatExactContentPort(fixture.capability);
    await fixture.store.createThread(request);
    assert.ok(isTrustedTavernExactContentReceipt(await port.ensureExactContent(binding, request)));
    const missing = { ...binding, chatThreadId: "missing_01" };
    const missingRequest = { ...request, chatThreadId: "missing_01" };
    const threadDir = join(fixture.root, "tavern", "v1", "continuities", "a".repeat(64), "threads", "missing_01");
    await writeFile(join(threadDir, "thread.json"), "{ broken", "utf8").catch(async () => {
      await (await import("node:fs/promises")).mkdir(threadDir, { recursive: true });
      await writeFile(join(threadDir, "thread.json"), "{ broken", "utf8");
    });
    await assert.rejects(
      () => port.ensureExactContent(missing, missingRequest),
      /Unexpected token|Expected property name|storage|broken/,
    );
    await assert.rejects(
      () => fixture.store.resumeThread("missing_01", binding.chatSurfaceSessionId),
      /Unexpected token|Expected property name|broken/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed durable state fails closed without a receipt", async () => {
  const fixture = await capability();
  try {
    await fixture.store.createThread(request);
    const threadPath = join(
      fixture.root,
      "tavern",
      "v1",
      "continuities",
      "a".repeat(64),
      "threads",
      "thread_01",
      "thread.json",
    );
    await writeFile(threadPath, "{ malformed", "utf8");
    await assert.rejects(
      () =>
        createInitialChatExactContentPort(fixture.capability).resumeExact(
          binding.chatThreadId,
          binding.companionId,
          binding.continuityId,
          binding.chatSurfaceSessionId,
        ),
      /Unexpected token|Expected property name|malformed/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("genuine stores reject proxy and spread clones without durable artifacts or receipts", async () => {
  const fixture = await capability();
  try {
    for (const candidate of [new Proxy(fixture.store, {}), { ...fixture.store }]) {
      let rejectedResult: unknown;
      assert.throws(() => {
        rejectedResult = createInitialChatExactContentCapability(candidate as never);
      }, /untrusted_chat_thread_store/);
      await assertNoDurableThreadArtifacts(fixture.root, rejectedResult);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("genuine capabilities reject proxy, clones, promises, and thenables without durable artifacts or receipts", async () => {
  const fixture = await capability();
  try {
    const resolvedCapability = Promise.resolve(fixture.capability);
    const thenableResolvingCapability = Object.freeze({
      then(resolve: (value: typeof fixture.capability) => unknown): unknown {
        return resolve(fixture.capability);
      },
    });
    assert.equal(await resolvedCapability, fixture.capability);
    assert.equal(await Promise.resolve(thenableResolvingCapability), fixture.capability);

    for (const candidate of [
      new Proxy(fixture.capability, {}),
      { ...fixture.capability },
      resolvedCapability,
      thenableResolvingCapability,
    ]) {
      let rejectedResult: unknown;
      assert.throws(() => {
        rejectedResult = createInitialChatExactContentPort(candidate as never);
      }, /untrusted_initial_chat_exact_content_capability/);
      await assertNoDurableThreadArtifacts(fixture.root, rejectedResult);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fake stores, capabilities, and receipts are rejected", async () => {
  const fake = Object.freeze({
    resumeExact: async () => ({ kind: "found", receipt: {} }),
    ensureExactContent: async () => ({ kind: "created" }),
  });
  assert.throws(() => createInitialChatExactContentCapability(fake as never), /untrusted_chat_thread_store/);
  assert.throws(
    () => createInitialChatExactContentPort(fake as never),
    /untrusted_initial_chat_exact_content_capability/,
  );
  const fixture = await capability();
  try {
    const port = createInitialChatExactContentPort(fixture.capability);
    const receipt = await port.ensureExactContent(binding, request);
    assert.equal(isTrustedTavernExactContentReceipt({ ...receipt }), false);
    assert.equal(isTrustedTavernExactContentReceipt(JSON.parse(JSON.stringify(receipt))), false);
    assert.equal(isTrustedTavernExactContentReceipt(new Proxy(receipt, {})), false);
    assert.equal(isTrustedTavernExactContentReceipt({ ...receipt, digest: "0".repeat(64) }), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("public initial content port has no explicit create operation", async () => {
  const fixture = await capability();
  try {
    const port = createInitialChatExactContentPort(fixture.capability);
    assert.deepEqual(Object.keys(port).sort(), ["ensureExactContent", "resumeExact"]);
    assert.equal("createExplicit" in port, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("port has no semantic, selector, or mutex imports", async () => {
  const source = await readFile(new URL("./initial-chat-exact-content-port.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import(?:\s+type)?\s+.*(?:continuity-semantic|mutex)/mu);
  assert.doesNotMatch(source, /\.selectActiveThread\(|\.readActiveThread|latest|title/imu);
});
