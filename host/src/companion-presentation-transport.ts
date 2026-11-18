/**
 * The transport's own ceiling on one companion presentation, and the only ceiling a delivered line meets.
 *
 * <p>
 * It is READ, not chosen. The Mod refuses a longer request (`integrations/stardew/BridgeSession.cs`
 * `MaximumPresentationTextLength`, answered with `companion_presentation_text_too_long:<length>:<maximum>`), and the wire
 * schema states the same maximum (`protocol/bridge-v1.schema.json`, `$defs/companionPresentationRequest.properties.text
 * .maxLength`). This declaration is the Host's one copy of it: the envelope validator (`protocol.ts`) and the Game
 * surface's delivery budget (`companion-delivery-pacing.ts`, `GAME_DELIVERY_PACING.lengthBudget`) both read it, and
 * `tools/check-delivery-truncation-bound.mjs` holds it equal to the Mod's constant and the schema's, so the three
 * cannot drift apart in silence.
 * </p>
 *
 * <p>
 * Counted the way each side counts it: `string.Length` in the Mod and `.length` here, both UTF-16 code units.
 * </p>
 */
export const MAX_COMPANION_PRESENTATION_TEXT_CHARS = 4_000;
