import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PRODUCTION_STORE_DATABASE = "gamebuddy-continuity-v1.sqlite";

/**
 * The v45 shape of the semantic authority, written the way that release wrote it.
 *
 * This is a FROZEN PRE-IMAGE, not a second copy of a shape this build runs: every statement here restores
 * one of the three differences commit 51986ac5 removed - the thread's `lifecycle` column, the
 * `production_chat_lifecycle_metadata` table that carried its CAS, and the `transition_chat_lifecycle`
 * member of the `command_kind` CHECK - plus the version CHECK that named 45. It exists because a migration
 * can only be tested against the file it is about, and no build can mint that file any more.
 *
 * It is shared by the store's migration gate and the provisioning upgrade gate so the two are reading the
 * same pre-image; a fixture per file would let one of them drift into testing a shape that never existed.
 */
export function rewriteProductionStoreAsVersion45(runtimeRoot: string): void {
  const db = new DatabaseSync(join(runtimeRoot, PRODUCTION_STORE_DATABASE));
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(
      `CREATE TABLE production_continuity_thread_v45 (chat_surface_session_id TEXT PRIMARY KEY REFERENCES production_surface_session(session_id), continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), chat_thread_id TEXT NOT NULL, companion_id TEXT NOT NULL, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived','trashed')), content_receipt_json TEXT, content_receipt_digest TEXT, UNIQUE(continuity_id,chat_thread_id), CHECK((content_receipt_json IS NULL AND content_receipt_digest IS NULL) OR (content_receipt_json IS NOT NULL AND content_receipt_digest IS NOT NULL)))`,
    );
    db.exec(
      "INSERT INTO production_continuity_thread_v45(chat_surface_session_id,continuity_id,chat_thread_id,companion_id,lifecycle,content_receipt_json,content_receipt_digest) SELECT chat_surface_session_id,continuity_id,chat_thread_id,companion_id,'active',content_receipt_json,content_receipt_digest FROM production_continuity_thread",
    );
    db.exec("DROP TABLE production_continuity_thread");
    db.exec("ALTER TABLE production_continuity_thread_v45 RENAME TO production_continuity_thread");
    db.exec(
      "CREATE INDEX production_thread_partition_index ON production_continuity_thread(continuity_id,chat_thread_id)",
    );
    db.exec(
      `CREATE TABLE production_chat_lifecycle_metadata (chat_surface_session_id TEXT PRIMARY KEY REFERENCES production_continuity_thread(chat_surface_session_id), management_revision INTEGER NOT NULL CHECK(management_revision>=1), trash_restore_lifecycle TEXT CHECK(trash_restore_lifecycle IN ('active','archived')))`,
    );
    db.exec(
      "INSERT INTO production_chat_lifecycle_metadata(chat_surface_session_id,management_revision,trash_restore_lifecycle) SELECT chat_surface_session_id,1,NULL FROM production_continuity_thread",
    );
    db.exec(
      `CREATE TABLE production_continuity_command_v45 (continuity_id TEXT NOT NULL REFERENCES production_partition(continuity_id), operation_id TEXT NOT NULL, command_kind TEXT NOT NULL CHECK(command_kind IN ('register_chat','verify_chat_content','select_chat','transition_chat_lifecycle')), payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, response_json TEXT NOT NULL, response_digest TEXT NOT NULL, committed_vector_json TEXT NOT NULL, PRIMARY KEY(continuity_id,operation_id))`,
    );
    db.exec("INSERT INTO production_continuity_command_v45 SELECT * FROM production_continuity_command");
    db.exec("DROP TABLE production_continuity_command");
    db.exec("ALTER TABLE production_continuity_command_v45 RENAME TO production_continuity_command");
    db.exec(
      `CREATE TABLE production_store_meta_v45 (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL CHECK(schema_version=45))`,
    );
    db.exec("INSERT INTO production_store_meta_v45 SELECT singleton,store_id,45 FROM production_store_meta");
    db.exec("DROP TABLE production_store_meta");
    db.exec("ALTER TABLE production_store_meta_v45 RENAME TO production_store_meta");
  } finally {
    db.close();
  }
}
