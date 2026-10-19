import { createHash } from "node:crypto";
import type {
  GameBuddyAuthoredStableSourceRef,
  GameBuddyAuthoredVolatileSourceRef,
  GameBuddyChatContextScope,
} from "@cortexkit/pi-magic-context/tavern";
import { canonicalHash } from "../tavern/artifact-store.js";

/**
 * A genuinely valid `gamebuddy-authored-context-catalog/v2` for tests that publish through the
 * vendor's own capability.
 *
 * The vendor validates the catalog before it mints a capability and refuses one whose
 * `canonicalHash` is not sha256 over its own canonical form, so a fixture carrying an invented
 * hash never reaches the registry - a delivery assertion built on one would be vacuous. The
 * hash is computed here, over the Host's equivalent canonical form, not faked.
 */
export type AuthoredContextStableSource = Readonly<{
  sourceId: string;
  kind: "persona" | "scenario" | "dialogue_examples" | "lorebook_constant";
  revision: string;
  content: string;
  budgetTokens: number;
  totalOrderKey: string;
  provenance: string;
}>;

export type AuthoredContextVolatileSource = Readonly<{
  sourceId: string;
  revision: string;
  content: string;
  budgetTokens: number;
  totalOrderKey: string;
  provenance: string;
  selectionKeys: readonly string[];
}>;

export type AuthoredContextCatalogFixture = Readonly<{
  catalog: unknown;
  stableRefs: readonly GameBuddyAuthoredStableSourceRef[];
  volatileRefs: readonly GameBuddyAuthoredVolatileSourceRef[];
}>;

const contentHash = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

/**
 * The one process-wide authored-context registry Magic Context keeps on `globalThis`
 * (`vendor/magic-context/packages/pi-plugin/src/gamebuddy-stable-context-source.ts`). The published
 * package carries two bundle entries - the Host's `./tavern` (publish + per-turn volatile bind) and
 * the Pi extension entry (the reader that renders m[0]/m[1]) - so a Host test has to read the same
 * slot the extension entry reads to assert what the model will actually receive.
 */
export const AUTHORED_CONTEXT_REGISTRY_SLOT_KEY = "magic-context.pi.gamebuddy-authored-context-registry";

const AUTHORED_CONTEXT_REGISTRY_SLOT = Symbol.for(AUTHORED_CONTEXT_REGISTRY_SLOT_KEY);

type AuthoredContextMaterializationView = Readonly<{
  renderedBlock: string;
  sources: readonly Readonly<{ kind: string }>[];
}>;

export type AuthoredContextRegistry = Readonly<{
  materializations: Map<string, AuthoredContextMaterializationView>;
  volatileTurns: Map<string, Readonly<{ turnId: string; sourceRefs: readonly unknown[] }>>;
}>;

export function readAuthoredContextRegistry(): AuthoredContextRegistry | undefined {
  return (globalThis as typeof globalThis & { [AUTHORED_CONTEXT_REGISTRY_SLOT]?: AuthoredContextRegistry })[
    AUTHORED_CONTEXT_REGISTRY_SLOT
  ];
}

/** Key order is load-bearing: the vendor compares refs with `JSON.stringify`. */
function authoredContextStableRef(source: AuthoredContextStableSource): GameBuddyAuthoredStableSourceRef {
  return Object.freeze({
    sourceId: source.sourceId,
    kind: source.kind,
    revision: source.revision,
    canonicalHash: contentHash(source.content),
    totalOrderKey: source.totalOrderKey,
  });
}

function authoredContextVolatileRef(source: AuthoredContextVolatileSource): GameBuddyAuthoredVolatileSourceRef {
  return Object.freeze({
    sourceId: source.sourceId,
    kind: "lorebook_entry",
    revision: source.revision,
    canonicalHash: contentHash(source.content),
    totalOrderKey: source.totalOrderKey,
    provenance: source.provenance,
  });
}

export function authoredContextCatalogFixture(
  scope: GameBuddyChatContextScope,
  sources: Readonly<{
    stableSources?: readonly AuthoredContextStableSource[];
    volatileSources?: readonly AuthoredContextVolatileSource[];
  }>,
): AuthoredContextCatalogFixture {
  const stableSources = (sources.stableSources ?? []).map((source) =>
    Object.freeze({ ...source, canonicalHash: contentHash(source.content) }),
  );
  const volatileSources = (sources.volatileSources ?? []).map((source) =>
    Object.freeze({ ...source, kind: "lorebook_entry" as const, canonicalHash: contentHash(source.content) }),
  );
  const body = Object.freeze({
    version: "gamebuddy-authored-context-catalog/v2",
    scope,
    stableSources,
    volatileSources,
  });
  return Object.freeze({
    catalog: Object.freeze({ ...body, canonicalHash: canonicalHash(body) }),
    stableRefs: Object.freeze((sources.stableSources ?? []).map(authoredContextStableRef)),
    volatileRefs: Object.freeze((sources.volatileSources ?? []).map(authoredContextVolatileRef)),
  });
}
