import { GAME_DELIVERY_PACING } from "./companion-delivery-pacing.js";
import { FACT_BRIEF_BLOCKS, type FactBriefBlock } from "./fact-brief.js";
import {
  BED_IS_INSIDE,
  CONTENT_IDS_IN_WORDS,
  HOUSE_HAS_NO_KITCHEN,
  LIVE_STATE_GROUNDING,
  SLEEPING_IS_AN_ACTION,
} from "./games/stardew/prompt/stardew-game-conduct.js";
import { buildCompanionSystemPrompt, type IdentityProfile } from "./identity-profile.js";
import type { GamePromptAddition } from "./settings/player-preference-store.js";

/**
 * The Game surface's prompt floor: the conduct rules a Game companion reads, and the one builder that installs them.
 *
 * <p>
 * It is its own module because the floor is the part of the Game prompt that grows, rule by rule, out of live-run
 * measurements - and it lives on the Game surface alone. The shared framework, the identity block, the card's own
 * directive and the Chat builders stay in `identity-profile.ts`; what is here is the surface's conduct and the
 * deliverable that renders it.
 * </p>
 *
 * <p>
 * The rules are split by OWNER, and this module composes them into the one list the model reads. What holds for any game
 * surface is written below: machine-block semantics, the bubble's delivery unit, the receipt vocabulary, body language
 * through the mounted tools, the register of a person rather than a helper. What is true only of this save format - the
 * starter house, the bed inside it, the mines at 01:30, `(T)Hoe` - is Stardew's, in
 * `games/stardew/prompt/stardew-game-conduct.ts`, and is spliced in at the position it reads at. The order is
 * `GAME_SURFACE_INTERACTION_CONDUCT`'s, and it is the order of the prompt.
 * </p>
 *
 * <h2>Every instruction here is one of exactly three kinds</h2>
 *
 * <p>
 * Classify a new one before adding it, because the third kind grows into the other two:
 * </p>
 *
 * <ul>
 *  <li>FLOOR - what she must never do: break character, speak out of world or as a helper, or violate a product
 *    safety/contract rule. A pacing bound that only forbids a monologue ("do not write long speeches") is floor. The
 *    prompt owns this.</li>
 *  <li>FORM - how long a turn is, how many action beats it carries, what shape the prose takes. THE CARD OWNS THIS;
 *    the prompt says nothing about it. A prompt-written shape rule beats a card that teaches the opposite shape, which
 *    is exactly how a character whose every example opens with a `*...*` micro-action flattened into dialogue-only
 *    service prose (owner ruling: "the prompt governs the floor, the card governs the form; anything that governs form
 *    gets deleted").</li>
 *  <li>CHANNEL - how to operate the surface we gave her: the one stage-direction syntax the renderer draws, the
 *    mounted tool name that moves her body, the machine vocabulary a receipt has to be translated out of, what to do
 *    when an action is refused. Legitimate and required - the renderer draws nothing until the prompt names its syntax
 *    - but it is the kind that quietly claims authority over form, so state what the surface DOES, never what her prose
 *    must look like. `stardew_express_emote` is a channel fact; "at most one short stage direction" was form wearing a
 *    channel's clothes.</li>
 * </ul>
 *
 * <p>
 * The classification is not a matter of taste, so it is written down beside the rules: every entry of
 * `GAME_SURFACE_CONDUCT_RULES` carries one class and one line saying why, the Stardew module carries the same table for
 * the rules it owns, `GAME_SURFACE_CONDUCT_CLASSES` is that first set of entries read as a table, and
 * `tools/check-game-surface-conduct-classes.mjs` fails by name when a rule arrives without a class, when a class is
 * stated anywhere but inside its rule's own entry, or when a rule classified FORM is still in the floor.
 * </p>
 *
 * <h2>WHEN she speaks is the persona's, and this floor states nothing about it</h2>
 *
 * <p>
 * The three kinds above decide what a rule is ABOUT. This is a separate axis, and it decides WHO OWNS the rule: the
 * persona owns her voice and every rule about when, whether or how much she speaks (`assets/tavern/presets/` - the card's
 * own directive, which every Game session mounts as `characterVoice`, and the preset the surface mounts); the floor owns
 * what the blocks and the receipts MEAN, what counts as an action, and what the SURFACE does; a tool description owns
 * only how to call the tool. The floor may state the bubble's size, the renderer's markdown, the machine vocabulary of a
 * receipt and the ban on speaking as a helper. It may not hang a speech act on a state, a reply or a count - not as a
 * command, not as a permission, and not as a claim about what the surface will carry.
 * </p>
 *
 * <p>
 * Measured 2026-11-15: the floor said "say one thing per reply and stop when it has been said" and the plan tool's
 * description ended "so end your turn and speak to the player". Together they read as WAKE UP - SAY ONE THING - STOP on
 * every turn, work or no work, and the run answered with a bubble on 120 opened turns of which 86 carried
 * `observation:nothing_pending`. Nothing kept the shape from coming back, because the gate that watched this floor looked
 * for PHRASINGS. On 2026-11-22 ten of the nineteen rules these tables declare were still state machines written in prose no phrase list
 * contained - "When a stretch of work ends ... speak from your immediate bodily sensation", "When something blocks you,
 * the player hears a person's reaction", "You may speak while you work", "the surface carries one per reply", "never ask
 * your partner what you should do next" - which is why the gate's population is now every rule these tables declare and
 * its property is whether the rule says when, whether or how much she speaks. Six of those rules duplicated the card's
 * own directive and were deleted rather than moved (one spelling: 先接住人 / 不报进度 / 遇上卡路只说眼前障碍); the one rule
 * nothing else stated - never hand the choice of the next move back, with its concrete-question boundary - moved to the
 * preset the Game surface mounts (`amber-game.json`).
 * </p>
 */

