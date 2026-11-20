/**
 * The speech gate: the conduct the card declares, read against what she actually said - and how far apart she said it.
 *
 * WHY (measured 2026-11-18, `round73`). `assets/tavern/presets/default-companion/card.json` declares
 * `【不当对讲机，不报进度】` in the player's own words: `不报进度、不数第几颗、不说"马上就好"`, `动作回执是内部认知，绝不
 * 翻成台词广播`. The run answered with exactly that: `掰下来了`, `树桩一个个挖掉，地上散的木头也捡了`, and seven bubbles in
 * 252 s - one every 36 s, with a 7-second gap between two of them. THE RULES EXISTED AND NOTHING READ THEM, which is the
 * defect this gate is for; the bubbles are quoted from that run's own `result.json`.
 *
 * THE POPULATION IS THE CARD'S OWN TEXT, NOT A LIST WRITTEN HERE. `cardConductRules` parses `data.system_prompt` by its
 * own shape - `【section】` headers and `- rule` bullets - so a rule the card adds tomorrow is in the population without an
 * edit, and a card that stops declaring one leaves the population rather than leaving a stale list behind.
 *
 * THE TEST IS STATED, AND DELIBERATELY NARROW. A natural-language rule cannot be checked against text without deciding
 * what the words mean, so the decision is written down once (`TEXT_TESTS`) and bound to the rule BY THE CARD'S OWN
 * PHRASE (`不报进度`), not by a line number: if the card stops saying it, the binding is gone and this gate BLOCKS
 * rather than passing over nothing. The test is: A BUBBLE IS A PROGRESS REPORT WHEN A CLAUSE OF IT NAMES A STEP'S
 * STATE CHANGE - a work verb (掰 挖 砍 捡 拔 浇 种 收 割 铲 锄 清 放倒 敲) directly followed by a completion particle
 * (下来 下 掉 完 好 了) - in a clause that carries no forward marker (先 要 该 得 再 去 马上 一会儿 等下 待会 回头 准备 打算 还 没
 * 不 别 想) and whose verb is not negated. Two decisions are worth naming because they are the narrowness:
 *
 *   - `总算/终于/已经 … 了` is NOT a marker, although `西头这一圈总算能看出地皮了` is plainly a progress report. It fires
 *     on a greeting (`总算回来了`), and a gate that fails a good run is worse than one that misses a bubble. The missed
 *     shape is stated in the report rather than papered over.
 *   - `V完就…` IS A PLAN, and this test read it as a receipt until `round84`. `这一小片扫完我就去捡地上那些零碎` and
 *     `我把地上这点零碎捡完就回屋` name what happens WHEN the work is done, so the completion particle is the condition
 *     and not the receipt; the clause's own `就` is the marker, and it is now read (`PLAN_THEN`). Two of that run's eleven
 *     flagged bubbles were this shape.
 *   - `V完，我…` IS STILL READ AS A RECEIPT: `西头这片清完，我把地上的木料石头零碎挨个捡一圈再收手` is a plan whose
 *     second clause carries the forward marker, and the clause that carries the particle has none. Named, not hidden.
 *   - A REMAINING count is not a DONE count: `还剩一棵花椰菜卡在那块地上` and `还落了一棵没掰` are the card's own
 *     forbidden shape and this test does not catch them, because `还剩`/`没掰` name what is LEFT. Named, not hidden.
 *
 * THE FREQUENCY CLAUSE. `speech_is_not_a_metronome` reads the gaps between the delivered bubbles from the pieces' own
 * absolute moments and fails when the shortest is under `SHORTEST_BUBBLE_GAP_MS`. THE FLOOR'S PROVENANCE IS IN ITS OWN
 * COMMENT: it is not a taste. THE READING PRINTS ITS WHOLE POPULATION - `shortest gap` AND `N of G gaps under the floor` -
 * because the minimum alone says nothing about a run: `round84`'s 2 850 ms was read as one tight pair, and the bundle's
 * own pieces carry ELEVEN of its sixty-one gaps under 10 000 ms, one every five or six bubbles, which is a cadence and not
 * an accident. A reading that prints only its extreme invites either a threshold raised to hide it or a verdict dismissed
 * as a fluke.
 *
 * EACH RULE NAMES WHAT IT COUNTED, AND `a_speech_gate_names_what_it_counted` IS THE GATE OVER THAT. Every gate in this
 * module and in `dialogue-gates.mjs` declares a unit (`COUNT_UNITS`) and a threshold beside itself (`speechRules()` here,
 * the gates' own `measure` there), and a gate that stops declaring one fails by name instead of passing over a verdict
 * nobody can trace. `round84` is why: `turn-initiative-split` failed `companion_spoke_a_paragraph` about a 119-character window whose
 * longest bubble was 48 characters, and neither number was in the artifact.
 *
 * Usage:
 *   node tools/check-live-run-speech.mjs                      # the falsifiers: one synthetic case per rule
 *   node tools/check-live-run-speech.mjs --run-dir <dir>      # a real run: its `result.json` and the shipped card
 *   node tools/check-live-run-speech.mjs --rules --json       # the falsifier report, machine-readable
 *
 * red-proof: `--rules` runs every rule against an input that violates it, so the gate cannot pass without being able to
 *            fail (tools/check-live-run-speech.test.mjs drives the same cases). Red on REAL HISTORY: `--run-dir` on
 *            `round73`'s bundle fails `a_turn_reports_progress_it_was_told_not_to:不当对讲机，不报进度` naming the 2 bubbles
 *            that report a finished step, and fails `speech_is_not_a_metronome:7133` on the 7.1 s gap. The fifth of the
 *            seven bubbles spelled `掰下来了` and nothing in the run's artifacts read it.
 */

