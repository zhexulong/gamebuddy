/**
 * The one preset readout the browser reads: every preset the durable store holds, assembled by the producer.
 *
 * Design (`design/architecture/tavern-preset-compatibility.md` §2.1): presets are imported once and read from then
 * on. This module is the read half of that sentence over the real store (`preset-store.ts`), and it owns nothing of
 * its own: the population is the store's own `list`, each document is the store's own `read` (which re-derives the
 * summary and refuses a preset whose summary drifted), and every fact on the wire comes from
 * `presetAssemblySurface`. An empty list is therefore the STORE's answer - it holds no preset - and not a constant
 * this module returns when it cannot think of anything.
 *
 * WHAT THIS READ CANNOT YET SAY, and why that is deliberate rather than forgotten. Two of the producer's inputs are
 * the runtime's own facts, and nothing in this product supplies them yet:
 *
 *  - `sampling` needs the composed model the adapter will send (§5). No preset is bound to the Chat runtime, so there
 *    is no composed model: the read states `{ unavailable: "no_composed_model" }` per row rather than the preset's
 *    own values, which §5 forbids printing because the runtime does not send them;
 *  - `markers` is the assembly's slot content (the companion card, the bound world book), which the caller owns. Until
 *    the Chat pipeline assembles presets, the production caller has no slot content to hand over, so every marker
 *    reads as a slot with no source. That is the assembly's own answer about the content it was given, not a claim
 *    about what a session would fill.
 *
 * There is also no "which preset is the installation using" field anywhere, and this read does not invent one: it
 * lists what is stored, because that is the fact the store owns. Binding a preset to the runtime is its own decision
 * with its own lane, and it is what turns both gaps above into real readings.
 */
import { type PresetAssemblySurfaceV1, presetAssemblySurface } from "../preset-assembly-surface.js";
import type { PresetAssemblyReadV1 } from "./browser-contract/index.js";
import type { MacroContext } from "./preset-macros.js";
import type { SamplingRuntimeModel } from "./preset-sampling.js";
import type { PresetStore } from "./preset-store.js";

/** The read the browser's route answers. It is the contract's own type, not a second spelling of it. */
export type PresetAssemblyRead = Readonly<{ read(): Promise<PresetAssemblyReadV1> }>;

/**
 * The read over one store.
 *
 * `macros`, `markers` and `sampling` are the caller's exactly as `presetAssemblySurface` takes them: the same three
 * values are applied to every stored preset, because a preset that is not in force has no per-preset runtime facts -
 * that resolution belongs to the binding, not here.
 */
export function createPresetAssemblyRead(
  input: Readonly<{
    store: PresetStore;
    macros: MacroContext;
    markers: Readonly<Record<string, string>>;
    sampling: Readonly<{ model: SamplingRuntimeModel; thinkingLevel: string }> | null;
  }>,
): PresetAssemblyRead {
  return Object.freeze({
    async read(): Promise<PresetAssemblyReadV1> {
      const stored = await input.store.list();
      const presets: PresetAssemblySurfaceV1[] = [];
      for (const summary of stored) {
        // The store's own read is the document's authority, and it re-checks the stored summary against the document
        // on the way out - so a listing entry and the assembly below can never describe two different revisions.
        const record = await input.store.read(summary.presetId);
        presets.push(
          presetAssemblySurface({
            presetId: record.presetId,
            name: record.summary.name,
            revision: record.revision,
            document: record.document,
            macros: input.macros,
            markers: input.markers,
            sampling: input.sampling,
          }),
        );
      }
      return Object.freeze({ apiVersion: 1 as const, presets: Object.freeze(presets) });
    },
  });
}
