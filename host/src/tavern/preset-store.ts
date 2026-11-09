/**
 * The durable preset store: SillyTavern's own preset JSON, imported once and read from then on.
 *
 * Design (design/architecture/tavern-preset-compatibility.md §2.1) is that presets are READ-ONLY: `import`, `read`,
 * `export`, `delete`, and nothing else - no per-entry editing surface. `export` is not optional convenience: the
 * round-trip invariant ("import -> export -> re-import leaves the field set and the entry set equal") is the only
 * measurable form of §2.2's "preserve verbatim, never flatten", and without an export it is a claim with no evidence.
 *
 * The document is the authority. The summary a listing needs is DERIVED from it on every read and compared against
 * the copy written at import, so the two can never disagree silently - `preset_summary_drift` names the disagreement
 * instead. Nothing here interprets a field: `marker`, `injection_position` and `injection_depth` are read for the
 * summary and otherwise travel untouched.
 *
 * Layout, following the World Info store's own revision convention rather than a catalog: one file per preset under
 * `<playerRoot>/presets/<presetId>/preset.json`, holding a revision envelope whose artifact is the document plus the
 * summary derived from it. A preset is player-scoped, so it is reachable from every Chat of that player.
 */
import { join, resolve } from "node:path";
import {
  atomicWriteFile,
  readSafeDirectory,
  removeSafeFile,
  verifySafePathBoundary,
  withPathLock,
} from "../path-lock.js";
import { readStrictJsonFile, STRICT_JSON_READER_MAX_BUDGET_BYTES } from "../strict-json-reader.js";
import { canonicalHash, canonicalJson } from "./artifact-store.js";
import {
  type PresetDocument,
  type PresetSummary,
  presetDocumentSummary,
  validatePresetDocument,
  withPromptEnabled,
} from "./preset-document.js";

/** The store needs these two roots and nothing else; `TavernPaths` satisfies it structurally. */
export type PresetStorePaths = Readonly<{ runtimeRoot: string; playerRoot: string }>;

/** One stored preset: the document, and the summary derived from it at this revision. */
export type PresetRecord = Readonly<{
  presetId: string;
  revision: number;
  summary: PresetSummary;
  document: PresetDocument;
}>;

export type PresetImportRequest = Readonly<{ presetId: string; document: unknown }>;

export type PresetStore = Readonly<{
  /**
   * Stores one preset under a caller-chosen id. An id that is already taken is refused
   * (`preset_already_imported`) rather than overwritten: presets are read-only, so re-importing over one would be an
   * edit nobody asked for. Delete and import again is the path a player takes to replace a preset.
   */
  import(request: PresetImportRequest): Promise<PresetRecord>;
  read(presetId: string): Promise<PresetRecord>;
  /** The document as stored, for the round trip. Field-for-field what `import` accepted, unknown keys included. */
  export(presetId: string): Promise<PresetDocument>;
  list(): Promise<readonly PresetSummary[]>;
  delete(presetId: string): Promise<void>;
  /**
   * Switches one entry on or off - the single mutation this read-only domain allows (a marker entry such as
   * `chatHistory` can only be enabled or disabled, never edited: A4 §2.2/§10). It rewrites both places SillyTavern
   * keeps that fact, so the stored preset stays one document rather than two disagreeing ones.
   */
  setEnabled(presetId: string, identifier: string, enabled: boolean): Promise<PresetRecord>;
}>;

type PresetArtifact = Readonly<{
  presetId: string;
  revision: number;
  summary: PresetSummary;
  document: PresetDocument;
}>;
type PresetEnvelope = Readonly<{
  schemaVersion: 1;
  revision: number;
  canonicalHash: string;
  artifact: PresetArtifact;
}>;

const PRESET_ID = /^[A-Za-z0-9._-]{1,128}$/u;
// A real preset is a generated file a player downloaded: the largest measured ones are hundreds of KiB, so the file is
// read at the reader's absolute ceiling rather than its 64 KiB configuration default.
const MAX_PRESET_BYTES = STRICT_JSON_READER_MAX_BUDGET_BYTES;