export const gateDeclaration = {
  id: "check-live-run-speech",
  domain: "data",
  tier: "l0",
  kind: "contract",
};

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COUNT_UNITS, SCHEDULED_DIALOGUE_GATES } from "./live-run/dialogue-gates.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The shipped card whose own text declares the conduct this gate reads. */
export const CARD_PATH = "assets/tavern/presets/default-companion/card.json";

/**
 * The shortest gap between two of her bubbles, in milliseconds - the metronome floor.
 *
 * ITS PROVENANCE IS A MEASUREMENT, AND THE MEASUREMENT IT WAS SUPPOSED TO COME FROM DOES NOT EXIST. `round42`'s runner log
 * is on this machine (`tools/_multiday_routine-round42-live-runner.log`, 6 135 237 bytes, 2026-11-10) and it carries NO
 * clock this floor could be read from: its seventeen `NATIVE_COMPANION_TURN_DELIVERY` records have no `atMs`, and its
 * twenty-eight `AGENT_PRESENTATION_PIECE` lines carry only `elapsedMs` measured from their OWN TURN's start - piece 5
 * reads 166 458 ms and piece 6 reads 10 806 ms with no reset of the run-global index, so an inter-bubble gap cannot be
 * subtracted from that file. Nor does any bundle beside it: every `result.json` in the main checkout's `.live-runs` from
 * 2026-11-09 and 2026-11-10 (fifteen runs) carries pieces with `elapsedMs` and NOT ONE with `atMs`, because the absolute
 * clock was added on 2026-11-17 (`presentation-piece-time.mjs`). What round42 does prove: SEVENTEEN bubbles, one per turn,
 * of which THREE were `suppressed: {no_presentation_lease: 1}` - a period far slower than what this clause catches, which
 * is why no number from it can be a floor of SECONDS between bubbles.
 *
 * THE NUMBER IS THEREFORE CHOSEN FROM THE RUNS THAT CAN BE PLACED ON A CLOCK, and it is stated as what it is: the two
 * bundles on this machine whose pieces carry an absolute moment (`presentation-piece-time.mjs`) report shortest gaps of
 * 7 133 ms (`round73`, 7 bubbles in 253 s) and 7 200 ms (the 2026-11-17T23-22 bundle, 10 bubbles). BOTH ARE THE DEFECT -
 * one bubble per step - so the floor sits above the worse of every MEASURABLE metronome and well below round42's one
 * bubble per turn. It is a bound on the disease, not a measurement of the cure, and this comment says so rather than
 * dressing 10 000 ms as round42's own gap.
 *
 * THE POPULATION IS DELIVERED BUBBLES. A bubble that was composed and refused by the presentation lease never reached
 * the player, so it cannot be half of a gap - otherwise a run that loses them reads as quiet instead of broken. The
 * losses are printed beside the cadence for that reason (`lost L {reason}`).
 */
