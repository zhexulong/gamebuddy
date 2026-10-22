import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWriteFile, removeSafeFile, verifySafePathBoundary, withPathLock } from "../../path-lock.js";
import { readStrictJsonFile, STRICT_JSON_READER_MAX_BUDGET_BYTES } from "../../strict-json-reader.js";
import { canonicalHash, canonicalJson } from "../artifact-store.js";
import {
  importTavernLorebook,
  isRawTavernLorebook,
  type TavernLorebookImportOptions,
} from "./tavern-lorebook-importer.js";

const MAX_ARTIFACTS = 128;
const MAX_TITLE = 128;
const MAX_SUMMARY = 4_000;
const MAX_KEYS = 128;
const MAX_KEY_LENGTH = 128;

export type PublicWorldInfoEntry = Readonly<{
  scope: "companion" | "setting";
  publicTitle: string;
  summary: string;
  keys?: readonly string[];
  secondaryKeys?: readonly string[];
  selectiveLogic?: 0 | 1 | 2 | 3;
  constant?: boolean;
}>;
export type PublicWorldInfoProjection = Readonly<{
  revision: number;
  publicTitle: string;
  summary: string;
  entries: readonly PublicWorldInfoEntry[];
}>;
export type CreateWorldInfoRequest = Omit<PublicWorldInfoProjection, "revision">;
export type UpdateWorldInfoRequest = CreateWorldInfoRequest & Readonly<{ expectedRevision: number }>;
/**
 * One continuity's activated library item, named the way the library names an
 * item: by its public title and the exact revision the activation pins.
 */
export type WorldInfoActivation = Readonly<{ publicTitle: string; revision: number }>;
export type WorldInfoManagementRepository = Readonly<{
  create(request: CreateWorldInfoRequest | unknown): Promise<PublicWorldInfoProjection>;
  import?(rawLorebook: unknown, options?: TavernLorebookImportOptions): Promise<PublicWorldInfoProjection>;
  list(): Promise<readonly PublicWorldInfoProjection[]>;
  detail(publicTitle: string): Promise<PublicWorldInfoProjection | null>;
  update(publicTitle: string, request: UpdateWorldInfoRequest): Promise<PublicWorldInfoProjection>;
  /**
   * Removes the item's entry from the catalog so it is no longer listed or
   * bindable. The immutable revision files under `revisions/<handle>/<n>.json`
   * are deliberately retained: they are the history, and a Chat bound to an
   * exact revision reads that revision, so delete means "no longer in the
   * library", never "erase an artifact a conversation may be holding". There is
   * no cascade: no revision is deleted, no binding or Chat is touched.
   */
  delete(publicTitle: string): Promise<void>;
  history(publicTitle: string): Promise<readonly PublicWorldInfoProjection[]>;
  /**
   * The continuity's activated library item, resolved at the exact revision the
   * activation pins, or `undefined` when nothing is activated for it.
   *
   * The library itself is global; this record is the missing fact that says
   * WHICH of its items is in use for one continuity. It is thread-free on
   * purpose: the Game surface has no Chat thread, so a per-thread binding alone
   * can never reach it. A record that no longer resolves to its pinned revision
   * (the revision file's bytes changed, or the item left the catalog) refuses
   * with `continuity_world_info_activation_drift` instead of serving something
   * else.
   */
  activation(identityKey: string): Promise<PublicWorldInfoProjection | undefined>;
  /**
   * Activates one exact library revision for one continuity, or clears the
   * activation with `null`. The pin is written under the catalog's own lock and
   * only after the exact revision reads back, so an activation can never name a
   * revision the library does not hold.
   */
  setActivation(
    identityKey: string,
    activation: WorldInfoActivation | null,
  ): Promise<PublicWorldInfoProjection | undefined>;
  validateCreateRequest(value: unknown): asserts value is CreateWorldInfoRequest;
}>;

type ManagedArtifact = Readonly<{
  revision: number;
  publicTitle: string;
  summary: string;
  entries: readonly PublicWorldInfoEntry[];
}>;
type CatalogItem = Readonly<{
  handle: string;
  publicTitle: string;
  revision: number;
}>;
type Catalog = Readonly<{
  schemaVersion: 1;
  artifacts: readonly CatalogItem[];
}>;
type RevisionEnvelope = Readonly<{
  schemaVersion: 1;
  revision: number;
  canonicalHash: string;
  artifact: ManagedArtifact;
}>;
/**
 * The durable activation record. It pins the storage handle rather than the
 * public title: an item can be renamed while the artifact a continuity
 * activated is exactly the one it pinned.
 */
