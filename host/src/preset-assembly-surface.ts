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
 *  - §5 - a preset's sampling values reach the wire through the provider entry's `samplingParams`, and the model or
 *    the thinking level may override any of them, so the surface carries `effectivePresetSampling`'s own reading per
 *    key (`{ key, value, source }`) instead of the value the preset wrote. A row is produced for every sampling key,
 *    including the `unset` ones, because an omitted row reads as "no such setting". When no composed model exists the
 *    surface reports `{ unavailable: "no_composed_model" }` instead of rows: the reading cannot be taken, and neither
 *    an empty list nor the preset's own values is the fact (§5).
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
import { type MacroContext, presetMacroEntryFor, presetMacroTokens } from "./tavern/preset-macros.js";
import { type PresetDocument, validatePresetDocument } from "./tavern/preset-document.js";
import {
  type SamplingRuntimeModel,
  type SamplingSource,
  effectivePresetSampling,
  presetSamplingParams,
} from "./tavern/preset-sampling.js";

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
 * One sampling key's effective value and the layer that decided it (§5).
 *
 * `value` is `null` exactly when `source` is `unset`, and for one reason: JSON has no `undefined`, so a row carrying
 * `undefined` would be dropped from the array on the wire - an omitted row, which a player reads as "there is no such
 * setting", the opposite of the fact. Every other source carries the finite number the runtime will send.
 */
export type PresetSamplingRowV1 = Readonly<{ key: string; value: number | null; source: SamplingSource }>;

/**
 * Why the sampler reading could not be taken at all. A closed set, one member per fact, so the wire never carries a
 * sentence only one side understands.
 *
 * `no_composed_model` is the whole of it today: the reading is taken against the composed model the adapter will send
 * (§5), and nothing binds a preset to the runtime yet, so there is no composed model this readout could describe. It
 * is a NAMED absence rather than an empty row list or the preset's own values: an omitted row reads as "no such
 * setting" and the written value reads as "this is what will be sent", and neither is true while no model exists.
 */
export type PresetSamplingUnavailableReasonV1 = "no_composed_model";

/**
 * The fifth answer: the rows in force, or the named reason no reading exists.
 *
 * Exactly one shape, never both and never neither - a body carrying rows and an absence would say two things about
 * the same fact, and a body carrying neither would leave the player unable to tell "nothing is sent" from "nobody
 * looked".
 */
export type PresetSamplingReadingV1 =
  | readonly PresetSamplingRowV1[]
  | Readonly<{ unavailable: PresetSamplingUnavailableReasonV1 }>;

/**
 * What the read-only preset surface shows for one imported preset.
 *
 * `entries`, `disabledEntries`, `unfilledMarkers`, `macros` and `depth` are the four answers: the switch is
 * observable, every unfilled slot is named, every unusable macro is named with its code, and the depth injection
 * is visible as a count and as the depths themselves. `sampling` is the fifth: what each sampler key will actually
 * be sent as, and which layer decided it.
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
  /** Every sampling key, with the value in force and its layer: never the value the preset wrote. */
  sampling: PresetSamplingReadingV1;
}>;

/**
 * Derives the readout for one stored preset.
 *
 * `markers` is the assembly's own slot content (the companion card, the bound world book), which the caller owns:
 * a slot with no source is what `unfilledMarkers` reports, and this function must not invent one.
 *
 * `sampling` is the runtime's own facts, for the same reason: the composed model the adapter will send and the
 * thinking level the session reports are what decide the effective value, and a caller that could pass its own
 * intentions instead would make the reading say something the wire will not show. `null` is the caller stating that
 * no composed model exists for this preset; the surface then reports `unavailable` by name instead of rows, because
 * the alternative - rows built from the preset's own values - is the false reading §5 exists to delete.
 */
export function presetAssemblySurface(
  input: Readonly<{
    presetId: string;
    name: string | null;
    revision: number;
    document: unknown;
    macros: MacroContext;
    markers: Readonly<Record<string, string>>;
    sampling: Readonly<{ model: SamplingRuntimeModel; thinkingLevel: string }> | null;
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
    sampling:
      input.sampling === null
        ? Object.freeze({ unavailable: "no_composed_model" as const })
        : presetSurfaceSampling(document, input.sampling),
  });
}

/**
 * The sampling rows, read through `effectivePresetSampling` and never recomputed here.
 *
 * The preset's own values come from the document through `presetSamplingParams`, the same allow-list read the wire
 * uses, so the row a player sees and the value that is carried cannot be two opinions. A layer that holds a value
 * which is not a finite number is refused by name rather than narrowed to `null`: `null` is this wire's word for
 * "nothing is sent", and reporting it for a layer that does set the key would be the false green §5 exists for.
 */
function presetSurfaceSampling(
  document: PresetDocument,
  runtime: Readonly<{ model: SamplingRuntimeModel; thinkingLevel: string }>,
): readonly PresetSamplingRowV1[] {
  const readings = effectivePresetSampling({
    model: runtime.model,
    thinkingLevel: runtime.thinkingLevel,
    preset: presetSamplingParams(document),
  });
  return Object.freeze(
    readings.map((reading) => {
      if (reading.source === "unset") return Object.freeze({ key: reading.key, value: null, source: reading.source });
      const value = reading.value;
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`preset_sampling_not_a_number:${reading.key}:${reading.source}:${String(value)}`);
      return Object.freeze({ key: reading.key, value, source: reading.source });
    }),
  );
}

/**
 * The macros this preset spells that the product will not evaluate, one row per name.
 *
 * The scan reads every string in the document at any depth - the population `tools/check-preset-macros.mjs` judges
 * - and attributes each spelling to the prompt entry (or the top-level document key) that carries it. An
 * implemented macro is not a finding; that is what keeps this list a list of what the player cannot rely on
 * rather than a list of every `{{...}}` in the file.
 *
 * Which entry governs a spelling is `presetMacroEntryFor`'s answer, never a lookup of the token's own text: a
 * variable shorthand carries its variable's name where a named macro carries its word, so it is admitted by a
 * FAMILY entry (`.varName`, `.varName = value`, `$varName`) whose own name no token can equal. Reading the table by
 * token text instead reported every shorthand as a spelling no authority defines, while the evaluator resolved it
 * and this repository's gate called it declared.
 */
function presetSurfaceMacros(document: PresetDocument): readonly PresetAssemblyMacroV1[] {
  const found = new Map<string, { code: string; entries: Set<string> }>();
  const record = (text: string, owner: string): void => {
    for (const token of presetMacroTokens(text)) {
      const entry = presetMacroEntryFor(token.name);
      if (entry?.implemented === true) continue;
      const code = entry === undefined ? `macro_unknown:${token.name}` : `macro_not_implemented:${token.name}`;
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
