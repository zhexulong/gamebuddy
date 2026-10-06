import { join, resolve } from "node:path";
import type { TavernArtifactStore } from "./artifact-store.js";
import {
  type StCardImportHistoryDispositionCounts,
  type StCardImportHistoryRecord,
  validateTavernArtifact,
} from "./types.js";

/** The closed disposition classes a decoder can assign to a raw card field. */
export type StCardImportDispositionClass = keyof StCardImportHistoryDispositionCounts;

export type StCardImportHistoryEntry = Readonly<{
  importId: string;
  occurredAtMs: number;
  cardName: string;
  companionId: string;
  counts: StCardImportHistoryDispositionCounts;
}>;

export type RecordStCardImportHistoryInput = Readonly<{
  importId: string;
  occurredAtMs: number;
  cardName: string;
  companionId: string;
  dispositions: readonly Readonly<{ classification: StCardImportDispositionClass }>[];
}>;

/**
 * Player-scoped append-only evidence for confirmed reviewed-card imports.
 *
 * One immutable record is written per confirmed import at its own
 * `import-history/<importId>/history.json` leaf, so a second write to the same
 * import is a revision conflict rather than a mutation, and `list()` enumerates
 * the leaf per import exactly like the other Tavern record repositories.
 *
 * The record is EVIDENCE only: no reader consults it to grant, deny or rewrite
 * what an import did, and it never carries card body text.
 */
export type StCardImportHistoryService = Readonly<{
  record(input: RecordStCardImportHistoryInput): Promise<StCardImportHistoryEntry>;
  /** Newest first; an absent history root is an empty history, never an error. */
  list(): Promise<readonly StCardImportHistoryEntry[]>;
}>;

export function createStCardImportHistoryService(
  store: TavernArtifactStore,
  playerRoot: string,
): StCardImportHistoryService {
  const root = join(resolve(playerRoot), "import-history");
  const recordPath = (importId: string) => join(root, importId, "history.json");
  return Object.freeze({
    async record(input) {
      const artifact = historyRecord(input);
      return project((await store.write(recordPath(artifact.importId), artifact, validateTavernArtifact)).artifact);
    },
    async list() {
      const entries = await store.listArtifactRepositories(root, (entry) =>
        store.openArtifactRepository<StCardImportHistoryRecord, StCardImportHistoryEntry>({
          path: join(root, entry, "history.json"),
          validateArtifact: (value) => {
            const artifact = validateTavernArtifact(value);
            if (!isHistoryRecord(artifact)) throw new Error("invalid_st_card_import_history");
            return artifact;
          },
          project: (artifact) => project(artifact),
        }),
      );
      return Object.freeze(
        [...entries].sort(
          (left, right) =>
            right.occurredAtMs - left.occurredAtMs || right.importId.localeCompare(left.importId, "en"),
        ),
      );
    },
  });
}

function historyRecord(input: RecordStCardImportHistoryInput): StCardImportHistoryRecord {
  const counts: Record<StCardImportDispositionClass, number> = {
    accepted_typed: 0,
    preserved_opaque: 0,
    dropped_unsupported: 0,
    rejected_invalid: 0,
  };
  for (const disposition of input.dispositions) counts[disposition.classification] += 1;
  return Object.freeze({
    schemaVersion: 1,
    revision: 1,
    importId: input.importId,
    occurredAtMs: input.occurredAtMs,
    cardName: input.cardName,
    companionId: input.companionId,
    counts: Object.freeze(counts),
  });
}

function project(artifact: unknown): StCardImportHistoryEntry {
  if (!isHistoryRecord(artifact)) throw new Error("invalid_st_card_import_history");
  return Object.freeze({
    importId: artifact.importId,
    occurredAtMs: artifact.occurredAtMs,
    cardName: artifact.cardName,
    companionId: artifact.companionId,
    counts: Object.freeze({
      accepted_typed: artifact.counts.accepted_typed,
      preserved_opaque: artifact.counts.preserved_opaque,
      dropped_unsupported: artifact.counts.dropped_unsupported,
      rejected_invalid: artifact.counts.rejected_invalid,
    }),
  });
}

function isHistoryRecord(value: unknown): value is StCardImportHistoryRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "importId" in value &&
    "occurredAtMs" in value &&
    "counts" in value
  );
}
