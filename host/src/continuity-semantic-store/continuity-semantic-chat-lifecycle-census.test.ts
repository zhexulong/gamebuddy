import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  openProductionContinuityStore,
  PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
  type ProductionBootstrapInput,
  type TavernExactContentReceipt,
} from "./continuity-semantic-production-store.js";

const principal = { continuityId: "continuity1", companionId: "companion1", playerId: "player1" } as const;
const bootstrap: ProductionBootstrapInput = {
  principal,
  bootstrapOperationId: "bootstrap1",
  authorityGeneration: 1,
  authorityRootIdentity: "a".repeat(64),
};
const holderBindingDigest = "b".repeat(64);

function receiptFor(chatThreadId: string, chatSurfaceSessionId: string): TavernExactContentReceipt {
  return Object.freeze({
    chatThreadId,
    chatSurfaceSessionId,
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    digest: "c".repeat(64),
  });
}

/** One fresh root whose initial Chat is registered, verified and selected. */
function freshRoot() {
  const root = canonicalTestRootSync("production-chat-lifecycle-census-");
  const control = openProductionContinuityStore({ runtimeRoot: root });
  const metadata = control.bootstrapFresh(bootstrap);
  const store = control.bindBootstrapContext({ bootstrap, metadata });
  const claim = store.claim({
    holderBindingDigest,
    operationId: "claim-1",
    expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
  });
  const registered = store.register({ holderBindingDigest, operationId: "register-1", expected: claim.vector });
  const verified = store.verify(
    { holderBindingDigest, operationId: "verify-1", expected: registered.vector },
    receiptFor(registered.chatThreadId!, registered.chatSurfaceSessionId!),
  );
  store.select({ holderBindingDigest, operationId: "select-1", expected: verified.vector });
  return { root, control, store };
}

/**
 * ADR-0011 deleted the semantic store's Chat lifecycle mirror. Before the deletion this lane censused
 * the corpus (only `active`, zero `transition_chat_lifecycle` commands) and landed that answer; what
 * remains worth gating is that the mirror is really gone rather than merely unread - a leftover column
 * would be a state nothing writes and nothing validates, and a leftover command would be a way back
 * into a state the materialization validator no longer admits.
 *
 * The three facts are read from SQLite's own catalogue, not from the store's types: a schema shape is
 * the only thing that survives a caller that never compiles against these types.
 */
test("the built schema carries no Chat lifecycle mirror", () => {
  const { root, control } = freshRoot();
  control.close();
  const db = new DatabaseSync(join(root, "gamebuddy-continuity-v1.sqlite"), { readOnly: true });
  try {
    const columns = (db.prepare("PRAGMA table_info(production_continuity_thread)").all() as { name: string }[]).map(
      (column) => column.name,
    );
    console.log(`census schema: production_continuity_thread columns -> ${JSON.stringify(columns)}`);
    assert.equal(columns.includes("lifecycle"), false, "the thread table still carries a lifecycle mirror");

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (table) => table.name,
    );
    assert.equal(
      tables.includes("production_chat_lifecycle_metadata"),
      false,
      "the lifecycle metadata table survived the deletion and holds the mirror's CAS",
    );

    const commandSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='production_continuity_command'").get() as {
        sql: string;
      }
    ).sql;
    console.log(`census schema: production_continuity_command -> ${commandSql}`);
    assert.equal(
      commandSql.includes("transition_chat_lifecycle"),
      false,
      "the command ledger still admits transition_chat_lifecycle",
    );

    const version = (
      db.prepare("SELECT schema_version FROM production_store_meta WHERE singleton=1").get() as {
        schema_version: number;
      }
    ).schema_version;
    assert.equal(version, PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION);
  } finally {
    db.close();
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The refusal that survives: the store admits a selection only for a Chat whose exact content it holds.
 * `chat_transition_invalid` is the name it answers with, and it is genuinely reachable - a Chat is
 * registered before its Tavern content is verified - so the code keeps its meaning after the mirror's
 * two refusal codes (`chat_selected_lifecycle_forbidden`,
 * `chat_selection_pending_lifecycle_forbidden`) went with the command they guarded.
 */
test("a select of a Chat the store holds no content receipt for is refused by name", () => {
  const { root, control, store } = freshRoot();
  try {
    const unverified = Object.freeze({ chatThreadId: "chat-unverified", chatSurfaceSessionId: "surface-unverified" });
    store.registerChat(
      Object.freeze({
        operationId: "register-unverified",
        ...unverified,
        expected: { ...store.readChatCatalog().vector },
      }),
    );
    assert.equal(
      store.readChatCatalog().threads.find((thread) => thread.chatThreadId === unverified.chatThreadId)?.contentState,
      "registered",
    );
    assert.throws(
      () =>
        store.selectChat(
          Object.freeze({
            operationId: "select-unverified",
            ...unverified,
            expected: { ...store.readChatCatalog().vector },
          }),
        ),
      /chat_transition_invalid/,
    );
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});