export const SHORTEST_BUBBLE_GAP_MS = 10_000;

/** A rule's line in the card: a bullet. A section's line: its own `【】` header. */
const SECTION_HEADER = /^【(.+)】\s*$/u;
const RULE_BULLET = /^[-•]\s*(.+)$/u;

/**
 * The card's conduct rules, parsed by the card's own shape.
 *
 * `data.system_prompt` is the conduct channel (`data.description` is the character sheet), so it is the one read. A
 * section with no bullet is kept with `rules: []` - a header that declares nothing is a shape a reader should be able to
 * see, not one to drop silently.
 */
export function cardConductRules(card) {
  const prompt = card?.data?.system_prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) return { sections: [], rules: [] };
  const sections = [];
  for (const line of prompt.split(/\r?\n/u)) {
    const header = SECTION_HEADER.exec(line.trim());
    if (header !== null) {
      sections.push({ name: header[1], rules: [] });
      continue;
    }
    const bullet = RULE_BULLET.exec(line.trim());
    if (bullet === null) continue;
    if (sections.length === 0) sections.push({ name: "", rules: [] });
    sections.at(-1).rules.push(bullet[1]);
  }
  const rules = sections.flatMap((section) => section.rules.map((text) => ({ section: section.name, text })));
  return { sections, rules };
}

/** The verbs that move something in a farm, and the particles that say the move finished. */
const WORK_VERBS = ["掰", "挖", "砍", "捡", "拔", "浇", "种", "收", "割", "铲", "锄", "清", "放倒", "敲"];
const COMPLETION_PARTICLES = ["下来", "下", "掉", "完", "好", "了"];

/**
 * A forward marker says the clause is about what happens NEXT: `先把…掰下来` is a plan, not a receipt. `还` and `没`
 * carry `还落了一棵没掰` - the remaining count the card forbids and this test deliberately does not read.
 */
const FORWARD_MARKERS = /先|要|该|得|再|去|马上|一会儿|等下|待会|回头|准备|打算|还|没|不|别|想/u;

/** The negation a verb can carry on its own left edge (`没掰`, `不捡`). */
const NEGATED = /[不没别未]$/u;

/**
 * A completion particle followed by `就`/`才`/`再`/`然后`/`接着` is a WHEN, not a receipt: `捡完就回屋` says what happens
 * next, so the particle is the condition on the next step rather than the step having happened.
 */
const PLAN_THEN = /^(?:我|你|俺|咱)?(?:就|才|再|然后|接着)/u;

/**
 * A clause that states a condition, not a receipt: `西边这一片清完，下午我再看北头` is about what happens AFTER, and both
 * halves of it are one sentence. The consequent marker is in the NEXT clause, so a clause followed by one names a
 * condition rather than a finished step.
 */
const CONSEQUENT_START = /^(再|就|才|然后|接着|下午|晚上|明天|等|回头)/u;

/** The clauses of a bubble, sentence by sentence: a state change is stated inside one sentence. */
function sentencesOf(text) {
  return String(text ?? "")
    .split(/[。！？；\n]/u)
    .map((sentence) =>
      sentence
        .split(/[，、…—]/u)
        .map((clause) => clause.trim())
        .filter((clause) => clause.length > 0),
    )
    .filter((clauses) => clauses.length > 0);
}

/**
 * Every clause of a bubble that names a step's state change, or an empty array.
 *
 * The scan looks at each occurrence of each work verb, so a negated one (`没掰`) is skipped rather than swallowing the
 * clause: `咬了咬牙，掰下来了` is a report and `还落了一棵没掰` is not.
 */
