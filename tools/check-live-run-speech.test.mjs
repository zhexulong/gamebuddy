import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cardConductRules,
  CARD_PATH,
  deliveredBubbles,
  progressReportClauses,
  readMetronome,
  readProgressReports,
  rulesChecks,
  rulesUnderTest,
  runDirChecks,
  SHORTEST_BUBBLE_GAP_MS,
  TEXT_TESTS,
} from "./check-live-run-speech.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CARD = JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, CARD_PATH), "utf8"));

/**
 * `round73`'s seven delivered bubbles, verbatim from that run's own `result.json` (`presentation.pieces`), with the
 * moments the presentation port committed them at.
 *
 * THE RED CASE IS REAL HISTORY, not a shape written for this suite: the run was handed the shipped card, the card
 * declared `不报进度` in its own words, and the fifth bubble spelled `掰下来了`. Two of the seven report a finished step
 * and the other five say why they are not one - which is the narrowness this suite pins.
 */
const ROUND73 = {
  startedAtMs: 1794984809363,
  endedAtMs: 1794985062407,
  presentation: {
    pieceCount: 7,
    speechFrequency: {
      bubbles: 7,
      placedBubbles: 7,
      turns: 7,
      spanMs: 253044,
      oneEveryMs: 36149,
      shortestGapMs: 7133,
      shortestGap: { fromIndex: 2, toIndex: 3, gapMs: 7133 },
      notMeasured: null,
    },
    pieces: [
      { index: 0, atMs: 1794984854863, text: "醒了就起，趁日头还软。门口那三棵花椰菜该掰了，我出门了。" },
      {
        index: 1,
        atMs: 1794984901571,
        text:
          "嗯。 行，镇上你去忙，家里这摊我收拾。屋里刚出去，先把门口那三棵熟的花椰菜掰下来，再顺着地边把草和石头" +
          "一处处清了。 还落了一棵没掰，我这就过去。",
      },
      { index: 2, atMs: 1794984918904, text: "还剩一棵花椰菜卡在那块地上，我绕到它边上再掰。" },
      { index: 3, atMs: 1794984926037, text: "掰下来了。这边草和石头我接着往西捋。" },
      { index: 4, atMs: 1794984998509, text: "西头这片的草有点密，我顺着往西捋。花椰菜先揣包里，傍晚一并塞出货箱。" },
      {
        index: 5,
        atMs: 1794985036604,
        text:
          "西头这一圈总算能看出地皮了，地上落的东西我也顺手揣进兜里。你在镇上要是路过种子店，看看有没有便宜货。 " +
          "这几棵挡在院子中间的树我一并放倒，木头留着以后打箱子。西边这一片清完，下午我再看北头。",
      },
      { index: 6, atMs: 1794985051954, text: "树桩一个个挖掉，地上散的木头也捡了。中午前后我该把这些菜先送去过秤。" },
    ],
  },
};

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), "live-run-speech-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the population is the card's own text: sections and bullets, parsed rather than listed", () => {
  const parsed = cardConductRules(CARD);
  assert.ok(parsed.sections.length > 0, "the shipped card declares at least one section");
  const bulletLines = CARD.data.system_prompt.split(/\r?\n/u).filter((line) => line.trim().startsWith("- "));
  assert.equal(
    parsed.rules.length,
    bulletLines.length,
    "every bullet in the card's system prompt is one rule, and none is invented",
  );
  for (const rule of parsed.rules) assert.ok(rule.section.length > 0, `the rule "${rule.text}" sits in a section`);
  // The property, not today's number: a rule added to the card tomorrow is in the population without an edit here.
  const grown = { data: { system_prompt: `${CARD.data.system_prompt}\n- 一条新加的规则。\n` } };
  assert.equal(cardConductRules(grown).rules.length, parsed.rules.length + 1);
  // And a card that declares nothing yields nothing rather than a fixture's opinion.
  assert.equal(cardConductRules({ data: {} }).rules.length, 0);
  assert.equal(cardConductRules(null).rules.length, 0);
});

