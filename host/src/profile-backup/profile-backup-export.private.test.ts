import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { HostDeploymentManifest } from "../deployment-manifest.js";
import { provisionFreshProductionContinuity } from "../continuity-semantic-provisioning/continuity-semantic-provisioning.internal.js";
import { identityKey, resolveRuntimePaths } from "../runtime-identity.js";
import { PlayerPreferenceStore, playerPreferencePath } from "../settings/player-preference-store.js";
import { CHAT_THREAD_SCHEMA_VERSION, createChatThreadStore } from "../tavern/chat-thread-store.js";
import { provisionDirectNewCompanion } from "../tavern/new-companion-service.js";
import { createStCardImportHistoryService } from "../tavern/st-card-import-history.js";
import { resolveTavernPaths } from "../tavern/tavern-paths.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { PROFILE_BACKUP_AUTHORITIES, type ProfileBackupAuthorityId } from "./profile-backup-authorities.js";
import { exportProfileBackup, type ProfileBackupDocument } from "./profile-backup-export.js";

const playerId = "profile_backup_player";

type Fixture = Readonly<{
  root: string;
  deployment: HostDeploymentManifest;
  identity: Readonly<{ playerId: string; companionId: string; continuityId: string }>;
}>;

/**
 * One installation as the product itself writes it: a provisioned companion, her Chat store, the
 * player's settings record, a managed World Info book, one confirmed import's history, the semantic
 * continuity authority, and the Magic Context store the runtime points itself at.
 *
 * Every member is written through the module that owns it, so the test's population is the real
 * on-disk layout rather than a transcription of it. The Magic Context store is the one boundary
 * this lane does not own: its directory and `context.db` name are the vendor's, and this fixture
 * creates that file with SQLite directly rather than pretending to be the vendor's writer.
 */
async function fixture(): Promise<Fixture> {
  const root = await canonicalTestRoot("profile-backup-");
  const created = await provisionDirectNewCompanion(root, playerId, "Backup Buddy");
  const identity = Object.freeze({
    playerId,
    companionId: created.identity.companionId,
    continuityId: created.identity.continuityId!,
  });
  const runtime = resolveRuntimePaths(identity, root);
  const tavern = resolveTavernPaths(runtime, identity);

  const threads = createChatThreadStore(root, identityKey(identity));
  await threads.listThreads?.();
  threads.close?.();

  await new PlayerPreferenceStore(playerPreferencePath(root)).update(0, { action: "setLocale", locale: "zh-CN" });

  await createWorldInfoManagementRepository(root).create({
    publicTitle: "Pelican Town",
    summary: "The town the player lives beside.",
    entries: [{ scope: "setting", publicTitle: "Pelican Town", summary: "The town the player lives beside." }],
  });

  await createStCardImportHistoryService(new TavernArtifactStore(root), tavern.playerRoot).record({
    importId: "import_01",
    occurredAtMs: 1_760_000_000_000,
    cardName: "Backup Buddy",
    companionId: identity.companionId,
    dispositions: [{ classification: "accepted_typed" }],
  });

  provisionFreshProductionContinuity({
    runtimeCwd: runtime.runtimeCwd,
    principal: identity,
    bootstrapOperationId: "bootstrap_profile_backup",
    authorityGeneration: 1,
  }).close();

  const memoryRoot = join(runtime.runtimeCwd, "data", "cortexkit", "magic-context");
  await mkdir(memoryRoot, { recursive: true });
  const memory = new DatabaseSync(join(memoryRoot, "context.db"));
  try {
    memory.exec("CREATE TABLE memory_items(id INTEGER PRIMARY KEY, body TEXT)");
    memory.prepare("INSERT INTO memory_items(id, body) VALUES(1, 'the player promised to return')").run();
  } finally {
    memory.close();
  }

  return Object.freeze({
    root,
    identity,
    deployment: Object.freeze({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: root,
      principal: identity,
      bootstrapOperationId: "bootstrap_profile_backup",
      authorityGeneration: 1,
    }),
  });
}

function documentOf(exported: Awaited<ReturnType<typeof exportProfileBackup>>): ProfileBackupDocument {
  assert.equal(exported.status, "saved", "the fixture installation is fully readable, so the export must not refuse");
  return JSON.parse(exported.document) as ProfileBackupDocument;
}

function authorityOf(document: ProfileBackupDocument, id: ProfileBackupAuthorityId) {
  const record = document.authorities.find((authority) => authority.id === id);
  assert.ok(record, `the archive carries no record for the declared authority ${id}`);
  return record;
}

/**
 * The archive's population and the walk's population are one declaration.
 *
 * Red-proof: point any member of `PROFILE_BACKUP_AUTHORITIES` at a path the product does not write
 * (this lane ran `tavern/v3` -> `tavern/v9`) and this test fails naming that authority with a zero
 * count, which is the drift it exists for.
 */
