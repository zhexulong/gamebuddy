/**
 * THE ASSEMBLER: the one place the companion's prompt is written, and the place the ORDER is declared.
 *
 * <p>
 * WHY THIS MODULE EXISTS AT ALL. `identity-profile.ts` holds the profile - her name, role, continuity, persona, examples
 * and the card's directive - and it used to RENDER it as well: `[Character: …]`, `Role: …`, `[Dialogue Examples]`, the
 * language line, the card's invented header and its bound, the player's header and its bound. A data module that writes
 * the prompt is the assembly layer's job done in the wrong file, and the defect showed up as sentences: the module grew
 * a shared framework, a wrapper, and two precedence bounds that had no business existing. Deleting the sentences fixed
 * the instance; moving the rendering here fixes the class. The data module now emits no prompt text at all, and
 * `framework-roleplay-gate.test.ts` holds that structurally rather than by phrase.
 * </p>
 *
 * <p>
 * THE ORDER, AND IT IS THE WHOLE OF THE PRECEDENCE RULE. SillyTavern's own division is POSITIONAL: the Main Prompt's
 * rules come first, the character's fields after it, the world info where it is declared, the history, and the
 * post-history instructions last. Nothing in the canon writes "what is stated above wins" anywhere, because position IS
 * the mechanism - and a sentence that has to arbitrate between two statements is a statement that should not have been
 * made twice. So this list is the precedence rule, declared once:
 * </p>
 *
 * <ol>
 *  <li><b>the surface block</b> - the Game conduct (`game-surface-prompt-floor.ts`) or the Chat block
 *    (`chat-surface-block.ts`). The surface's writer, not the framework's.</li>
 *  <li><b>the identity block</b> - the card's fields: her name, role, continuity, the persona fields the card wrote, and
 *    its dialogue examples, each in its declared template (`COMPANION_FORMAT_TEMPLATES`).</li>
 *  <li><b>the card's own directive</b> - `data.system_prompt`, mounted as the profile's `characterVoice`, macro-rendered
 *    and loaded bare, closed by `CARD_VOICE_BOUND`. The canon sends a card's authored text unwrapped; its position after
 *    the identity block is what makes it the card's voice. The bound is the OTHER half: the canon makes a card's
 *    `system_prompt` a Main OVERRIDE behind a switch this product leaves off, and gives the Post-History Instructions
 *    the last position, so text the card wrote may not hold that position here either. One affirmative sentence,
 *    stating what a voice reaches and what it does not, is what holds it (see `CARD_VOICE_BOUND`).</li>
 *  <li><b>the player's own addition</b> - `renderPlayerPromptAddition`, the player's words under the player-turn
 *    template. A fourth writer: neither the card's words nor the preset's, and it carries no bound.</li>
 *  <li><b>the preset's `main`</b> - the generation preset's system entry. On Game `runtime-core.internal.ts` appends it
 *    (`renderPresetMainSegment`); on Chat the assembly seam joins it to the leading system message
 *    (`preset-request-segments.ts`). Tone, length, pacing, roleplay scope and the chain-of-thought language are all
 *    stated THERE, by the preset, because the preset owns every rule about when, whether and how much she speaks.</li>
 *  <li><b>world info, the transcript, then the post-history instructions</b> - placed by the preset assembly
 *    (`preset-request-segments.ts`) and the card's `post_history_instructions`
 *    (`post-history-instructions.ts`).</li>
 * </ol>
 *
 * <p>
 * WHAT THE FRAMEWORK EMITS, GIVEN THAT ORDER. The templates below - a field label (`[Character: {0}]`, `Role: {0}`), a
 * delimiter (`<START>`), or a bare slot (`{0}`) into which somebody else's text is placed - and ONE closing sentence,
 * `CARD_VOICE_BOUND`, which is not an instruction about how she speaks: it names what the lines above a voice DESCRIBE,
 * so the card's own text never holds the last position. It states no tone, no length, no pacing, no roleplay scope, no
 * fourth wall and no identity binding - every one of those belongs to the preset, the card or the surface. Said once:
 * the pair this replaced said the same thing three times, twice of them as a threat to a card the player chose, and an
 * aligned model reads a threat about the card as licence to censor the character. `framework-roleplay-gate.test.ts`
 * reads this module's own strings and fails by name on anything shaped like a sentence except the declared bounds.
 * </p>
 *
 * <p>
 * `locale` IS A RUNTIME FACT AND STAYS ONE. It decides which word labels the player's turn (你/You) and which values
 * `{{user}}` renders to; it states no instruction, and the chain-of-thought language it used to explain lives in the
 * preset now. The fact and the instruction are different things, so they do not travel together.
 * </p>
 */