export function progressReportClauses(text) {
  const found = [];
  for (const sentence of sentencesOf(text)) {
    for (const [offset, clause] of sentence.entries()) {
      if (FORWARD_MARKERS.test(clause)) continue;
      const next = sentence[offset + 1];
      if (next !== undefined && CONSEQUENT_START.test(next)) continue;
      let reported = false;
      for (const verb of WORK_VERBS) {
        for (let at = clause.indexOf(verb); at >= 0 && !reported; at = clause.indexOf(verb, at + 1)) {
          if (NEGATED.test(clause.slice(0, at))) continue;
          const rest = clause.slice(at + verb.length);
          const particle = COMPLETION_PARTICLES.find((candidate) => rest.startsWith(candidate));
          if (particle === undefined) continue;
          if (PLAN_THEN.test(rest.slice(particle.length))) continue;
          reported = true;
        }
        if (reported) break;
      }
      if (reported) found.push(clause);
    }
  }
  return found;
}

/**
 * The tests this gate knows how to run against delivered text, each bound to a rule by the card's own phrase.
 *
 * `anchor` is not a rule id invented here: it is the phrase the card uses, so a card that rewords the rule without the
 * phrase leaves the binding and this gate says so instead of testing a rule nobody declares.
 */
export const TEXT_TESTS = Object.freeze([
  Object.freeze({
    id: "progress_report",
    anchor: "不报进度",
    unit: "sentences",
    threshold: 0,
    statement:
      "a bubble is a progress report when a clause names a step's state change: a work verb directly followed by a " +
      "completion particle, in a clause with no forward marker and no negated verb",
    clauses: progressReportClauses,
  }),
]);

/**
 * The metronome rule, declared where its floor is: the cadence between two delivered bubbles.
 *
 * `unit` is the bubble because the gap is between bubbles; `threshold` is the floor in milliseconds. The pair is what
 * `a_speech_gate_names_what_it_counted` reads, so a reading that compared bubbles with something other than the floor
 * would have to say so here.
 */
export const METRONOME_RULE = Object.freeze({
  id: "speech_is_not_a_metronome",
  unit: "bubbles",
  threshold: SHORTEST_BUBBLE_GAP_MS,
  statement: "the shortest gap between two delivered bubbles, compared with SHORTEST_BUBBLE_GAP_MS",
});

/** Every rule this module states, each carrying the unit it counts and the bound it compares that count with. */
export function speechRules() {
  return [...TEXT_TESTS, METRONOME_RULE];
}

/**
 * The gate `a_speech_gate_names_what_it_counted:<gate>`: does every speech verdict trace to a stated count and a bound?
 *
 * THE POPULATION IS DERIVED, NOT LISTED: every gate in `dialogue-gates.mjs` (imported, so a gate added tomorrow is in the
 * population without an edit here) crossed with every rule this module states. `round84` is the reason the question is
 * asked per gate instead of in prose: `turn-initiative-split` failed `companion_spoke_a_paragraph` on a reply whose
 * longest bubble was 48 characters, and both the count and the bound existed only in the gate's head.
 *
 * THREE ANSWERS, not two: a gate is `failed` when it declares no unit or no bound, `unmeasured` when the unit is not one
 * of `COUNT_UNITS` (the module may count something this repository has no word for, but it has to be given one), and
 * `passed` only when both are stated. `T` counts the gates that stated a bound, and the caller prints it beside `G`.
 */
