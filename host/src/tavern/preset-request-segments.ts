/**
 * The preset in force, as the bytes one request carries: the segments the vendored assembly seam receives, and the
 * placement that puts them where SillyTavern puts them.
 *
 * Design (`design/architecture/tavern-preset-compatibility.md` §2.3/§2.4/§3.1): `magic-context` is the one authority
 * that assembles the outgoing message array, so the Host does not build a second array beside it - it hands over the
 * rendered buckets and gets back the array Pi is served. `preset-segments.ts` renders the buckets from the bound
 * document; this module is the other half: the `assemblePresetSegments` function the vendor calls, and the
 * publication that makes the vendor call it at all.
 *
 * WHERE THE PUBLICATION GOES, AND WHY IT IS NOT AN OPTION. The seam is two fields of the options object the
 * extension builds for itself (`vendor/.../pi-plugin/src/index.ts` `buildContextOptions`), and the Host mounts that
 * extension as a PATH whose factory takes only `(pi)` - so the Host's half crosses the way this package's other
 * embedding inputs do: `publishGameBuddyPresetSegments`, a `globalThis[Symbol.for(...)]` registry read once per pass,
 * keyed by the project directory the pass reports as `ctx.cwd`. One runtime root is one project directory.
 *
 * THE THREE BUCKETS, PLACED AS §2.4 SAYS.
 *
 *  - `before` is the stable prefix, so it joins the LEADING system message's text. Not a system message of its own:
 *    `pi-ai`'s `resolveTranscript` drops every system message after the first on a transport that does not support
 *    mid-conversation system messages (`collapseSystemMessages`), so a separate system block would vanish on exactly
 *    the transports this product runs - and the prefix is where these entries belong anyway.
 *  - `after` goes after the transcript, and `depth` is inserted at `messages.length - depth` counted from the end,
 *    deepest first and, within one depth, in the preset's own `injection_order`.
 *  - Both of those are `user`-role text, for the reason `post-history-instructions-pi.ts` records: a `user` message
 *    stays where it is placed on every transport, so position survives the collapse above.
 *
 * The seam's published signature (§3.1) carries TEXT only, so the role is this module's decision and not the
 * document's. `PresetPass` keeps each entry's role for the panel and the run's own report; a request carries the
 * buckets above.
 *
 * WHAT IS REPORTED, NEVER DROPPED. A marker with no content source and a macro this product will not evaluate are
 * printed by name on every publication (`preset_unfilled_markers:`, `preset_unresolved_macros:`), because the
 * alternative is a preset whose text silently arrives shorter than its author wrote it.
 */
import {
  type GameBuddyPresetAssembly,
  clearGameBuddyPresetSegments,
  publishGameBuddyPresetSegments,
} from "@cortexkit/pi-magic-context/tavern";

import type { MacroContext } from "./preset-macros.js";
import type { PresetBindingStore } from "./preset-binding.js";
import { type PresetSamplingValues, presetSamplingParams } from "./preset-sampling.js";
import { type PresetPass, renderPresetPass } from "./preset-segments.js";
import type { PresetStore } from "./preset-store.js";

/** The prefixes of the two lines a runtime prints when the bound preset could not be carried whole. */
export const PRESET_UNFILLED_MARKERS_PREFIX = "preset_unfilled_markers:";
export const PRESET_UNRESOLVED_MACROS_PREFIX = "preset_unresolved_macros:";

/** What the seam receives for one pass: the same three buckets, as text, in the order they are placed. */
export type PresetRequestSegments = Readonly<{
  before: readonly string[];
  after: readonly string[];
  depth: readonly Readonly<{ depth: number; content: string }>[];
}>;

/** One request's preset half: the buckets to hand over and the function that places them. */
export type PresetRequestAssembly = Readonly<{
  pass: PresetPass;
  segments: PresetRequestSegments;
  assemble: GameBuddyPresetAssembly;
}>;

/**
 * The macro context one Chat request renders its preset with.
 *
 * `char` is the companion's own name, which the identity profile owns. `user` is empty because this runtime holds no
 * player-name authority: a preset's `{{user}}` therefore renders empty, which is a content gap named here rather than
 * a macro this product declines (that distinction belongs to `PRESET_MACROS`).
 */
export function presetRequestMacros(companionName: string): MacroContext {
  return Object.freeze({
    char: companionName,
    user: "",
    description: "",
    personality: "",
    scenario: "",
    persona: "",
    itemId: "",
  });
}

/**
 * The sampler values the preset in force carries, or `null` when nothing is bound.
 *
 * Read through the binding and the store, so the values that reach `models.json` are the ones the panel's own binding
 * row names - and an id the store no longer holds is refused by the store's `preset_not_found:<id>`.
 */