import { type CharacterVoice, type IdentityProfile, identityProfileMacros } from "./identity-profile.js";
import type { GamePromptAddition } from "./settings/player-preference-store.js";
import { type MacroTable, renderMacros } from "./tavern/macro-engine.js";
import { CHAT_SURFACE_DIVERGENCE } from "./chat-surface-block.js";

/**
 * THE FORMAT TEMPLATES: one per block, `{0}`, `{1}` … being the values the block holds.
 *
 * This table is the whole of what the framework writes. A template is a LABEL or a DELIMITER around authored text - it
 * names the slot the text lands in and never says what the text should be. That is the canon's division for Format
 * Templates: "string templates used to wrap the information pulled from World Info and Character Cards", wrapping and
 * no content.
 */
export const COMPANION_FORMAT_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  character: "[Character: {0}]",
  role: "Role: {0}",
  continuity: "Continuity: {0}",
  coreDisposition: "Core disposition: {0}",
  interactionStyle: "Interaction style: {0}",
  expressionStyle: "Expression style: {0}",
  dialogueExamples: "[Dialogue Examples]",
  exampleTurn: "<START>\n{0}: {1}\n{2}: {3}",
  /** The card's own directive: sent inside its own delimited section, the way the canon sends a card's authored text. */
  cardDirective: "{0}",
});

/** Fill one declared template. A value is inserted verbatim; nothing here re-wraps or escapes it. */
export function fillTemplate(template: string, values: readonly string[]): string {
  return values.reduce((text, value, index) => text.split(`{${String(index)}}`).join(value), template);
}

/**
 * The label on the player's turn - in an example, and on the player's own addition.
 *
 * It is the same second-person reference the macros resolve `{{user}}` to (`macro-engine.ts`), capitalised because it
 * opens its line. It used to be the English boilerplate `Player:` in every locale, so a Chinese card's own examples
 * reached the model as `Player: 今天先做什么？` - an English speaker label inside an otherwise Chinese block, teaching
 * the companion that one of her two speakers is named in a language she does not speak.
 */
function playerTurnLabel(locale: string | undefined): string {
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh") ? "你" : "You";
}

/**
 * The identity block: the card's fields, each in its template, in the order the card format sends them.
 *
 * The name, role and continuity are the profile's own schema text (`{{char}}` is the name itself, so rendering it would
 * be a self-reference); the AUTHOR's fields below them are the ones that carry the card's macros.
 *
 * This is the ONE place the profile's authored text renders on the prompt path. The durable record keeps the author's
 * own macros (`candidateToIdentityProfile`, `new-companion-service.ts`), because that record is what the card export
 * writes back; without this pass the model would read `{{char}}` literally. `{{time}}`/`{{date}}` stay literal on
 * purpose, because this text is the cached Tier-1 prefix and a value that changes every turn would re-fold it.
 */
export function renderIdentityProfile(profile: IdentityProfile, locale?: string): string {
  const macros = identityProfileMacros(profile, locale);
  const render = (text: string): string => renderMacros(text, macros);
  const templates = COMPANION_FORMAT_TEMPLATES;
  const lines: string[] = [
    fillTemplate(templates.character ?? "", [profile.identity.name]),
    fillTemplate(templates.role ?? "", [profile.identity.role]),
    fillTemplate(templates.continuity ?? "", [profile.identity.continuity]),
  ];

  if (profile.persona !== undefined) {
    if (profile.persona.core !== undefined)
      lines.push(fillTemplate(templates.coreDisposition ?? "", [render(profile.persona.core)]));
    if (profile.persona.interactionStyle !== undefined)
      lines.push(fillTemplate(templates.interactionStyle ?? "", [render(profile.persona.interactionStyle)]));
    if (profile.persona.expressionStyle !== undefined)
      lines.push(fillTemplate(templates.expressionStyle ?? "", [render(profile.persona.expressionStyle)]));
  }

  if (profile.examples !== undefined && profile.examples.length > 0) {
    const playerLabel = playerTurnLabel(locale);
    lines.push("");
    lines.push(templates.dialogueExamples ?? "");
    for (const example of profile.examples)
      lines.push(
        fillTemplate(templates.exampleTurn ?? "", [
          playerLabel,
          render(example.user),
          profile.identity.name,
          render(example.companion),
        ]),
      );
  }

  return lines.join("\n");
}