export function countedGateChecks({ dialogueGates = SCHEDULED_DIALOGUE_GATES, rules = speechRules() } = {}) {
  const population = [
    ...dialogueGates.map((gate) => ({ id: gate.id, declaration: gate.measure ?? null })),
    ...rules.map((rule) => ({ id: rule.id, declaration: rule })),
  ];
  const checks = population.map((entry) => {
    const unit = entry.declaration?.unit ?? null;
    const bound = entry.declaration?.threshold;
    const stated = bound !== undefined && bound !== null && bound !== "";
    const status = !stated ? "failed" : COUNT_UNITS.includes(unit) ? "passed" : "unmeasured";
    return {
      id: `a_speech_gate_names_what_it_counted:${entry.id}`,
      status,
      detail:
        status === "passed"
          ? `counts ${String(unit)} · threshold ${String(bound)} · ${String(entry.declaration.statement ?? "")}`
          : status === "failed"
            ? `the verdict has no stated threshold, so nothing can check it: ${JSON.stringify(entry.declaration)}`
            : `counts ${String(unit)}, which is not one of ${COUNT_UNITS.join(" / ")}`,
    };
  });
  const by = (unit) => population.filter((entry) => entry.declaration?.unit === unit).length;
  const stated = population.filter(
    (entry) => entry.declaration?.threshold !== undefined && entry.declaration?.threshold !== null,
  ).length;
  return {
    checks,
    population,
    reading:
      `gates ${String(population.length)} · count-sentences ${String(by("sentences"))} · ` +
      `count-chars ${String(by("chars"))} · count-bubbles ${String(by("bubbles"))} · ` +
      `threshold-stated ${String(stated)}`,
    thresholdStated: stated,
    gates: population.length,
  };
}

/**
 * Which of the card's own sections carry a stated test, and the rules they declare.
 *
 * A binding is found by the anchor appearing in the section's header or in one of its bullets, so `不报进度` in the
 * header binds the whole family - including `动作回执是内部认知，绝不翻成台词广播`, which is the same claim about the same
 * text.
 */
export function rulesUnderTest(card) {
  const parsed = cardConductRules(card);
  const bindings = [];
  for (const test of TEXT_TESTS) {
    const section = parsed.sections.find(
      (candidate) => candidate.name.includes(test.anchor) || candidate.rules.some((rule) => rule.includes(test.anchor)),
    );
    if (section === undefined) continue;
    bindings.push({ test, section: section.name, rules: section.rules.length });
  }
  return { rules: parsed.rules, bindings };
}

/** Every delivered bubble of a bundle, in the order the player heard them. */
export function deliveredBubbles(result) {
  const pieces = result?.presentation?.pieces;
  if (!Array.isArray(pieces)) return [];
  return pieces.map((piece, index) => ({
    index: typeof piece?.index === "number" ? piece.index : index,
    atMs: typeof piece?.atMs === "number" && Number.isFinite(piece.atMs) ? piece.atMs : null,
    text: typeof piece?.text === "string" ? piece.text : "",
  }));
}

/**
 * The gaps between consecutive delivered bubbles, from the pieces' own absolute moments.
 *
 * The population is DELIVERED bubbles that carry a moment: a bubble the presentation lease refused never reached the
 * player, so it cannot be half of a gap. `publishedShortestGapMs` is the run's own reading of the same population
 * (`tools/lib/presentation-delivery-account.mjs`, derived from these same pieces) and is carried so a disagreement between
 * the two is visible in the reading instead of one of them being silently preferred.
 */
export function bubbleGaps(result, bubbles) {
  const placed = bubbles.filter((bubble) => bubble.atMs !== null);
  const gaps = [];
  for (let index = 1; index < placed.length; index += 1) gaps.push(placed[index].atMs - placed[index - 1].atMs);
  const published = result?.presentation?.speechFrequency?.shortestGapMs;
  return {
    gaps,
    placed: placed.length,
    publishedShortestGapMs: typeof published === "number" && Number.isFinite(published) ? published : null,
  };
}

/**
 * The progress reading: every rule the card declares, crossed with every bubble the run delivered.
 *
 * `reports` is the population that fails - one entry per bubble that names a finished step, with the clause that did it
 * and the bubbles before it, because "she reported progress" is a claim a reader has to be able to check in one line.
 */
