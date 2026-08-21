import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { TavernArtifactStore } from "../artifact-store.js";
import { type Scenario, validateTavernArtifact } from "../types.js";

export type PlayerScenarioProjection = Readonly<{
  revision: number;
  name: string;
  description: string;
  preview: string;
}>;

export type CreatePlayerScenarioRequest = Readonly<{
  name: string;
  description: string;
}>;

export type UpdatePlayerScenarioRequest = CreatePlayerScenarioRequest &
  Readonly<{
    expectedRevision: number;
  }>;

export type ScenarioManagementService = Readonly<{
  create(request: CreatePlayerScenarioRequest): Promise<PlayerScenarioProjection>;
  read(): Promise<PlayerScenarioProjection | null>;
  update(request: UpdatePlayerScenarioRequest): Promise<PlayerScenarioProjection>;
}>;

/**
 * Player-scoped Scenario metadata persistence. Only safe display metadata is
 * projected; artifact provenance, paths, identifiers, and materialized text
 * remain internal.
 */
export function createScenarioManagementService(
  store: TavernArtifactStore,
  playerRoot: string,
): ScenarioManagementService {
  const root = resolve(playerRoot);
  const scenarioId = `player-scenario-${digest(root)}`;
  const repository = store.openRevisionRepository({
    root: join(root, "scenarios", scenarioId),
    artifactKind: "scenario",
    id: scenarioId,
    validateArtifact: validateTavernArtifact,
    matchesId: (artifact, id) => isScenario(artifact) && artifact.scenarioId === id,
    project,
    invalidArtifact: () => new Error("invalid_scenario_artifact"),
    conflict: () => new Error("scenario_revision_conflict"),
  });
  return Object.freeze({
    async create(request) {
      validateCreateRequest(request);
      try {
        return await repository.create(() => scenario(scenarioId, 1, request));
      } catch (error) {
        if (error instanceof Error && error.message === "scenario_revision_conflict")
          throw new Error("scenario_already_exists");
        throw error;
      }
    },
    async read() {
      return (await repository.readLatest()) ?? null;
    },
    async update(request) {
      validateUpdateRequest(request);
      return repository.update(request.expectedRevision, (revision) => scenario(scenarioId, revision, request));
    },
  });
}
function scenario(scenarioId: string, revision: number, request: CreatePlayerScenarioRequest): Scenario {
  return Object.freeze({
    schemaVersion: 1,
    revision,
    scenarioId,
    name: request.name,
    description: request.description,
    text: request.description,
    provenance: "authored",
    owner: "chat_override",
  });
}

function project(artifact: unknown): PlayerScenarioProjection {
  if (!isScenario(artifact) || artifact.name === undefined || artifact.description === undefined)
    throw new Error("invalid_scenario_artifact");
  return Object.freeze({
    revision: artifact.revision,
    name: artifact.name,
    description: artifact.description,
    preview: preview(artifact.description),
  });
}

function validateCreateRequest(value: unknown): asserts value is CreatePlayerScenarioRequest {
  if (
    !record(value) ||
    !allowed(value, ["name", "description"]) ||
    !safeText(value.name, 128) ||
    !safeText(value.description, 8_192)
  )
    throw new Error("invalid_scenario_request");
}
function validateUpdateRequest(value: unknown): asserts value is UpdatePlayerScenarioRequest {
  if (
    !record(value) ||
    !allowed(value, ["expectedRevision", "name", "description"]) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1 ||
    !safeText(value.name, 128) ||
    !safeText(value.description, 8_192)
  )
    throw new Error("invalid_scenario_request");
}
function isScenario(value: unknown): value is Scenario {
  return (
    record(value) &&
    typeof value.scenarioId === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.text === "string" &&
    Number.isSafeInteger(value.revision)
  );
}
function preview(value: string): string {
  return value.slice(0, 240);
}
function allowed(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/u.test(value)
  );
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}