test("the stated test is bound to the card's own phrase, and a card that stops saying it leaves the binding empty", () => {
  const bound = rulesUnderTest(CARD);
  assert.equal(bound.bindings.length, TEXT_TESTS.length, "every stated test has a rule in the shipped card");
  for (const binding of bound.bindings)
    assert.ok(binding.rules > 0, `the bound section "${binding.section}" declares the rules it governs`);
  // THE EXPIRY: remove the card's phrase everywhere and the binding is gone - the gate then blocks instead of passing
  // over nothing. The anchor is a phrase the card uses twice (the header and the bullet), so both have to go: a card
  // that still declares 不报进度在 its bullets is still declaring the rule this test reads.
  const reworded = {
    data: { system_prompt: CARD.data.system_prompt.split("不报进度").join("不絮叼") },
  };
  assert.equal(rulesUnderTest(reworded).bindings.length, 0, "no rule carries the anchor any more");
});

test("a finished step is a report and the clause that stated it is the one named", () => {
  assert.deepEqual(progressReportClauses("掰下来了。这边草和石头我接着往西捋。"), ["掰下来了"]);
  assert.deepEqual(progressReportClauses("树桩一个个挖掉，地上散的木头也捡了。"), [
    "树桩一个个挖掉",
    "地上散的木头也捡了",
  ]);
  // One bubble, one report entry per clause: the population counted is clauses, so a bubble that lists three finished
  // steps is three reports, not one.
  assert.equal(progressReportClauses("草清完了，石头捡了，木头也收完了。").length, 3);
});

test("the test is narrow on purpose: a plan, a remaining count and a condition are not reports", () => {
  // THE FALSIFIER FOR NARROWNESS. Each of these is a bubble the contract forbids and this test does not catch, and the
  // shape of each is named here so the gap is a decision rather than an accident.
  assert.deepEqual(
    progressReportClauses("门口那三棵花椰菜该掰了，我出门了。"),
    [],
    "a forward marker keeps a plan out",
  );
  assert.deepEqual(
    progressReportClauses("还落了一棵没掰，我这就过去。"),
    [],
    "a negated verb keeps a remaining count out",
  );
  assert.deepEqual(progressReportClauses("还剩一棵花椰菜卡在那块地上，我绕到它边上再掰。"), []);
  assert.deepEqual(
    progressReportClauses("西边这一片清完，下午我再看北头。"),
    [],
    "a consequent clause keeps a condition out",
  );
  // And the deliberate omission, as a decision: 总算 … 了 would catch bubble#5 and would also fire on a greeting.
  assert.deepEqual(progressReportClauses("总算回来了，饭在锅里。"), [], "a greeting is not a progress report");
});

