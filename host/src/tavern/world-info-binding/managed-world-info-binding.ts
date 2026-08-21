import { canonicalHash, canonicalJson } from "../artifact-store.js";
import type { TavernStableManagedWorldInfoBinding } from "../chat-thread-store.js";
import type {
  PublicWorldInfoProjection,
  WorldInfoManagementRepository,
} from "../world-info-management/world-info-management.js";

/** Exact immutable managed source delivered to Tavern stable materialization. */
export type ManagedWorldInfoSource = Readonly<{
  binding: TavernStableManagedWorldInfoBinding;
  content: string;
}>;

/**
 * Exact-revision-only resolver surface. Browser-selected revisions are always
 * resolved by the exact immutable revision; there is no latest projection.
 */
export type ManagedWorldInfoBindingResolver = Readonly<{
  bindExact(publicTitle: string, revision: number): Promise<TavernStableManagedWorldInfoBinding>;
  resolve(binding: TavernStableManagedWorldInfoBinding): Promise<ManagedWorldInfoSource>;
}>;

/**
 * Explicit adapter between the managed public repository and Tavern. It only
 * resolves a revision already named by a thread; it never lists or selects the
 * latest managed artifact, and browser-selected revisions never resolve as
 * latest.
 */
export function createManagedWorldInfoBindingResolver(
  repository: WorldInfoManagementRepository,
): ManagedWorldInfoBindingResolver {
  return Object.freeze({
    /**
     * Binds the exact immutable revision named by the caller. There is no
     * latest-resolving variant: durable selection must always name a specific
     * revision so a later repository update can never silently move a binding.
     */
    async bindExact(publicTitle: string, revision: number): Promise<TavernStableManagedWorldInfoBinding> {
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("managed_world_info_revision_missing");
      const history = await repository.history(publicTitle);
      const projection = history.find((candidate) => candidate.revision === revision);
      if (projection === undefined) throw new Error("managed_world_info_revision_missing");
      return bindingFor(projection);
    },
    async resolve(binding: TavernStableManagedWorldInfoBinding): Promise<ManagedWorldInfoSource> {
      const history = await repository.history(binding.publicTitle);
      const projection = history.find((candidate) => candidate.revision === binding.revision);
      if (projection === undefined) throw new Error("managed_world_info_revision_missing");
      const resolved = bindingFor(projection);
      if (resolved.canonicalHash !== binding.canonicalHash) throw new Error("managed_world_info_binding_mismatch");
      return Object.freeze({ binding: resolved, content: contentFor(projection) });
    },
  });
}

function bindingFor(projection: PublicWorldInfoProjection): TavernStableManagedWorldInfoBinding {
  return Object.freeze({
    source: "managed_world_info",
    publicTitle: projection.publicTitle,
    revision: projection.revision,
    canonicalHash: canonicalHash(canonicalProjection(projection)),
  });
}
function contentFor(projection: PublicWorldInfoProjection): string {
  return canonicalJson(canonicalProjection(projection));
}
function canonicalProjection(projection: PublicWorldInfoProjection) {
  return {
    revision: projection.revision,
    publicTitle: projection.publicTitle,
    summary: projection.summary,
    entries: projection.entries.map((entry) => ({
      scope: entry.scope,
      publicTitle: entry.publicTitle,
      summary: entry.summary,
    })),
  };
}
