/**
 * One pass's preset segments: what the preset IN FORCE contributes to this request, rendered.
 *
 * This is the Host half of the one assembly seam (`design/architecture/tavern-preset-compatibility.md` §3.1,
 * `patches/vendor-magic-context/0001-preset-assembly-seam.patch`). The authority for assembling the outgoing message
 * array is `magic-context`, so the Host renders the three segments and hands them over; it does NOT build a second
 * message list beside the vendor's, because two order decisions for one request is exactly what §2.3 forbids.
 *
 * The three buckets are `assemblePreset`'s own (`preset-assembler.ts`) - this module adds no placement rule of its
 * own, only the facts a request needs: each segment's SillyTavern `role`, the depth each in-chat entry lands at, the
 * macros the text left unresolved, and the hash of the stable prefix.
 *
 * `prefixHash` is content-addressed and never turn-addressed (§2.7): the before-block bytes are the seed, so the same
 * preset renders the same hash on every turn of every session. A turn index in that seed would rewrite the cached
 * prefix every round and destroy the very prefix protection the whole seam exists to preserve.
 *
 * WHICH preset is in force is `preset-binding.ts`'s fact and the store is the document's authority, so nothing here
 * decides it. `null` means nothing is bound - a normal state, and one the caller renders nothing for. A binding that
 * names a preset the store no longer holds is NOT `null`: the store's own `preset_not_found:<id>` is thrown, so a
 * request never silently assembles from a preset the player believed was in use.
 */
import { canonicalHash } from "./artifact-store.js";
import { type PresetSegment, assemblePreset } from "./preset-assembler.js";
import type { PresetBindingStore } from "./preset-binding.js";
import type { MacroContext } from "./preset-macros.js";
import type { PresetStore } from "./preset-store.js";

/** One rendered entry: its preset identity, the role SillyTavern sends it as, and its text. */
export type PresetPassSegment = Readonly<{
  identifier: string;
  role: PresetSegment["role"];
  text: string;
}>;

/** One entry placed inside the transcript by `injection_depth`; `depth` is the preset's own number. */
export type PresetPassDepthSegment = PresetPassSegment & Readonly<{ depth: number }>;

/** One macro the rendered text left unresolved, and the entries that spell it. */
export type PresetPassUnresolvedMacro = Readonly<{ name: string; entries: readonly string[] }>;

export type PresetPass = Readonly<{
  presetId: string;
  revision: number;
  /** The stable prefix, in the preset's own `prompt_order`. */
  before: readonly PresetPassSegment[];
  /** The post-history entries, sent after the transcript. */
  after: readonly PresetPassSegment[];
  /** Deepest first, then ascending `injection_order`, exactly as `assemblePreset` sorted them. */
  depth: readonly PresetPassDepthSegment[];
  /** Markers with no content source: named, never blanked (§2.5). */
  unfilled: readonly string[];
  /** Entries the preset has switched off; listed rather than absent. */
  disabled: readonly string[];
  /** Macros this product will not evaluate, by name, so no text silently rendered as empty (§4). */
  unresolved: readonly PresetPassUnresolvedMacro[];
  /** `sha256` of the before-block bytes: what the Host states it placed, never read back by the vendor. */
  prefixHash: string;
}>;

/**
 * Renders the segments for the preset in force, or `null` when none is bound.
 *
 * `markers` is the assembly's slot content and the caller owns it (the companion card's fields, the bound world book,
 * the player's persona): this function never invents a slot's content, and every slot it is not given is named in
 * `unfilled`.
 */
export async function renderPresetPass(
  input: Readonly<{
    presets: PresetStore;
    binding: PresetBindingStore;
    macros: MacroContext;
    markers: Readonly<Record<string, string>>;
  }>,
): Promise<PresetPass | null> {
  const bound = await input.binding.read();
  if (bound === null) return null;
  // The store's own read re-derives and re-checks the stored summary, so the rendering and the panel's row can never
  // describe two different revisions of the same preset.
  const record = await input.presets.read(bound.presetId);
  const assembly = assemblePreset(record.document, { macros: input.macros, markers: input.markers });
  const before = assembly.before.map(segmentOf);
  const after = assembly.after.map(segmentOf);
  const depth = assembly.depth.map((block) => Object.freeze({ ...segmentOf(block), depth: block.depth }));
  return Object.freeze({
    presetId: record.presetId,
    revision: record.revision,
    before: Object.freeze(before),
    after: Object.freeze(after),
    depth: Object.freeze(depth),
    unfilled: Object.freeze([...assembly.unfilled]),
    disabled: Object.freeze([...assembly.disabled]),
    unresolved: Object.freeze(unresolvedMacros(assembly)),
    prefixHash: canonicalHash({ segments: before }),
  });
}

function segmentOf(segment: PresetSegment): PresetPassSegment {
  return Object.freeze({ identifier: segment.identifier, role: segment.role, text: segment.text });
}

/**
 * Every macro the rendered text left unresolved, one row per name, with the entries that spell it.
 *
 * The population is the segments that WILL be sent, not the document's whole text: a macro in a switched-off entry or
 * in a marker with no source reaches no request, and reporting it here would tell the player about text nobody sends.
 */
function unresolvedMacros(assembly: ReturnType<typeof assemblePreset>): PresetPassUnresolvedMacro[] {
  const byName = new Map<string, Set<string>>();
  for (const segment of [...assembly.before, ...assembly.after, ...assembly.depth]) {
    for (const name of segment.unresolved) {
      const entries = byName.get(name) ?? new Set<string>();
      entries.add(segment.identifier);
      byName.set(name, entries);
    }
  }
  return [...byName.entries()]
    .map(([name, entries]) => Object.freeze({ name, entries: Object.freeze([...entries].sort()) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
