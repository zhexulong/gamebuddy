import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { TavernArtifactStore, TavernRevisionConflict } from "../artifact-store.js";
import { readSafeDirectory } from "../../path-lock.js";
import { validateTavernArtifact, type GreetingSet } from "../types.js";

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
  const legacyPath = join(root, "greeting-management", "greetings.json");
  const greetingSetId = `greeting-set-${digest(root)}`;
  const directory = join(root, "greetings", greetingSetId);
  const path = (revision: number) => join(directory, "revisions", `${revision}.json`);
  return Object.freeze({
    async create(request) {
      validateRequest(request);
      const artifact: GreetingSet = Object.freeze({
        schemaVersion: 1,
        revision: 1,
        greetingSetId,
        label: request.label,
        variants: Object.freeze(
          request.variants.map((variant, index) =>
            Object.freeze({ variantId: `greeting-${index + 1}`, label: variant.label, text: variant.text }),
          ),
        ),
      });
      try {
        return project((await store.write(path(1), artifact, validateTavernArtifact)).artifact);
      } catch (error) {
        if (error instanceof TavernRevisionConflict) throw new Error("greeting_already_exists");
        throw error;
      }
    },
    async read() {
      const canonical = await latest(store, directory, greetingSetId);
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
      const previous = await latest(store, directory, greetingSetId);
      if (previous === undefined || previous.revision !== request.expectedRevision)
        throw new Error("greeting_revision_conflict");
      const artifact: GreetingSet = Object.freeze({
        schemaVersion: 1,
        revision: request.expectedRevision + 1,
        greetingSetId,
        label: request.label,
        variants: Object.freeze(
          request.variants.map((variant, index) =>
            Object.freeze({ variantId: `greeting-${index + 1}`, label: variant.label, text: variant.text }),
          ),
        ),
      });
      return project((await store.write(path(artifact.revision), artifact, validateTavernArtifact)).artifact);
    },
  });
}

async function latest(store: TavernArtifactStore, directory: string, id: string): Promise<GreetingSet | undefined> {
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
      if (isGreetingSet(artifact) && artifact.greetingSetId === id && artifact.revision === revision) return artifact;
      corrupt = true;
    } catch {
      corrupt = true;
    }
  }
  if (corrupt) throw new Error("invalid_greeting_artifact");
  return undefined;
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