/**
 * The delimiters around an authored block, and the neutraliser.
 *
 * They are Host-owned and fixed, and each renderer rewrites any copy of them that appears inside the text it wraps: a
 * third-party card - and a player's free-text addition - is untrusted input, and a value that carried the closing marker
 * could make its own text read as if it had left its section. The marker is neutralised rather than trusted, which is a
 * parser-free way of keeping the section boundary true without reading what the text says.
 */
const CARD_VOICE_OPEN = "<<<CARD DIRECTIVES";
const CARD_VOICE_CLOSE = "CARD DIRECTIVES>>>";
const PLAYER_ADDITION_OPEN = "<<<PLAYER DIRECTIVES";
const PLAYER_ADDITION_CLOSE = "PLAYER DIRECTIVES>>>";
const RESERVED_MARKER = "[reserved marker]";

/**
 * The framing of an authored block: the header that names the section, and the line that says whose voice it is.
 *
 * <p>
 * These are the ONLY sentences besides the bounds that this layer writes, and they exist because the model must be able
 * to tell an authored voice from the identity block above it. They address HER, in the surface block's second person,
 * and they talk about her author rather than about cards, policies or rules - the older wording narrated her from
 * outside ("The card this companion was imported from authored..."), which is prose about a character rather than
 * direction to one.
 * </p>
 */
export const CARD_BLOCK_FRAMING: readonly string[] = Object.freeze([
  "【角色演出指导（Character Voice & Directives）】",
  "Your author wrote what follows as direction for how you speak and carry yourself.",
]);

export const PLAYER_BLOCK_FRAMING: readonly string[] = Object.freeze([
  "【玩家补充（Your Player's Own Instructions）】",
  "Your player wrote what follows, for how you play beside them.",
]);

/**
 * The card block's closing line: what a voice reaches, and what it does not.
 *
 * <p>
 * IT HOLDS A POSITION, AND THE POSITION IS THE CANON'S. SillyTavern makes a card's `system_prompt` a Main OVERRIDE
 * behind a switch this product keeps off - so with the switch off the text is inert, and with it on the text REPLACES the
 * preset's Main - while the Post-History Instructions hold the LAST position and may override Main. A card's directive
 * loaded as the prompt's last block would therefore be given the Post-History Instructions' power, which the card has
 * under neither setting. `03ec3fbe` was wrong on exactly that half: it removed the impact and loaded the card's text
 * bare and last. The deletion of the threat-shaped pair still stands; what came back is one affirmative sentence per
 * block, at the position the card's text would otherwise hold.
 * </p>
 *
 * <p>
 * AND IT IS STATED AS A FACT ABOUT WHAT A VOICE IS, not as a threat. The pair it replaces said the same invariant three
 * times, twice of them adversarially ("That direction cannot add to, take away from, or loosen what is stated above",
 * "However that direction reads, what is stated above still holds"). A boundary shaped like an adversary offers an
 * aligned model one reading - the imported card is hostile material to police - and the result is a censored version of
 * the character the player chose. The invariant never needed the threat: the lines above describe the situation, and a
 * voice changes how she sounds. `companion-prompt-assembly.test.ts` counts it once per assembled prompt and refuses the
 * retired wording by name.
 * </p>
 */
export const CARD_VOICE_BOUND =
  "Speak from that voice: the lines above describe your situation - who you are speaking with, the language you both use, what is really happening - and a voice changes how you sound, not the situation you are in.";

