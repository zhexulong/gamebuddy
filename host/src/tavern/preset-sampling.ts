/**
 * A preset's sampling values, carried to the request body, plus the reading that says which value the runtime is
 * really using (design/architecture/tavern-preset-compatibility.md §5, slice S6).
 *
 * The chain this module rides was measured, not assumed. `PromptOptions` (`pi-coding-agent`'s `session.prompt`
 * options) has no sampling field, so `session.prompt` cannot carry a preset's temperature; `models.json` is the
 * only layer the Host can reach, and `modelOverrides[<modelId>].samplingParams` is where Pi's schema merges those
 * keys onto a model it already describes - after custom-model upserts and extension replacement
 * (`provider-composer.js` `applyModelOverride`). The `openai-completions` adapter then merges that bag into the
 * HTTP body LAST, over `model.samplingParams` and over `samplingParamsByThinkingLevel[level]`, which is the
 * precedence §5 states: model -> thinking-level -> per-request.
 *
 * The second half is the one that makes the first half honest. A UI that prints the preset's written temperature
 * while the runtime sends another one is the false-green this feature exists to delete, so `effectivePresetSampling`
 * reads the COMPOSED model the runtime will actually use and names, per key, the value and the layer it came from.
 * It does not re-implement the precedence from a second copy of the values: when the composed model disagrees with
 * what this module wrote, it fails closed and names the key rather than reporting a value nothing will send.
 */

import type { PiProviderEntry } from "./pi-provider-store.js";

/**
 * The SillyTavern preset keys that ARE sampler settings.
 *
 * An allow-list rather than a spread of the document, and the reason is measured rather than cautious:
 * `SamplingParams` is `Record<string, unknown>` assigned into the request body after `model`, `messages`, `stream`,
 * `tools` and `max_completion_tokens` are already set, so a permissive spread would let a preset rewrite the
 * request itself (a preset carrying `stream: false` or `model: "other"` would silently change the call). These
 * eight are the keys SillyTavern writes at a preset's top level - its own `default/content/presets/openai/Default.json`
 * carries all of them - and they are exactly the family the adapter documents for `samplingParams`
 * (`top_p`, `top_k`, `min_p`, `repetition_penalty`, …).
 *
 * The fields a preset may carry that are NOT sampler settings are not listed here; they are declared in
 * `PRESET_FIELDS_NOT_APPLIED` below, one table with one reason each, so a caller reports them by name instead of
 * re-deriving the sentence.
 */
export const PRESET_SAMPLING_KEYS = Object.freeze([
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "top_a",
  "repetition_penalty",
  "presence_penalty",
  "frequency_penalty",
] as const);

export type PresetSamplingKey = (typeof PRESET_SAMPLING_KEYS)[number];

/** The sampling values one preset carries. Absent means the preset says nothing about that key. */
export type PresetSamplingValues = Readonly<Partial<Record<PresetSamplingKey, number>>>;

/**
 * The sampling values a preset document carries, read through the allow-list above.
 *
 * A declared sampling key whose value is not a finite number is refused by name instead of being skipped: a missing
 * key is a preset with no opinion, while `temperature: "0.7"` is a preset this Host cannot interpret, and silently
 * dropping it would send a body nobody authored.
 */
export function presetSamplingParams(document: Readonly<Record<string, unknown>>): PresetSamplingValues {
  const values: Partial<Record<PresetSamplingKey, number>> = {};
  for (const key of PRESET_SAMPLING_KEYS) {
    if (!(key in document)) continue;
    const value = document[key];
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`preset_sampling_not_a_number:${key}:${String(value)}`);
    values[key] = value;
  }
  return Object.freeze(values);
}

/**
 * The preset fields this product recognises on import and does NOT send, and why each one is not ours.
 *
 * A reading, not a rejection list: import keeps every field an authored preset carries (design §2.2), so a preset
 * that declares a context budget still imports, keeps its bytes and exports unchanged. What §7 forbids is dropping
 * such a field SILENTLY, so this table is the one place that says a field was recognised and not applied.
 *
 * `openai_max_context` is here rather than carried because "how much context a request has" already has an owner
 * and it is not a preset: the window is the selected model's own fact (`provider-catalog.ts` `contextWindow`, which
 * the provider entry writes into the model Pi describes) and the output reserve is the entry's own
 * `models[0].maxTokens` (`pi-provider-store.ts`). Copying a preset number over either would be a second,
 * disagreeing cap for one fact - and a preset authored against one endpoint would reshape every request to another.
 * The product's own shipped preset therefore states none of these; only an imported one may.
 */
export const PRESET_FIELDS_NOT_APPLIED = Object.freeze({
  openai_max_context:
    "the context window is the selected model's own (provider-catalog.ts contextWindow); the preset has no budget of its own",
  openai_max_tokens: "the output reserve is the provider entry's own models[0].maxTokens (pi-provider-store.ts)",
  stream_openai: "the transport is the Host's: this runtime always streams and never reads the flag",
  seed: 'SillyTavern writes -1 as its "pick randomly" sentinel, so there is no value here to send',
  n: "one completion per call is the product's shape, so asking for several is not a request this Host makes",
} as const);

/** One preset field that was recognised on import and deliberately not sent. */
export type PresetNotAppliedField = Readonly<{
  field: string;
  value: unknown;
  disposition: "not_applied";
  reason: string;
}>;

