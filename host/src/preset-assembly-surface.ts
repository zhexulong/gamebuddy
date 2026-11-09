/**
 * The preset assembly as one read-only readout: the four facts a player must be able to see about the preset
 * they imported, derived from the authorities that already own them and from nothing else.
 *
 * Design (`design/architecture/tavern-preset-compatibility.md`):
 *
 *  - §2.1 - presets are imported once and read from then on, so this is a READING and never an editor. The one
 *    legal mutation (`enabled`) belongs to the store (`preset-store.ts`), not here.
 *  - §2.5 - a marker is a SLOT. `assemblePreset` names every slot it could not fill (`unfilled`) rather than
 *    blanking it, and this projection carries those names through untouched: a blank region is not a fact a
 *    player can act on, and a missing entry is a fact nobody can see at all.
 *  - §4 - a macro this product declined or does not know is named with its code (`macro_not_implemented:<name>`,
 *    `macro_unknown:<name>`), never counted away and never rendered as an empty string.
 *
 * The population of the macro scan is the preset's own text, read the way `tools/check-preset-macros.mjs` reads it
 * (every string at any depth), and the table and the token grammar are that module's and the gate's shared
 * authority (`preset-macros.ts`) rather than a second reading of them. Each finding keeps the entries that spell
 * it, so the player is told WHERE the preset leans on it.
 *
 * The entry counts partition the preset's own `prompts[]`, which is the population a player can count in the file
 * they imported: a prompt switched off in `prompt_order` is still one of the preset's entries, and it is counted
 * as disabled instead of disappearing from the total.
 */
import { assemblePreset } from "./tavern/preset-assembler.js";
import { type MacroContext, PRESET_MACROS, presetMacroTokens } from "./tavern/preset-macros.js";
import { type PresetDocument, validatePresetDocument } from "./tavern/preset-document.js";

/** One macro the preset spells that this product will not evaluate, with the code that says why. */
export type PresetAssemblyMacroV1 = Readonly<{
  /** `macro_not_implemented:<name>` or `macro_unknown:<name>` - the code the design names the case by. */
  code: string;
  name: string;
  /** The prompt identifiers (or top-level document keys) whose text spells it. Never empty. */
  entries: readonly string[];
}>;

/** One entry placed inside the transcript by `injection_depth`. */
export type PresetAssemblyDepthBlockV1 = Readonly<{ identifier: string; depth: number }>;

/**
 * What the read-only preset surface shows for one imported preset.
 *
 * `entries`, `disabledEntries`, `unfilledMarkers`, `macros` and `depth` are the four answers: the switch is
 * observable, every unfilled slot is named, every unusable macro is named with its code, and the depth injection
 * is visible as a count and as the depths themselves.
 */
export type PresetAssemblySurfaceV1 = Readonly<{
  presetId: string;
  name: string | null;
  revision: number;
  entries: Readonly<{ total: number; enabled: number; disabled: number }>;
  /** The entries switched off, by identifier: listed rather than hidden. */
  disabledEntries: readonly string[];
  /** The markers with no content source, by identifier: named rather than blanked. */
  unfilledMarkers: readonly string[];
  macros: readonly PresetAssemblyMacroV1[];
  depth: Readonly<{
    count: number;
    /** The distinct depths the blocks land at, in the order the assembly inserts them (deepest first). */
    depths: readonly number[];
    blocks: readonly PresetAssemblyDepthBlockV1[];
  }>;
}>;

/**
 * Derives the readout for one stored preset.
 *
 * `markers` is the assembly's own slot content (the companion card, the bound world book), which the caller owns:
 * a slot with no source is what `unfilledMarkers` reports, and this function must not invent one.
 */
export function presetAssemblySurface(
  input: Readonly<{
    presetId: string;
    name: string | null;
    revision: number;
    document: unknown;
    macros: MacroContext;
    markers: Readonly<Record<string, string>>;
  }>,
): PresetAssemblySurfaceV1 {
  const document = validatePresetDocument(input.document);
  const assembly = assemblePreset(document, { macros: input.macros, markers: input.markers });
  const total = document.prompts.length;
  const disabled = assembly.disabled.length;
  if (disabled > total) throw new Error(`preset_surface_disabled_exceeds_entries:${input.presetId}`);
  const blocks = assembly.depth.map((block) => Object.freeze({ identifier: block.identifier, depth: block.depth }));
  return Object.freeze({
    presetId: input.presetId,
    name: input.name,
    revision: input.revision,
    entries: Object.freeze({ total, enabled: total - disabled, disabled }),
    disabledEntries: Object.freeze([...assembly.disabled]),
    unfilledMarkers: Object.freeze([...assembly.unfilled]),
    macros: presetSurfaceMacros(document),
    depth: Object.freeze({
      count: blocks.length,
      depths: Object.freeze([...new Set(blocks.map((block) => block.depth))]),
      blocks: Object.freeze(blocks),
    }),
  });
}

/**
 * The macros this preset spells that the product will not evaluate, one row per name.
 *
 * The scan reads every string in the document at any depth - the population `tools/check-preset-macros.mjs` judges
 * - and attributes each spelling to the prompt entry (or the top-level document key) that carries it. An
 * implemented macro is not a finding; that is what keeps this list a list of what the player cannot rely on
 * rather than a list of every `{{...}}` in the file.
 */
function presetSurfaceMacros(document: PresetDocument): readonly PresetAssemblyMacroV1[] {
  const found = new Map<string, { code: string; entries: Set<string> }>();
  const record = (text: string, owner: string): void => {
    for (const token of presetMacroTokens(text)) {
      const implemented = MACRO_IMPLEMENTATION.get(token.name);
      if (implemented === true) continue;
      const code = implemented === undefined ? `macro_unknown:${token.name}` : `macro_not_implemented:${token.name}`;
      const row = found.get(token.name) ?? { code, entries: new Set<string>() };
      row.entries.add(owner);
      found.set(token.name, row);
    }
  };
  const walk = (value: unknown, owner: string): void => {
    if (typeof value === "string") {
      record(value, owner);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, owner);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) walk(child, owner);
    }
  };
  for (const prompt of document.prompts) walk(prompt, prompt.identifier);
  for (const [key, value] of Object.entries(document)) {
    if (key !== "prompts") walk(value, key);
  }
  return Object.freeze(
    [...found.entries()]
      .map(([name, row]) => Object.freeze({ code: row.code, name, entries: Object.freeze([...row.entries].sort()) }))
      .sort((left, right) => left.code.localeCompare(right.code) || left.name.localeCompare(right.name)),
  );
}

/** The table's own answer for one macro name; absent means no authority defines the spelling. */
const MACRO_IMPLEMENTATION: ReadonlyMap<string, boolean> = new Map(
  PRESET_MACROS.map((entry) => [entry.name, entry.implemented]),
);
