/**
 * The Game floor's Stardew rules: the ones that are true of THIS save format, not of a game surface.
 *
 * <p>
 * Everything in `game-surface-prompt-floor.ts` holds for any game surface - machine-block semantics, the bubble's own
 * delivery unit, the receipt vocabulary, body language through the mounted tools. What is here is Stardew's physics: the
 * mines at 01:30 and the pass-out at 02:00, and `(T)Hoe` is not a word a person says. A second game would write its own
 * file like this one and the generic floor would not grow a branch for it.
 * </p>
 *
 * <p>
 * HOW THE DAY ENDS IS NOT HERE, and its absence is the shape every fact in this tree should end in. `SLEEPING_IS_AN_ACTION`
 * stood in the floor until 2026-11-19 saying the day ends by calling `builder.sleep()` with no arguments from inside the
 * farmhouse; it left because the tool that mounts that call already declares it, and a precondition a caller needs AT THE
 * MOMENT OF THE CALL belongs beside the call. `stardew_plan_work`'s own description (`body-program-script.ts`
 * `planWorkDescription`) states that `sleep()` takes no arguments and ends the day only from inside your own farmhouse or
 * cabin, answering `not_home` outdoors - the floor is the last thing she reads, not the place she decides what to write.
 * `body-program-script.test.ts` holds the sentence where it now lives and fails by naming `sleep` and the missing
 * precondition, so the move cannot become a deletion.
 * </p>
 *
 * <p>
 * TWO RULES LEFT THIS MODULE BECAUSE THE DELIVERY STATES THEIR FACT EVERY TURN: the starter house's own form and the
 * live-state grounding. The room's rule was measured here (2026-11-05, day 2 at 18:00 in the starter farmhouse: "六点了，锅
 * 里没东西可下，我烧壶水泡点茶对付一口算了" in a house with neither a kitchen nor a stove), and the grounding rule listed
 * facts the turn already carried. Both are now read off the Mod's own snapshot - `厨房: 无` / `厨房: 有` from its
 * `cookingStationTargets` scan, and the clock, date, weather, map, tile, held tool, unwatered crops and stamina from the
 * same line - so restating them here was a second spelling of a fact the turn already had. It is also the spelling that
 * drifts: a rule about a starter house is a lie the day the house is upgraded, and only the snapshot knows when that was.
 * `game-surface-prompt-floor.test.ts` holds the pair together: every fact the line renders must reach her in
 * `<world-state>`, and the floor must state none of them again.
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
 *
 * <p>
 * The table also carries each rule's EXIT - the surface change that would delete it - in the same row as its class, for
 * the reason the floor module's own entries carry one: a rule that names no exit cannot be told apart from a rule nobody
 * will ever delete. `GameRuleExit` is imported as a type only; at runtime this module still imports nothing from the
 * floor, which is what keeps `game-surface-prompt-floor.ts` the one place the reading order is written.
 * </p>
 */

import type { GameRuleExit } from "../../../game-surface-prompt-floor.js";

export const NIGHT_HAS_ENFORCED_HOURS =
  "The night has hours the game enforces, not ones you can spend: from 01:30 AM drop what is not urgent and make for the bed inside the farmhouse, and 02:00 AM is the day's last legal hour - stay up past it and you pass out where you stand, which costs the day rather than finishing it. The <world-state> line carries the clock and where you are, so read the hour before you accept another piece of work.";

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
  /** The surface change that would delete the rule, or the reason no mechanism can enforce it. */
  exit: GameRuleExit;
}>[] = Object.freeze([
  {
    id: "night_has_enforced_hours",
    class: "CHANNEL",
    reason:
      "the clock and its pass-out are the surface's own authority; the model cannot infer 01:30 as the hour to turn for home or 02:00 as the hour that ends the day.",
    exit: "surface: the `<world-state>` clock line states what the hour means - game-world-vocabulary.ts already formats the same clock against the day's last legal hour and fact-brief.ts already reports a pass-out by name (night_ended_pass_out) - so the line can warn before it happens and the floor has nothing left to add.",
  },
  {
    id: "content_ids_in_words",
    class: "CHANNEL",
    reason:
      "content ids are handles for action arguments; the channel says which side of the sentence each belongs to.",
    exit: "surface: every line she reads pairs an id with its word the way the world-state line does (手持: 锄头（+2）) - including the held-tool fallback that still renders 手持: (T)Hoe when the Mod publishes no display name, and the action arguments' own labels - so no id is the only name she is handed.",
  },
]);
