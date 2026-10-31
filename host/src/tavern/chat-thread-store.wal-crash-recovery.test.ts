import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "./chat-thread-store.js";

/**
 * The chat store's crash recovery, which is the other half of the durability story and a
 * different mechanism: this store runs `journal_mode=WAL; synchronous=NORMAL`, so a killed
 * process leaves `-wal`/`-shm` behind instead of a rollback journal, and recovery replays
 * the committed frames that never reached the main file.
 *
 * What must hold afterwards, for a player whose Host was killed rather than closed: the
 * store opens, the last committed turn is present, the interrupted one is absent, and no
 * human touches a file.
 */

const continuityKey = "b".repeat(64);
const profileReader = {
  async readExact() {
    return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
  },
};

function threadRequest() {
  return {
    chatThreadId: "thread_01",
    companionId: "companion_01",
    continuityId: "continuity_01",
    chatSurfaceSessionId: "surface_01",
    opening: "blank",
  } as const;
}

async function disposeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

test("the chat store recovers from a killed WAL commit and reopens with the committed turn intact", async () => {
  const root = await canonicalTestRoot("gamebuddy-chat-wal-crash-");
  try {
    // A real thread first, so the killed transaction is an ordinary append against an
    // existing schema rather than the schema creation itself.
    const store = createChatThreadStore(root, continuityKey, () => 100);
    const creation = createProfileAwareChatThreadCreationCapability(store, profileReader);
    await creation.createExplicit(threadRequest());
    await store.appendPlayer!("thread_01", { messageId: "kept-message", text: "kept", occurredAtMs: 110 });
    store.close?.();

    const databasePath = join(root, "tavern", "v3", "continuities", continuityKey, "tavern.sqlite");
    const childPath = join(root, "killed-append.mjs");
    // The child appends one message and commits, then starts a second append and dies inside
    // it. `synchronous=NORMAL` under WAL means the first commit lives in the WAL file, not in
    // the main database, so this is the exact state a killed Host leaves behind.
    writeFileSync(
      childPath,
      [
        'import { DatabaseSync } from "node:sqlite";',
        'import { writeFileSync } from "node:fs";',
        "const [dbPath, markerPath] = process.argv.slice(2);",
        "const db = new DatabaseSync(dbPath);",
        'db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");',
        "const append = (id, ordinal, text) => {",
        '  db.prepare("INSERT INTO tavern_messages(thread_id,message_id,append_ordinal,role,kind,text,occurred_at_ms) VALUES(?,?,?,?,?,?,?)").run("thread_01", id, ordinal, "player", "player", text, 200);',
        "};",
        'db.exec("BEGIN IMMEDIATE");',
        'append("child-committed", 2, "committed before the kill");',
        'db.exec("COMMIT");',
        'db.exec("BEGIN IMMEDIATE");',
        'append("child-interrupted", 3, "never committed");',
        'writeFileSync(markerPath, "uncommitted");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const markerPath = join(root, "marker.txt");
    const child = spawn(process.execPath, [childPath, databasePath, markerPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (!existsSync(markerPath)) return;
        clearInterval(timer);
        resolve();
      }, 20);
      child.once("error", reject);
      child.once("exit", () => {
        clearInterval(timer);
        reject(new Error("the appending process exited before it reached its uncommitted insert"));
      });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    // The WAL file is the recovery work, and asserting it exists is what stops this test
    // from passing by reopening a database that was never interrupted.
    assert.ok(
      existsSync(`${databasePath}-wal`),
      `no -wal file was left beside ${databasePath}: the kill did not interrupt a WAL transaction, so this test proved nothing about recovery`,
    );

    // No manual intervention: open the store the way the product does and read through it.
    const reopened = createChatThreadStore(root, continuityKey, () => 300);
    try {
      const state = await reopened.resumeThread("thread_01", "surface_01");
      const ids = state.messages.map((message) => message.messageId);
      assert.ok(
        ids.includes("kept-message"),
        `the message committed before the child ran is gone (saw ${ids.join(", ")}): recovery did not preserve committed history`,
      );
      assert.ok(
        ids.includes("child-committed"),
        `the message the child COMMITTED before being killed is gone (saw ${ids.join(", ")}): WAL recovery did not replay a committed frame`,
      );
      assert.ok(
        !ids.includes("child-interrupted"),
        `the message the child was killed before committing is present (saw ${ids.join(", ")}): an uncommitted WAL frame was made durable`,
      );
      const reader = new DatabaseSync(databasePath);
      try {
        assert.equal(
          (reader.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
          "ok",
          "the chat database reports damage after recovering from a killed WAL commit",
        );
      } finally {
        reader.close();
      }
    } finally {
      reopened.close?.();
    }
  } finally {
    await disposeRoot(root);
  }
});
