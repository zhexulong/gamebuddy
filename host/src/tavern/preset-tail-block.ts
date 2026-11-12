/**
 * The ONE decision about publishing a preset's post-history entry as the Game request's tail block.
 *
 * It lives apart from both of its readers because there are two of them and they must not disagree: the catalog
 * builder publishes the text (`catalog-service.ts`), and the runtime's own publication line reports whether it was
 * published or refused (`preset-game-session.ts`). Two derivations of "did the tail block go out?" is the class of
 * defect where a bundle says `delivered: true` about a block nothing sent.
 *
 * The rules are the CARD's own rules applied to the preset's text rather than new policy: a macro still standing after
 * the preset's evaluator ran is either one this product does not recognise, or a standard macro the evaluator could not
 * fill, or there is none. Over the published byte bound the entry is refused rather than truncated, for the reason that
 * bound gives - a closing direction cut mid-sentence is worse than none.
 *
 * What the two callers do about a refusal DIFFERS on purpose and is recorded here so it is one decision, not an
 * oversight: the catalog names every refusal on stderr and keeps the session running, while a card's own field is
 * refused hard (`catalog-service.ts` `authoredPostHistoryInstructions`). A card is reviewed input this product owns; a
 * preset is third-party input, and a player's game must not fail to load because one of its tokens is unfamiliar.
 */
import { namedMacros, survivingMacros } from "./macro-engine.js";
import type { GameSessionPresetPrompt } from "./preset-game-session.js";

/**
 * What publishing the preset's tail entry amounts to.
 *
 * Three answers rather than a string or `undefined`, because the difference has to survive into the run's own record:
 * an entry that was never there, an entry that was published, and an entry that this product refused are three
 * different facts, and the last one printed only as "no tail block" would read as the first.
 */
export type PresetTailBlockDecision =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "published"; text: string }>
  | Readonly<{
      kind: "refused";
      reason: "unrecognised_macro" | "unfillable_macro" | "over_byte_bound";
      detail: string;
    }>;

/**
 * The byte bound this text is published under, which is NOT the Host's card-field bound.
 *
 * Two declared numbers govern a closing direction and they disagree: the Host accepts a card's field up to
 * `ST_CARD_DECODER_LIMITS_V1.postHistoryInstructionsBytes` (16 384, `compatibility-manifest.v1.ts`), and the vendored
 * publication refuses above its own `MAX_POST_HISTORY_INSTRUCTIONS_BYTES` (4 096,
 * `vendor/magic-context/packages/pi-plugin/src/post-history-instructions-pi.ts`). The smaller one is the one that can
 * actually stop a run, so it is the one a preset's entry is measured against - otherwise an entry between the two
 * imports cleanly and then takes the whole Game session down at publication, which is the layer where nobody can fix it.
 *
 * It is a copy of the vendor's number, and `prompt-field-delivery.private.test.ts` asserts it EQUALS the vendor's exported
 * constant, so a vendor bump turns that assertion red instead of silently drifting.
 */
export const PRESET_TAIL_PUBLICATION_BYTE_BOUND = 4_096;

export function decidePresetTailBlock(prompt: GameSessionPresetPrompt | undefined): PresetTailBlockDecision {
  if (prompt === undefined || prompt.disposition !== "applied") return Object.freeze({ kind: "absent" as const });
  const surviving = survivingMacros(prompt.text);
  if (surviving !== undefined) {
    if (surviving.unrecognised.length > 0)
      return Object.freeze({
        kind: "refused" as const,
        reason: "unrecognised_macro" as const,
        detail: namedMacros(surviving.unrecognised),
      });
    return Object.freeze({
      kind: "refused" as const,
      reason: "unfillable_macro" as const,
      detail: namedMacros(surviving.standard),
    });
  }
  const bytes = Buffer.byteLength(prompt.text, "utf8");
  const bound = PRESET_TAIL_PUBLICATION_BYTE_BOUND;
  if (bytes > bound)
    return Object.freeze({
      kind: "refused" as const,
      reason: "over_byte_bound" as const,
      detail: `${String(bytes)}>${String(bound)}`,
    });
  return Object.freeze({ kind: "published" as const, text: prompt.text });
}
