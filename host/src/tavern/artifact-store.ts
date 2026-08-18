import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { atomicWriteFile, readSafeDirectory, verifySafePathBoundary, withPathLock } from "../path-lock.js";
import { readStrictJsonFile } from "../strict-json-reader.js";

export type ArtifactEnvelope<T> = Readonly<{
  schemaVersion: 1;
  revision: number;
  canonicalHash: string;
  artifact: T;
}>;
export class TavernRevisionConflict extends Error {
  constructor() {
    super("tavern_revision_conflict");
  }
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
type RevisionedArtifact = Readonly<{ revision: number }>;
export type TavernRevisionRepositoryOptions<T extends RevisionedArtifact, View> = Readonly<{
  root: string;
  artifactKind: string;
  id: string;
  validateArtifact: (value: unknown) => T;
  matchesId: (artifact: T, id: string) => boolean;
  project: (artifact: T) => View;
  invalidArtifact: () => Error;
  conflict: () => Error;
}>;
export type TavernRevisionRepository<T extends RevisionedArtifact, View> = Readonly<{
  /** Returns the authoritative latest envelope; no lower revision fallback is permitted. */
  readLatestArtifact(): Promise<ArtifactEnvelope<T> | undefined>;
  readLatest(): Promise<View | undefined>;
  create(buildRevisionOne: () => T): Promise<View>;
  update(expectedRevision: number, buildNext: (revision: number) => T): Promise<View>;
}>;
export type TavernArtifactRepository<T extends RevisionedArtifact, View> = Readonly<{
  read(): Promise<View>;
  /** An absent exact leaf is not an artifact; corruption and invalid contents fail closed. */
  readIfPresent(): Promise<View | undefined>;
}>;
export type TavernArtifactRepositoryOptions<T extends RevisionedArtifact, View> = Readonly<{
  path: string;
  validateArtifact: (value: unknown) => T;
  project: (artifact: T) => View;
}>;

export class TavernArtifactStore {
  constructor(private readonly runtimeRoot: string) {}
  openArtifactRepository<T extends RevisionedArtifact, View>(
    options: TavernArtifactRepositoryOptions<T, View>,
  ): TavernArtifactRepository<T, View> {
    const store = this;
    const path = store.target(options.path);
    const read = async (): Promise<View> =>
      options.project((await store.read(path, options.validateArtifact)).artifact);
    return Object.freeze({
      read,
      async readIfPresent(): Promise<View | undefined> {
        const result = await store.readIfPresent(path, options.validateArtifact);
        return result === undefined ? undefined : options.project(result.artifact);
      },
    });
  }
  async listArtifactRepositories<View>(
    root: string,
    repositoryForEntry: (entry: string) => TavernArtifactRepository<RevisionedArtifact, View>,
  ): Promise<readonly View[]> {
    let entries: readonly string[];
    try {
      entries = await readSafeDirectory(this.target(root), this.runtimeRoot);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return Object.freeze([]);
      throw error;
    }
    const artifacts: View[] = [];
    for (const entry of [...entries].sort()) {
      const artifact = await repositoryForEntry(entry).readIfPresent();
      if (artifact !== undefined) artifacts.push(artifact);
    }
    return Object.freeze(artifacts);
  }
  openRevisionRepository<T extends RevisionedArtifact, View>(
    options: TavernRevisionRepositoryOptions<T, View>,
  ): TavernRevisionRepository<T, View> {
    const store = this;
    const directory = this.target(options.root);
    const revisionPath = (revision: number) => join(directory, "revisions", `${revision}.json`);
    const readLatestArtifact = async (): Promise<ArtifactEnvelope<T> | undefined> => {
      let names: readonly string[];
      try {
        names = await readSafeDirectory(join(directory, "revisions"), directory);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw options.invalidArtifact();
      }
      const revisions: number[] = [];
      for (const name of names) {
        const match = /^([1-9]\d*)\.json$/u.exec(name);
        if (match === null) throw options.invalidArtifact();
        const revision = Number(match[1]);
        if (!Number.isSafeInteger(revision)) throw options.invalidArtifact();
        revisions.push(revision);
      }
      if (new Set(revisions).size !== revisions.length) throw options.invalidArtifact();
      revisions.sort((a, b) => b - a);
      if (revisions.length === 0) return undefined;
      let latest: ArtifactEnvelope<T> | undefined;
      for (const revision of revisions) {
        try {
          const envelope = await store.read(revisionPath(revision), options.validateArtifact);
          if (!options.matchesId(envelope.artifact, options.id) || envelope.artifact.revision !== revision)
            throw options.invalidArtifact();
          latest ??= envelope;
        } catch {
          // Every numeric entry is authoritative history. A corrupt lower
          // revision cannot be hidden by a valid higher revision.
          throw options.invalidArtifact();
        }
      }
      return latest;
    };
    return Object.freeze({
      readLatestArtifact,
      async readLatest() {
        const envelope = await readLatestArtifact();
        return envelope === undefined ? undefined : options.project(envelope.artifact);
      },
      async create(buildRevisionOne) {
        const artifact = buildRevisionOne();
        if (artifact.revision !== 1) throw options.invalidArtifact();
        try {
          return options.project((await store.write(revisionPath(1), artifact, options.validateArtifact)).artifact);
        } catch (error) {
          if (error instanceof TavernRevisionConflict) throw options.conflict();
          throw error;
        }
      },
      async update(expectedRevision, buildNext) {
        const latest = await readLatestArtifact();
        if (latest === undefined || latest.artifact.revision !== expectedRevision) throw options.conflict();
        const artifact = buildNext(expectedRevision + 1);
        if (artifact.revision !== expectedRevision + 1) throw options.invalidArtifact();
        try {
          return options.project(
            (await store.write(revisionPath(artifact.revision), artifact, options.validateArtifact)).artifact,
          );
        } catch (error) {
          if (error instanceof TavernRevisionConflict) throw options.conflict();
          throw error;
        }
      },
    });
  }
  async read<T extends Readonly<{ revision: number }>>(
    path: string,
    validate: (value: unknown) => T,
  ): Promise<ArtifactEnvelope<T>> {
    const result = await this.readIfPresent(path, validate);
    if (result === undefined) throw new Error("tavern_artifact_unreadable");
    return result;
  }
  async readIfPresent<T extends Readonly<{ revision: number }>>(
    path: string,
    validate: (value: unknown) => T,
  ): Promise<ArtifactEnvelope<T> | undefined> {
    const target = this.target(path);
    let raw: unknown;
    try {
      await verifySafePathBoundary(target, this.runtimeRoot);
      raw = await readStrictJsonFile(target);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new Error("tavern_artifact_unreadable");
    }
    return envelope(raw, validate);
  }
  async write<T extends Readonly<{ revision: number }>>(
    path: string,
    artifact: T,
    validate: (value: unknown) => T,
  ): Promise<ArtifactEnvelope<T>> {
    return this.compareAndWrite(path, undefined, artifact, validate);
  }
  async compareAndWrite<T extends Readonly<{ revision: number }>>(
    path: string,
    expectedRevision: number | undefined,
    artifact: T,
    validate: (value: unknown) => T,
  ): Promise<ArtifactEnvelope<T>> {
    const target = this.target(path);
    const clean = validate(artifact);
    const next = makeEnvelope(clean);
    return withPathLock(
      target,
      async () => {
        let existing: ArtifactEnvelope<T> | undefined;
        // Only a second, successful boundary verification followed by an
        // ENOENT from this exact leaf means "new artifact". Parse, permission,
        // corruption, and unsafe-boundary failures remain barriers.
        await verifySafePathBoundary(target, this.runtimeRoot);
        try {
          existing = envelope(await readStrictJsonFile(target), validate);
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            await verifySafePathBoundary(target, this.runtimeRoot);
            existing = undefined;
          } else {
            // Existing malformed, inaccessible, or otherwise unreadable state is
            // never a new-artifact case. Preserve the public fail-closed error.
            throw new Error("tavern_artifact_unreadable", { cause: error });
          }
        }
        if (expectedRevision !== undefined && existing?.revision !== expectedRevision)
          throw new TavernRevisionConflict();
        if (existing !== undefined && next.revision <= existing.revision) throw new TavernRevisionConflict();
        await atomicWriteFile(target, canonicalJson(next), this.runtimeRoot);
        const readBack = await this.read(target, validate);
        if (readBack.canonicalHash !== next.canonicalHash || readBack.revision !== next.revision)
          throw new Error("tavern_artifact_readback_mismatch");
        return readBack;
      },
      { containmentRoot: this.runtimeRoot },
    );
  }
  private target(path: string): string {
    const root = resolve(this.runtimeRoot);
    const target = resolve(path);
    if (target === root || !target.startsWith(`${root}${sep}`)) throw new Error("unsafe_tavern_artifact_path");
    return target;
  }
}
function makeEnvelope<T extends Readonly<{ revision: number }>>(artifact: T): ArtifactEnvelope<T> {
  if (!Number.isSafeInteger(artifact.revision) || artifact.revision < 1) throw new Error("invalid_tavern_revision");
  const frozen = canonical(artifact) as T;
  return Object.freeze({
    schemaVersion: 1,
    revision: artifact.revision,
    canonicalHash: canonicalHash(frozen),
    artifact: frozen,
  });
}
function envelope<T extends Readonly<{ revision: number }>>(
  value: unknown,
  validate: (v: unknown) => T,
): ArtifactEnvelope<T> {
  if (
    !rec(value) ||
    !onlyKeys(value, ["schemaVersion", "revision", "canonicalHash", "artifact"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.canonicalHash !== "string" ||
    !rec(value.artifact)
  )
    throw new Error("invalid_tavern_artifact");
  const revision = value.revision;
  const artifact = validate(value.artifact);
  if (artifact.revision !== revision || canonicalHash(artifact) !== value.canonicalHash)
    throw new Error("invalid_tavern_artifact");
  return Object.freeze({
    schemaVersion: 1,
    revision,
    canonicalHash: value.canonicalHash,
    artifact,
  });
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(canonical));
  if (rec(value))
    return Object.freeze(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])]),
      ),
    );
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  throw new Error("non_canonical_tavern_value");
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
function rec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
