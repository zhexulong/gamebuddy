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
 * Explicit adapter between the managed public repository and Tavern. It only
 * resolves a revision already named by a thread; it never lists or selects the
 * latest managed artifact.
 */
export function createManagedWorldInfoBindingResolver(repository: WorldInfoManagementRepository) {
  return Object.freeze({
    async bind(publicTitle: string): Promise<TavernStableManagedWorldInfoBinding> {
      const projection = await repository.detail(publicTitle);
      if (projection === null) throw new Error("managed_world_info_not_found");
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
