import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { atomicWriteFile, verifySafePathBoundary, withPathLock } from "../../path-lock.js";
import { readStrictJsonFile } from "../../strict-json-reader.js";
import { canonicalHash, canonicalJson } from "../artifact-store.js";

const MAX_ARTIFACTS = 128;
const MAX_ENTRIES = 32;
const MAX_TITLE = 128;
const MAX_SUMMARY = 4_000;

export type PublicWorldInfoEntry = Readonly<{
  scope: "companion" | "setting";
  publicTitle: string;
  summary: string;
}>;
export type PublicWorldInfoProjection = Readonly<{
  revision: number;
  publicTitle: string;
  summary: string;
  entries: readonly PublicWorldInfoEntry[];
}>;
export type CreateWorldInfoRequest = Omit<PublicWorldInfoProjection, "revision">;
export type UpdateWorldInfoRequest = CreateWorldInfoRequest & Readonly<{ expectedRevision: number }>;
export type WorldInfoManagementRepository = Readonly<{
  create(request: CreateWorldInfoRequest): Promise<PublicWorldInfoProjection>;
  list(): Promise<readonly PublicWorldInfoProjection[]>;
  detail(publicTitle: string): Promise<PublicWorldInfoProjection | null>;
  update(publicTitle: string, request: UpdateWorldInfoRequest): Promise<PublicWorldInfoProjection>;
  history(publicTitle: string): Promise<readonly PublicWorldInfoProjection[]>;
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

  return Object.freeze({
    async create(request) {
      validateCreateRequest(request);
      return withCatalog(root, catalogPath, async (catalog) => {
        if (
          catalog.artifacts.length >= MAX_ARTIFACTS ||
          catalog.artifacts.some((item) => item.publicTitle === request.publicTitle)
        )
          throw new Error("world_info_already_exists");
        const handle = makePersistentHandle();
        const artifact = artifactFor(1, request);
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
        const artifact = artifactFor(current.revision + 1, request);
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
      !text(item.publicTitle, MAX_TITLE) ||
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
    value = await readStrictJsonFile(path);
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
async function atomicWrite(path: string, content: string, containmentRoot: string): Promise<void> {
  await atomicWriteFile(path, content, containmentRoot);
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
  validateArtifact({ revision: 1, ...(record(value) ? value : {}) });
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
    !text(value.publicTitle, MAX_TITLE) ||
    !text(value.summary, MAX_SUMMARY) ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES
  )
    throw new Error("invalid_world_info_request");
  const entries = value.entries.map((entry) => {
    if (
      !record(entry) ||
      !only(entry, ["scope", "publicTitle", "summary"]) ||
      (entry.scope !== "companion" && entry.scope !== "setting") ||
      !text(entry.publicTitle, MAX_TITLE) ||
      !text(entry.summary, MAX_SUMMARY)
    )
      throw new Error("invalid_world_info_request");
    return Object.freeze({
      scope: entry.scope,
      publicTitle: entry.publicTitle,
      summary: entry.summary,
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
  if (!text(value, MAX_TITLE)) throw new Error("invalid_world_info_request");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/u.test(value)
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
