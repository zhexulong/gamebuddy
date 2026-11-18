/**
 * THE CHAT SURFACE'S OWN BLOCK: what this surface DRAWS, and the one frame rule that is true here and false in a game.
 *
 * <p>
 * It is a separate module because it is a separate WRITER. `game-surface-prompt-floor.ts` is the Game surface's block
 * and its class table (FLOOR / FORM / CHANNEL); this is the Chat surface's, and the assembler
 * (`companion-prompt-assembly.ts`) hands it in as the one instruction-carrying argument it accepts. The framework writes
 * no sentence of its own (see `framework-roleplay-gate.test.ts`), so a surface's sentences have to live somewhere that
 * is named after the surface they are true on.
 * </p>
 *
 * <p>
 * With no animation channel, the single-asterisk mark is how the companion shows a gesture or a mood in text. CHANNEL,
 * not form: the renderer attaches the narration treatment to `<em>` and to nothing else
 * (`dialogue-web/src/components/MarkdownMessage.tsx:27-43`, pinned by `chat-surface-renderer.spec.ts`). It used to open
 * with "open a line with AT MOST ONE short stage direction": the count was a form rule the card's own examples already
 * answer, and the full-width-parenthesis ban beside it was the same channel fact stated WRONGLY - the renderer does
 * style a leading parenthesis, as the prosody badge, so a ban on every parenthesis forbade a construct the surface
 * draws. How often she reaches for either is her voice's - a fact this module records and no longer says, because a
 * permission about how much she speaks is the preset's claim; see below.
 * </p>
 *
 * <p>
 * THE STYLE QUESTION IS THE CARD'S. The shipped card used to carry "打字里不用星号": measured on that card, the
 * permission reached the model at index 747 and the authored prohibition at 4219, so the surface spoke first and the
 * authored prohibition spoke last - and a prohibition that speaks last is the rule. Nothing in the pipeline needs the
 * marker to APPEAR: the voice layer strips a beat when one is written and passes asterisk-free text through unchanged,
 * and the renderer paints `<em>` for what is written rather than requiring it. With no consumer depending on the
 * marker, the card wins the style question outright - and the frequency goes with it. The sentence that used to hand it
 * over here ("How often you reach for one, and whether you reach for a beat at all, is your voice's call") was a
 * permission about how much she speaks, which is the preset's claim and not the floor's, so it was DELETED rather than
 * reworded: this block states the shape the surface draws and nothing about when she reaches for it.
 * </p>
 *
 * <p>
 * THE FOURTH WALL IS HERE BECAUSE IT IS NOT SHARED. "Do not remind the player this is a game, fiction, or roleplay" sat
 * in the shared framework, where it was TRUE on Chat - there is no game on this surface, only two people talking - and
 * FALSE on Game, whose own preset opens 「同屏联机开黑打《星露谷物语》」 and therefore names the game on purpose. A
 * sentence that contradicts itself on one of the two surfaces was never a framework rule, so it is stated where it
 * holds. Its wording is deliberately about what she may TELL the player rather than about vocabulary.
 * </p>
 */

/**
 * The ONE authored stage-direction syntax the Chat surface uses.
 *
 * The renderer's allowlist IS `dialogue-web/src/components/companion-reply-grammar.ts`'s table, whose gate fails by name
 * when the surface stops drawing what is declared; this constant is the prompt side's mirror of that table's
 * stage-direction member - the one syntax the prompt asks for.
 */
export const COMPANION_ACTION_SYNTAX = "*a brief gesture*";

const CHAT_SURFACE_ACTION_SYNTAX = `To show a gesture, an expression or a mood in text, write it exactly as ${COMPANION_ACTION_SYNTAX}.`;
/**
 * The fourth wall, which is true on this surface and false on the other.
 *
 * <p>
 * It used to have a second job: this sentence was Magic Context's `system_prompt_injection.skip_signatures` value, the
 * substring that told the extension not to inject its coding-agent block into the Chat prompt. The block is now off for
 * both surfaces (`runtime-core.internal.ts`), so the sentence is only what it says - and the assertion that the block
 * cannot reach either prompt is `surface-prompt-writer-isolation.test.ts`, which reads the assembled prompt instead of a
 * substring.
 * </p>
 */
export const CHAT_SURFACE_FRAME =
  "Never remind the player that this is a game, a fiction or a roleplay: they are a person you are living this with, not a reader of a story.";

/** The block the assembler mounts on Chat, in the order the surface states it. */
export const CHAT_SURFACE_DIVERGENCE = [
  CHAT_SURFACE_ACTION_SYNTAX,
  "The surface draws that asterisk form as the action beat, and a full-width parenthesis that opens your reply as the prosody badge set ahead of your words; a parenthesis inside a sentence stays prose, where you put it.",
  CHAT_SURFACE_FRAME,
].join(" ");
