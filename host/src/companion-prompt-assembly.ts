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
 *    and wrapped in the Host's own markers (`<<<CARD DIRECTIVES` … `CARD DIRECTIVES>>>`). The canon sends a card's
 *    authored text unwrapped; its position after the identity block is what makes it the card's voice. What keeps it
 *    out of the LAST position is the request's SHAPE and not a sentence: the canon gives that position to the
 *    post-history instructions, and the closing-direction message is appended after the system message this block is
 *    part of. `companion-prompt-assembly.test.ts` asserts it as a position, over the appender the request goes through,
 *    so a card moved after that slot reds instead of being argued with.</li>
 *  <li><b>the player's own addition</b> - `renderPlayerPromptAddition`, the player's words between the same kind of
 *    Host-owned markers. A fourth writer: neither the card's words nor the preset's.</li>
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
 * WHAT THE FRAMEWORK EMITS, GIVEN THAT ORDER: a field label (`[Character: {0}]`, `Role: {0}`), a delimiter
 * (`<START>`, `<<<CARD DIRECTIVES` — which names the section as well as bounding it), or a bare slot (`{0}`) into which
 * somebody else's text is placed. Nothing else. No register claim, no sentence saying what the author meant, and no
 * bound: those are the preset's, the card's or the surface's, and a bound stated as a sentence is a promise a later
 * edit can break while a bound asserted as a position is a test that fails. `framework-roleplay-gate.test.ts` reads this
 * module's own strings and fails by name on anything shaped like a sentence; the position is
 * `companion-prompt-assembly.test.ts`'s.
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
 * The card's own directive: the author's words, macro-rendered, between the Host's own markers.
 *
 * The author's text is the AUTHOR's and the section is the Host's: the markers are neutralised inside the text, so a card
 * cannot close a section it did not open. The markers are also the section's NAME - `<<<CARD DIRECTIVES` says whose words
 * follow - which is why no header line is written above them.
 */
export function renderCardDirective(voice: CharacterVoice, macros: MacroTable): string {
  return [
    CARD_VOICE_OPEN,
    neutraliseMarkers(fillTemplate(COMPANION_FORMAT_TEMPLATES.cardDirective ?? "", [renderMacros(voice.text, macros)])),
    CARD_VOICE_CLOSE,
  ].join("\n");
}

/**
 * The PLAYER's own addition to the companion's instructions, in its own delimited section.
 *
 * An addition, never a replacement: it is the fourth writer, it lands after the card's directive and before the preset
 * (item 4 of the order). The same mechanism as the card's block, for the same reason: the markers say whose words these
 * are and keep them inside the section they opened.
 *
 * An empty addition renders nothing at all, so a player who wrote none has a prompt that does not mention them.
 */
export function renderPlayerPromptAddition(addition: GamePromptAddition): string {
  if (addition.length === 0) return "";
  return [PLAYER_ADDITION_OPEN, neutraliseMarkers(addition), PLAYER_ADDITION_CLOSE].join("\n");
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
