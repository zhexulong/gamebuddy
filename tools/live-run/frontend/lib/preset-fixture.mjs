// The preset the run binds, and the three facts a reader needs to look for it on the wire.
//
// ONE definition, two processes: the launch phase imports and binds this document through the product's
// own store, and driver V (a separate process, a separate phase) reads the same strings back out of
// `state/launch.json` to build its probe. A second copy of a marker string is a probe that can silently
// stop matching the thing it was planted in, so the fixture lives here once.
//
// WHY A FIXTURE AND NOT A PRESET FROM THE CHECKOUT. `assets/tavern/presets/**` holds the presets this
// repository ships, and their entry text is prose a human wrote. A reading that greps for prose cannot tell
// "the preset's entry arrived" from "the same words appeared in a card field, a world-book entry or the
// player's own line". These three strings exist nowhere else in the product, so one `indexOf` decides it.
//
// THE DOCUMENT IS THE SMALLEST VALID ONE, and every shape rule below is the assembler's own
// (`host/src/tavern/preset-assembler.ts`), not an invention here:
//   - a `chatHistory` marker row is REQUIRED: with no cut point the assembler refuses the whole document
//     (`preset_cut_point_missing`) and the Host fails every turn (`[provider-start] preset refused`), which
//     would break every turn-dependent driver in the run rather than this claim;
//   - `main` is a slot marker, and a slot with no caller-supplied source falls back to the author's text, so
//     it needs no source from the harness;
//   - the two markers after the cut are what make the PLACEMENT readable: `jailbreak` lands in the `after`
//     bucket (appended after the transcript) and `claimDepthEntry` carries `injection_position: 1` with
//     `injection_depth: 0`, which places it last, after the `after` bucket;
//   - the prompt-order group is `character_id: 100000`, the base class's single group, which is what a
//     legacy preset ships and what `selectedPromptOrderGroup` accepts
//     (`host/src/tavern/preset-placement.ts`). It is deliberately not 100001: that group is asserted by the
//     host's own tests, and this fixture should not be a second opinion about the ladder;
//   - `temperature` is a sampler value no layer of this product writes by itself, so a body carrying 0.13 is
//     a body the bound preset reached (`host/src/tavern/preset-sampling.ts` PRESET_SAMPLING_KEYS).
export const FIXTURE_PRESET_ID = "r1-preset-claim";

/** The three marker strings, one per placement bucket, and the sampler value the fixture carries. */
export const FIXTURE_PRESET_MARKERS = Object.freeze({
  /** Joins the LEADING SYSTEM MESSAGE's text (`preset-request-segments.ts` `placeSegments`, `before`). */
  before: "gbp4-preset-prefix-marker",
  /** Appended after the transcript as a `user` message (`after`). */
  after: "gbp4-preset-tail-marker",
  /** Inserted at `messages.length - depth`, so `injection_depth: 0` makes it the last message (`depth`). */
  depth: "gbp4-preset-depth-marker",
});

/** The sampler key and value the claim reads out of the request body. */
export const FIXTURE_PRESET_SAMPLING = Object.freeze({ key: "temperature", value: 0.13 });

/**
 * The document the run imports, freshly built so a caller cannot mutate the module's copy.
 *
 * `name` is what the panel prints, and driver U holds the panel's row against a document under
 * `assets/tavern/presets/` by that name. No document there carries this one, so U reports its two
 * assertions as UNOBSERVED (a side that is not there is not a pass) rather than matching a preset the
 * player does not have.
 */
export function fixturePresetDocument() {
  return {
    name: "R1 preset claim fixture",
    temperature: FIXTURE_PRESET_SAMPLING.value,
    prompts: [
      { identifier: "main", name: "Main", role: "system", content: `${FIXTURE_PRESET_MARKERS.before}` },
      { identifier: "chatHistory", name: "Chat History", marker: true },
      { identifier: "jailbreak", name: "Jailbreak", role: "system", content: `${FIXTURE_PRESET_MARKERS.after}` },
      {
        identifier: "claimDepthEntry",
        name: "Claim depth entry",
        role: "user",
        content: `${FIXTURE_PRESET_MARKERS.depth}`,
        injection_position: 1,
        injection_depth: 0,
        injection_order: 10,
      },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: "main", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "jailbreak", enabled: true },
          { identifier: "claimDepthEntry", enabled: true },
        ],
      },
    ],
  };
}
