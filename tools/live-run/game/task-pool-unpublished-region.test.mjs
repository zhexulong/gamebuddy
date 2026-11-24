// red-proof: inject  the pool's own retired sentence into any task's prompt (「东头那片地该收拾了，杂草和石头都清一清。」 /
//   "the east patch wants clearing - weeds and rocks.") -> `task_names_an_unpublished_region:<task>:zh|en:a compass end`
//   and `…:a compass word`, and "the strip along the fence" -> `…:a fence`; dropping a task's sentence from the prompt
//   table -> `task_has_no_prompt:<task>:<locale>`
//   (tools/live-run/game/task-pool-unpublished-region.test.mjs)
/**
 * NO TASK ASKS FOR A PART OF THE WORLD THE PERCEPTION LAYER DOES NOT HAVE.
 *
 * <p>
 * THE RULE, from the owner: the perception layer publishes OBJECTIVE ANCHORS - the map's size, the buildings and their
 * doors, aggregates over where things are - and never a hard-coded "east area"/"west area". A task is a sentence a
 * partner says, and it may name a published anchor (the farmhouse door, the greenhouse, the mine, a map) or a
 * MEASURABLE OUTCOME (twenty pieces cleared), but a sentence that names a region the world never states asks her to hold
 * something she cannot look up.
 * </p>
 *
 * <p>
 * MEASURED, `round99` day 1. The rotation's first clearing day was `clear_east_patch` - 「东头那片地该收拾了，杂草和石头都清一
 * 清。」 / "the east patch wants clearing - weeds and rocks." - and she cleared the farm while the judge asked about a patch
 * she had no way to identify. The criterion could not be decided either (no clearing receipt publishes a `location`), so
 * the day was `unjudged` as well as unaddressable: one name, two defects, which is why the fix was to ask for a COUNT
 * (`clear_ground_clutter`) rather than to find a better word for the same place.
 * </p>
 *
 * <p>
 * POPULATION: every task the rotation can schedule, read from `DAILY_TASK_ROTATION` - never a list here - with the four
 * texts a day owns: its id, its sentence in both locales (from the runner's own prompt table, through the same
 * source-evaluating loader the day-note gate uses), its purpose, and the missing fact a gap day declares. PROPERTY: none
 * of them carries a region word, and every task has a sentence in both locales - the second half exists because a renamed
 * task with no prompt row is handed the literal string "undefined" (`town_errand`, measured before the prompt table was a
 * population).
 * </p>
 *
 * <p>
 * A REGION WORD IS NOT A PLACE WORD. 「屋里」/the house, 「地里」/the field and 「林子」/the woods are maps or parts of the
 * farm that the published surface answers about (`Farm`, `FarmHouse`, `Forest`), and a task that says "somewhere on the
 * farm" is not asking for a subdivision. The entries below are the vocabulary that cannot be resolved without a fact the
 * world does not publish: a COMPASS END (needs an origin and axes), a CORNER, a FENCE, the map's EDGE, and the FAR SIDE -
 * each of which needs the world to say where its boundary is. Each entry also names the published fact that would retire
 * it, so the list expires instead of growing.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DAILY_TASK_ROTATION, dayTaskSchedule } from "../../lib/multiday-daily-tasks.mjs";
import { judgesAPublishedFact, readScheduledJudgement, TASK_PURPOSE_CRITERIA } from "../../lib/task-purpose.mjs";
import { loadPromptScope } from "./run-stardew-native-local-agent-ab-live.support.mjs";

/**
 * The vocabulary in which a task can ask for ground the world never states, and what would make each one legitimate.
 *
 * `phrase` is what a failure prints - the vocabulary word, not the pattern, because the reader needs to know which kind
 * of place was named. `pattern` carries the spellings the pool could use today. `retiredBy` is the published fact that
 * would make the word honest, so the list is a declaration a producer can expire rather than an opinion.
 */
