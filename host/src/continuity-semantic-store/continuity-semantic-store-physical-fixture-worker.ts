import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openProductionContinuityStore } from "./continuity-semantic-production-store.js";

type Mode = "malformed-game-session" | "malformed-game-lease" | "malformed-game-intent";

const tableColumns = {
  production_game_session: ["session_id", "continuity_id", "state"],
  production_game_lease: [
    "continuity_id",
    "session_id",
    "binding_digest",
    "state",
    "lease_revision",
    "world_json",
    "owner_json",
    "fence_token",
    "deadline_at_ms",
  ],
  production_game_intent: [
    "continuity_id",
    "operation_id",
    "session_id",
    "payload_digest",
    "status",
    "request_id",
    "request_json",
    "world_json",
    "owner_json",
    "fence_token",
    "deadline_at_ms",
    "prepared_vector_json",
    "committed_vector_json",
    "receipt_json",
    "receipt_digest",
    "recovery_reason",
  ],
} as const;

function tableSql(db: DatabaseSync, table: keyof typeof tableColumns): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
    | { sql: string }
    | undefined;
  assert.ok(row?.sql, `missing ${table}`);
  return row.sql.replace(/[\s"`]/g, "").toLowerCase();
}

function assertIndependentGameSchema(db: DatabaseSync): void {
  for (const [table, expectedColumns] of Object.entries(tableColumns)) {
    assert.deepEqual(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      expectedColumns,
    );
  }
  assert.match(
    tableSql(db, "production_game_session"),
    /check\(statein\('pending','active','ended','recovery_required'\)\)/,
  );
  assert.match(
    tableSql(db, "production_game_lease"),
    /check\(statein\('owned','close_pending','recovery_required'\)\)/,
  );
  assert.match(
    tableSql(db, "production_game_intent"),
    /check\(statusin\('pending','terminal','aborted','recovery_required'\)\)/,
  );
  const gameSql = Object.keys(tableColumns)
    .map((table) => tableSql(db, table as keyof typeof tableColumns))
    .join(" ");
  for (const forbidden of ["origin_json", "return_chat_session_id", "return_pending", "chat_surface_session_id"])
    assert.equal(gameSql.includes(forbidden), false, `legacy Game authority field leaked: ${forbidden}`);
}

function schemaSnapshot(db: DatabaseSync): unknown {
  return {
    objects: db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all(),
    gameRows: Object.fromEntries(
      Object.keys(tableColumns).map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
    ),
  };
}

function createFixture(root: string, mode: Mode): string {
  const store = openProductionContinuityStore({ runtimeRoot: root });
  store.close();
  const path = `${root}/gamebuddy-continuity-v1.sqlite`;
  const db = new DatabaseSync(path);
  try {
    assertIndependentGameSchema(db);
    if (mode === "malformed-game-session")
      db.exec("ALTER TABLE production_game_session RENAME COLUMN state TO malformed_state");
    if (mode === "malformed-game-lease")
      db.exec("ALTER TABLE production_game_lease RENAME COLUMN state TO malformed_state");
    if (mode === "malformed-game-intent")
      db.exec("ALTER TABLE production_game_intent RENAME COLUMN request_id TO malformed_request_id");
  } finally {
    db.close();
  }
  return path;
}

function run(root: string, mode: Mode): void {
  const path = createFixture(root, mode);
  const before = new DatabaseSync(path);
  let snapshot: unknown;
  try {
    snapshot = schemaSnapshot(before);
  } finally {
    before.close();
  }
  assert.throws(() => openProductionContinuityStore({ runtimeRoot: root }), /unsupported_production_store_schema/);
  const after = new DatabaseSync(path);
  try {
    assert.deepEqual(schemaSnapshot(after), snapshot);
  } finally {
    after.close();
  }
}

const [root, mode] = process.argv.slice(2) as [string | undefined, Mode | undefined];
let failure: unknown;
try {
  if (!root || !mode || !["malformed-game-session", "malformed-game-lease", "malformed-game-intent"].includes(mode))
    throw new Error("invalid_fixture_worker_arguments");
  mkdirSync(root, { recursive: true });
  run(root, mode);
} catch (error) {
  failure = error;
}
try {
  if (root) rmSync(root, { recursive: true, force: true });
} catch (cleanupError) {
  failure ??= cleanupError;
}
if (failure) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure),
    }),
  );
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify({ ok: true, mode }));