type ActivationRecord = Readonly<{
  schemaVersion: 1;
  identityKey: string;
  handle: string;
  revision: number;
}>;
/**
 * Separate managed public World Info domain. It stores each revision as an
 * immutable snapshot and keeps storage handles strictly internal.
 */
export function createWorldInfoManagementRepository(runtimeRoot: string): WorldInfoManagementRepository {
  const root = resolve(runtimeRoot);
  // Persistent handles use their own cryptographic UUID source and never
  // derive from the atomic writer's private temporary-name entropy.
  const makePersistentHandle = randomUUID;
  const directory = join(root, "world-info-management");
  const catalogPath = join(directory, "catalog.json");
  const activationsDirectory = join(directory, "activations");

  return Object.freeze({
    async create(request) {
      const normalized = isRawTavernLorebook(request)
        ? importTavernLorebook(request)
        : (request as CreateWorldInfoRequest);
      validateCreateRequest(normalized);
      return withCatalog(root, catalogPath, async (catalog) => {
        if (
          catalog.artifacts.length >= MAX_ARTIFACTS ||
          catalog.artifacts.some((item) => item.publicTitle === normalized.publicTitle)
        )
          throw new Error("world_info_already_exists");
        const handle = makePersistentHandle();
        const artifact = artifactFor(1, normalized);
        const readBack = await writeRevision(root, directory, handle, artifact);
        await writeCatalog(root, catalogPath, {
          schemaVersion: 1,
          artifacts: [
            ...catalog.artifacts,
            {
              handle,
              publicTitle: artifact.publicTitle,
              revision: artifact.revision,
            },
          ],
        });
        return project(readBack);
      });
    },
    async import(rawLorebook, options) {
      const adapted = importTavernLorebook(rawLorebook, options);
      return this.create(adapted);
    },
    async list() {
      const catalog = await readCatalog(root, catalogPath);
      return Object.freeze(
        await Promise.all(
          catalog.artifacts.map(async (item) =>
            project(await readRevision(root, directory, item.handle, item.revision)),
          ),
        ),
      );
    },
    async detail(publicTitle) {
      validateTitle(publicTitle);
      const catalog = await readCatalog(root, catalogPath);
      const item = catalog.artifacts.find((candidate) => candidate.publicTitle === publicTitle);
      return item === undefined ? null : project(await readRevision(root, directory, item.handle, item.revision));
    },
    async update(publicTitle, request) {
      validateTitle(publicTitle);
      validateUpdateRequest(request);
      return withCatalog(root, catalogPath, async (catalog) => {
        const index = catalog.artifacts.findIndex((item) => item.publicTitle === publicTitle);
        if (index === -1) throw new Error("world_info_not_found");
        const current = catalog.artifacts[index]!;
        if (current.revision !== request.expectedRevision) throw new Error("world_info_revision_conflict");
        if (
          request.publicTitle !== publicTitle &&
          catalog.artifacts.some((item) => item.publicTitle === request.publicTitle)
        )
          throw new Error("world_info_already_exists");
        const previous = await readRevision(root, directory, current.handle, current.revision);
        const artifact = artifactFor(current.revision + 1, {
          publicTitle: request.publicTitle,
          summary: request.summary,
          entries: entriesCarryingSelection(previous.entries, request.entries),
        });
        const readBack = await writeRevision(root, directory, current.handle, artifact);
        const artifacts = catalog.artifacts.map((item, itemIndex) =>
          itemIndex === index
            ? {
                handle: current.handle,
                publicTitle: artifact.publicTitle,
                revision: artifact.revision,
              }
            : item,
        );
        await writeCatalog(root, catalogPath, { schemaVersion: 1, artifacts });
        return project(readBack);
      });
    },
    async delete(publicTitle) {
      validateTitle(publicTitle);
      await withCatalog(root, catalogPath, async (catalog) => {
        const index = catalog.artifacts.findIndex((item) => item.publicTitle === publicTitle);
        if (index === -1) throw new Error("world_info_not_found");
        // Only the catalog entry is removed; the revision files stay because a
        // binding pins an exact revision that this item's Chat still reads.
        const artifacts = catalog.artifacts.filter((_, itemIndex) => itemIndex !== index);
        await writeCatalog(root, catalogPath, { schemaVersion: 1, artifacts });
      });
    },
    async history(publicTitle) {
      validateTitle(publicTitle);
      const catalog = await readCatalog(root, catalogPath);
      const item = catalog.artifacts.find((candidate) => candidate.publicTitle === publicTitle);
      if (item === undefined) return Object.freeze([]);
      const history = await Promise.all(
        Array.from({ length: item.revision }, async (_, index) =>
          project(await readRevision(root, directory, item.handle, index + 1)),
        ),
      );
      return Object.freeze(history);
    },
    async activation(identityKey) {
      validateIdentityKey(identityKey);
      const record = await readActivation(root, activationsDirectory, identityKey);
      if (record === undefined) return undefined;
      // The catalog's own handle is what makes the pin exact: a title that was
      // deleted and re-created names a different artifact, and one that was
      // renamed still resolves. Anything the pin no longer reaches is drift.
      const catalog = await readCatalog(root, catalogPath);
      if (!catalog.artifacts.some((item) => item.handle === record.handle))
        throw new Error("continuity_world_info_activation_drift");
      try {
        return project(await readRevision(root, directory, record.handle, record.revision));
      } catch {
        throw new Error("continuity_world_info_activation_drift");
      }
    },
    async setActivation(identityKey, activation) {
      validateIdentityKey(identityKey);
      if (activation !== null) {
        validateTitle(activation.publicTitle);
        if (!revision(activation.revision)) throw new Error("invalid_world_info_request");
      }
      const path = activationPath(activationsDirectory, identityKey);
      return withCatalog(root, catalogPath, async (catalog) => {
        let record: ActivationRecord | undefined;
        let projection: PublicWorldInfoProjection | undefined;
        if (activation !== null) {
          const item = catalog.artifacts.find((candidate) => candidate.publicTitle === activation.publicTitle);
          if (item === undefined) throw new Error("world_info_not_found");
          // The exact revision is read back before it is pinned, so an
          // activation never names a revision the library does not hold.
          projection = project(await readRevision(root, directory, item.handle, activation.revision));
          record = Object.freeze({
            schemaVersion: 1 as const,
            identityKey,
            handle: item.handle,
            revision: activation.revision,
          });
        }
        if (record === undefined) await removeSafeFile(path, root);
        else {
          await mkdir(dirname(path), { recursive: true });
          await atomicWrite(path, canonicalJson(record), root);
        }
        return projection;
      });
    },
    validateCreateRequest,
  });
}

