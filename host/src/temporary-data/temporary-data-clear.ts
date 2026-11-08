import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { DESKTOP_HOST_EXIT_RECORD_DIRECTORY } from "../bootstrap/wire/desktop-host-exit-record.internal.js";

/**
 * Temporary-data clearing: the one operation that empties the declared
 * temporary roots of this product.
 *
 * The roots are not a parameter. They are declared once, below, and every path
 * this module deletes is derived from that declaration, so the durable runtime
 * root, the credentials, Chat, Memory, game lifecycle state and the update
 * staging are unreachable by construction rather than by a check somebody has
 * to remember to run.
 *
 * There is no rotated-log root: this product has no log rotation, so naming one
 * here would be a category the UI claims and the product does not have. When a
 * real rotated-log writer appears it becomes one descriptor in
 * `declaredTemporaryDataRoots` - not a fourth branch of the clear.
 */

/** The four roots the launcher declares; `validateRootLayout` proves the same shape. */
export type TemporaryDataRootLayout = Readonly<{
  programRoot: string;
  dataRoot: string;
  operationalRoot: string;
  presentationRoot: string;
}>;

export type TemporaryDataRootId = "presentation" | "host_exit_records";

export type DeclaredTemporaryDataRoot = Readonly<{
  id: TemporaryDataRootId;
  /** Absolute directory a clear empties. The directory itself always survives. */
  directory: string;
  /** What the root holds, in the product's own vocabulary. */
  holds: "presentation_cache" | "host_diagnostics";
}>;

export type RetainedTemporaryDataKind = Readonly<{
  kind: "durable_data" | "credentials" | "chat" | "memory" | "game_lifecycle" | "update_staging";
  /** The declared directory, or `null` when the product keeps it outside the filesystem roots. */
  directory: string | null;
}>;

export type TemporaryDataRefusalCode =
  | "temporary_data_update_in_flight"
  | "temporary_data_writer_open"
  | "temporary_data_root_identity_unverified"
  | "temporary_data_path_outside_declared_roots";

export class TemporaryDataClearRefused extends Error {
  readonly code: TemporaryDataRefusalCode;

  constructor(code: TemporaryDataRefusalCode) {
    super(code);
    this.name = "TemporaryDataClearRefused";
    this.code = code;
  }
}

/**
 * The two facts this operation cannot read for itself.
 *
 * `openWriterRootIds` is the Host's own statement about which declared root is
 * still being written; `rootIdentityVerified` re-reads the root object identity
 * against the one captured at bootstrap. Both are injected because the layer
 * that runs the clear does not own writers or the Windows identity helper.
 */
export type TemporaryDataClearProbe = Readonly<{
  openWriterRootIds(): readonly TemporaryDataRootId[];
  rootIdentityVerified(): Promise<boolean>;
}>;

/** The two reads a browser surface may ask for: never a path, only what the declaration holds. */
export type TemporaryDataClearPort = Readonly<{
  inspect(requestedRootIds?: readonly string[]): Promise<TemporaryDataInspection>;
  clear(requestedRootIds?: readonly string[]): Promise<TemporaryDataClearReport>;
}>;

export type TemporaryDataRootContents = Readonly<{
  rootId: TemporaryDataRootId;
  holds: DeclaredTemporaryDataRoot["holds"];
  directory: string;
  files: number;
  bytes: number;
}>;

export type TemporaryDataInspection = Readonly<{
  roots: readonly TemporaryDataRootContents[];
  retained: readonly RetainedTemporaryDataKind[];
  /** The updater's declared staging directory; the clear refuses while it holds anything. */
  updateStagingDirectory: string;
  updateInFlight: boolean;
  writerOpenRootIds: readonly TemporaryDataRootId[];
  rootIdentityVerified: boolean;
}>;

export type TemporaryDataRootClearOutcome = Readonly<{
  rootId: TemporaryDataRootId;
  holds: DeclaredTemporaryDataRoot["holds"];
  /** `writer_open` names the root the clear left alone, and why. */
  outcome: "cleared" | "writer_open";
  files: number;
  bytes: number;
}>;

export type TemporaryDataClearReport = Readonly<{
  roots: readonly TemporaryDataRootClearOutcome[];
  removedFiles: number;
  removedBytes: number;
}>;

/**
 * The declared temporary roots, in the order the surface presents them.
 *
 * `presentation` is the launcher's presentation root. Nothing writes it today,
 * so a clear of it removes zero files - and this list says so rather than
 * hiding it behind a button that implies otherwise.
 *
 * `host_exit_records` is the directory the Desktop Host writes its own
 * non-clean-exit diagnostic into; that module documents the records as
 * deletable by an operator or a support run at any time, which is what makes
 * them temporary rather than durable.
 */
export function declaredTemporaryDataRoots(layout: TemporaryDataRootLayout): readonly DeclaredTemporaryDataRoot[] {
  return Object.freeze([
    Object.freeze({ id: "presentation", directory: layout.presentationRoot, holds: "presentation_cache" }),
    Object.freeze({
      id: "host_exit_records",
      directory: join(layout.operationalRoot, DESKTOP_HOST_EXIT_RECORD_DIRECTORY),
      holds: "host_diagnostics",
    }),
  ]);
}