const REGION_WORDS = Object.freeze([
  Object.freeze({
    phrase: "a compass end",
    // `东头`/`西边`/`南面` and their kin. The bare pair `东西` is "things" and is not matched; a direction always carries a
    // locative here, which is what makes this a direction word rather than a character in a word.
    pattern: /[东西南北](头|边|面|侧|半|部|角|段|片)/u,
    retiredBy:
      "a published family that partitions the map - the farm arrives as one `Farm` with one tile grid and no sub-area id, so a compass end has no origin to be measured from",
  }),
  Object.freeze({
    phrase: "a compass word",
    pattern: /\b(north|south|east|west)(ern|ward|wards)?\b/iu,
    retiredBy: "the same partition: no published fact says which side of a map is north",
  }),
  Object.freeze({
    phrase: "a corner",
    pattern: /角落|拐角|\bcorner\b/iu,
    retiredBy: "a published anchor that is a corner of something (a building's footprint edge) rather than a corner of a map",
  }),
  Object.freeze({
    phrase: "a fence",
    pattern: /篱笆|栅栏|\bfence\b/iu,
    retiredBy: "the fence itself as a published row (`place_wood_fence` publishes where one went), which no clearing family publishes",
  }),
  Object.freeze({
    phrase: "the map's edge",
    pattern: /边缘|周边|\bedge(?:s)?\b/iu,
    retiredBy: "a published statement of the farm's boundary as ground rather than as `mapWidth`/`mapHeight`",
  }),
  Object.freeze({
    phrase: "the far side",
    pattern: /尽头|另一头|(?:那|这)头|(?:那|这)边|\bfar (?:side|end)\b/iu,
    retiredBy: "the same boundary fact: \"the far end\" is a comparison against an origin nothing publishes",
  }),
]);

/**
 * Every task in the rotation with the texts a day owns, as `[label, text]` pairs.
 *
 * The prompts come from the runner's own table through `loadPromptScope`, which evaluates the runner's source - the
 * runner never loads here, because importing it starts a live run. A task missing a sentence contributes none, and the
 * gate reports that separately rather than measuring a shorter list in silence.
 */
function poolTexts() {
  const scope = loadPromptScope();
  const pool = [];
  for (const task of DAILY_TASK_ROTATION) {
    const entry = TASK_PURPOSE_CRITERIA[task];
    const texts = [["id", task]];
    for (const [locale, table] of [
      ["zh", scope.DAILY_TASK_PROMPT_ZH],
      ["en", scope.DAILY_TASK_PROMPT_EN],
    ]) {
      const sentence = table[task];
      if (typeof sentence === "string" && sentence.trim().length > 0) texts.push([locale, sentence]);
    }
    if (typeof entry?.purpose === "string") texts.push(["purpose", entry.purpose]);
    if (typeof entry?.missingFact === "string") texts.push(["missing_fact", entry.missingFact]);
    pool.push(Object.freeze({ task, texts: Object.freeze(texts) }));
  }
  return Object.freeze(pool);
}

/**
 * Every region word in one task's texts, as failure lines that name the task, the text and the phrase.
 *
 * A pure function of the texts so the falsifier below drives the same code path as the gate: a checker written twice
 * would agree with itself and prove nothing about the pool.
 */
function regionViolationsOf(task, texts) {
  const violations = [];
  for (const [label, text] of texts) {
    for (const word of REGION_WORDS) {
      const match = word.pattern.exec(text);
      if (match === null) continue;
      violations.push(
        `task_names_an_unpublished_region:${task}:${label}:${word.phrase} (${JSON.stringify(match[0])} in ` +
          `${JSON.stringify(text.slice(0, 80))}${text.length > 80 ? "…" : ""} - would need ${word.retiredBy})`,
      );
    }
  }
  return violations;
}

test("no task in the rotation asks for a region the perception layer never publishes", (t) => {
  const pool = poolTexts();
  const violations = [];
  let textsExamined = 0;
  for (const { task, texts } of pool) {
    textsExamined += texts.length;
    violations.push(...regionViolationsOf(task, texts));
    // A task with no sentence in a locale is handed the literal string "undefined" by the prompt table that is read by
    // key - the `town_errand` defect, which a rename reproduces if the table is not renamed with it.
    for (const locale of ["zh", "en"])
      if (!texts.some(([label]) => label === locale)) violations.push(`task_has_no_prompt:${task}:${locale}`);
  }
  const reading =
    `tasks examined ${String(pool.length)} · texts examined ${String(textsExamined)} · ` +
    `region words declared ${String(REGION_WORDS.length)} · unpublished regions ${String(violations.length)}`;
  t.diagnostic(reading);
  // Zero is not green: a pool that could not be read would report no region words and agree with itself.
  assert.ok(
    pool.length > 0 && textsExamined >= pool.length * 2,
    `${reading} - the pool or its prompt tables examined nothing, so this reading cannot fail`,
  );
  // AND THE OTHER DIRECTION: a sentence for a task the rotation never asks for is dead data that reads as coverage -
  // `town_errand` was exactly that key, and it is how two days were handed the literal string "undefined".
  const scope = loadPromptScope();
  for (const [locale, table] of [
    ["zh", scope.DAILY_TASK_PROMPT_ZH],
    ["en", scope.DAILY_TASK_PROMPT_EN],
  ])
    for (const task of Object.keys(table))
      if (!DAILY_TASK_ROTATION.includes(task))
        violations.push(`prompt_for_a_task_the_rotation_never_asks_for:${task}:${locale}`);
  assert.deepEqual(violations, [], `${reading}\n${violations.join("\n")}`);
});