test("round73's seven bubbles: two report a finished step, five do not, and which is which is pinned", () => {
  const result = ROUND73;
  const bubbles = deliveredBubbles(result);
  assert.equal(bubbles.length, deliveredBubbles(result).length, "the reading sees every bubble the bundle delivered");
  const { bindings } = rulesUnderTest(CARD);
  const reading = readProgressReports({ bindings, bubbles });
  const flagged = [...new Set(reading.reports.map((report) => report.bubble))];
  assert.deepEqual(flagged, [3, 6], `flagged bubbles: ${flagged.join(",")} of ${bubbles.length} delivered`);
  assert.equal(reading.reports.length, 3, "bubble#6 states two finished steps, so it is two report clauses");
  // The ones it misses, named with the reason each is missed - a test that caught all seven on the run it was written
  // against would not have been shown to be narrow at all.
  const missed = bubbles.filter((bubble) => !flagged.includes(bubble.index)).map((bubble) => bubble.index);
  assert.deepEqual(missed, [0, 1, 2, 4, 5]);
  // The rule the reading names is the card's, in the card's own words.
  assert.deepEqual([...new Set(reading.reports.map((report) => report.rule))], ["不当对讲机，不报进度"]);
  const [check] = reading.checks;
  assert.equal(check.status, "failed");
  assert.match(check.id, /^a_turn_reports_progress_it_was_told_not_to:不当对讲机，不报进度$/u);
  assert.match(check.detail, /rules 5 · bubbles examined 7 · reports 3/u);
  assert.match(check.detail, /bubble#3 「掰下来了」/u);
  assert.match(check.detail, /in 「掰下来了。这边草和石头我接着往西捋。」/u, "the failure quotes the bubble it read");
});

test("the metronome clause fails a 7-second gap by name, passes a turn-per-bubble cadence, and never passes unmeasured", () => {
  const fast = readMetronome({ gapMs: ROUND73.presentation.speechFrequency.shortestGapMs, bubbles: 7 });
  assert.equal(fast.status, "failed");
  assert.equal(fast.id, `speech_is_not_a_metronome:${String(fast.gapMs)}`);
  assert.equal(fast.floorMs, SHORTEST_BUBBLE_GAP_MS);
  assert.match(fast.detail, /shortest gap 7133 ms between two of 7 bubbles/u);
  const slow = readMetronome({ gapMs: SHORTEST_BUBBLE_GAP_MS, bubbles: 7 });
  assert.equal(slow.status, "passed", "a gap exactly at the floor is not under it");
  const unmeasured = readMetronome({ gapMs: null, bubbles: 7 });
  assert.equal(unmeasured.status, "unmeasured");
  assert.match(unmeasured.detail, /an absent reading is not a passing one/u);
});

test("the gate cannot pass without being able to fail: every rule in --rules mode is exercised", () => {
  const reading = rulesChecks({ root: REPOSITORY_ROOT });
  assert.ok(reading.examined > 0, "a report over zero cases agrees with itself");
  assert.equal(reading.checks.length, reading.examined);
  for (const check of reading.checks)
    assert.equal(check.status, "passed", `${check.id} did not pass on the shipped tree: ${String(check.detail)}`);
  assert.ok(reading.boundRules > 0, "the shipped card binds a stated test to at least one rule");
});

test("a real run dir: a clean bundle passes, round73's bundle fails, and a bundle with no bubble blocks", () => {
  withTempDir((root) => {
    const clean = {
      presentation: {
        pieces: [
          { index: 0, atMs: 0, text: "今天风不大，适合把手头这点活干完。" },
          { index: 1, atMs: 60_000, text: "你回来啦，锅里热着汤。" },
        ],
      },
    };
    writeFileSync(join(root, "result.json"), JSON.stringify(clean), "utf8");
    const passing = runDirChecks(root, { root: REPOSITORY_ROOT });
    assert.equal(passing.checks.filter((check) => check.status === "failed").length, 0);
    assert.equal(passing.gapMs, 60_000);
    assert.equal(passing.bubbles, 2);

    writeFileSync(join(root, "result.json"), JSON.stringify(ROUND73), "utf8");
    const red = runDirChecks(root, { root: REPOSITORY_ROOT });
    assert.ok(red.checks.some((check) => check.status === "failed" && check.id.startsWith("a_turn_reports_progress")));

    writeFileSync(join(root, "result.json"), JSON.stringify({ presentation: { pieces: [] } }), "utf8");
    assert.equal(runDirChecks(root, { root: REPOSITORY_ROOT }).blocked, "run_presented_no_bubble");

    rmSync(join(root, "result.json"));
    assert.equal(runDirChecks(root, { root: REPOSITORY_ROOT }).blocked, "result_json_unreadable");
  });
});

// red-proof: inject  round73's own seven bubbles against the card's `不当对讲机，不报进度` rule -> the check
//   `a_turn_reports_progress` fails quoting the bubble it read (`in 「掰下来了。这边草和石头我接着往西捋。」`); two
//   bubbles closer than SHORTEST_BUBBLE_GAP_MS -> `speech_is_not_a_metronome:<gapMs>`; and a run directory whose
//   bundle presented no bubble -> blocked `run_presented_no_bubble` (tools/check-live-run-speech.test.mjs)