/**
 * What a clear never touches, named so a surface can say it before the player
 * confirms instead of after they discover it.
 *
 * `data` is the durable runtime root the launcher hands the Host as the
 * deployment manifest's `runtimeRoot`; the semantic SQLite, the Chat
 * transcripts and Magic Context all live inside it, which is why Chat, Memory
 * and game lifecycle state are listed as that same directory and not as roots
 * of their own. Credentials are kept in the current-user Windows credential
 * vault and are not a filesystem root at all.
 */
export function retainedTemporaryDataKinds(layout: TemporaryDataRootLayout): readonly RetainedTemporaryDataKind[] {
  return Object.freeze([
    Object.freeze({ kind: "durable_data", directory: layout.dataRoot }),
    Object.freeze({ kind: "credentials", directory: null }),
    Object.freeze({ kind: "chat", directory: layout.dataRoot }),
    Object.freeze({ kind: "memory", directory: layout.dataRoot }),
    Object.freeze({ kind: "game_lifecycle", directory: layout.dataRoot }),
    Object.freeze({ kind: "update_staging", directory: updateStagingDirectory(layout) }),
  ]);
}

/**
 * The updater's declared staging directory.
 *
 * The Desktop updater stages a downloaded installer here before it hands off
 * (`UpdateInstaller.StagingDirectoryName` in the launcher owns the same
 * literal). The launcher runs the updater as its own process, so this
 * directory is the only fact the Host can honestly read about it: a non-empty
 * staging directory means an update is staged or in flight, and the clear
 * refuses instead of deleting the download underneath it.
 */
export function updateStagingDirectory(layout: TemporaryDataRootLayout): string {
  return join(layout.programRoot, ".updates");
}

/**
 * Reads what a clear would remove and what blocks it, without removing
 * anything. Every refusal is reported here as a fact rather than thrown: a
 * surface has to be able to print the list on a refused clear too.
 */
export async function inspectTemporaryData(
  layout: TemporaryDataRootLayout,
  probe: TemporaryDataClearProbe,
  requestedRootIds?: readonly string[],
): Promise<TemporaryDataInspection> {
  const roots = selectDeclaredRoots(layout, requestedRootIds);
  const updateDirectory = updateStagingDirectory(layout);
  const rootContents = await Promise.all(
    roots.map(async (root) => {
      const measured = await measureTemporaryRoot(layout, roots, root);
      return Object.freeze({
        rootId: root.id,
        holds: root.holds,
        directory: root.directory,
        files: measured.files,
        bytes: measured.bytes,
      });
    }),
  );
  const openWriterRootIds = probe.openWriterRootIds().filter((rootId) => roots.some((root) => root.id === rootId));
  return Object.freeze({
    roots: Object.freeze(rootContents),
    retained: retainedTemporaryDataKinds(layout),
    updateStagingDirectory: updateDirectory,
    updateInFlight: await holdsAnything(updateDirectory),
    writerOpenRootIds: Object.freeze([...openWriterRootIds]),
    rootIdentityVerified: await probe.rootIdentityVerified(),
  });
}

/**
 * Empties every declared temporary root the probe did not report as being
 * written, and reports what it removed per root.
 *
 * The global refusals come first and they refuse the whole operation, because
 * each of them means the answer to "is this the moment" is no: the updater
 * holds the staging directory, or the roots are no longer the objects the
 * launcher admitted. A root whose writer is open is reported per root instead,
 * so one live writer does not make the other root unclearable - and when every
 * requested root has an open writer the whole clear is refused with
 * `temporary_data_writer_open` rather than reporting a clear that removed
 * nothing as a success.
 *
 * Idempotent by construction: it removes directory entries, never a declared
 * root directory (the launcher's derivation refuses a missing root), so a
 * second run measures zero and removes zero.
 */
export async function clearTemporaryData(
  layout: TemporaryDataRootLayout,
  probe: TemporaryDataClearProbe,
  requestedRootIds?: readonly string[],
): Promise<TemporaryDataClearReport> {
  const roots = selectDeclaredRoots(layout, requestedRootIds);
  if (await holdsAnything(updateStagingDirectory(layout))) {
    throw new TemporaryDataClearRefused("temporary_data_update_in_flight");
  }
  if (!(await probe.rootIdentityVerified())) {
    throw new TemporaryDataClearRefused("temporary_data_root_identity_unverified");
  }
  const openWriterRootIds = probe.openWriterRootIds();
  const clearable = roots.filter((root) => !openWriterRootIds.includes(root.id));
  if (clearable.length === 0) throw new TemporaryDataClearRefused("temporary_data_writer_open");

  const outcomes: TemporaryDataRootClearOutcome[] = [];
  for (const root of roots) {
    if (!clearable.includes(root)) {
      outcomes.push(Object.freeze({ rootId: root.id, holds: root.holds, outcome: "writer_open", files: 0, bytes: 0 }));
      continue;
    }
    const removed = await emptyTemporaryRoot(layout, roots, root);
    outcomes.push(
      Object.freeze({
        rootId: root.id,
        holds: root.holds,
        outcome: "cleared",
        files: removed.files,
        bytes: removed.bytes,
      }),
    );
  }
  return Object.freeze({
    roots: Object.freeze(outcomes),
    removedFiles: outcomes.reduce((total, entry) => total + entry.files, 0),
    removedBytes: outcomes.reduce((total, entry) => total + entry.bytes, 0),
  });
}