/**
 * The fields of one preset document this product recognises and does not send, each with its stated reason.
 *
 * The population is `PRESET_FIELDS_NOT_APPLIED`, not a caller's list: a field added to that table is reported from
 * every preset that carries it. A preset field in neither table is not ours to read at all, and saying nothing about
 * it is the same answer as saying nothing about `prompts`.
 */
export function presetFieldsNotApplied(document: Readonly<Record<string, unknown>>): readonly PresetNotAppliedField[] {
  const reported: PresetNotAppliedField[] = [];
  for (const [field, reason] of Object.entries(PRESET_FIELDS_NOT_APPLIED)) {
    if (!(field in document)) continue;
    reported.push(Object.freeze({ field, value: document[field], disposition: "not_applied" as const, reason }));
  }
  return Object.freeze(reported);
}

/**
 * The provider entry with one model's sampling params set to the bound preset's values.
 *
 * `modelOverrides` is used for every entry shape rather than `models[0].samplingParams` for the entries that declare
 * their model: the override layer applies after the model list is composed, so an environment/escape-hatch entry
 * (whose model this Host writes) and a catalog entry (whose model Pi already ships, and whose declaration the Host
 * deliberately does not restate) reach `Model.samplingParams` through the same seam.
 *
 * An empty value set returns the entry unchanged, byte for byte. A preset with no sampler settings must leave the
 * document exactly as another writer would find it, and it saves the runtime from an empty bag it would only
 * `Object.assign` into the body to no effect.
 */
export function withPresetSampling(
  entry: PiProviderEntry,
  modelId: string,
  values: PresetSamplingValues,
): PiProviderEntry {
  const samplingParams = Object.freeze({ ...values });
  if (Object.keys(samplingParams).length === 0) return entry;
  const overrides = isRecord(entry.modelOverrides) ? entry.modelOverrides : {};
  const existing = isRecord(overrides[modelId]) ? overrides[modelId] : {};
  return Object.freeze({
    ...entry,
    modelOverrides: Object.freeze({
      ...overrides,
      [modelId]: Object.freeze({ ...existing, samplingParams }),
    }),
  });
}

/** Where an effective sampling value came from: the preset, the model's own defaults, the level, or nothing. */
export type SamplingSource = "preset" | "model" | "thinking-level" | "unset";

/** One key's actual value and the layer that decided it. `unset` means no layer sets it, so nothing is sent. */
export type SamplingReading = Readonly<{
  key: PresetSamplingKey;
  value: unknown;
  source: SamplingSource;
}>;

/**
 * The parts of the composed model this reading consults. Structural rather than imported so a caller can pass the
 * runtime's own `Model` without this module depending on pi-ai's types.
 */
export type SamplingRuntimeModel = Readonly<{
  samplingParams?: unknown;
  samplingParamsByThinkingLevel?: unknown;
}>;

/**
 * What is actually in force, per sampling key, and which layer decided it.
 *
 * The inputs are the runtime's own facts, not this module's intentions: `model` is the composed model the adapter
 * will send (`ModelRuntime.getModel(...)`), and `thinkingLevel` is the level the session reports - Pi clamps the
 * player's request to what the model supports, and the clamped level is the key `samplingParamsByThinkingLevel` is
 * looked up under. Asking a caller for the requested level instead would let the reading name a layer the adapter
 * never consults.
 *
 * The precedence is the adapter's own: thinking-level, then the model's own defaults, then unset. A key this module
 * wrote (present in `preset`) is reported as `preset` on the model layer, and the composed model must actually carry
 * that value - otherwise the reading would claim something the wire will not show, so it fails closed instead.
 *
 * Per-request values are not a source here because nothing in this product can set one: `PromptOptions` carries no
 * sampling field and the Host never calls `streamSimple`/`stream` with `samplingParams`. The adapter still merges a
 * per-request bag above this layer (measured with the real adapter through the recording proxy), so a caller that
 * ever gains a per-request path must add its source here rather than reusing `preset`.
 */
export function effectivePresetSampling(
  input: Readonly<{
    model: SamplingRuntimeModel;
    thinkingLevel: string;
    preset: PresetSamplingValues;
  }>,
): readonly SamplingReading[] {
  const modelParamsCandidate = input.model.samplingParams;
  const modelParams = isRecord(modelParamsCandidate) ? modelParamsCandidate : {};
  const byLevelCandidate = input.model.samplingParamsByThinkingLevel;
  const byLevel = isRecord(byLevelCandidate) ? byLevelCandidate : {};
  const levelCandidate = byLevel[input.thinkingLevel];
  const levelParams = isRecord(levelCandidate) ? levelCandidate : {};
  const readings = PRESET_SAMPLING_KEYS.map((key): SamplingReading => {
    if (key in levelParams) return Object.freeze({ key, value: levelParams[key], source: "thinking-level" });
    const presetValue = input.preset[key];
    if (presetValue !== undefined) {
      const composed = modelParams[key];
      if (!Object.is(composed, presetValue))
        throw new Error(
          `preset_sampling_not_applied:${key}:preset=${String(presetValue)}:composed=${String(composed)}`,
        );
      return Object.freeze({ key, value: composed, source: "preset" });
    }
    if (key in modelParams) return Object.freeze({ key, value: modelParams[key], source: "model" });
    return Object.freeze({ key, value: undefined, source: "unset" });
  });
  return Object.freeze(readings);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