/**
 * How many characters one Game bubble delivers, read from the pacing policy that
 * actually splits the reply (`GAME_DELIVERY_PACING`). The conduct states this number,
 * so it has to be the number the surface uses; `lengthBudget` is nullable only because
 * Chat switches it off, so its absence on Game is a wiring fault, not a vague sentence.
 */
function gameBubbleMaxChars(): number {
  const budget = GAME_DELIVERY_PACING.lengthBudget;
  if (budget === null) throw new Error("game_bubble_length_budget_missing");
  return budget.maxChars;
}

/**
 * Game-surface conduct shared by every Game companion runtime.
 *
 * The Game surface has native action channels (movement, the emote balloon, a
 * turn to a cardinal direction), so spoken text must carry only interaction —
 * never a play-by-play of the actions themselves. Long step-by-step narration
 * makes the companion feel like a status reporter instead of a companion.
 *
 * THE NAME THIS RULE USES IS THE ONE THE LIVE SURFACE MOUNTS, and those are `stardew_express_emote` and
 * `stardew_face_direction`. `runtime-core.internal.ts` drops every tool the adapter publishes as an action when
 * `planActionSurface` is declared, and the live Game materializer declares it, so `STARDEW_ACTION_TOOL_NAMES` is a
 * projection the Agent is never handed - EXCEPT for the actions the registry declares expression-only
 * (`EXPRESSION_ONLY_ACTION_IDS`), whose tools that same filter keeps. A gesture is one step by nature, so it does not
 * need the plan to avoid a one-step run of work; forcing it into the plan made it queue behind the work steps in front of
 * it and be reported settled by the plan's own settlement. This paragraph has now been wrong twice in the same way, both
 * times by naming a route the request did not carry: it once called the per-action names "the MOUNTED ones" (measured
 * `round46b`, 2026-11-11: 68 tool calls, not one emote), then called the plan step the route (measured `round47`, 64
 * assistant turns, 188 planned nodes, zero emotes). `action-route-gate.test.ts` is what now holds every action to exactly
 * one route, derived from the assembled tool set rather than from a name list, and `identity-profile.test.ts`,
 * `surface-protocol-isolation.test.ts` and `action-registry-consistency.test.ts` resolve every `stardew_*` name in the
 * prompt against the MOUNTED set.
 *
 * THE ROUTE BEING NAMED WAS NOT THE WHOLE OF WHAT A CALLER NEEDS, so the rule names the argument too. Measured
 * `round47` (64 assistant turns, 188 planned nodes - 140 `move_to_tile`, 26 `cut_weeds`, 12 `break_rock`, 9 `cut_grass`,
 * 1 `enter_exit`): zero emotes, because nothing a caller was handed said which of the 21 `emote` words an `emote` call
 * takes. The rule now names the argument, and the words themselves are the tool's own closed set in its parameter list -
 * `stardew_plan_shape` cannot answer for these two actions, because the plan form does not admit them.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY IS A FREQUENCY. Under the owner's Option
 * B nothing guarantees an emote: the product teaches the shape and leaves the
 * judgement to her, and no gate anywhere fails a run for not using one. The record
 * is exported so `conversational-stance-gate.test.ts` can read every rule this floor
 * declares; only `buildGameCompanionSystemPrompt` and that gate consume it.
 *
 * THE PACING BOUND IS GONE WITH THE RULES THAT OWNED IT, and its measurement is why
 * it cannot come back as a floor rule. Measured 2026-10-27 on a chain-fixed live run:
 * `firstPieceTtfbMs = 88,532` over a 130 s run whose first SIXTEEN assistant messages
 * were pure `toolCall` turns with no text at all. Nothing in the presentation path was
 * withholding speech (the Game observer releases one mid-work line per reply,
 * `native-companion-content.ts` under `stopReason === "toolUse"` and its 3 s silence
 * timer) - the floor had licensed the silence, and the clause that replaced it then
 * made a line owed on every turn instead. Both readings are one error from two
 * directions: how much she says is the persona's, and the card's own directive states
 * it (说完就停 / 不报进度).
 *
 * LENGTH IS THE SURFACE'S OWN FACT HERE, AND ONLY THE BUBBLE'S.
 *
 * Live runs answered the old adjective with 157/178/144-character turns: paragraphs in a
 * box the player cannot scroll, shaped like a status document, in the voice of a host. No
 * imported card is obliged to say anything about the box, so the floor states it - as the
 * box's measured size, DERIVED from the delivery policy that splits the reply and never
 * restated, plus the markdown the renderer draws as prose. How many lines a reply carries,
 * and when a line belongs, are the persona's.
 *
 * Deliberately absent: a banned list of dialect particles (a card's voice may carry them),
 * any restatement of the persona, and any rule about a moment. The observation-honesty and
 * emote-channel rules are contract, not style.
 *
 * ONE RULE NAMES THE DAY'S OWN MECHANISM, because it is a fact about the surface and
 * nothing else said it. Measured 2026-10-28 (run game-1793210285549, day 5): at in-game
 * 22:00 in the farmhouse the companion's own thinking read "Going to bed would be good.
 * Let me check if there's a sleep action. ... I don't know the action id. Let me not risk
 * it; a brief line is fine." It said goodnight and the body never moved; the engine's
 * 02:00 pass-out took the night, and `advance_day` - published, live-verified, and a plan
 * builder method - was never dispatched, which is also why no `advance_day` lifecycle was
 * running for the morning's ShippingMenu to belong to. The scenario text already said that
 * announcing does not end the day, so the companion knew a goodnight was not the act; what
 * nothing said is that the day's end is an ACTION at all. It went looking for one named
 * "sleep", found none, and fell back on speech. The rule below therefore states the
 * mechanism the way the emote rule states its channel - what the world does, never a tool
 * id (the Game surface mounts the plan builder, not `stardew_advance_day`) and never an
 * hour at which sleeping is owed.
 *
 * A RULE ALSO STATES WHAT A ROOM CONTAINS, because the companion's own book cannot: measured 2026-11-05
 * (day 2, 18:00, the starter farmhouse) she said "六点了，锅里没东西可下，我烧壶水泡点茶对付一口算了" in a house
 * with neither a kitchen nor a stove. The shipped book does say so (`wb-entry-07`), but it says it behind its
 * own trigger words (料理/做饭/绿菜/土豆饼/...), and nothing in that sentence is one of them - so the entry could
 * not fire and no other part of the prompt mentioned the room. The rule below is not a second copy of that
 * entry: it states the HOUSE's own form (one room until its kitchen upgrade), which is true for every card,
 * every save and every imported book, and it is what the live state is checked against when the house does
 * gain a kitchen. The book stays the authored prose about cooking; the premise about the room is the floor.
 *
 * Rendered one rule per line (joined with "\n"): joined as one paragraph, these rules hide
 * their own structure from whoever reviews the next change here.
 *
 * ONE RULE NAMES THE DELIVERY'S BLOCKS, because the block names are markup the model has to recognize rather
 * than prose it can infer. It is CHANNEL - what the surface sends, that every block is the machine's, and that the
 * words above them are the person speaking - and it is written once, here, rather than repeated in every delivery.
 * The distinction it draws is positional on purpose: speech has no markup of its own since `2026-11-14`, so the rule
 * says where it sits instead of naming a block that holds it.
 *
 * THE COUNT AND THE NAMES ARE READ FROM `FACT_BRIEF_BLOCKS`, never typed here: on 2026-11-11 a fifth block
 * (`<in-flight>`) was added while this paragraph still said "four", so the prompt told her the batch had four
 * blocks and then sent five. A number in prose is a second spelling of a fact the constant already owns, and
 * `FACT_BRIEF_BLOCK_GLOSS` is a `Record<FactBriefBlock, string>` because that is what makes a sixth block a
 * compile error here instead of a silent omission from the prompt.
 *
 * THE HEAD OF THE MESSAGE IS CHECKED AGAINST A DELIVERY, because on 2026-11-21 it was not. Measured `round56`, 32
 * delivered batches: 29 began with `<world-state>` and 3 with the partner's own words - which is every shape there is,
 * because `composeFactBrief` puts the player's speech first when they typed and otherwise the world block, the one block
 * every batch carries. The rule said "A turn's message opens with your partner's own words ... answer what your partner
 * said at the top of the message": a false premise stated as fact on 90% of the turns that ran, and an instruction to
 * answer something that was not there. It now states both shapes and what to do in each one, and
 * `game-surface-prompt-floor.test.ts` composes a delivery of EACH shape through the producer and fails by name
 * (`floor_asserts_a_premise_the_delivery_contradicts:<claim>:<shape>`) on any conduct sentence - including one written
 * tomorrow - that names the partner's words as what the head holds.
 *
 * THE TWO SHAPES ARE STATED, AND WHEN SHE SPEAKS STILL IS NOT. The measurement above invites "act on it, and speak only
 * if there is something to coordinate", and that clause is deliberately absent: a condition on when she speaks is a
 * MOMENT, which the section above says the floor may not command, and its history here is the WAKE UP - SAY ONE THING -
 * STOP that the 2026-11-15 measurement produced. Removing the false premise is what this rule owes her; what she says on
 * a turn with nobody speaking is the preset's.
 */
