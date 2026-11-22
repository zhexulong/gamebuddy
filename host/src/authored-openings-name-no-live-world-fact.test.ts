/**
 * GATE `an_authored_opening_names_no_fact_the_live_world_owns:<field>:<word>`.
 *
 * <p>
 * AN OPENING IS WRITTEN BEFORE ANYBODY LOOKED AT THE SCREEN. `first_mes` and every `alternate_greetings` entry are
 * authored text: the reviewed card's openings become the companion's greeting variants
 * (`host/src/tavern/new-companion-service.ts`) and the chosen one is committed as a new chat's first row
 * (`host/src/tavern/library-service.ts`). No observation is read to write it, and a chat can be created with no game
 * session at all, so an opening that states the weather, the season, the clock or a festival states something the
 * observation owns. The shipped `data.alternate_greetings[0]` did exactly that - 「游戏里下雨了，今天不用给地浇水！」
 * was message zero on a 晴天 HUD - and the card's own conduct rule (「只聊眼下屏幕真看到的状况」) is broken by the
 * card's own first breath.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE AUTHORITY'S, not a list here: `DEFAULT_COMPANION_PRESET.greetings`, which
 * `host/scripts/compile-default-companion-preset.mjs` generates from the committed card and
 * `default-companion-preset.test.ts` holds to it, so an opening added tomorrow is measured without an edit to this
 * file. Every run prints `openings examined N · live-world words W · openings naming a fact F`, and zero openings is
 * blocked rather than green.
 * </p>
 *
 * <p>
 * WHAT IT CANNOT SEE, said out loud rather than passed silently: this reads the WORDS the world publishes - the
 * vocabulary declared below - and not what a sentence implies. 「被子够厚」 implies a cold night and no list catches it,
 * so the judgement about these lines belongs to a reader, and a rewrite of them is argued in
 * `assets/tavern/presets/PERSONA-REVISION.md`. The vocabulary lives here rather than in product code because nothing
 * in the product prints from it: it is the writing rule, not a value any surface renders.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_COMPANION_PRESET } from "./tavern/default-companion-preset.js";

/** One family of facts the observation publishes, and the words a reader would take as a claim about the screen. */
type LiveWorldFact = Readonly<{ field: string; words: readonly string[] }>;

/**
 * The world's live facts in the words an opening would use, specific word first so a finding names the narrowest one.
 *
 * Each family answers a field of the snapshot the composed block prints: `weather` (`formatGameWeather` - 天气：晴天),
 * `season` (`SEASON_NAMES_ZH` - 春季/夏季/秋季/冬季), the HUD's clock, and the town's calendar the world book documents.
 */
const LIVE_WORLD_FACTS: readonly LiveWorldFact[] = Object.freeze([
  Object.freeze({
    field: "weather",
    words: Object.freeze([
      "天气",
      "下雨",
      "下雪",
      "晴天",
      "阴天",
      "起雾",
      "刮风",
      "绿雨",
      "大风",
      "雷",
      "雨",
      "雪",
      "晴",
      "雾",
    ]),
  }),
  Object.freeze({
    field: "season",
    words: Object.freeze(["季节", "换季", "春季", "夏季", "秋季", "冬季", "春天", "夏天", "秋天", "冬天"]),
  }),
  Object.freeze({ field: "clock", words: Object.freeze(["点半", "点钟", "凌晨", "正午", "傍晚", "天黑", "天亮"]) }),
  Object.freeze({ field: "occasion", words: Object.freeze(["节日", "节庆", "蛋节", "花舞节", "月光水母"]) }),
]);

/** The facts one text names, one per family, naming the narrowest word it used. */
export function liveWorldClaims(text: string): readonly Readonly<{ field: string; word: string }>[] {
  const claims: Readonly<{ field: string; word: string }>[] = [];
  for (const family of LIVE_WORLD_FACTS) {
    const word = family.words.find((candidate) => text.includes(candidate));
    if (word !== undefined) claims.push(Object.freeze({ field: family.field, word }));
  }
  return claims;
}

/** What a failure says: the opening's own label and text, and the fact it named. */
function namingLine(opening: Readonly<{ label: string; text: string }>): string {
  const claims = liveWorldClaims(opening.text);
  return `${opening.label} names ${claims.map((claim) => `${claim.field}:${claim.word}`).join(",")} in ${opening.text}`;
}

test("an_authored_opening_names_no_fact_the_live_world_owns: every shipped opening leaves the live world to the observation", () => {
  const openings = DEFAULT_COMPANION_PRESET.greetings;
  const verdicts = openings.map((greeting) =>
    Object.freeze({ label: greeting.label, text: greeting.text, claims: liveWorldClaims(greeting.text) }),
  );
  const naming = verdicts.filter((verdict) => verdict.claims.length > 0);
  console.log(
    `an_authored_opening_names_no_fact_the_live_world_owns:${verdicts.map((verdict) => verdict.label).join(",")} · ` +
      `openings examined ${String(verdicts.length)} · ` +
      `live-world words ${String(LIVE_WORLD_FACTS.reduce((total, family) => total + family.words.length, 0))} · ` +
      `openings naming a fact ${String(naming.length)}`,
  );
  assert.ok(
    verdicts.length > 0,
    "zero openings examined is blocked, never green: DEFAULT_COMPANION_PRESET.greetings is the population",
  );
  for (const verdict of verdicts)
    assert.ok(verdict.text.trim().length > 0, `${verdict.label} is published with no text, so nothing was examined`);
  assert.deepEqual(
    naming.map(namingLine),
    [],
    `an authored opening names a fact the live world owns: ${naming.map(namingLine).join(" | ")}`,
  );
});

test("an_authored_opening_names_no_fact_the_live_world_owns: the line the review measured names the weather", () => {
  // THE FALSIFIER, quoting the opening this repository shipped. A check the rewritten card passes has to refuse the
  // line that was actually on screen, or it is decoration.
  const measured = "游戏里下雨了，今天不用给地浇水！正好，咱俩上河边甩两杆还是镇上逛一圈？";
  assert.deepEqual(
    liveWorldClaims(measured).map((claim) => `${claim.field}:${claim.word}`),
    ["weather:下雨"],
    `the shipped line states the weather the HUD prints: ${measured}`,
  );
  // AND IT READS ONLY WHAT THE WORLD OWNS: an opening that plans the session in her own voice names no live fact, so
  // the fix is a rewrite rather than the removal of every opening.
  assert.deepEqual(liveWorldClaims("这片清得差不多了，歇口气喝口水？你那边咋样？"), []);
});
