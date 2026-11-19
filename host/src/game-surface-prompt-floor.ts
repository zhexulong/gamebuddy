import { FACT_BRIEF_BLOCKS, type FactBriefBlock } from "./fact-brief.js";
import { type IdentityProfile } from "./identity-profile.js";
import { buildCompanionSystemPrompt } from "./companion-prompt-assembly.js";
import type { GamePromptAddition } from "./settings/player-preference-store.js";

/**
 * The Game surface's prompt header: the syntax of one turn's message, and the one builder that installs it.
 *
 * <p>
 * THIS FILE USED TO BE A FLOOR OF CONDUCT RULES, and it is a header now. Every rule it carried was a second spelling of
 * a fact another layer already owned - the night's enforced hours are the shipped world book's entry, the day's end is
 * `sleep()`'s own description, how to move her body is the two mounted tools' descriptions, and when she speaks is the
 * card's. Each left for the layer that owns it, and what remains is the one thing no other layer can state: which parts
 * of a turn's message are the machine's blocks and which part is her partner talking.
 * </p>
 *
 * <p>
 * WHAT IS LEFT IS SYNTAX, AND IT IS WRITTEN LIKE SYNTAX: one line in the run's own locale, naming the blocks the delivery
 * sends, the one positional fact that speech has no markup of its own (`2026-11-14`: the player's words are the head,
 * unlabelled), and the one fact about the turn's OTHER end - a turn may deliver no bubble at all. Nothing here tells her
 * what to feel, how long a turn is, or when to speak.
 * </p>
 *
 * <p>
 * THE NO-BUBBLE CLAUSE IS SYNTAX AND NOT CONDUCT, which is why it is here rather than in the card: a turn that says
 * nothing is not a refusal or a failure, it is a shape the delivery already has (`deliverTurn` answers `nothing_to_say`),
 * and the model cannot use it unless the surface's own syntax says so. Where the persona draws the line between speaking
 * and being quiet is the card's business; what a delivered turn may CONTAIN is this header's.
 * </p>
 *
 * <p>
 * WHY A FUTURE "ADD A RULE HERE" IS THE WRONG PLACE. A conduct rule has an owner whenever it is about the world, a
 * tool, a renderer or her voice, and this module owns none of those - so a rule written here is a rule written twice.
 * The gate in `game-surface-prompt-floor.test.ts` (`a_rule_the_prompt_states_has_an_owner`) reads every sentence of this
 * block and refuses one that states behaviour with neither an owner nor a recorded reason it cannot move.
 * </p>
 *
 * <p>
 * THE DEBT LINE LEFT ON 2026-11-19, THE DAY IT WAS PAID, exactly as it said it would. It read "receipts and refusals still
 * carry the machine's own vocabulary (a reason code such as `gift_given`, fields such as `location=Farm;item=(O)472`), so
 * say what they mean to a person" - a floor telling her to do the translating that the two renderers owed. Both renderers
 * now do it (`fact-brief.ts`: a refusal reads as `<action> 没做成` plus the instruction `stardew-action-remedy.ts` composes
 * for that code, and the code and its evidence print verbatim on the address line the block declares) and the remaining
 * third of the debt - `game-world-vocabulary.ts`'s `formatHeldTool` falling back to the native identity when a slot
 * publishes no tool word - is reachable only in that block's own address field, where an id is what a later argument
 * copies. The archive claim LEFT on 2026-11-24 for the same reason: the two mounted readers' own descriptions now say
 * whose memory they open (`companion-archive-tool-descriptions.ts`), which is the layer that hands her the call.
 * </p>
 *
 * <p>
 * THE COUNT AND THE NAMES ARE READ FROM `FACT_BRIEF_BLOCKS`, never typed here: on 2026-11-11 a fifth block (`<in-flight>`)
 * was added while a sentence still said "four", so the prompt told her the batch had four blocks and then sent five. A
 * number in prose is a second spelling of a fact the constant already owns, and `BLOCK_GLOSS` is a
 * `Record<FactBriefBlock, …>` because that is what makes a sixth block a compile error here instead of a silent omission.
 * </p>
 */

/** One block's gloss, in each of the two languages this surface renders: the run's locale decides which. */
const BLOCK_GLOSS: Readonly<Record<FactBriefBlock, Readonly<{ zh: string; en: string }>>> = Object.freeze({
  "world-state": Object.freeze({
    zh: "世界现状，每轮都有",
    en: "the world as last observed; the one block every turn carries",
  }),
  "world-facts": Object.freeze({
    zh: "要你知道的事：被拒绝、有人来了、桥断了",
    en: "the decisions you have to see: a refusal, a notice, an arrival, the bridge going away",
  }),
  "execution-result": Object.freeze({ zh: "你交的计划跑成什么样", en: "what a plan you submitted did" }),
});

/** True when the run's own locale is a Chinese one; the surface renders in that locale and nowhere else. */
function readsChinese(locale: string | undefined): boolean {
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh");
}

/**
 * The header's one line for one locale: which blocks the delivery sends, where speech sits, and that a turn may carry no
 * bubble at all.
 */
export function gameSurfaceInputHeader(locale?: string): string {
  const zh = readsChinese(locale);
  const blocks = FACT_BRIEF_BLOCKS.map((block) => {
    const gloss = BLOCK_GLOSS[block];
    if (gloss === undefined) throw new Error(`game_surface_block_without_gloss:${block}`);
    return `<${block}> ${zh ? gloss.zh : gloss.en}`;
  }).join(zh ? "、" : ", ");
  const blockCount = String(FACT_BRIEF_BLOCKS.length);
  return zh
    ? `【消息格式】机器报告，${blockCount} 段：${blocks}。段内机器写的，段外是你搭档的原话、在最前；他没开口就从 <world-state> 起。你的话变成一个气泡，可以没有。`
    : `[Message format] The machine's report, in ${blockCount} blocks: ${blocks}. The blocks are written by the machine; text outside them is your partner's own words, put first, and a turn with none opens with <world-state> instead. Your own words become one bubble, and a turn may deliver none at all.`;
}

/** The header the shipped configuration installs: the locale a player's Game session runs under (measured 2026-10-31). */
export const GAME_SURFACE_INPUT_HEADER = gameSurfaceInputHeader("zh-CN");

/**
 * The Game companion's prompt: the surface's header, then the identity, the card and the player's own addition.
 *
 * `playerAddition` is passed in rather than read here: a running Game session keeps the
 * instructions it started with, so the value is resolved ONCE where the session is
 * constructed (`runtime-core.internal.ts`) and carried by that session for its whole life.
 * Reading it inside this builder would make every turn consult the settings file, which is
 * exactly the live-updating behaviour the settings panel tells the player it does not have.
 */
export function buildGameCompanionSystemPrompt(
  profile: IdentityProfile,
  locale?: string,
  playerAddition?: GamePromptAddition,
): string {
  return buildCompanionSystemPrompt(profile, {
    surfaceBlock: gameSurfaceInputHeader(locale),
    ...(locale === undefined ? {} : { locale }),
    ...(playerAddition === undefined ? {} : { playerAddition }),
  });
}