const FACT_BRIEF_BLOCK_GLOSS: Record<FactBriefBlock, string> = {
  "world-state":
    "the world as last observed; its first line names the revision and says whether this turn brought a new observation or re-states the last one",
  "in-flight": "plans you already submitted that have not settled - dispatched is not done",
  "world-facts": "what has happened since",
  "execution-result": "what a plan you submitted did",
};

/** One of the doctrine's three kinds. `FORM` is a finding here, not an option: the card owns form. */
type GameSurfaceConductClass = "FLOOR" | "CHANNEL" | "FORM";

/** One rule of this floor: its text, and the class it belongs to, in one place. */
type GameSurfaceConductRule = Readonly<{
  class: GameSurfaceConductClass;
  reason: string;
  text: string;
}>;

/**
 * Every rule this module owns: the text, the class, and the line of argument for that class, in ONE entry.
 *
 * <p>
 * There is no second array to keep in step, and none is possible: a class is a fact about a rule, so it is declared
 * inside the rule's own entry, and the readers below - the joined prompt and the class view - are projections of these
 * entries. Until 2026-11-15 the rules were one array and their classes another, joined only by array index, and
 * `tools/check-game-surface-conduct-classes.mjs` read the RESULT of that pairing: swapping two rules of different
 * classes left every number in its report unchanged - the observation rule recorded as a delivery rule and the delivery
 * rule as observation honesty - at exit code 0. A rule cannot be added here without a class now; the type refuses it.
 * </p>
 *
 * <p>
 * The keys are the ids the gate's failure codes and the live run's input manifest name a rule by, so they outlive any
 * rewording. They are also not the prompt's order: `GAME_SURFACE_INTERACTION_CONDUCT` below is where the order is
 * written, because a game module's rules read at positions between these.
 * </p>
 */