export function readProgressReports({ bindings, bubbles }) {
  const checks = [];
  const reports = [];
  for (const binding of bindings) {
    for (const bubble of bubbles) {
      for (const clause of binding.test.clauses(bubble.text)) {
        reports.push({ rule: binding.section, bubble: bubble.index, clause, text: bubble.text });
      }
    }
  }
  for (const binding of bindings) {
    const forRule = reports.filter((report) => report.rule === binding.section);
    checks.push({
      id: `a_turn_reports_progress_it_was_told_not_to:${binding.section}`,
      status: forRule.length === 0 ? "passed" : "failed",
      detail:
        `rules ${String(binding.rules)} · bubbles examined ${String(bubbles.length)} · reports ${String(forRule.length)}` +
        (forRule.length === 0
          ? ""
          : ` · ${forRule
              .map((report) => `bubble#${String(report.bubble)} 「${report.clause}」 in 「${report.text}」`)
              .join(" · ")}`) +
        ` · the test: ${binding.test.statement}`,
    });
  }
  return { checks, reports };
}

/**
 * The metronome reading as one check: the shortest gap AND the population of gaps under the floor, both printed.
 *
 * The minimum alone is not a reading. `round84`'s 2 850 ms was read as a single tight pair while the bundle carried
 * eleven of its sixty-one gaps under 10 000 ms; `round82` carried eleven of forty-seven. A verdict about a cadence has to
 * say how much of the run the cadence covers, or the next reader either dismisses it as a fluke or raises the floor.
 */
export function readMetronome({ gaps = null, floorMs = SHORTEST_BUBBLE_GAP_MS, bubbles, published = null }) {
  if (gaps === null || gaps.length === 0)
    return {
      id: "speech_is_not_a_metronome:unmeasured",
      status: "unmeasured",
      detail:
        `${String(bubbles)} bubbles delivered and fewer than two carry an absolute moment, so no gap can be measured; ` +
        "an absent reading is not a passing one",
      gapMs: null,
      floorMs,
      gapsUnderFloor: null,
      gapsMeasured: 0,
    };
  const shortest = Math.min(...gaps);
  const under = gaps.filter((gap) => gap < floorMs).length;
  const disagreement =
    published === null || published === undefined || published === shortest
      ? ""
      : ` · the run published ${String(published)} ms`;
  return {
    id: `speech_is_not_a_metronome:${String(Math.round(shortest))}`,
    status: shortest < floorMs ? "failed" : "passed",
    detail:
      `shortest gap ${String(shortest)} ms between two of ${String(bubbles)} bubbles; floor ${String(floorMs)} ms; ` +
      `${String(under)} of ${String(gaps.length)} gaps under the floor` +
      (under === 0
        ? " - no two bubbles arrived closer than the floor"
        : ` - ${String(under)} of this run's bubbles arrived less than ${String(floorMs)} ms after the one before: the ` +
          "cadence the card's 不报进度 family forbids") +
      disagreement,
    gapMs: shortest,
    floorMs,
    gapsUnderFloor: under,
    gapsMeasured: gaps.length,
  };
}

/** The card, read from disk; `null` when the tree has none, which the caller reports rather than inventing rules. */
function readCard({ root, cardPath }) {
  const path = resolve(root, cardPath);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const checkStatus = (status) => (status === true ? "passed" : status === false ? "failed" : status);

/**
 * `--rules`: one synthetic case per rule, so the gate cannot pass without being able to fail.
 *
 * Every case is the smallest input that makes its rule fire, built from the shipped card where the card is the
 * population and from the real bubbles where the text is. `examined` counts them: a report over zero cases is blocked
 * by the caller, never green.
 */
export function rulesChecks({ root = REPOSITORY_ROOT } = {}) {
  const checks = [];
  const card = readCard({ root, cardPath: CARD_PATH });
  const { rules, bindings } = rulesUnderTest(card);
  checks.push({
    id: "card_declares_conduct_rules",
    status: checkStatus(rules.length > 0),
    detail: `${CARD_PATH}: ${String(rules.length)} rules in ${String(card?.data?.system_prompt === undefined ? 0 : 1)} system prompt`,
  });
  checks.push({
    id: "a_card_rule_carries_a_stated_text_test",
    status: checkStatus(bindings.length > 0),
    detail:
      bindings.length === 0
        ? `no section of the card carries ${TEXT_TESTS.map((test) => `「${test.anchor}」`).join(" / ")}, so no stated test has a rule to check`
        : `bound: ${bindings.map((binding) => `「${binding.section}」 (${String(binding.rules)} rules)`).join(" · ")}`,
  });
  // The falsifier the progress rule needs: the real bubble that reports a finished step, and the real bubble that is
  // the card's shape but NOT a state change - so the test is seen to catch one and to let the other through.
  const caught = progressReportClauses("树桩一个个挖掉，地上散的木头也捡了。中午前后我该把这些菜先送去过秤。");
  checks.push({
    id: "a_finished_step_is_a_report",
    status: checkStatus(caught.length > 0),
    detail:
      caught.length > 0 ? `clauses: ${caught.join(" · ")}` : "the test missed a bubble that names a finished step",
  });
  const planOnly = progressReportClauses("门口那三棵花椰菜该掰了，我出门了。");
  checks.push({
    id: "a_plan_is_not_a_report",
    status: checkStatus(planOnly.length === 0),
    detail:
      planOnly.length === 0
        ? "a forward marker keeps a plan out of the population"
        : `clauses: ${planOnly.join(" · ")}`,
  });
  const negated = progressReportClauses("还落了一棵没掰，我这就过去。");
  checks.push({
    id: "a_remaining_count_is_not_a_report",
    status: checkStatus(negated.length === 0),
    detail: negated.length === 0 ? "a negated verb keeps a remaining count out" : `clauses: ${negated.join(" · ")}`,
  });
  const condition = progressReportClauses("西边这一片清完，下午我再看北头。");
  checks.push({
    id: "a_condition_is_not_a_report",
    status: checkStatus(condition.length === 0),
    detail: condition.length === 0 ? "a consequent clause keeps a condition out" : `clauses: ${condition.join(" · ")}`,
  });
  const metronome = readMetronome({ gaps: [7_133], floorMs: SHORTEST_BUBBLE_GAP_MS, bubbles: 7 });
  checks.push({
    id: "a_seven_second_gap_is_a_metronome",
    status: checkStatus(metronome.status === "failed"),
    detail: metronome.detail,
  });
  const turnPerBubble = readMetronome({ gaps: [40_000, 13_000], floorMs: SHORTEST_BUBBLE_GAP_MS, bubbles: 7 });
  checks.push({
    id: "a_thirteen_second_gap_is_not_a_metronome",
    status: checkStatus(turnPerBubble.status === "passed"),
    detail: turnPerBubble.detail,
  });
  const unplaceable = readMetronome({ gaps: [], floorMs: SHORTEST_BUBBLE_GAP_MS, bubbles: 7 });
  checks.push({
    id: "an_unmeasurable_cadence_is_not_a_pass",
    status: checkStatus(unplaceable.status === "unmeasured"),
    detail: unplaceable.detail,
  });
  // The falsifier the cadence POPULATION needs: one tight pair printed alone reads as a fluke (`round84`'s 2 850 ms), so
  // the reading is exercised on a run whose shortest gap is one of eleven.
  const burst = readMetronome({
    gaps: [2_850, ...Array.from({ length: 10 }, () => 6_000), 40_000],
    floorMs: 10_000,
    bubbles: 13,
  });
  checks.push({
    id: "a_cadence_says_how_much_of_the_run_it_covers",
    status: checkStatus(burst.gapsUnderFloor === 11 && /11 of 12 gaps under the floor/u.test(burst.detail)),
    detail: burst.detail,
  });
  // The falsifier the traceability gate needs: a gate that states no bound cannot be checked, so it fails by name.
  const untraceable = countedGateChecks({
    dialogueGates: [{ id: "a_gate_with_no_bound", measure: { unit: "chars", statement: "no bound, no reading" } }],
    rules: [],
  });
  checks.push({
    id: "a_gate_that_names_no_bound_fails_by_name",
    status: checkStatus(untraceable.checks[0]?.status === "failed" && untraceable.thresholdStated === 0),
    detail: untraceable.checks[0]?.detail ?? "the falsifier produced no check at all",
  });
  const counted = countedGateChecks();
  checks.push(...counted.checks);
  return {
    checks,
    examined: checks.length,
    rules: rules.length,
    boundRules: bindings.reduce((total, binding) => total + binding.rules, 0),
    bindings,
    counted,
  };
}

/** One real run: its own `result.json` and the card the run was handed. */
export function runDirChecks(runDir, { root = REPOSITORY_ROOT } = {}) {
  const checks = [];
  const resultPath = join(runDir, "result.json");
  let result = null;
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    result = null;
  }
  if (result === null)
    return {
      checks: [{ id: "result_json_readable", status: "failed", detail: resultPath }],
      blocked: "result_json_unreadable",
    };
  const card = readCard({ root, cardPath: CARD_PATH });
  const { rules, bindings } = rulesUnderTest(card);
  if (rules.length === 0)
    return {
      checks: [{ id: "card_declares_conduct_rules", status: "failed", detail: `${CARD_PATH}: no rule declared` }],
      blocked: "card_declares_no_conduct_rule",
    };
  if (bindings.length === 0)
    return {
      checks: [
        {
          id: "a_card_rule_carries_a_stated_text_test",
          status: "failed",
          detail: `no section of the card carries ${TEXT_TESTS.map((test) => `「${test.anchor}」`).join(" / ")}`,
        },
      ],
      blocked: "no_stated_text_test_for_any_declared_rule",
    };
  const bubbles = deliveredBubbles(result);
  if (bubbles.length === 0)
    return {
      checks: [{ id: "bubbles_delivered", status: "failed", detail: "the run's bundle carries no delivered bubble" }],
      blocked: "run_presented_no_bubble",
    };
  const reading = readProgressReports({ bindings, bubbles });
  const gaps = bubbleGaps(result, bubbles);
  const metronome = readMetronome({
    gaps: gaps.gaps,
    bubbles: bubbles.length,
    published: gaps.publishedShortestGapMs,
  });
  const counted = countedGateChecks();
  return {
    checks: [...reading.checks, metronome, ...counted.checks],
    examined: bubbles.length,
    rules: rules.length,
    boundRules: bindings.reduce((total, binding) => total + binding.rules, 0),
    bubbles: bubbles.length,
    reports: reading.reports,
    gaps: gaps.gaps.length,
    gapMs: metronome.gapMs,
    gapsUnderFloor: metronome.gapsUnderFloor,
    counted: counted.reading,
  };
}

const parseOption = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 || index + 1 >= process.argv.length ? null : process.argv[index + 1];
};

