import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CHAT_DRAFT_TEXT_MAX_LENGTH, createChatDraftStore, type ChatDraftScope } from "./chat-draft-store.js";

const scope: ChatDraftScope = Object.freeze({
  chatThreadId: "thread-opaque-01",
  chatSurfaceSessionId: "surface-opaque-01",
  companionId: "companion-opaque-01",
  continuityId: "continuity-opaque-01",
});

async function fixture(): Promise<Readonly<{ root: string; store: ReturnType<typeof createChatDraftStore> }>> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-draft-"));
  return Object.freeze({ root, store: createChatDraftStore(root) });
}

test("chat drafts are durable revisioned state with atomic update readback and discard", async () => {
  const { root, store } = await fixture();
  try {
    assert.deepEqual(await store.read(scope), { revision: 0, text: null });
    assert.deepEqual(await store.update({ scope, expectedRevision: 0, text: "A message still being written" }), {
      revision: 1,
      text: "A message still being written",
    });
    assert.deepEqual(await createChatDraftStore(root).read(scope), {
      revision: 1,
      text: "A message still being written",
    });
    assert.deepEqual(await store.discard({ scope, expectedRevision: 1 }), { revision: 2, text: null });
    assert.deepEqual(await store.delete({ scope, expectedRevision: 2 }), { revision: 3, text: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chat drafts do not remove a pre-existing temporary write target", async () => {
  const { root } = await fixture();
  const fixedTemporaryId = "fixed-temp-id";
  const store = createChatDraftStore(root, { randomUUID: () => fixedTemporaryId });
  const key = createHash("sha256")
    .update(`${scope.chatThreadId}\u001f${scope.chatSurfaceSessionId}`, "utf8")
    .digest("hex");
  const dataPath = join(root, "tavern", "v1", "chat-drafts", "drafts", `${key}.json`);
  const temporaryPath = `${dataPath}.${process.pid}.${fixedTemporaryId}.tmp`;
  try {
    await store.read(scope);
    await writeFile(temporaryPath, "pre-existing temporary content", "utf8");
    await assert.rejects(
      store.update({ scope, expectedRevision: 0, text: "must not overwrite temporary" }),
      /EEXIST/,
    );
    assert.equal(await readFile(temporaryPath, "utf8"), "pre-existing temporary content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chat drafts cleanup waits for the final scoped store operation", async () => {
  const { root, store } = await fixture();
  await store.update({ scope, expectedRevision: 0, text: "cleanup boundary" });
  await store.read(scope);
  await rm(root, { recursive: true, force: true });
});

test("chat drafts reject stale revisions, invalid text, and scope mismatch without leaking raw ids to read models", async () => {
  const { root, store } = await fixture();
  try {
    await store.update({ scope, expectedRevision: 0, text: "private draft" });
    await assert.rejects(store.update({ scope, expectedRevision: 0, text: "stale" }), /chat_draft_revision_conflict/);
    await assert.rejects(store.update({ scope, expectedRevision: 1, text: "" }), /invalid_chat_draft_text/);
    await assert.rejects(store.update({ scope, expectedRevision: 1, text: "bad\ntext" }), /invalid_chat_draft_text/);
    await assert.rejects(
      store.update({ scope, expectedRevision: 1, text: "x".repeat(CHAT_DRAFT_TEXT_MAX_LENGTH + 1) }),
      /invalid_chat_draft_text/,
    );

    const otherScope = { ...scope, chatSurfaceSessionId: "surface-opaque-02" };
    assert.deepEqual(await store.read(otherScope), { revision: 0, text: null });
    await assert.rejects(store.read({ ...scope, companionId: "companion-opaque-02" }), /chat_draft_scope_mismatch/);
    assert.deepEqual(Object.keys(await store.read(scope)).sort(), ["revision", "text"]);

    const files = await readFile(join(root, "tavern", "v1", "chat-drafts", "index.json"), "utf8");
    assert.equal(files.includes(scope.chatThreadId), false);
    assert.equal(files.includes(scope.chatSurfaceSessionId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chat drafts fail closed when an external drafts junction replaces their parent", async (t) => {
  const { root, store } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "gamebuddy-chat-draft-sentinel-"));
  const draftsPath = join(root, "tavern", "v1", "chat-drafts", "drafts");
  const movedDraftsPath = join(root, "tavern", "v1", "chat-drafts", "drafts-real");
  const sentinelPath = join(outside, "sentinel.txt");
  try {
    await store.update({ scope, expectedRevision: 0, text: "protected" });
    await writeFile(sentinelPath, "must remain untouched", "utf8");
    await rename(draftsPath, movedDraftsPath);
    try {
      await symlink(outside, draftsPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(store.read(scope), /unsafe_path_boundary/);
    await assert.rejects(store.update({ scope, expectedRevision: 1, text: "must not escape" }), /unsafe_path_boundary/);
    assert.equal(await readFile(sentinelPath, "utf8"), "must remain untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("chat draft storage detects a persisted scope collision rather than crossing scopes", async () => {
  const { root, store } = await fixture();
  try {
    await store.update({ scope, expectedRevision: 0, text: "private draft" });
    const indexPath = join(root, "tavern", "v1", "chat-drafts", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as { entries: Record<string, { scopeDigest: string }> };
    const [key] = Object.keys(index.entries);
    index.entries[key]!.scopeDigest = "0".repeat(64);
    await (await import("node:fs/promises")).writeFile(indexPath, JSON.stringify(index), "utf8");
    await assert.rejects(store.read(scope), /chat_draft_scope_mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