export const GAME_SURFACE_CONDUCT_RULES = {
  fact_batch_blocks: {
    class: "CHANNEL",
    reason: "the block names are markup the model cannot infer; what the surface sends and who is speaking in it.",
    text: `Every turn's message is the machine's report, in ${String(FACT_BRIEF_BLOCKS.length)} blocks - ${FACT_BRIEF_BLOCKS.map((block) => `<${block}> (${FACT_BRIEF_BLOCK_GLOSS[block]})`).join(", ")} - and only <world-state> arrives on every turn. Your partner's own words are the one thing that breaks into it: a turn that carries them puts them first, exactly as they said them and outside every block, and a turn that carries none opens with <world-state> instead. Every block is written by the machine, never by your partner: they are reports from the world, and the one thing in the message that is not a block is your partner talking.`,
  },
  one_bubble_of_size: {
    class: "CHANNEL",
    reason:
      "the bubble is the surface's delivery unit and cannot be retracted; its size is read from GAME_DELIVERY_PACING.",
    text: `One bubble holds about ${gameBubbleMaxChars()} characters and cannot be retracted once it is shown.`,
  },
  one_utterance_per_reply: {
    class: "CHANNEL",
    reason: "the bubble is drawn as plain prose; markdown is the document form it has no room for.",
    text: "No markdown headings, lists, bold or block quotes, and no 首先, 其次, 最后 or 总结: the bubble draws plain prose, so structure in it reads as a document where a person was talking.",
  },
  observed_only: {
    class: "FLOOR",
    reason:
      "what she may assert: an NPC reaction the game never reported is the contract violation live runs produced.",
    text: "Only state what you actually observed in the game. You cannot see an NPC's feelings, expression or words unless the game reported them back to you, so never claim an NPC smiled, beamed, was delighted, or said something on your account. Your partner shares this world and sees the physical reality with their own eyes: wet soil, cleared fields, and filled bins speak for themselves, so never audit, recite, or list completed chores.",
  },
  machine_fields_translated: {
    class: "CHANNEL",
    reason:
      "a receipt's field names are machine vocabulary; the channel says what to do with them instead of reading them out.",
    text: "Speak in the player's language, never in the game's internal one. Tool results, receipts and status fields are written for machines (identifiers like gift_given or quest_25_completed, flags, enum values); say what they MEAN to a person instead of reading them out. \"That came through as an ordinary gift, so the letter's request still isn't done\" is right; pasting the raw field names is not.",
  },
  body_language_is_native: {
    class: "CHANNEL",
    reason:
      "the two tools that move her body, mounted for her because expression is one step by nature, the one argument each takes, and the three bracketed forms it never draws.",
    text: "Body language has its own tool, mounted beside the plan builder because a gesture is one step by nature and must not wait behind the work: `stardew_express_emote` raises an overhead emote balloon and takes one `emote` word, and `stardew_face_direction` turns you to a cardinal direction and takes one `direction` word - each tool's own parameters spell out the words it accepts, and neither is a step inside stardew_plan_work. Write no bracketed stage direction at all - （转身微笑）, [sighs], *a sigh* - because none of them is a body your partner can see: a full-width parenthesis is an audio tag the voice channel performs instead of speaking （轻声）, and an asterisk beat is dropped from the bubble entirely, so the gesture happens nowhere and the words around it are what reaches your partner.",
  },
  never_a_customer: {
    class: "FLOOR",
    reason:
      "never speak as a helper: the assistant register and the closing offer of further help are what give her away.",
    text: "Talk to your partner, never to a customer. The assistant register and customer-service warmth both give you away: no 当然可以, no 祝你玩得开心, no 还有什么需要吗, no closing line that offers further help, and no summarising back what you just said you would do.",
  },
} as const satisfies Readonly<Record<string, GameSurfaceConductRule>>;

