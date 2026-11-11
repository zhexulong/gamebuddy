/**
 * The Game floor's Stardew rules: the ones that are true of THIS save format, not of a game surface.
 *
 * <p>
 * Everything in `game-surface-prompt-floor.ts` holds for any game surface - machine-block semantics, the bubble's own
 * delivery unit, the receipt vocabulary, body language through the mounted tools. What is here is Stardew's physics: the
 * starter house is one room until its kitchen upgrade, the day ends at your own bed inside that house, the mines at
 * 01:30 and the pass-out at 02:00, and `(T)Hoe` is not a word a person says. A second game would write its own file
 * like this one and the generic floor would not grow a branch for it.
 * </p>
 *
 * <p>
 * The rules are exported as texts and are ORDERED BY THE FLOOR, not by this file: `game-surface-prompt-floor.ts`
 * composes the one list the model reads, and a rule belongs where it reads, not where it is written. That is the one
 * dependency from the generic floor into a game tree, and it is deliberate - the alternative is the floor knowing which
 * game it is talking to at render time.
 * </p>
 *
 * <p>
 * Each rule's class is recorded beside the rules it describes, in `STARDEW_GAME_CONDUCT_CLASSES`, and
 * `tools/check-game-surface-conduct-classes.mjs` reads it from the source: a rule of this module that governs FORM is a
 * finding (`floor_governs_form:<id>:host/src/games/stardew/prompt/stardew-game-conduct.ts`) rather than a
 * classification, because the card owns form on this surface as on every other.
 * </p>
 */

export const LIVE_STATE_GROUNDING =
  "Ground every utterance in the live game state (<runtime-environment>): time, weather, location, stamina, held tool, and unwatered crops. Never hallucinate chores or conditions that contradict reality (e.g. watering crops on a rainy day, proposing heavy labour when stamina is drained, or strolling past midnight). In deep mines stay alert; at 01:30 AM drop non-urgent tasks and sprint home before passing out at 02:00 AM. Speak from tangible objects in front of you, not vacuum chit-chat.";

export const HOUSE_HAS_NO_KITCHEN =
  "The house you share is what this save says it is, not what a farmhouse usually has: the starting house is one room, and a kitchen with a stove appears only once the house has been upgraded. So never cook, brew, or name a stove or a pot unless the live state reports a kitchen where you are standing - a sentence that cooks in a room with no stove sends your partner looking for something that is not there.";

export const BED_IS_INSIDE =
  "The day ends at your own bed inside that house, never out in the fields: going to bed from anywhere else is refused before it starts, so walk inside first and then end the day.";

export const SLEEPING_IS_AN_ACTION =
  "The day ends by going to bed and sleeping, and that is an action like any other — a spoken goodnight leaves the day exactly where it was.";

export const CONTENT_IDS_IN_WORDS =
  "Name the things you handle in words, never in the game's own ids. A live session said \"我们带着 (T)Hoe 去 Town\", reading the world's content ids out loud: (T)Hoe and (W)47 are how the game files its tools, and UndergroundMine10 is a map name, not a place a person goes. Say 锄头 / hoe, 镰刀 / scythe, 矿洞第 10 层 / floor 10 of the mines, 农场 / the farm, 镇上 / town - the fact line already names the tool for you (手持: 锄头（+2）), so read the word. The ids keep their own place, copied exactly into an action argument or compared against a snapshot field, which is what they are good for; they just never belong inside a sentence your partner hears.";

/**
 * The classification of every rule above, in the order the floor reads them.
 *
 * <p>
 * Positional, exactly as the floor module's own table is: entry `n` classifies this module's rule `n`. The two tables are
 * separate because the rules are; a game that is not Stardew writes its own, and the floor's one composed list keeps the
 * reading order.
 * </p>
 */
export const STARDEW_GAME_CONDUCT_CLASSES: readonly Readonly<{
  /** Stable short id, used by the gate's failure codes. */
  id: string;
  /** One of the doctrine's three kinds. `FORM` is a finding here, not an option: the card owns form. */
  class: "FLOOR" | "CHANNEL" | "FORM";
  /** The one line of argument for that class. */
  reason: string;
}>[] = Object.freeze([
  {
    id: "live_state_grounding",
    class: "FLOOR",
    reason: "observation honesty: a companion who invents a chore or a condition contradicts the world she shares.",
  },
  {
    id: "house_has_no_kitchen",
    class: "FLOOR",
    reason: "the room she stands in is a fact: cooking in a house with no stove is a false claim about the world.",
  },
  {
    id: "bed_is_inside",
    class: "CHANNEL",
    reason: "what the surface refuses - going to bed from the fields - is a mechanic no card can state.",
  },
  {
    id: "sleeping_is_an_action",
    class: "CHANNEL",
    reason: "the day's end is an action on this surface; the run that announced goodnight left the body standing.",
  },
  {
    id: "content_ids_in_words",
    class: "CHANNEL",
    reason:
      "content ids are handles for action arguments; the channel says which side of the sentence each belongs to.",
  },
]);
