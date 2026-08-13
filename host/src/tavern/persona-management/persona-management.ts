import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { TavernArtifactStore, TavernRevisionConflict } from "../artifact-store.js";
import { readSafeDirectory } from "../../path-lock.js";
import { validateTavernArtifact, type UserPersona } from "../types.js";

export type PlayerPersonaProjection = Readonly<{
  revision: number;
  name: string;
  description?: string;
}>;

export type CreatePlayerPersonaRequest = Readonly<{
  name: string;
  description?: string;
}>;
export type UpdatePlayerPersonaRequest = CreatePlayerPersonaRequest & Readonly<{ expectedRevision: number }>;

export type PersonaManagementService = Readonly<{
  create(request: CreatePlayerPersonaRequest): Promise<PlayerPersonaProjection>;
  read(): Promise<PlayerPersonaProjection | null>;
  update(request: UpdatePlayerPersonaRequest): Promise<PlayerPersonaProjection>;
}>;

/**
 * Player-scoped persona persistence. The public result is deliberately a
 * strict projection: no artifact path, identifier, hash, or runtime content
 * crosses this boundary.
 */
export function createPersonaManagementService(
  store: TavernArtifactStore,
  playerRoot: string,
): PersonaManagementService {
  const root = resolve(playerRoot);
  const legacyPath = join(root, "persona-management", "persona.json");
  const personaId = `player-persona-${digest(root)}`;
  const path = (revision: number) => join(root, "personas", personaId, "revisions", `${revision}.json`);
  return Object.freeze({
    async create(request) {
      validateRequest(request);
      const artifact: UserPersona = Object.freeze({
        schemaVersion: 1,
        revision: 1,
        personaId,
        name: request.name,
        ...(request.description === undefined ? {} : { description: request.description }),
      });
      try {
        return project((await store.write(path(1), artifact, validateTavernArtifact)).artifact);
      } catch (error) {
        if (error instanceof TavernRevisionConflict) throw new Error("persona_already_exists");
        throw error;
      }
    },
    async read() {
      const artifact = await latest(store, join(root, "personas", personaId), personaId);
      return artifact === undefined ? null : project(artifact);
    },
    async update(request) {
      validateUpdateRequest(request);
      const artifact: UserPersona = Object.freeze({
        schemaVersion: 1,
        revision: request.expectedRevision + 1,
        personaId,
        name: request.name,
        ...(request.description === undefined ? {} : { description: request.description }),
      });
      try {
        return project(
          (await store.compareAndWrite(path(artifact.revision), undefined, artifact, validateTavernArtifact)).artifact,
        );
      } catch (error) {
        if (error instanceof TavernRevisionConflict) throw new Error("persona_revision_conflict");
        try {
          await store.read(path(request.expectedRevision), validateTavernArtifact);
        } catch {
          throw new Error("persona_revision_conflict");
        }
        throw error;
      }
    },
  });
}

async function latest(
  store: TavernArtifactStore,
  directory: string,
  personaId: string,
): Promise<UserPersona | undefined> {
  let names: readonly string[];
  try {
    names = await readSafeDirectory(join(directory, "revisions"), directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let corrupt = false;
  for (const revision of names
    .map((name) => /^(\d+)\.json$/u.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((a, b) => b - a)) {
    try {
      const artifact = (await store.read(join(directory, "revisions", `${revision}.json`), validateTavernArtifact))
        .artifact;
      if (isUserPersona(artifact) && artifact.personaId === personaId && artifact.revision === revision)
        return artifact;
      corrupt = true;
    } catch {
      corrupt = true;
    }
  }
  if (corrupt) throw new Error("invalid_persona_artifact");
  return undefined;
}
function project(artifact: unknown): PlayerPersonaProjection {
  if (!isUserPersona(artifact)) throw new Error("invalid_persona_artifact");
  return Object.freeze({
    revision: artifact.revision,
    name: artifact.name,
    ...(artifact.description === undefined ? {} : { description: artifact.description }),
  });
}
function validateRequest(value: unknown): asserts value is CreatePlayerPersonaRequest {
  if (
    !record(value) ||
    !allowed(value, ["name", "description"]) ||
    !text(value.name, 128) ||
    (value.description !== undefined && !text(value.description, 4_096))
  )
    throw new Error("invalid_persona_request");
}
function validateUpdateRequest(value: unknown): asserts value is UpdatePlayerPersonaRequest {
  if (
    !record(value) ||
    !allowed(value, ["expectedRevision", "name", "description"]) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1 ||
    !text(value.name, 128) ||
    (value.description !== undefined && !text(value.description, 4_096))
  )
    throw new Error("invalid_persona_request");
}
function isUserPersona(value: unknown): value is UserPersona {
  return (
    record(value) &&
    typeof value.personaId === "string" &&
    typeof value.name === "string" &&
    Number.isSafeInteger(value.revision)
  );
}
function allowed(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}
