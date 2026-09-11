import type { AcceptedTurnAuthoredContextPlan, AuthoredContextSourceRef } from "../chat-thread-store.js";
import type { PublicWorldInfoProjection, WorldInfoManagementRepository } from "../world-info-management/world-info-management.js";
import { createHash } from "node:crypto";
import { canonicalHash } from "../artifact-store.js";

/** Read-only facts proving that an old accepted plan still names retained managed history. */
export type ManagedWorldInfoHistoryIntegrityFact = Readonly<{
  sourceId: string;
  revision: string;
  canonicalHash: string;
  present: boolean;
  hashMatches: boolean;
}>;
export type ManagedWorldInfoHistoryIntegrity = Readonly<{
  intact: boolean;
  facts: readonly ManagedWorldInfoHistoryIntegrityFact[];
}>;

/**
 * Detached verifier: it reads only retained managed World Info history. It has
 * no runtime/session capability and cannot publish, install, or assert a
 * current catalog.
 */
export async function verifyManagedWorldInfoHistoryIntegrity(
  plan: Pick<AcceptedTurnAuthoredContextPlan, "stableSources">,
  repository: WorldInfoManagementRepository,
): Promise<ManagedWorldInfoHistoryIntegrity> {
  const facts: ManagedWorldInfoHistoryIntegrityFact[] = [];
  // Managed source IDs are intentionally opaque hashes, so resolve the public
  // provenance key from the retained repository catalog before reading exact
  // history. This verifier never installs or publishes a source.
  const publicSources = await repository.list();
  const histories = await Promise.all(publicSources.map(async (item) => [item.publicTitle, await repository.history(item.publicTitle)] as const));
  for (const source of plan.stableSources) {
    if (source.kind !== "lorebook_constant") continue;
    const revision = Number(source.revision);
    const matchingHistory = histories.find(([publicTitle]) =>
      managedWorldInfoSourceId(publicTitle, revision, source.canonicalHash) === source.sourceId);
    const history = matchingHistory?.[1] ?? [];
    const candidate = history.find((item) => item.revision === revision);
    const hashMatches = candidate !== undefined && canonicalHash(canonicalProjection(candidate)) === source.canonicalHash;
    facts.push(Object.freeze({ sourceId: source.sourceId, revision: source.revision, canonicalHash: source.canonicalHash, present: candidate !== undefined, hashMatches }));
  }
  return Object.freeze({ intact: facts.every((fact) => fact.present && fact.hashMatches), facts: Object.freeze(facts) });
}

function managedWorldInfoSourceId(publicTitle: string, revision: number, hash: string): string {
  return `managed_world_info_${createHash("sha256").update(`${publicTitle}\u001f${revision}\u001f${hash}`, "utf8").digest("hex").slice(0, 32)}`;
}

function canonicalProjection(projection: PublicWorldInfoProjection) {
  return { revision: projection.revision, publicTitle: projection.publicTitle, summary: projection.summary, entries: projection.entries.map((entry) => ({ scope: entry.scope, publicTitle: entry.publicTitle, summary: entry.summary })) };
}
