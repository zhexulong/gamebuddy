import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { TavernArtifactStore } from "../artifact-store.js";
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
  const personaId = `player-persona-${digest(root)}`;
  const repository = store.openRevisionRepository({
    root: join(root, "personas", personaId),
    artifactKind: "persona",
    id: personaId,
    validateArtifact: validateTavernArtifact,
    matchesId: (artifact, id) => isUserPersona(artifact) && artifact.personaId === id,
    project,
    invalidArtifact: () => new Error("invalid_persona_artifact"),
    conflict: () => new Error("persona_revision_conflict"),
  });
  return Object.freeze({
    async create(request) {
      validateRequest(request);
      try {
        return await repository.create(() => persona(personaId, 1, request));
      } catch (error) {
        if (error instanceof Error && error.message === "persona_revision_conflict")
          throw new Error("persona_already_exists");
        throw error;
      }
    },
    async read() {
      return (await repository.readLatest()) ?? null;
    },
    async update(request) {
      validateUpdateRequest(request);
      return repository.update(request.expectedRevision, (revision) => persona(personaId, revision, request));
    },
  });
}
function persona(personaId: string, revision: number, request: CreatePlayerPersonaRequest): UserPersona {
  return Object.freeze({
    schemaVersion: 1,
    revision,
    personaId,
    name: request.name,
    ...(request.description === undefined ? {} : { description: request.description }),
  });
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
