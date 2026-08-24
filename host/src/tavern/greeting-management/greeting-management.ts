import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { TavernArtifactStore } from "../artifact-store.js";
import { type GreetingSet, validateTavernArtifact } from "../types.js";

export type GreetingVariantProjection = Readonly<{ label?: string; text: string }>;
export type GreetingSetProjection = Readonly<{
  revision: number;
  label?: string;
  variants: readonly GreetingVariantProjection[];
}>;
export type CreateGreetingSetRequest = Readonly<{
  label: string;
  variants: readonly Readonly<{ label: string; text: string }>[];
}>;
export type UpdateGreetingSetRequest = CreateGreetingSetRequest & Readonly<{ expectedRevision: number }>;
export type GreetingManagementService = Readonly<{
  create(request: CreateGreetingSetRequest): Promise<GreetingSetProjection>;
  read(): Promise<GreetingSetProjection | null>;
  update(request: UpdateGreetingSetRequest): Promise<GreetingSetProjection>;
}>;

/** Player-scoped durable greeting data. Authored text is stored and projected verbatim. */
export function createGreetingManagementService(
  store: TavernArtifactStore,
  playerRoot: string,
): GreetingManagementService {
  const root = resolve(playerRoot);
  const greetingSetId = `greeting-set-${digest(root)}`;
  const repository = store.openRevisionRepository({
    root: join(root, "greetings", greetingSetId),
    artifactKind: "greeting",
    id: greetingSetId,
    validateArtifact: validateTavernArtifact,
    matchesId: (artifact, id) => isGreetingSet(artifact) && artifact.greetingSetId === id,
    project,
    invalidArtifact: () => new Error("invalid_greeting_artifact"),
    conflict: () => new Error("greeting_revision_conflict"),
  });
  return Object.freeze({
    async create(request) {
      validateRequest(request);
      try {
        return await repository.create(() => greeting(greetingSetId, 1, request));
      } catch (error) {
        if (error instanceof Error && error.message === "greeting_revision_conflict")
          throw new Error("greeting_already_exists");
        throw error;
      }
    },
    async read() {
      return (await repository.readLatest()) ?? null;
    },
    async update(request) {
      validateUpdateRequest(request);
      return repository.update(request.expectedRevision, (revision) => greeting(greetingSetId, revision, request));
    },
  });
}
function greeting(greetingSetId: string, revision: number, request: CreateGreetingSetRequest): GreetingSet {
  return Object.freeze({
    schemaVersion: 1,
    revision,
    greetingSetId,
    label: request.label,
    variants: Object.freeze(
      request.variants.map((variant, index) =>
        Object.freeze({ variantId: `greeting-${index + 1}`, label: variant.label, text: variant.text }),
      ),
    ),
  });
}
function project(artifact: unknown): GreetingSetProjection {
  if (!isGreetingSet(artifact)) throw new Error("invalid_greeting_artifact");
  return Object.freeze({
    revision: artifact.revision,
    ...(artifact.label === undefined ? {} : { label: artifact.label }),
    variants: Object.freeze(
      artifact.variants.map((variant) =>
        Object.freeze({ ...(variant.label === undefined ? {} : { label: variant.label }), text: variant.text }),
      ),
    ),
  });
}
function validateRequest(value: unknown): asserts value is CreateGreetingSetRequest {
  if (
    !record(value) ||
    !allowed(value, ["label", "variants"]) ||
    !text(value.label, 128) ||
    !Array.isArray(value.variants) ||
    value.variants.length === 0 ||
    value.variants.length > 16 ||
    !value.variants.every(
      (variant) =>
        record(variant) && allowed(variant, ["label", "text"]) && text(variant.label, 128) && text(variant.text, 8_192),
    )
  )
    throw new Error("invalid_greeting_request");
}
function validateUpdateRequest(value: unknown): asserts value is UpdateGreetingSetRequest {
  if (
    !record(value) ||
    !allowed(value, ["expectedRevision", "label", "variants"]) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1
  )
    throw new Error("invalid_greeting_request");
  validateRequest({ label: value.label, variants: value.variants });
}
function isGreetingSet(value: unknown): value is GreetingSet {
  return (
    record(value) &&
    typeof value.greetingSetId === "string" &&
    Number.isSafeInteger(value.revision) &&
    Array.isArray(value.variants)
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
