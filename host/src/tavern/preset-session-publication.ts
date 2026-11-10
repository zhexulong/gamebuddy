/**
 * What one Game runtime PUBLISHES about the preset it applied, and the one line it prints.
 *
 * The operator's question was "did the live run load the preset?", and until this module it could only be answered by
 * reading code. So the answer is a record, printed once per Game runtime on the stderr channel the live-run harness
 * already captures, and published by that harness into the run's evidence bundle.
 *
 * It lives apart from `preset-game-session.ts` because it is the REPORT of that reading, not the reading: the reader
 * answers what the preset contributes, this module answers what a bundle may claim about it. The sampler half is handed
 * in rather than read here, because it is the EFFECTIVE reading over the composed model
 * (`preset-sampling.ts` `effectivePresetSampling`) - the values the adapter really merges into the request body - and
 * this module must not become a second place that asserts what the wire carried.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { GameSessionPreset, GameSessionPresetDisposition } from "./preset-game-session.js";
import { PRESET_SAMPLING_KEYS, type PresetSamplingValues } from "./preset-sampling.js";
import { decidePresetTailBlock } from "./preset-tail-block.js";

/** The prefix of the one line per Game runtime that states the preset facts a run bundle publishes. */
export const COMPANION_PRESET_LINE_PREFIX = "COMPANION_PRESET";

/** How one of the preset's two taken prompts is reported. */
export type CompanionPresetPrompt = Readonly<{
  /** Characters of RENDERED text: macros already evaluated, exactly the bytes the segment carries. */
  chars: number;
  delivered: boolean;
  disposition: GameSessionPresetDisposition;
  /** `null` unless `delivered` is false because this product refused the entry; the refusal names its reason. */
  refused: string | null;
}>;

/** The preset's two taken prompts and the entries it switches off. */
export type CompanionPresetPrompts = Readonly<{
  /** The preset's `main` entry: the SYSTEM segment `runtime-core.internal.ts` appends to the Game floor. */
  system: CompanionPresetPrompt;
  /** The preset's post-history entry: the request's tail block. */
  postHistory: CompanionPresetPrompt;
  /** Every identifier the preset switched off, in `prompt_order` sequence. */
  disabled: readonly string[];
}>;

/**
 * The preset facts one Game runtime publishes, in the states a reader must be able to tell apart:
 *
 *  - `generation: null` - this runtime cwd was provisioned with NO preset file. Nothing was read. A path here is the
 *    file that WAS read; the key is present in both cases, because "no preset" and "we forgot to say" are different
 *    facts.
 *  - `card`/`worldbook`: the canonical persona files this runtime cwd carries, or `null` when it carries none.
 *  - `sampling: "not_applied"` - none of the preset's sampler values reached the request: there is no preset file, its
 *    keys matched no composed model, or it declares no sampler keys at all. The alternative to this string is the bag
 *    of values in force, and an EMPTY bag would spell "the preset's sampler is not in force" the same way a reader
 *    spells a preset that applied nothing.
 *  - `contextBudget: { not_measured, missingField }` - nothing was measured, and this names what was missing. The
 *    budget belongs to the selected model (`preset-sampling.ts` `PRESET_FIELDS_NOT_APPLIED`), so a run with no composed
 *    model cannot state one.
 */
export type CompanionPresetPublication = Readonly<{
  card: string | null;
  worldbook: string | null;
  generation: string | null;
  sampling: PresetSamplingValues | "not_applied";
  contextBudget: Readonly<{ value: number; source: "model" }> | Readonly<{ not_measured: true; missingField: string }>;
  prompts: CompanionPresetPrompts;
}>;

/**
 * The publication for one Game runtime.
 *
 * `card` and `worldbook` are the canonical files the persona mount places in the runtime cwd: `null` when this root has
 * none, which is a different fact from a path and is spelled differently on purpose.
 *
 * `sampling` is the EFFECTIVE values the adapter will merge, and only the keys this preset declares are published: a
 * value the model or the thinking level contributes is not the preset's answer, and putting it under this name would
 * credit the preset with a sampler setting it never wrote.
 */
export function companionPresetPublication(
  input: Readonly<{
    preset: GameSessionPreset | null;
    runtimeCwd: string;
    sampling: PresetSamplingValues | null;
    contextWindow: number | undefined;
  }>,
): CompanionPresetPublication {
  const preset = input.preset;
  const tailDecision = decidePresetTailBlock(preset?.postHistory);
  return Object.freeze({
    card: fileOrNull(join(input.runtimeCwd, "card.json")),
    worldbook: fileOrNull(join(input.runtimeCwd, "worldbook.json")),
    generation: preset === null ? null : preset.source,
    sampling: samplingInForce(preset, input.sampling),
    contextBudget:
      input.contextWindow === undefined
        ? Object.freeze({ not_measured: true as const, missingField: "model.contextWindow" })
        : Object.freeze({ value: input.contextWindow, source: "model" as const }),
    prompts: Object.freeze({
      system: Object.freeze({
        chars: preset?.main.text.length ?? 0,
        delivered: preset?.main.disposition === "applied",
        disposition: preset?.main.disposition ?? "absent_from_preset",
        refused: null,
      }),
      postHistory: Object.freeze({
        chars: preset?.postHistory.text.length ?? 0,
        delivered: tailDecision.kind === "published",
        disposition: preset?.postHistory.disposition ?? "absent_from_preset",
        refused: tailDecision.kind === "refused" ? `${tailDecision.reason}(${tailDecision.detail})` : null,
      }),
      disabled: preset?.disabled ?? Object.freeze([]),
    }),
  });
}

/** The one line the runtime prints: a fixed prefix the harness matches, then the block as JSON. */
export function formatCompanionPresetLine(publication: CompanionPresetPublication): string {
  return `${COMPANION_PRESET_LINE_PREFIX} ${JSON.stringify(publication)}`;
}

/**
 * The preset's own sampler values as the request will carry them, or `"not_applied"`.
 *
 * The population is `PRESET_SAMPLING_KEYS` narrowed by what the preset declares, so a key added to that family is
 * published from every preset that states it. A declared key whose effective value is absent is dropped rather than
 * invented: `effectivePresetSampling` reads the composed model and fails closed when it disagrees with the preset, so
 * the only way a declared key has no value here is that nothing will send it.
 */
function samplingInForce(
  preset: GameSessionPreset | null,
  effective: PresetSamplingValues | null,
): PresetSamplingValues | "not_applied" {
  if (preset === null || effective === null) return "not_applied";
  const values: Partial<Record<(typeof PRESET_SAMPLING_KEYS)[number], number>> = {};
  for (const key of PRESET_SAMPLING_KEYS) {
    if (preset.sampling[key] === undefined) continue;
    const value = effective[key];
    if (value === undefined) continue;
    values[key] = value;
  }
  return Object.keys(values).length === 0 ? "not_applied" : Object.freeze(values);
}

function fileOrNull(path: string): string | null {
  return existsSync(path) ? path : null;
}