/**
 * Resolves the requested roots against the declaration. A requested id the
 * declaration does not hold is refused here, which is the only way a caller can
 * name something the clear would touch: no path crosses this boundary.
 */
function selectDeclaredRoots(
  layout: TemporaryDataRootLayout,
  requestedRootIds: readonly string[] | undefined,
): readonly DeclaredTemporaryDataRoot[] {
  const declared = declaredTemporaryDataRoots(layout);
  if (requestedRootIds === undefined) return declared;
  if (requestedRootIds.length === 0) throw new TemporaryDataClearRefused("temporary_data_path_outside_declared_roots");
  const selected = declared.filter((root) => requestedRootIds.includes(root.id));
  if (selected.length !== requestedRootIds.length) {
    throw new TemporaryDataClearRefused("temporary_data_path_outside_declared_roots");
  }
  return Object.freeze(selected);
}

async function measureTemporaryRoot(
  layout: TemporaryDataRootLayout,
  declared: readonly DeclaredTemporaryDataRoot[],
  root: DeclaredTemporaryDataRoot,
): Promise<Readonly<{ files: number; bytes: number }>> {
  assertDeclaredTemporaryDataPath(layout, declared, root.directory);
  return await measureDirectory(root.directory);
}

async function emptyTemporaryRoot(
  layout: TemporaryDataRootLayout,
  declared: readonly DeclaredTemporaryDataRoot[],
  root: DeclaredTemporaryDataRoot,
): Promise<Readonly<{ files: number; bytes: number }>> {
  assertDeclaredTemporaryDataPath(layout, declared, root.directory);
  const entries = await directoryEntries(root.directory);
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const path = join(root.directory, entry);
    const measured = await measurePath(path);
    // `force` keeps a vanished entry from failing the clear; a held file still
    // throws, which is the one outcome the caller must see rather than a
    // success that quietly removed less than it reported.
    await rm(path, { recursive: true, force: true });
    files += measured.files;
    bytes += measured.bytes;
  }
  return Object.freeze({ files, bytes });
}

/**
 * The guard every deletion passes through.
 *
 * A declared root that is not strictly inside the launcher's mutable layout, or
 * that overlaps anything the product keeps, is refused instead of emptied. It
 * exists because the declaration is code: a descriptor added later with the
 * wrong base would otherwise delete the durable root, and the incident that
 * matters is the one nobody wrote a test for.
 */
function assertDeclaredTemporaryDataPath(
  layout: TemporaryDataRootLayout,
  declared: readonly DeclaredTemporaryDataRoot[],
  candidate: string,
): void {
  const absolute = resolve(candidate);
  const insideDeclared = declared.some((root) => contains(resolve(root.directory), absolute));
  if (!insideDeclared) throw new TemporaryDataClearRefused("temporary_data_path_outside_declared_roots");
  const retainedDirectories = retainedTemporaryDataKinds(layout)
    .map((entry) => entry.directory)
    .filter((directory): directory is string => directory !== null)
    .map((directory) => resolve(directory));
  if (retainedDirectories.some((directory) => contains(directory, absolute) || contains(absolute, directory))) {
    throw new TemporaryDataClearRefused("temporary_data_path_outside_declared_roots");
  }
  const mutableRoots = [layout.dataRoot, layout.operationalRoot, layout.presentationRoot].map((root) => resolve(root));
  if (!mutableRoots.some((root) => contains(root, absolute))) {
    throw new TemporaryDataClearRefused("temporary_data_path_outside_declared_roots");
  }
}

function contains(ancestor: string, candidate: string): boolean {
  return candidate === ancestor || candidate.startsWith(ancestor + sep);
}

async function holdsAnything(directory: string): Promise<boolean> {
  return (await directoryEntries(directory)).length > 0;
}

async function directoryEntries(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (isMissing(error)) return Object.freeze([]);
    throw error;
  }
}

async function measureDirectory(directory: string): Promise<Readonly<{ files: number; bytes: number }>> {
  let files = 0;
  let bytes = 0;
  for (const entry of await directoryEntries(directory)) {
    const measured = await measurePath(join(directory, entry));
    files += measured.files;
    bytes += measured.bytes;
  }
  return Object.freeze({ files, bytes });
}

async function measurePath(path: string): Promise<Readonly<{ files: number; bytes: number }>> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return Object.freeze({ files: 0, bytes: 0 });
    throw error;
  }
  if (stats.isDirectory()) return await measureDirectory(path);
  // `lstat` keeps a link's own size rather than following it: deleting a link
  // removes the link, so counting the target would report bytes never removed.
  return Object.freeze({ files: 1, bytes: stats.size });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