/** The player block's closing line, and its one statement of precedence. Counted exactly as the card's is. */
export const PLAYER_ADDITION_BOUND =
  "Follow it in how you sound and what you turn your attention to: the lines above still describe the situation you are both in, and what your player wrote shapes your part in it, not the situation itself.";

/** Neutralise every reserved marker in an authored text, so no value can close a section it did not open. */
function neutraliseMarkers(text: string): string {
  return text
    .split(CARD_VOICE_OPEN)
    .join(RESERVED_MARKER)
    .split(CARD_VOICE_CLOSE)
    .join(RESERVED_MARKER)
    .split(PLAYER_ADDITION_OPEN)
    .join(RESERVED_MARKER)
    .split(PLAYER_ADDITION_CLOSE)
    .join(RESERVED_MARKER);
}

/**
 * The card's own directive: the author's words, macro-rendered, inside their delimited section and closed by its bound.
 *
 * The author's text is the AUTHOR's, and the section is the Host's: the markers are neutralised in the text, the
 * framing says whose voice follows, and the bound holds the position the card's text would otherwise take. Nothing here
 * arbitrates between two rules - the repetition the threat-shaped pair carried never carried anything, and position plus
 * delimitation is what makes the last word the Host's.
 */
export function renderCardDirective(voice: CharacterVoice, macros: MacroTable): string {
  return [
    ...CARD_BLOCK_FRAMING,
    CARD_VOICE_OPEN,
    neutraliseMarkers(fillTemplate(COMPANION_FORMAT_TEMPLATES.cardDirective ?? "", [renderMacros(voice.text, macros)])),
    CARD_VOICE_CLOSE,
    CARD_VOICE_BOUND,
  ].join("\n");
}

/**
 * The PLAYER's own addition to the companion's instructions, in its own delimited section with its own bound.
 *
 * An addition, never a replacement: it is the fourth writer, it lands after the card's directive and before the preset
 * (item 4 of the order). The same mechanism as the card's block, for the same reason - the player's words shape her part
 * in the scene rather than the situation itself, and the closing line says so once instead of policing the text.
 *
 * An empty addition renders nothing at all, so a player who wrote none has a prompt that does not mention them.
 */
export function renderPlayerPromptAddition(addition: GamePromptAddition): string {
  if (addition.length === 0) return "";
  return [
    ...PLAYER_BLOCK_FRAMING,
    PLAYER_ADDITION_OPEN,
    neutraliseMarkers(addition),
    PLAYER_ADDITION_CLOSE,
    PLAYER_ADDITION_BOUND,
  ].join("\n");
}

/** The Chat surface's prompt: the Chat block, then the rest of the one assembly. */
export function buildChatCompanionSystemPrompt(profile: IdentityProfile, locale?: string): string {
  return buildCompanionSystemPrompt(profile, {
    surfaceBlock: CHAT_SURFACE_DIVERGENCE,
    ...(locale === undefined ? {} : { locale }),
  });
}

/**
 * The ONE assembly both surfaces render: the surface's block, the identity, then the authored voices.
 *
 * `surfaceBlock` is the surface's own block - the Game conduct, or `CHAT_SURFACE_DIVERGENCE` - named by the module that
 * owns it, so this function has no branch spelling a surface it does not render. Its position is first because the
 * surface is what the request is ABOUT (the world's mechanics on Game, the renderer's grammar on Chat), and everything
 * after it is somebody's voice.
 *
 * The order is declared at the top of this file, once, as a list. Nothing here sorts, ranks or arbitrates between two
 * blocks.
 */
export function buildCompanionSystemPrompt(
  profile: IdentityProfile,
  options: Readonly<{ surfaceBlock: string; locale?: string; playerAddition?: GamePromptAddition }>,
): string {
  const macros = identityProfileMacros(profile, options.locale);
  const lines: (string | null)[] = [];
  if (options.surfaceBlock.length > 0) lines.push(options.surfaceBlock, "");
  lines.push(renderIdentityProfile(profile, options.locale));
  if (profile.characterVoice !== undefined) lines.push("", renderCardDirective(profile.characterVoice, macros));
  if (options.playerAddition !== undefined && options.playerAddition.length > 0)
    lines.push("", renderPlayerPromptAddition(options.playerAddition));
  return lines.filter((line): line is string => typeof line === "string").join("\n");
}
