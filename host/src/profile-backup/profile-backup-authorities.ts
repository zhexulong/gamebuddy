import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Every durable authority a whole-profile backup must contain, declared once.
 *
 * This list is the archive's population. Nothing else in the backup path may name an
 * authority or a path: the manifest is built from this declaration, the walk reads it,
 * and the fixture test fails when a member here names a place the product does not write.
 * A hand-written second list is how a backup silently stops covering the thing that was
 * added last week.
 *
 * What is deliberately NOT here, and why:
 *
 *  - `contexts/<identity>/pi-agent/` and `contexts/<identity>/surface-sessions/` hold the
 *    embedded runtime's own session records and its per-launch handoff. They are the
 *    runtime's private state, they can carry provider material, and no player-authored
 *    fact lives only there.
 *  - `companion-run-manifest.json` and `.gamebuddy-internal-locks/` are per-launch
 *    operational records: restoring them would describe a run that is not this one.
 *  - `stardew/` and the game world itself belong to the installation and the save file,
 *    not to the profile: they name this machine's paths, and a backup that carried them
 *    would claim a game install the restoring machine may not have.
 *  - credentials never enter this archive. The provider connection store keeps its secret
 *    in the current user's credential vault, not in a file under the runtime root.
 */
export type ProfileBackupAuthority = Readonly<{
  /** Stable, machine-legible name that the manifest and a refusal both spell. */
  id: ProfileBackupAuthorityId;
  /** Root-relative directories (whole subtree) or single files under the runtime root. */
  roots: readonly string[];
  /** Root-relative paths resolved under every `contexts/<identityKey>/` the root holds. */
  perIdentity: readonly string[];
}>;

export type ProfileBackupAuthorityId =
  | "settings"
  | "companions"
  | "player-library"
  | "chats"
  | "world-info"
  | "identity"
  | "continuity"
  | "memory";

/**
 * The one declaration. Each `roots` member is the durable root its owning module writes:
 * `settings/` (`player-preference-store.ts`, `model-profile-store.ts`), `tavern/v1/companions`
 * (`library-service.ts` + `TavernArtifactStore`), `tavern/v1/players` (the card-import history
 * under `tavern-paths.ts`'s `playerRoot`), `tavern/v3` (`chat-thread-store.ts`), and
 * `world-info-management/` (`world-info-management.ts`). The per-identity members are the
 * three files `runtime-identity.ts` names on the identity root, the semantic authority
 * directory `continuity-semantic-provisioning` creates, and the Magic Context store the
 * runtime points `MAGIC_CONTEXT_STORAGE_DIR` at.
 */
export const PROFILE_BACKUP_AUTHORITIES: readonly ProfileBackupAuthority[] = Object.freeze([
  Object.freeze({ id: "settings", roots: Object.freeze(["settings"]), perIdentity: Object.freeze([]) }),
  Object.freeze({ id: "companions", roots: Object.freeze(["tavern/v1/companions"]), perIdentity: Object.freeze([]) }),
  Object.freeze({ id: "player-library", roots: Object.freeze(["tavern/v1/players"]), perIdentity: Object.freeze([]) }),
  Object.freeze({ id: "chats", roots: Object.freeze(["tavern/v3"]), perIdentity: Object.freeze([]) }),
  Object.freeze({ id: "world-info", roots: Object.freeze(["world-info-management"]), perIdentity: Object.freeze([]) }),
  Object.freeze({
    id: "identity",
    roots: Object.freeze([]),
    perIdentity: Object.freeze(["identity-profile.json", "identity-profile-binding.json", "worldbook.json"]),
  }),
  Object.freeze({
    id: "continuity",
    roots: Object.freeze([]),
    perIdentity: Object.freeze([".gamebuddy-semantic-continuity-v1"]),
  }),
  Object.freeze({ id: "memory", roots: Object.freeze([]), perIdentity: Object.freeze(["data/cortexkit"]) }),
] as const);

/**
 * One authority could not be read.
 *
 * The id is the whole point: "the backup failed" leaves a player with a button that does
 * not work and no way to tell whether their chats, their companions or their Memory is the
 * unreadable one. The id is the same member `PROFILE_BACKUP_AUTHORITIES` declares.
 */
export class ProfileBackupAuthorityUnreadable extends Error {
  public constructor(
    public readonly authorityId: ProfileBackupAuthorityId,
    public readonly path: string,
    public readonly reason: unknown,
  ) {
    super(`profile_backup_authority_unreadable:${authorityId}`);
    this.name = "ProfileBackupAuthorityUnreadable";
  }
}

export type ProfileBackupSources = Readonly<{
  authority: ProfileBackupAuthority;
  /** Root-relative file paths, `/`-separated, in directory order. */
  files: readonly string[];
}>;

/**
 * Every regular file each declared authority holds, discovered by walking the declaration.
 *
 * Absence is ordinary and is not a failure: a fresh installation has no `tavern/v3` until
 * the first Chat exists, and a profile with no companions has no companion roots. What IS a
 * failure is a root that exists and cannot be read - that is the authority naming itself.
 *
 * Symlinks and reparse points are skipped rather than followed, so the walk cannot leave the
 * runtime root and cannot loop.
 */
export async function discoverProfileBackupSources(runtimeRoot: string): Promise<readonly ProfileBackupSources[]> {
  const root = resolve(runtimeRoot);
  const contexts = await identityRoots(root);
  const discovered: ProfileBackupSources[] = [];
  for (const authority of PROFILE_BACKUP_AUTHORITIES) {
    const files: string[] = [];
    const relatives = [
      ...authority.roots,
      ...contexts.flatMap((context) => authority.perIdentity.map((path) => `${context}/${path}`)),
    ];
    for (const relative of relatives) await collectRegularFiles(root, relative, authority.id, files);
    discovered.push(Object.freeze({ authority, files: Object.freeze(files) }));
  }
  return Object.freeze(discovered);
}

/** The identity roots the installation holds, named by the directory the root itself carries. */
async function identityRoots(root: string): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(join(root, "contexts"));
  } catch (error) {
    if (isMissing(error)) return Object.freeze([]);
    throw new ProfileBackupAuthorityUnreadable("identity", join(root, "contexts"), error);
  }
  const roots: string[] = [];
  for (const entry of entries) {
    const info = await statOrThrow(join(root, "contexts", entry), "identity");
    if (info?.isDirectory() === true) roots.push(`contexts/${entry}`);
  }
  return Object.freeze(roots);
}

async function collectRegularFiles(
  root: string,
  relative: string,
  authorityId: ProfileBackupAuthorityId,
  files: string[],
): Promise<void> {
  const absolute = join(root, ...relative.split("/"));
  const info = await statOrThrow(absolute, authorityId);
  if (info === null) return;
  if (info.isFile()) {
    files.push(relative);
    return;
  }
  if (!info.isDirectory()) return;
  let entries: readonly string[];
  try {
    entries = await readdir(absolute);
  } catch (error) {
    throw new ProfileBackupAuthorityUnreadable(authorityId, absolute, error);
  }
  for (const entry of [...entries].sort()) await collectRegularFiles(root, `${relative}/${entry}`, authorityId, files);
}

/** `null` for a path that does not exist; the authority's own refusal for anything else. */
async function statOrThrow(absolute: string, authorityId: ProfileBackupAuthorityId) {
  try {
    return await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new ProfileBackupAuthorityUnreadable(authorityId, absolute, error);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
