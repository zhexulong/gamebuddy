import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { MacroTable } from "../macro-engine.js";
import { renderMacros } from "../macro-engine.js";
import type { TavernArtifactStore } from "../artifact-store.js";
import { type Scenario, validateTavernArtifact } from "../types.js";

export type PlayerScenarioProjection = Readonly<{
  revision: number;
  name: string;
  description: string;
  preview: string;
}>;

type CreatePlayerScenarioRequest = Readonly<{
  name: string;
  description: string;
}>;

type UpdatePlayerScenarioRequest = CreatePlayerScenarioRequest &
  Readonly<{
    expectedRevision: number;
  }>;

export type ScenarioManagementService = Readonly<{
  create(request: CreatePlayerScenarioRequest): Promise<PlayerScenarioProjection>;
  read(): Promise<PlayerScenarioProjection | null>;
  update(request: UpdatePlayerScenarioRequest): Promise<PlayerScenarioProjection>;
}>;

/**
 * The ONE derivation of the companion's own scenario id.
 *
 * The reviewed card's scenario is written under this id at provisioning, and a Chat
 * creation that names no scenario binds the same id, so the writer and every reader
 * agree by construction rather than by two copies of a hash.
 */
export function companionScenarioId(companionRoot: string): string {
  return `player-scenario-${digest(resolve(companionRoot))}`;
}

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
  const scenarioId = companionScenarioId(root);
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
    (value.expectedRevision as number) < 0 ||
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
/** The bounded preview the browser projection carries, and the bound a rendered preview keeps. */
const SCENARIO_PREVIEW_LENGTH = 240;
function preview(value: string): string {
  return value.slice(0, SCENARIO_PREVIEW_LENGTH);
}

/**
 * Renders one scenario projection's authored text through the run's macro table.
 *
 * The durable record keeps the card's own `{{user}}`/`{{char}}` macros verbatim
 * (they are the authored content); this is the read-side rendering that keeps a
 * raw placeholder out of the surface a player reads. The table is the macro
 * engine's own (`macroTable`) so `{{char}}` is the companion's real name and
 * `{{user}}` the run's player reference, never a literal baked in here. The
 * rendered description is previewed AFTER rendering, so a macro that straddles
 * the preview bound is resolved whole rather than truncated into a stray `{{`.
 */
export function renderScenarioProjection(
  projection: PlayerScenarioProjection,
  macros: MacroTable,
): PlayerScenarioProjection {
  const description = renderMacros(projection.description, macros);
  return Object.freeze({
    revision: projection.revision,
    name: renderMacros(projection.name, macros),
    description,
    preview: preview(description),
  });
}

/**
 * The browser-facing projection over one scenario service: every projection the
 * surface can read (`create`, `read`, `update`) is rendered through the run's
 * macro table before it leaves the Host, so `scenario.read` can never paint a
 * `{{user}}`/`{{char}}` placeholder beside the player. The durable record is
 * untouched - `readScenario`/`update` still store what the caller wrote.
 */
export function withScenarioSurfaceMacros(
  service: ScenarioManagementService,
  resolveMacros: () => Promise<MacroTable>,
): ScenarioManagementService {
  const render = async (projection: PlayerScenarioProjection): Promise<PlayerScenarioProjection> =>
    renderScenarioProjection(projection, await resolveMacros());
  return Object.freeze({
    async create(request) {
      return render(await service.create(request));
    },
    async read() {
      const projection = await service.read();
      return projection === null ? null : render(projection);
    },
    async update(request) {
      return render(await service.update(request));
    },
  });
}
function allowed(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
  );
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}