/** The floor as the model reads it: each entry's own text, in reading order, with the game modules' rules spliced in. */
const GAME_SURFACE_INTERACTION_CONDUCT = [
  LIVE_STATE_GROUNDING,
  GAME_SURFACE_CONDUCT_RULES.fact_batch_blocks.text,
  HOUSE_HAS_NO_KITCHEN,
  BED_IS_INSIDE,
  SLEEPING_IS_AN_ACTION,
  GAME_SURFACE_CONDUCT_RULES.one_bubble_of_size.text,
  GAME_SURFACE_CONDUCT_RULES.one_utterance_per_reply.text,
  GAME_SURFACE_CONDUCT_RULES.observed_only.text,
  GAME_SURFACE_CONDUCT_RULES.machine_fields_translated.text,
  CONTENT_IDS_IN_WORDS,
  GAME_SURFACE_CONDUCT_RULES.body_language_is_native.text,
  GAME_SURFACE_CONDUCT_RULES.never_a_customer.text,
].join("\n");

/**
 * The same entries as the class table: one row per rule this module owns, its id, its class and the line of argument.
 *
 * <p>
 * PROJECTED, never written: a table beside the entries is the second spelling this unit removed, and a table that can
 * disagree with the entry it names is what let a reorder go unseen. `tools/check-game-surface-conduct-classes.mjs`
 * fails on any class stated outside the entries above (`conduct_class_restated:<id>`), so a table written back here
 * goes red naming the rule and both classes rather than drifting.
 * </p>
 */
export const GAME_SURFACE_CONDUCT_CLASSES: readonly Readonly<{
  id: string;
  class: GameSurfaceConductClass;
  reason: string;
}>[] = Object.entries(GAME_SURFACE_CONDUCT_RULES).map(([id, rule]) =>
  Object.freeze({ id, class: rule.class, reason: rule.reason }),
);

/**
 * The Game companion's prompt, with the player's own addition appended after the floor.
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
    surfaceBlock: GAME_SURFACE_INTERACTION_CONDUCT,
    ...(locale === undefined ? {} : { locale }),
    ...(playerAddition === undefined ? {} : { playerAddition }),
  });
}
