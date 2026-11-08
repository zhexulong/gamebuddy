import { createHash } from "node:crypto";
import { type FileHandle, copyFile, mkdtemp, lstat, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { HostDeploymentManifest } from "../deployment-manifest.js";
import {
  discoverProfileBackupSources,
  type ProfileBackupAuthorityId,
  ProfileBackupAuthorityUnreadable,
} from "./profile-backup-authorities.js";

/** The archive format a restore must recognise before it interprets a single field. */
const PROFILE_BACKUP_FORMAT = "gamebuddy.profile-backup/v1";

/**
 * A whole-profile backup: one file, or a refusal that names the authorities it could not read.
 *
 * `refused` carries ids rather than a sentence because the sentence belongs to the surface, which
 * knows the player's language; the id is the fact, and it names a member of
 * `PROFILE_BACKUP_AUTHORITIES`.
 */
export type ProfileBackupExport =
  | Readonly<{ status: "saved"; fileName: string; document: string }>
  | Readonly<{ status: "refused"; unreadable: readonly ProfileBackupAuthorityId[] }>;

type ProfileBackupManifest = Readonly<{
  format: typeof PROFILE_BACKUP_FORMAT;
  createdAtMs: number;
  /** The runtime root the archive describes: the identity of what was copied. */
  authorityRoot: string;
  /**
   * The deployment contract this installation declares. The product publishes no product
   * version at runtime, and a private package's `0.0.0` is not one; what a restore actually
   * needs in order to interpret these bytes is this schema, and each authority's own schema
   * version below.
   */
  deployment: Readonly<{
    schemaVersion: number;
    topology: string;
    authorityGeneration: number;
    principal: Readonly<{ playerId: string; companionId: string; continuityId: string }>;
  }>;
}>;

type ProfileBackupEntry = Readonly<{
  /** `/`-separated path relative to the runtime root: where a restore puts the bytes back. */
  path: string;
  bytes: number;
  /**
   * SHA-256 of exactly these bytes.
   *
   * One incident justifies it: the archive is a JSON text file whose whole purpose is to be
   * copied to another machine, and a copy that mangles a character - an editor normalising the
   * file, a cloud client truncating a transfer, a tool rewriting a page - still parses as JSON.
   * Without the digest a player restores mangled dialogue believing it is theirs. Truncation of
   * the document is caught by JSON parsing and by the declared `bytes`, so the digest is here for
   * silent replacement only, not as a seal.
   */
  sha256: string;
  /** `PRAGMA user_version` of the snapshot, for the authorities that carry one. */
  schemaVersion?: number;
  /** Base64 of the exact bytes: one encoding for text and binary alike. */
  content: string;
}>;

type ProfileBackupAuthorityRecord = Readonly<{
  id: ProfileBackupAuthorityId;
  count: number;
  bytes: number;
  entries: readonly ProfileBackupEntry[];
}>;

export type ProfileBackupDocument = Readonly<{
  manifest: ProfileBackupManifest;
  /** One record per declared authority, in declaration order, including empty ones. */
  authorities: readonly ProfileBackupAuthorityRecord[];
}>;

const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000", "latin1");

/**
 * Reads the installation and returns one archive, opening nothing for writing.
 *
 * Read-only is a property of the code rather than a promise: every file is opened with the `r`
 * flag, byte copies read the source and write only into a scratch directory outside the runtime
 * root, and the one SQLite connection this function opens is `readOnly: true` (see
 * `ProfileBackupSnapshots` for when that connection is opened at all). No file under the runtime
 * root is created, opened for writing, or locked exclusively, so a Chat or Game that is merely
 * idle is never locked out and never has to be stopped first.
 */
export async function exportProfileBackup(options: {
  deployment: HostDeploymentManifest;
  nowMs?: () => number;
}): Promise<ProfileBackupExport> {
  const nowMs = options.nowMs ?? Date.now;
  const createdAtMs = nowMs();
  const root = resolve(options.deployment.runtimeRoot);
  const unreadable: ProfileBackupAuthorityId[] = [];
  const records: ProfileBackupAuthorityRecord[] = [];
  const scratch = await mkdtemp(join(tmpdir(), "gamebuddy-profile-backup-"));
  try {
    for (const { authority, files } of await discoverProfileBackupSources(root)) {
      const entries: ProfileBackupEntry[] = [];
      try {
        const snapshots = new ProfileBackupSnapshots(scratch);
        for (const relative of files) {
          const read = await snapshots.read(join(root, ...relative.split("/")), authority.id);
          if (read === null) continue;
          entries.push(
            Object.freeze({
              path: relative,
              bytes: read.content.length,
              sha256: createHash("sha256").update(read.content).digest("hex"),
              ...(read.schemaVersion === undefined ? {} : { schemaVersion: read.schemaVersion }),
              content: read.content.toString("base64"),
            }),
          );
        }
      } catch (error) {
        if (!(error instanceof ProfileBackupAuthorityUnreadable)) throw error;
        unreadable.push(authority.id);
        continue;
      }
      records.push(
        Object.freeze({
          id: authority.id,
          count: entries.length,
          bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
          entries: Object.freeze(entries),
        }),
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  if (unreadable.length > 0) return Object.freeze({ status: "refused", unreadable: Object.freeze(unreadable) });
  const name = `gamebuddy-profile-backup-${new Date(createdAtMs).toISOString().replaceAll(/[:.]/gu, "-")}.json`;
  const document: ProfileBackupDocument = Object.freeze({
    manifest: Object.freeze({
      format: PROFILE_BACKUP_FORMAT,
      createdAtMs,
      authorityRoot: root,
      deployment: Object.freeze({
        schemaVersion: options.deployment.schemaVersion,
        topology: options.deployment.topology,
        authorityGeneration: options.deployment.authorityGeneration,
        principal: Object.freeze({
          playerId: options.deployment.principal.playerId,
          companionId: options.deployment.principal.companionId,
          continuityId: options.deployment.principal.continuityId,
        }),
      }),
    }),
    authorities: Object.freeze(records),
  });
  return Object.freeze({ status: "saved", fileName: name, document: JSON.stringify(document) });
}

/**
 * Materialises the databases one archive holds, without writing into the installation.
 *
 * Two cases, and the difference is the database's own on-disk state rather than a heuristic:
 *
 *  - **A journal sidecar exists** (`-wal` or `-journal`): committed state is not all in the
 *    main file, so a byte copy could capture a half-applied checkpoint. The database is
 *    materialised through a read-only connection with `VACUUM INTO` - SQLite's own snapshot,
 *    which folds the `-wal` into one consistent file and takes only the shared lock a reader
 *    takes. The `-wal`/`-shm` siblings are then skipped, because restoring both would replay
 *    a state the archive was not taken at.
 *  - **No sidecar**: every committed page is already in the main file (SQLite deletes the
 *    `-wal` after checkpointing on the last connection's close), so the file is copied
 *    byte for byte and no connection is ever opened against the installation at all.
 */
class ProfileBackupSnapshots {
  readonly #scratch: string;
  readonly #materialised = new Set<string>();
  #count = 0;

  public constructor(scratch: string) {
    this.#scratch = scratch;
  }

  public async read(
    absolute: string,
    authorityId: ProfileBackupAuthorityId,
  ): Promise<Readonly<{ content: Buffer; schemaVersion?: number }> | null> {
    if (this.#materialised.has(absolute)) return null;
    if (!(await this.#isDatabase(absolute, authorityId)))
      return Object.freeze({ content: await readBytes(absolute, authorityId) });
    const copy = join(this.#scratch, `${this.#count}.sqlite`);
    this.#count += 1;
    if (await hasJournalSidecar(absolute)) snapshotThroughSqlite(absolute, copy, authorityId);
    else await copyBytes(absolute, copy, authorityId);
    this.#materialised.add(absolute);
    this.#materialised.add(`${absolute}-wal`);
    this.#materialised.add(`${absolute}-shm`);
    return Object.freeze({
      content: await readBytes(copy, authorityId),
      schemaVersion: readUserVersion(copy, authorityId),
    });
  }

  async #isDatabase(absolute: string, authorityId: ProfileBackupAuthorityId): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(absolute, "r");
    } catch (error) {
      throw new ProfileBackupAuthorityUnreadable(authorityId, absolute, error);
    }
    try {
      const head = Buffer.alloc(SQLITE_HEADER.length);
      const read = await handle.read(head, 0, SQLITE_HEADER.length, 0);
      return read.bytesRead === SQLITE_HEADER.length && head.equals(SQLITE_HEADER);
    } finally {
      await handle.close();
    }
  }
}

async function hasJournalSidecar(absolute: string): Promise<boolean> {
  for (const sidecar of [`${absolute}-wal`, `${absolute}-journal`]) {
    try {
      await lstat(sidecar);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function snapshotThroughSqlite(absolute: string, copy: string, authorityId: ProfileBackupAuthorityId): void {
  try {
    const database = new DatabaseSync(absolute, { readOnly: true });
    try {
      database.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    } finally {
      database.close();
    }
  } catch (error) {
    throw new ProfileBackupAuthorityUnreadable(authorityId, absolute, error);
  }
}

async function copyBytes(absolute: string, copy: string, authorityId: ProfileBackupAuthorityId): Promise<void> {
  try {
    await copyFile(absolute, copy);
  } catch (error) {
    throw new ProfileBackupAuthorityUnreadable(authorityId, absolute, error);
  }
}

function readUserVersion(path: string, authorityId: ProfileBackupAuthorityId): number {
  try {
    const snapshot = new DatabaseSync(path, { readOnly: true });
    try {
      const row = snapshot.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      return Number(row?.user_version ?? 0);
    } finally {
      snapshot.close();
    }
  } catch (error) {
    throw new ProfileBackupAuthorityUnreadable(authorityId, path, error);
  }
}

async function readBytes(absolute: string, authorityId: ProfileBackupAuthorityId): Promise<Buffer> {
  try {
    return await readFile(absolute);
  } catch (error) {
    throw new ProfileBackupAuthorityUnreadable(authorityId, absolute, error);
  }
}