const runDir = parseOption("--run-dir");
const reading = runDir === null ? rulesChecks() : runDirChecks(runDir);
const blocked = reading.blocked ?? null;
const checks = reading.checks.map((entry) => ({ ...entry, status: checkStatus(entry.status) }));
const failed = checks.filter((entry) => entry.status === "failed");
const unmeasured = checks.filter((entry) => entry.status === "unmeasured");
const status = blocked !== null ? "blocked" : failed.length > 0 ? "failed" : "passed";
const report = {
  gate: "live_run_speech/v1",
  mode: runDir === null ? "rules" : "run-dir",
  runDir,
  status,
  // The population, printed: a report over no rule and no bubble agrees with itself, so both are on the line and zero
  // is a blocked run rather than a green one.
  rulesExamined: reading.rules ?? 0,
  bubblesExamined: runDir === null ? undefined : (reading.bubbles ?? 0),
  reports: runDir === null ? undefined : (reading.reports ?? []).length,
  checks,
  ...(blocked === null ? {} : { blocked }),
  ...(unmeasured.length > 0 ? { unmeasured: unmeasured.map((entry) => entry.id) } : {}),
};
const population =
  `rules examined ${String(report.rulesExamined)} · with a stated text test ${String(reading.boundRules ?? 0)}` +
  (runDir === null ? "" : ` · bubbles examined ${String(report.bubblesExamined)} · reports ${String(report.reports)}`) +
  ` · ${String(reading.counted?.reading ?? countedGateChecks().reading)}`;
process.stdout.write(`${population}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
if (status === "blocked") process.exitCode = 2;
else if (status === "failed") process.exitCode = 1;