async function withCatalog<T>(
  root: string,
  catalogPath: string,
  operation: (catalog: Catalog) => Promise<T>,
): Promise<T> {
  return withPathLock(catalogPath, async () => operation(await readCatalog(root, catalogPath)), {
    containmentRoot: root,
  });
}
async function readCatalog(root: string, path: string): Promise<Catalog> {
  try {
    await verifySafePathBoundary(path, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return Object.freeze({ schemaVersion: 1, artifacts: Object.freeze([]) });
    throw error;
  }
  let value: unknown;
  try {
    value = await readStrictJsonFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return Object.freeze({ schemaVersion: 1, artifacts: Object.freeze([]) });
    throw new Error("invalid_world_info_catalog");
  }
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > MAX_ARTIFACTS
  )
    throw new Error("invalid_world_info_catalog");
  const artifacts = value.artifacts.map((item) => {
    if (
      !record(item) ||
      !only(item, ["handle", "publicTitle", "revision"]) ||
      !uuid(item.handle) ||
      !titleText(item.publicTitle, MAX_TITLE) ||
      !revision(item.revision)
    )
      throw new Error("invalid_world_info_catalog");
    return Object.freeze({
      handle: item.handle,
      publicTitle: item.publicTitle,
      revision: item.revision,
    });
  });
  if (
    new Set(artifacts.map((item) => item.handle)).size !== artifacts.length ||
    new Set(artifacts.map((item) => item.publicTitle)).size !== artifacts.length
  )
    throw new Error("invalid_world_info_catalog");
  return Object.freeze({
    schemaVersion: 1,
    artifacts: Object.freeze(artifacts),
  });
}
async function writeCatalog(root: string, path: string, catalog: Catalog): Promise<void> {
  await atomicWrite(path, canonicalJson(catalog), root);
}
async function writeRevision(
  root: string,
  directory: string,
  handle: string,
  artifact: ManagedArtifact,
): Promise<ManagedArtifact> {
  const path = revisionPath(root, directory, handle, artifact.revision);
  const envelope: RevisionEnvelope = Object.freeze({
    schemaVersion: 1,
    revision: artifact.revision,
    canonicalHash: canonicalHash(artifact),
    artifact,
  });
  await withPathLock(
    path,
    async () => {
      await atomicWrite(path, canonicalJson(envelope), root);
    },
    { containmentRoot: root },
  );
  return readRevision(root, directory, handle, artifact.revision);
}
async function readRevision(
  root: string,
  directory: string,
  handle: string,
  expectedRevision: number,
): Promise<ManagedArtifact> {
  const path = revisionPath(root, directory, handle, expectedRevision);
  let value: unknown;
  try {
    await verifySafePathBoundary(path, root);
    // A single World Book (e.g. GI-Core, 256 entries) can exceed the 64 KiB
    // default strict-JSON budget; the revision envelope is capped by the
    // absolute 21 MiB reader ceiling, matching the 16 MiB character-book cap.
    value = await readStrictJsonFile(path, STRICT_JSON_READER_MAX_BUDGET_BYTES);
  } catch {
    throw new Error("invalid_world_info_artifact");
  }
  if (
    !record(value) ||
    !only(value, ["schemaVersion", "revision", "canonicalHash", "artifact"]) ||
    value.schemaVersion !== 1 ||
    value.revision !== expectedRevision ||
    typeof value.canonicalHash !== "string"
  )
    throw new Error("invalid_world_info_artifact");
  const artifact = validateArtifact(value.artifact);
  if (artifact.revision !== expectedRevision || canonicalHash(artifact) !== value.canonicalHash)
    throw new Error("invalid_world_info_artifact");
  return artifact;
}
function revisionPath(root: string, directory: string, handle: string, revisionNumber: number): string {
  const path = resolve(directory, "revisions", handle, `${revisionNumber}.json`);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("invalid_world_info_artifact");
  return path;
}
function activationPath(activationsDirectory: string, identityKey: string): string {
  return join(activationsDirectory, `${identityKey}.json`);
}
async function readActivation(
  root: string,
  activationsDirectory: string,
  identityKey: string,
): Promise<ActivationRecord | undefined> {
  const path = activationPath(activationsDirectory, identityKey);
  try {
    await verifySafePathBoundary(path, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("invalid_continuity_world_info_activation");
  }
  let value: unknown;
  try {
    value = await readStrictJsonFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("invalid_continuity_world_info_activation");
  }
  // The record must name the continuity it was found under: a copied or
  // hand-edited file never becomes another continuity's activation.
  if (
    !record(value) ||
    !only(value, ["schemaVersion", "identityKey", "handle", "revision"]) ||
    value.schemaVersion !== 1 ||
    value.identityKey !== identityKey ||
    !uuid(value.handle) ||
    !revision(value.revision)
  )
    throw new Error("invalid_continuity_world_info_activation");
  return Object.freeze({ schemaVersion: 1, identityKey, handle: value.handle, revision: value.revision });
}
function validateIdentityKey(value: string): void {
  // `identityKey()` is a sha256 hex digest (runtime-identity.ts); anything else
  // is not a continuity this store can hold an activation for.
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid_world_info_request");
}
async function atomicWrite(path: string, content: string, containmentRoot: string): Promise<void> {
  await atomicWriteFile(path, content, containmentRoot);
}

/**
 * The entry list one update writes: the caller's entries, plus the facts its surface never names.
 *
 * The library's editor carries an entry's scope, title, summary and trigger words, and the update
 * command is exactly the list it sent - that surface has no `constant`, `secondaryKeys` or
 * `selectiveLogic` control, so all three are absent from every save it makes. Writing the sent list
 * alone rewrites an imported entry's author rule ("all of my secondary words", always on) into
 * "any of these words" on a save that changed nothing. Her own book carries the same two facts for
 * the same reason (`authoredEntries` in `companion-world-book-service.ts`).
 *
 * An entry is matched by its public title, the entry's one stable identity - the same key an item is
 * named by - and the first unclaimed match wins, so two entries sharing a title keep their own rows
 * in order. A field the caller DID send is never overridden, even as `false`: that is the caller's
 * answer, and an entry's schema refuses an empty key list, so "clear the gate" is not expressible
 * by omission at all - omission here can only mean "not stated by this surface".
 */
function entriesCarryingSelection(
  previous: readonly PublicWorldInfoEntry[],
  incoming: readonly PublicWorldInfoEntry[],
): readonly PublicWorldInfoEntry[] {
  const claimed = new Set<number>();
  return incoming.map((entry) => {
    const matched = previous.findIndex(
      (candidate, index) => !claimed.has(index) && candidate.publicTitle === entry.publicTitle,
    );
    if (matched === -1) return entry;
    claimed.add(matched);
    const carried = previous[matched]!;
    return Object.freeze({
      ...entry,
      ...(entry.constant === undefined && carried.constant !== undefined ? { constant: carried.constant } : {}),
      ...(entry.secondaryKeys === undefined && carried.secondaryKeys !== undefined
        ? { secondaryKeys: carried.secondaryKeys }
        : {}),
      ...(entry.selectiveLogic === undefined && carried.selectiveLogic !== undefined
        ? { selectiveLogic: carried.selectiveLogic }
        : {}),
    });
  });
}

function artifactFor(revisionNumber: number, request: CreateWorldInfoRequest): ManagedArtifact {
  return validateArtifact({
    revision: revisionNumber,
    publicTitle: request.publicTitle,
    summary: request.summary,
    entries: request.entries,
  });
}
function project(artifact: ManagedArtifact): PublicWorldInfoProjection {
  return Object.freeze({
    revision: artifact.revision,
    publicTitle: artifact.publicTitle,
    summary: artifact.summary,
    entries: Object.freeze(artifact.entries.map((entry) => Object.freeze({ ...entry }))),
  });
}
function validateCreateRequest(value: unknown): asserts value is CreateWorldInfoRequest {
  const target = isRawTavernLorebook(value) ? importTavernLorebook(value) : value;
  validateArtifact({ revision: 1, ...(record(target) ? target : {}) });
}
function validateUpdateRequest(value: unknown): asserts value is UpdateWorldInfoRequest {
  if (
    !record(value) ||
    !only(value, ["expectedRevision", "publicTitle", "summary", "entries"]) ||
    !revision(value.expectedRevision)
  )
    throw new Error("invalid_world_info_request");
  validateCreateRequest({
    publicTitle: value.publicTitle,
    summary: value.summary,
    entries: value.entries,
  });
}
function validateArtifact(value: unknown): ManagedArtifact {
  if (
    !record(value) ||
    !only(value, ["revision", "publicTitle", "summary", "entries"]) ||
    !revision(value.revision) ||
    !titleText(value.publicTitle, MAX_TITLE) ||
    !summaryText(value.summary, MAX_SUMMARY) ||
    !Array.isArray(value.entries)
  )
    throw new Error("invalid_world_info_request");
  const entries = value.entries.map((entry) => {
    if (
      !record(entry) ||
      !only(entry, ["scope", "publicTitle", "summary", "keys", "constant", "secondaryKeys", "selectiveLogic"]) ||
      (entry.scope !== "companion" && entry.scope !== "setting") ||
      !titleText(entry.publicTitle, MAX_TITLE) ||
      !summaryText(entry.summary, MAX_SUMMARY) ||
      (entry.keys !== undefined && !keysValue(entry.keys)) ||
      (entry.constant !== undefined && typeof entry.constant !== "boolean") ||
      (entry.secondaryKeys !== undefined && !keysValue(entry.secondaryKeys)) ||
      (entry.selectiveLogic !== undefined &&
        !(
          typeof entry.selectiveLogic === "number" && ([0, 1, 2, 3] as readonly number[]).includes(entry.selectiveLogic)
        ))
    )
      throw new Error("invalid_world_info_request");
    return Object.freeze({
      scope: entry.scope,
      publicTitle: entry.publicTitle,
      summary: entry.summary,
      ...(entry.keys === undefined ? {} : { keys: Object.freeze([...entry.keys]) }),
      ...(entry.constant === undefined ? {} : { constant: entry.constant }),
      ...(entry.secondaryKeys === undefined ? {} : { secondaryKeys: Object.freeze([...entry.secondaryKeys]) }),
      ...(entry.selectiveLogic === undefined ? {} : { selectiveLogic: entry.selectiveLogic as 0 | 1 | 2 | 3 }),
    });
  });
  return Object.freeze({
    revision: value.revision,
    publicTitle: value.publicTitle,
    summary: value.summary,
    entries: Object.freeze(entries),
  });
}
function validateTitle(value: unknown): asserts value is string {
  if (!titleText(value, MAX_TITLE)) throw new Error("invalid_world_info_request");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function titleText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f<>]/u.test(value)
  );
}
function keysValue(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_KEYS &&
    value.every(
      (key) =>
        typeof key === "string" &&
        key.length >= 1 &&
        key.length <= MAX_KEY_LENGTH &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(key),
    )
  );
}
function summaryText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) &&
    !/<script\b/iu.test(value)
  );
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
