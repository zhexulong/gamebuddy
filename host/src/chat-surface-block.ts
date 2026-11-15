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
 * draws. How often she reaches for either is her voice's.
 * </p>
 *
 * <p>
 * THE STYLE QUESTION IS THE CARD'S. The shipped card used to carry "打字里不用星号": measured on that card, the
 * permission reached the model at index 747 and the authored prohibition at 4219, so the surface spoke first and the
 * authored prohibition spoke last - and a prohibition that speaks last is the rule. Nothing in the pipeline needs the
 * marker to APPEAR: the voice layer strips a beat when one is written and passes asterisk-free text through unchanged,
 * and the renderer paints `<em>` for what is written rather than requiring it. With no consumer depending on the
 * marker, the card wins the style question outright and this block hands it the frequency.
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
const CHAT_SURFACE_ACTION_FORM =
  "How often you reach for one, and whether you reach for a beat at all, is your voice's call: this is the shape the surface draws when you do.";
const CHAT_SURFACE_FRAME =
  "Never remind the player that this is a game, a fiction or a roleplay: they are a person you are living this with, not a reader of a story.";

/** The block the assembler mounts on Chat, in the order the surface states it. */
export const CHAT_SURFACE_DIVERGENCE = [
  CHAT_SURFACE_ACTION_SYNTAX,
  "The surface draws that asterisk form as the action beat, and a full-width parenthesis that opens your reply as the prosody badge set ahead of your words; a parenthesis inside a sentence stays prose, where you put it.",
  CHAT_SURFACE_ACTION_FORM,
  CHAT_SURFACE_FRAME,
].join(" ");

/**
 * The Chat surface's opt-out signature for the Magic Context guidance block.
 *
 * <p>
 * Chat and Game on one continuity share ONE Magic Context config (`resolveRuntimePaths` keys both on `continuityId`), so
 * the block cannot be enabled per surface in that file. What differs between the surfaces is the tool set: Chat mounts
 * no `ctx_*` tool at all, Game mounts all five. The desk protocol names those tools, so on Chat it would be a
 * description of tools she does not have - which is exactly the case Magic Context's own
 * `system_prompt_injection.skip_signatures` documents.
 * </p>
 *
 * <p>
 * It is THIS constant rather than a literal in the config writer, because a second spelling would let an edit to the
 * Chat block silently un-skip the surface, and the failure would be invisible. `runtime-core.internal.ts` therefore
 * refuses both directions at construction: a Chat prompt that no longer carries it, and a Game prompt that somehow does.
 * </p>
 */
export const CHAT_SURFACE_SKIP_SIGNATURE: string = CHAT_SURFACE_ACTION_FORM;