/**
 * THE FALSIFIER, on the pool's own history and on the shapes one edit away.
 *
 * Every case is a real sentence this pool or its runner has carried, or the shape a next edit reaches for: the retired
 * `clear_east_patch` prompt in both locales, a fence line, a corner, a map edge, and a compass word in a new task's
 * sentence. The clean case rides along, so a checker that rejects every place word is red as well as one that accepts
 * everything.
 */
test("the region checker is red on the sentences the pool used to carry", () => {
  const cases = [
    ["the retired clearing task", "zh", "东头那片地该收拾了，杂草和石头都清一清。", "a compass end"],
    ["the retired clearing task", "en", "the east patch wants clearing - weeds and rocks.", "a compass word"],
    ["a fence line", "en", "clear the strip along the fence before it rains.", "a fence"],
    ["a corner", "zh", "把院子角落的杂物清一下。", "a corner"],
    ["a map edge", "en", "sweep the farm edges for forage.", "the map's edge"],
    ["a far side", "zh", "把地那头剩下的草割了。", "the far side"],
  ];
  const missed = [];
  for (const [name, locale, text, phrase] of cases) {
    const raised = regionViolationsOf("a_task", [[locale, text]]);
    if (!raised.some((line) => line.includes(`:${locale}:${phrase}`)))
      missed.push(`${name}: expected ${locale}:${phrase}, raised ${JSON.stringify(raised)}`);
  }
  // The green case: the pool's own replacements, and the place words that name something published.
  const clean = [
    ["zh", "农场上的杂草、乱草、石头和树桩，今天清够二十样。"],
    ["en", "clear twenty pieces of the clutter on the farm today - weeds, grass, rocks and stumps."],
    ["zh", "屋里太空了，收拾一下、摆点东西，让它像个家。"],
    ["en", "sweep the woods for forage, shake plenty of trees, and chop down a few in the way for wood."],
  ];
  const falsePositives = clean.flatMap(([locale, text]) => regionViolationsOf("a_task", [[locale, text]]));
  assert.deepEqual(falsePositives, [], `a task that names only published ground raised ${falsePositives.join("\n")}`);
  assert.deepEqual(missed, [], missed.join("\n"));
});

/**
 * THE POOL IS STILL JUDGEABLE, printed as the line a reader asks for: `days N · judgedable J · gap G`.
 *
 * A schedule is composed through `dayTaskSchedule`, the one scheduling path, so the substitution rule and the pillar walk
 * land in this reading by construction. This is not the judgeability gate (`a_run_is_never_scheduled_on_days_nothing_can_
 * judge` in `tools/lib/task-purpose.test.mjs`, which fails on `J === 0`); it is the number, printed beside the region
 * audit, so "the pool still measures something" is visible in the same run as "the pool names no region".
 */
test("the rotation a run is scheduled from is still judged by facts the product publishes", (t) => {
  const schedule = dayTaskSchedule({ runOffset: 0, judgesAPublishedFact });
  const threeDays = readScheduledJudgement([1, 2, 3].map((day) => Object.freeze({ day, task: schedule(day) })));
  const wholeRotation = readScheduledJudgement(
    DAILY_TASK_ROTATION.map((_, index) => Object.freeze({ day: index + 1, task: schedule(index + 1) })),
  );
  t.diagnostic(`a three-day run · ${threeDays.reading}`);
  t.diagnostic(`the whole rotation · ${wholeRotation.reading}`);
  for (const reading of [threeDays, wholeRotation])
    assert.equal(
      reading.judgeable + reading.gap,
      reading.days,
      `${reading.reading} - every scheduled day is either judged by a published fact or declared a gap`,
    );
});