export function createPresetStore(paths: PresetStorePaths): PresetStore {
  const root = resolve(paths.runtimeRoot);
  const presetsRoot = join(resolve(paths.playerRoot), "presets");

  const presetPath = (presetId: string): string => join(presetsRoot, validPresetId(presetId), "preset.json");

  const readPreset = async (presetId: string, path: string): Promise<PresetRecord | undefined> => {
    let value: unknown;
    try {
      await verifySafePathBoundary(path, root);
      value = await readStrictJsonFile(path, MAX_PRESET_BYTES);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new Error("invalid_preset_artifact", { cause: error });
    }
    if (
      !isRecord(value) ||
      !only(value, ["schemaVersion", "revision", "canonicalHash", "artifact"]) ||
      value.schemaVersion !== 1 ||
      !revisionNumber(value.revision) ||
      typeof value.canonicalHash !== "string" ||
      !isRecord(value.artifact) ||
      !only(value.artifact, ["presetId", "revision", "summary", "document"]) ||
      value.artifact.presetId !== presetId ||
      value.artifact.revision !== value.revision
    )
      throw new Error(`invalid_preset_artifact:${presetId}`);
    const artifact = value.artifact;
    if (canonicalHash(artifact) !== value.canonicalHash) throw new Error(`invalid_preset_artifact:${presetId}`);
    const document = validatePresetDocument(artifact.document);
    const summary = presetDocumentSummary({ presetId, revision: value.revision, document });
    // The stored summary is the importer's own reading of this document. Re-deriving it here is what makes the two
    // one fact: a preset whose summary no longer describes it fails closed by name instead of listing a half-truth.
    if (canonicalJson(summary) !== canonicalJson(artifact.summary)) throw new Error(`preset_summary_drift:${presetId}`);
    return Object.freeze({ presetId, revision: value.revision, summary, document });
  };

  const writePreset = async (path: string, artifact: PresetArtifact): Promise<PresetRecord> => {
    const envelope: PresetEnvelope = Object.freeze({
      schemaVersion: 1 as const,
      revision: artifact.revision,
      canonicalHash: canonicalHash(artifact),
      artifact,
    });
    await atomicWriteFile(path, canonicalJson(envelope), root);
    const readBack = await readPreset(artifact.presetId, path);
    if (readBack === undefined || readBack.revision !== artifact.revision)
      throw new Error(`preset_artifact_readback_mismatch:${artifact.presetId}`);
    return readBack;
  };

  /** Runs one whole mutation of a preset file under that file's lock, so no read sees a half-written revision. */
  const withPresetLock = <T>(path: string, work: () => Promise<T>): Promise<T> =>
    withPathLock(path, work, { containmentRoot: root });

  return Object.freeze({
    async import(request) {
      const presetId = validPresetId(request.presetId);
      const document = validatePresetDocument(request.document);
      const path = presetPath(presetId);
      return withPresetLock(path, async () => {
        if ((await readPreset(presetId, path)) !== undefined) throw new Error(`preset_already_imported:${presetId}`);
        return writePreset(path, {
          presetId,
          revision: 1,
          summary: presetDocumentSummary({ presetId, revision: 1, document }),
          document,
        });
      });
    },

    async read(presetId) {
      const id = validPresetId(presetId);
      const record = await readPreset(id, presetPath(id));
      if (record === undefined) throw new Error(`preset_not_found:${id}`);
      return record;
    },

    async export(presetId) {
      return (await this.read(presetId)).document;
    },

    async list() {
      let entries: readonly string[];
      try {
        entries = await readSafeDirectory(presetsRoot, root);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return Object.freeze([]);
        throw error;
      }
      const summaries: PresetSummary[] = [];
      for (const entry of [...entries].sort()) {
        if (!PRESET_ID.test(entry)) continue;
        const record = await readPreset(entry, presetPath(entry));
        if (record !== undefined) summaries.push(record.summary);
      }
      return Object.freeze(summaries);
    },

    async delete(presetId) {
      const id = validPresetId(presetId);
      const path = presetPath(id);
      await withPresetLock(path, async () => {
        if ((await readPreset(id, path)) === undefined) throw new Error(`preset_not_found:${id}`);
        await removeSafeFile(path, root);
      });
    },

    async setEnabled(presetId, identifier, enabled) {
      if (typeof identifier !== "string" || identifier.length === 0 || typeof enabled !== "boolean")
        throw new Error("invalid_preset_request");
      const id = validPresetId(presetId);
      const path = presetPath(id);
      return withPresetLock(path, async () => {
        const current = await readPreset(id, path);
        if (current === undefined) throw new Error(`preset_not_found:${id}`);
        const document = withPromptEnabled(current.document, identifier, enabled);
        const revision = current.revision + 1;
        return writePreset(path, {
          presetId: id,
          revision,
          summary: presetDocumentSummary({ presetId: id, revision, document }),
          document,
        });
      });
    },
  });
}

function validPresetId(presetId: string): string {
  if (typeof presetId !== "string" || !PRESET_ID.test(presetId)) throw new Error("invalid_preset_id");
  return presetId;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function revisionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
