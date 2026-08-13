import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { verifySafePathBoundary, withPathLock } from "../path-lock.js";

export type ArtifactEnvelope<T> = Readonly<{ schemaVersion: 1; revision: number; canonicalHash: string; artifact: T }>;
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
type TavernArtifactStoreOptions = Readonly<{ randomUUID?: () => string }>;

export class TavernArtifactStore {
  private readonly makeUUID: () => string;
  constructor(
    private readonly runtimeRoot: string,
    options: TavernArtifactStoreOptions = {},
  ) {
    this.makeUUID = options.randomUUID ?? randomUUID;
  }
  async read<T extends Readonly<{ revision: number }>>(
    path: string,
    validate: (value: unknown) => T,
  ): Promise<ArtifactEnvelope<T>> {
    const target = this.target(path);
    let raw: unknown;
    try {
      await verifySafePathBoundary(target, this.runtimeRoot);
      raw = JSON.parse(await readFile(target, "utf8"));
    } catch {
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
    return withPathLock(target, async () => {
      let existing: ArtifactEnvelope<T> | undefined;
      // Only a second, successful boundary verification followed by an
      // ENOENT from this exact leaf means "new artifact". Parse, permission,
      // corruption, and unsafe-boundary failures remain barriers.
      await verifySafePathBoundary(target, this.runtimeRoot);
      try {
        existing = envelope(JSON.parse(await readFile(target, "utf8")), validate);
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
      if (expectedRevision !== undefined && existing?.revision !== expectedRevision) throw new TavernRevisionConflict();
      if (existing !== undefined && next.revision <= existing.revision) throw new TavernRevisionConflict();
      const temporary = `${target}.${process.pid}.${this.makeUUID()}.tmp`;
      let temporaryOwner: TemporaryFileIdentity | undefined;
      let primaryError: unknown;
      try {
        await verifySafePathBoundary(target, this.runtimeRoot);
        // wx makes a pre-existing temporary symlink/file fail closed rather
        // than allowing writeFile to follow an attacker-controlled path.
        await writeFile(temporary, canonicalJson(next), { encoding: "utf8", flag: "wx" });
        temporaryOwner = await identifyTemporary(temporary, this.runtimeRoot);
        // Both leaves are checked after the temporary is created and directly
        // before rename. This narrows, but cannot eliminate, hostile TOCTOU.
        await verifySafePathBoundary(temporary, this.runtimeRoot);
        await verifySafePathBoundary(target, this.runtimeRoot);
        await rename(temporary, target);
        const readBack = await this.read(target, validate);
        if (readBack.canonicalHash !== next.canonicalHash || readBack.revision !== next.revision)
          throw new Error("tavern_artifact_readback_mismatch");
        return readBack;
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        if (temporaryOwner !== undefined) {
          try {
            await cleanupTemporary(temporary, this.runtimeRoot, temporaryOwner);
          } catch (cleanupError) {
            // Never replace the operation's useful failure with a cleanup
            // failure. A cleanup failure after success remains observable.
            if (primaryError === undefined) throw cleanupError;
          }
        }
      }
    }, { containmentRoot: this.runtimeRoot });
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
  return Object.freeze({ schemaVersion: 1, revision, canonicalHash: value.canonicalHash, artifact });
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
type TemporaryFileIdentity = Readonly<{ dev: number; ino: number }>;

async function identifyTemporary(path: string, containmentRoot: string): Promise<TemporaryFileIdentity> {
  await verifySafePathBoundary(path, containmentRoot);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe_path_boundary");
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

async function cleanupTemporary(
  path: string,
  containmentRoot: string,
  owner: TemporaryFileIdentity,
): Promise<void> {
  await verifySafePathBoundary(path, containmentRoot);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== owner.dev || stat.ino !== owner.ino) return;
  // Recheck the boundary and identity immediately before unlinking. This is
  // only a best-effort ownership guard; it does not eliminate hostile TOCTOU.
  await verifySafePathBoundary(path, containmentRoot);
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) return;
  await rm(path, { force: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
function rec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