test("every declared authority is in the archive, in declaration order, with files of its own", async () => {
  const f = await fixture();
  try {
    const document = documentOf(await exportProfileBackup({ deployment: f.deployment }));
    assert.deepEqual(
      document.authorities.map((authority) => authority.id),
      PROFILE_BACKUP_AUTHORITIES.map((authority) => authority.id),
      "the manifest's authority list is not the declaration the export walked",
    );
    assert.deepEqual(
      document.authorities.filter((authority) => authority.count === 0).map((authority) => authority.id),
      [],
      "a declared authority contributed no files: the declaration names a place the product does not write",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * The bytes are the authority's own, not a re-serialisation of it.
 *
 * The Chat store declares its schema in `PRAGMA user_version`; the archive's own `schemaVersion` and
 * the restored file's `user_version` are read from that one place and asserted equal to the module's
 * constant, so a backup that copied a half-applied database (or one encoded wrongly) fails here.
 */
test("the Chat database in the archive opens as the Chat store's own schema", async () => {
  const f = await fixture();
  try {
    const document = documentOf(await exportProfileBackup({ deployment: f.deployment }));
    const chats = authorityOf(document, "chats");
    const entry = chats.entries.find((candidate) => candidate.path.endsWith("/tavern.sqlite"));
    assert.ok(entry, "the archive carries no Chat database, so the fixture's chats were not backed up");
    assert.equal(entry.schemaVersion, CHAT_THREAD_SCHEMA_VERSION);
    const restored = join(await mkdtemp(join(tmpdir(), "profile-backup-restore-")), "tavern.sqlite");
    await writeFile(restored, Buffer.from(entry.content, "base64"));
    try {
      const database = new DatabaseSync(restored, { readOnly: true });
      try {
        assert.equal(
          (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
          CHAT_THREAD_SCHEMA_VERSION,
        );
      } finally {
        database.close();
      }
    } finally {
      await rm(restored, { force: true });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * The export is a read: the installation it describes is byte-identical afterwards.
 *
 * This is the property, not a code review of it. Every file under the runtime root is fingerprinted
 * before and after the export, and the reading is the whole tree - so a write of any kind (a
 * created `-wal`, a checkpointed database, a touched record) fails here rather than reaching a
 * player whose Chats were quietly rewritten by the button that was supposed to save them.
 */
test("exporting a closed profile creates and changes nothing under the runtime root", async () => {
  const f = await fixture();
  try {
    const before = await fingerprintTree(f.root);
    const exported = await exportProfileBackup({ deployment: f.deployment });
    assert.equal(exported.status, "saved");
    assert.deepEqual(await fingerprintTree(f.root), before);
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * A Chat that is merely idle is never locked out, and an in-flight write never blocks the export.
 *
 * The reader takes only the shared lock SQLite's readers take, so a second connection holding the
 * write lock is not a reason for the export to wait: it reads the last committed state and returns.
 */
test("the export completes while another connection holds the Chat store's write lock", async () => {
  const f = await fixture();
  const databasePath = join(f.root, "tavern", "v3", "continuities", identityKey(f.identity), "tavern.sqlite");
  const writer = new DatabaseSync(databasePath);
  try {
    writer.exec("BEGIN IMMEDIATE");
    const startedAtMs = Date.now();
    const exported = await exportProfileBackup({ deployment: f.deployment });
    const elapsedMs = Date.now() - startedAtMs;
    assert.equal(exported.status, "saved");
    assert.ok(elapsedMs < 5_000, `the export waited ${elapsedMs} ms on a write lock a reader must not need`);
    writer.exec("ROLLBACK");
  } finally {
    writer.close();
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * A declared authority that cannot be read is named, and the archive is not written.
 *
 * The injection is a real one: a file that announces itself as a SQLite database (the format's own
 * header) and is not one. Merely existing is enough to make the authority unreadable, and the
 * refusal must say which authority rather than "the backup failed".
 */
test("an unreadable authority is named in the refusal", async () => {
  const f = await fixture();
  try {
    const broken = join(f.root, "world-info-management", "revisions", "corrupt.sqlite");
    await writeFile(broken, Buffer.concat([Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.alloc(64, 7)]));
    const exported = await exportProfileBackup({ deployment: f.deployment });
    assert.equal(exported.status, "refused");
    assert.deepEqual(exported.status === "refused" ? exported.unreadable : [], ["world-info"]);
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** Every file under the root, with its size and a digest of its bytes. */
async function fingerprintTree(root: string): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative === "" ? root : join(root, relative);
    for (const entry of (await readdir(absolute)).sort()) {
      const childRelative = relative === "" ? entry : `${relative}/${entry}`;
      const info = await stat(join(root, childRelative));
      if (info.isDirectory()) {
        fingerprints.set(`${childRelative}/`, "directory");
        await walk(childRelative);
        continue;
      }
      const bytes = await readFile(join(root, childRelative));
      fingerprints.set(childRelative, `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  };
  await walk("");
  return fingerprints;
}
