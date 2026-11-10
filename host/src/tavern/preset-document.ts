/**
 * A SillyTavern preset, kept as SillyTavern's own JSON.
 *
 * The ruling this module implements (design/architecture/tavern-preset-compatibility.md §2.2) is that a preset's
 * fields are preserved verbatim and never flattened. Flattening is the specific mistake that loses `marker` and
 * `injection_depth` - the two things a modern preset is worth - so nothing here reconstructs a document: the
 * validator reads the structural facts a store needs and freezes the caller's value in place. Every key - the ones
 * A4 §2.2 names, the ones a newer SillyTavern adds, the ones an author invented - reaches the export unchanged,
 * because there is no code path that copies fields one at a time.
 *
 * A4 (`ref/TavernWeave/skills/consult-tavernweave-library/references/st-guides/A4_提示词与预设.md` §2.2/§2.5) is the
 * field authority; the reference implementation read beside this module is SillyTavern's own
 * `default/content/presets/openai/Default.json`.
 */
import { PRESET_NAME_CHARS } from "./browser-contract/index.js";

/**
 * The prompt-entry fields A4 §2.2 documents. This is a reading aid for callers that must name or recognise one
 * (`marker`, `injection_position`), never a filter: an entry carrying only some of them, or more, is preserved whole.
 */
export const PRESET_PROMPT_FIELDS = Object.freeze([
  "identifier",
  "name",
  "content",
  "role",
  "enabled",
  "system_prompt",
  "marker",
  "injection_position",
  "injection_depth",
  "injection_order",
  "forbid_overrides",
  "extension",
  "injection_trigger",
] as const);

/** One `prompts[]` entry, exactly as the author wrote it. `identifier` is the one field a preset cannot omit. */
export type PresetPrompt = Readonly<Record<string, unknown>> & Readonly<{ identifier: string }>;

/** A whole preset file. `prompts` is required; everything else is SillyTavern's, including keys unknown here. */
export type PresetDocument = Readonly<Record<string, unknown>> & Readonly<{ prompts: readonly PresetPrompt[] }>;

/**
 * What a preset listing needs, derived from the document rather than stored as a second opinion about it.
 * `list` and `read` both derive it through `presetDocumentSummary`, so a summary can never be older than the
 * document it describes.
 */
export type PresetSummary = Readonly<{
  presetId: string;
  revision: number;
  /** SillyTavern's own top-level `name`, when the file carries one: presets are usually named by their filename. */
  name: string | null;
  promptCount: number;
  /** Entries with `marker: true` - slots the runtime fills (`chatHistory`, `worldInfoBefore`, ...), not content. */
  markerIdentifiers: readonly string[];
  /** Entries with `injection_position: 1` (ABSOLUTE / in-chat): these are inserted at a depth, not concatenated. */
  depthInjectionIdentifiers: readonly string[];
  promptOrderGroups: number;
}>;

/**
 * Validates the three things whose absence makes a preset structurally impossible, and nothing else.
 *
 * Each refusal names the offending field by path, because "invalid preset" tells an author with 300 entries nothing
 * about which one is wrong. Type mismatches inside a field are deliberately NOT refused: a preset that carries
 * `injection_depth: "4"` is still SillyTavern's document, and refusing it would be this repo inventing a stricter
 * format than the one it promises to preserve.
 */
export function validatePresetDocument(value: unknown): PresetDocument {
  if (!isRecord(value)) throw new Error("preset_document_not_an_object:preset");
  if (!Array.isArray(value.prompts)) throw new Error("preset_prompts_not_an_array:prompts");
  // The ONE ceiling this validator adds to the format, and it is the WIRE's own rather than a stricter reading of
  // SillyTavern's: the surface publishes `name`, so a document whose name is past `PRESET_NAME_CHARS` is a preset no
  // panel can draw, and the read would answer the whole listing with `preset_assembly_read_unavailable` instead of
  // naming the field at fault. Refused here, by name, before anything is stored.
  if (typeof value.name === "string" && value.name.length > PRESET_NAME_CHARS)
    throw new Error(`preset_name_over_ceiling:${String(value.name.length)}:${String(PRESET_NAME_CHARS)}`);
  value.prompts.forEach((entry, index) => {
    const path = `prompts[${index}]`;
    if (!isRecord(entry)) throw new Error(`preset_prompt_entry_not_an_object:${path}`);
    if (typeof entry.identifier !== "string" || entry.identifier.length === 0)
      throw new Error(`preset_prompt_entry_missing_identifier:${path}.identifier`);
  });
  return deepFreeze(value) as PresetDocument;
}

/** Every prompt entry, in the document's own order - the population a reader or a gate iterates. */
export function promptEntries(document: PresetDocument): readonly PresetPrompt[] {
  return document.prompts;
}

/** One entry by its identifier, or `undefined`. Identifiers are SillyTavern's own key for an entry. */
export function promptEntry(document: PresetDocument, identifier: string): PresetPrompt | undefined {
  return document.prompts.find((entry) => entry.identifier === identifier);
}

export function presetDocumentSummary(
  input: Readonly<{
    presetId: string;
    revision: number;
    document: PresetDocument;
  }>,
): PresetSummary {
  const document = input.document;
  const promptOrders = Array.isArray(document.prompt_order) ? document.prompt_order : [];
  return Object.freeze({
    presetId: input.presetId,
    revision: input.revision,
    name: typeof document.name === "string" ? document.name : null,
    promptCount: document.prompts.length,
    markerIdentifiers: Object.freeze(
      document.prompts.filter((entry) => entry.marker === true).map((entry) => entry.identifier),
    ),
    depthInjectionIdentifiers: Object.freeze(
      document.prompts.filter((entry) => entry.injection_position === 1).map((entry) => entry.identifier),
    ),
    promptOrderGroups: promptOrders.length,
  });
}

/**
 * The ONE legal change after import (design §2.1: presets are read-only, import is the edit).
 *
 * SillyTavern keeps an entry's on/off state in two places - the prompt's own `enabled`, and the same identifier's row
 * in every `prompt_order` group - so both are written. Rewriting one would leave a document whose two `enabled` facts
 * disagree, which is a preset no ST version reads the same way twice.
 */
export function withPromptEnabled(document: PresetDocument, identifier: string, enabled: boolean): PresetDocument {
  const target = promptEntry(document, identifier);
  if (target === undefined) throw new Error(`preset_prompt_not_found:${identifier}`);
  const prompts = document.prompts.map((entry) => (entry.identifier === identifier ? { ...entry, enabled } : entry));
  return deepFreeze({
    ...document,
    prompts,
    ...(Array.isArray(document.prompt_order)
      ? {
          prompt_order: document.prompt_order.map((group) =>
            isRecord(group) && Array.isArray(group.order)
              ? {
                  ...group,
                  order: group.order.map((row) =>
                    isRecord(row) && row.identifier === identifier ? { ...row, enabled } : row,
                  ),
                }
              : group,
          ),
        }
      : {}),
  }) as PresetDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