export async function boundPresetSampling(
  input: Readonly<{ presets: Pick<PresetStore, "read">; binding: Pick<PresetBindingStore, "read"> }>,
): Promise<PresetSamplingValues | null> {
  const bound = await input.binding.read();
  if (bound === null) return null;
  const record = await input.presets.read(bound.presetId);
  return presetSamplingParams(record.document);
}

/**
 * The seam's two halves for one rendered pass.
 *
 * `assemble` closes over the pass only for `prefixHash` - the Host's own statement about the bytes it placed, which
 * the vendor never reads. The buckets come from the arguments, so the vendor and this function can never disagree
 * about what was handed over.
 */
export function presetRequestAssembly(pass: PresetPass): PresetRequestAssembly {
  const segments: PresetRequestSegments = Object.freeze({
    before: Object.freeze(pass.before.map((segment) => segment.text)),
    after: Object.freeze(pass.after.map((segment) => segment.text)),
    depth: Object.freeze(pass.depth.map((block) => Object.freeze({ depth: block.depth, content: block.text }))),
  });
  return Object.freeze({
    pass,
    segments,
    assemble: (input) => ({
      messages: placeSegments(input.messages, input),
      prefixHash: pass.prefixHash,
    }),
  });
}

/**
 * Publish the preset in force for one project directory, or withdraw the previous one when nothing is bound.
 *
 * The read is the binding's and the store's - never a second copy of "which preset" - so a preset the store no longer
 * holds is refused by the store's own `preset_not_found:<id>` instead of assembling a request from a preset the
 * player believed was in use.
 *
 * A null binding CLEARS the publication rather than leaving the previous one in place: unbinding must stop the very
 * next request, and the seam's call site requires both fields, so a cleared entry assembles nothing at all.
 */
export async function publishPresetRequestSegments(
  input: Readonly<{
    projectDir: string;
    presets: PresetStore;
    binding: PresetBindingStore;
    macros: MacroContext;
    markers: Readonly<Record<string, string>>;
  }>,
): Promise<PresetRequestAssembly | null> {
  const pass = await renderPresetPass({
    presets: input.presets,
    binding: input.binding,
    macros: input.macros,
    markers: input.markers,
  });
  if (pass === null) {
    clearGameBuddyPresetSegments(input.projectDir);
    return null;
  }
  const assembly = presetRequestAssembly(pass);
  publishGameBuddyPresetSegments(input.projectDir, {
    segments: assembly.segments,
    assemble: assembly.assemble,
  });
  if (pass.unfilled.length > 0) process.stderr.write(`${PRESET_UNFILLED_MARKERS_PREFIX}${pass.unfilled.join(",")}\n`);
  if (pass.unresolved.length > 0)
    process.stderr.write(
      `${PRESET_UNRESOLVED_MACROS_PREFIX}${pass.unresolved
        .map((macro) => `${macro.name}(${macro.entries.join("|")})`)
        .join(",")}\n`,
    );
  return assembly;
}

/**
 * The message array with the pass's three buckets placed, and nothing else changed.
 *
 * The returned array is always a new one: the vendor keeps the reference it was given when this seam is absent, so
 * returning the same array here would make "placed nothing" and "placed everything" indistinguishable to a reader.
 */
function placeSegments(
  messages: readonly unknown[],
  segments: Readonly<{
    before: readonly string[];
    after: readonly string[];
    depth: readonly Readonly<{ depth: number; content: string }>[];
  }>,
): unknown[] {
  const placed = [...messages];
  if (segments.before.length > 0) {
    const prefix = segments.before.join("\n\n");
    const head = placed[0];
    if (isMessageWithRole(head, "system")) placed[0] = withText(head, prefix);
    else placed.unshift(textMessage("system", prefix));
  }
  for (const text of segments.after) placed.push(textMessage("user", text));
  // Counted back from the END of the assembled array (§2.4), and inserted from the far end inward so an insertion
  // never moves the index a later one was computed from. Same depth keeps the preset's own order.
  const end = placed.length;
  for (const block of [...segments.depth].reverse()) {
    placed.splice(Math.max(0, end - block.depth), 0, textMessage("user", block.content));
  }
  return placed;
}

type WireMessage = Readonly<{ role: string; content: unknown }>;

function isMessageWithRole(value: unknown, role: string): value is WireMessage {
  return typeof value === "object" && value !== null && (value as { role?: unknown }).role === role;
}

function textMessage(role: string, text: string): unknown {
  return { role, content: [{ type: "text", text }] };
}

/**
 * The same message with `text` appended to its content.
 *
 * Both content shapes Pi accepts are carried: a string is extended with a blank line between the two texts, and a
 * block list gains one text block. A message carrying neither is given a block list rather than dropped.
 */
function withText(message: WireMessage, text: string): WireMessage {
  const content = message.content;
  if (typeof content === "string")
    return { ...message, content: content.length === 0 ? text : `${content}\n\n${text}` };
  if (Array.isArray(content)) return { ...message, content: [...content, { type: "text", text }] };
  return { ...message, content: [{ type: "text", text }] };
}
