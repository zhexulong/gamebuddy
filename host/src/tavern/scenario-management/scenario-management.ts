import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { TavernArtifactStore, TavernRevisionConflict } from "../artifact-store.js";
import { readSafeDirectory } from "../../path-lock.js";
import { validateTavernArtifact, type Scenario } from "../types.js";

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
  const legacyPath = join(root, "scenario-management", "scenario.json");
  const scenarioId = `player-scenario-${digest(root)}`;
  const directory = join(root, "scenarios", scenarioId);
  const path = (revision: number) => join(directory, "revisions", `${revision}.json`);

  return Object.freeze({
    async create(request) {
      validateCreateRequest(request);
      const artifact = scenario(scenarioId, 1, request);
      try {
        return project((await store.write(path(1), artifact, validateTavernArtifact)).artifact);
      } catch (error) {
        if (error instanceof TavernRevisionConflict) throw new Error("scenario_already_exists");
        throw error;
      }
    },
    async read() {
      const canonical = await latest(store, directory, scenarioId);
      if (canonical !== undefined) return project(canonical);
      try {
        return project((await store.read(legacyPath, validateTavernArtifact)).artifact);
      } catch (error) {
        if (error instanceof Error && error.message === "tavern_artifact_unreadable") return null;
        throw error;
      }
    },
    async update(request) {
      validateUpdateRequest(request);
      const previous = await latest(store, directory, scenarioId);
      if (previous === undefined || previous.revision !== request.expectedRevision)
        throw new Error("scenario_revision_conflict");
      const artifact = scenario(scenarioId, request.expectedRevision + 1, request);
      try {
        return project((await store.write(path(artifact.revision), artifact, validateTavernArtifact)).artifact);
      } catch (error) {
        if (error instanceof TavernRevisionConflict) throw new Error("scenario_revision_conflict");
        throw error;
      }
    },
  });
}

async function latest(
  store: TavernArtifactStore,
  directory: string,
  scenarioId: string,
): Promise<Scenario | undefined> {
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
      if (isScenario(artifact) && artifact.scenarioId === scenarioId && artifact.revision === revision) return artifact;
      corrupt = true;
    } catch {
      corrupt = true;
    }
  }
  if (corrupt) throw new Error("invalid_scenario_artifact");
  return undefined;
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
  if (!isScenario(artifact)) throw new Error("invalid_scenario_artifact");
  // Text-only artifacts predate durable player metadata. Preserve their
  // readable content without treating missing metadata as corruption.
  const description = artifact.description ?? artifact.text;
  const name = artifact.name ?? "Scenario";
  return Object.freeze({ revision: artifact.revision, name, description, preview: preview(description) });
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
