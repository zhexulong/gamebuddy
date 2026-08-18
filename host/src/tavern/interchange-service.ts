import type { ArtifactEnvelope } from "./artifact-store.js";
import type { PersistedStCardImport, StCardImportService } from "./st-card-import-service.js";
import type { CharacterCandidate, StCardImportRecord } from "./types.js";

/**
 * Safe interchange composition. ST payloads enter only through the bounded
 * decoder and leave only as canonical inert candidate/report artifacts; this
 * module never emits a runnable card or invokes imported content.
 */
export type TavernSafeInterchange = Readonly<{
  candidate: ArtifactEnvelope<CharacterCandidate>;
  report: ArtifactEnvelope<StCardImportRecord>;
}>;
export type TavernInterchangeImports = Pick<StCardImportService, "import" | "export">;
export type TavernInterchangeService = Readonly<{
  importStCard(importId: string, input: string | Uint8Array): Promise<TavernSafeInterchange>;
  exportSafe(importId: string): Promise<TavernSafeInterchange>;
}>;

export function createTavernInterchangeService(imports: TavernInterchangeImports): TavernInterchangeService {
  return Object.freeze({
    async importStCard(importId, input) {
      return compose(await imports.import(importId, input));
    },
    async exportSafe(importId) {
      return compose(await imports.export(importId));
    },
  });
}
function compose(value: PersistedStCardImport): TavernSafeInterchange {
  const { candidate, report } = value;
  if (
    candidate.artifact.candidateId !== `st-card-${report.artifact.importId}` ||
    candidate.artifact.sourceHash !== report.artifact.sourceHash ||
    candidate.artifact.reviewState !== "pending"
  )
    throw new Error("invalid_tavern_safe_interchange");
  return Object.freeze({ candidate, report });
}
