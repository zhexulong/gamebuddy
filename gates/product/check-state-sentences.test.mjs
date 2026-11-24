#!/usr/bin/env node
/**
 * The falsifier of `gates/product/check-state-sentences.mjs`.
 *
 * red-proof: history  the sentence that shipped (measured 2026-11-24, both catalogues) is replayed below and the gate
 *                     reports `sentence_names_a_step_the_product_cannot_perform` naming `cabin/uncertain` and both of
 *                     the steps it asked for: "reload the page to recover" and "wait for recovery". The tree before this
 *                     lane also has no `CABIN_HANDOFF_FINISHED_BY`, so the same readers answer `blocked` naming
 *                     `cabin_handoff_finish_not_declared` instead of green over a handoff nothing finishes.
 * red-proof: inject   `CABIN_HANDOFF_ACTIONS.moved_in` offering `confirm` reads
 *                     `step_offered_for_an_action_that_is_finished`; a sentence naming a step its state does not offer
 *                     reads `sentence_names_a_step_the_phase_does_not_offer`; a state with no steps whose sentence names
 *                     none reads `sentence_names_no_step_but_offers_none`; a module declaring nothing reads
 *                     `population_empty` and exits blocked.
 *
 * Every case drives the gate's own readers (`checkStateSentencesOf`) over a throwaway copy of the product's own file with
 * exactly one defect injected, so what is proved is the gate's behaviour on the product's shape rather than a second
 * implementation of the same rules agreeing with itself.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CODES, checkStateSentences, checkStateSentencesOf, SOURCES } from "./check-state-sentences.mjs";

const scratch = mkdtempSync(join(tmpdir(), "state-sentences-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function copy(source, name, edits) {
  let text = readFileSync(source, "utf8");
  for (const [from, to] of edits) {
    assert.ok(
      text.includes(from),
      `${source} no longer contains ${JSON.stringify(from)}, so this injection cannot be made`,
    );
    text = text.split(from).join(to);
  }
  const target = join(scratch, name);
  writeFileSync(target, text, "utf8");
  return target;
}

/** One catalogue key rewritten, in the first binding that carries it (or in every one, with `all`). */
function withSentence(source, name, key, value, all = false) {
  const text = readFileSync(source, "utf8");
  const pattern = new RegExp(`(${key}:\\s*)"[^"]*"`, all ? "gu" : "u");
  assert.ok(pattern.test(text), `${key} is not a literal in ${source}`);
  const target = join(scratch, name);
  writeFileSync(
    target,
    text.replace(pattern, (_match, head) => `${head}${JSON.stringify(value)}`),
    "utf8",
  );
  return target;
}

/** The two sentences as they shipped, from the catalogue before this lane (quoted in the gate's header). */
const SHIPPED = {
  en: "Confirmation is still awaiting verification. Do not confirm again. Wait for recovery or reload the page to recover manually.",
  zh: "确认结果仍在等待验证。请勿再次确认；等待恢复，或重新加载页面进行手动恢复。",
};

const codesOf = (verdict) => verdict.findings.map((entry) => entry.code);

describe("check-state-sentences", () => {
  test("the real tree answers every declared sentence, over a population no reader left empty", (t) => {
    const verdict = checkStateSentences();
    assert.equal(verdict.status, "passed", JSON.stringify(verdict.findings, null, 2));
    // The population is derived, so a reader that quietly stopped finding things would still read as "passed" over
    // what little it saw: the floor is the number of declared states that state a sentence today.
    assert.ok(
      verdict.examined >= 17,
      `only ${verdict.examined} (state, sentence) member(s) were derived; a population this small means a reader broke`,
    );
    assert.ok(
      verdict.naming > 0,
      "no sentence names a step at all, so the matching half of this gate looked at nothing",
    );
    t.diagnostic(
      `state-sentences.1: sentences examined ${verdict.examined} · naming a step ${verdict.naming} · naming a step that cannot work ${verdict.cannotWork}`,
    );
  });

  test("the declared code vocabulary is the one the gate reports", (t) => {
    assert.deepEqual([...CODES].sort(), [
      "cabin_handoff_finish_not_declared",
      "cabin_occupancy_answer_states_no_sentence",
      "phase_sentence_not_declared",
      "population_empty",
      "sentence_key_missing",
      "sentence_names_a_step_the_phase_does_not_offer",
      "sentence_names_a_step_the_product_cannot_perform",
      "sentence_names_no_step_but_offers_none",
      "step_offered_for_an_action_that_is_finished",
    ]);
    t.diagnostic(`state-sentences.2: ${CODES.length} code(s) declared`);
  });

  // The red case this lane exists for, in both languages: the sentence the player actually read.
  for (const [locale, shipped] of Object.entries(SHIPPED)) {
    test(`the sentence that shipped, in ${locale}, is reported as naming steps the product cannot perform`, (t) => {
      const catalogue = withSentence(
        SOURCES.catalogue,
        `shipped-${locale}.ts`,
        "stardewCabinConfirmationUncertain",
        shipped,
        true,
      );
      const verdict = checkStateSentencesOf({ catalogue });
      assert.equal(verdict.status, "failed");
      const reported = verdict.findings.filter(
        (entry) => entry.code === "sentence_names_a_step_the_product_cannot_perform",
      );
      assert.ok(
        reported.some((entry) => entry.detail.startsWith("cabin/uncertain")),
        `the shipped sentence is not reported: ${JSON.stringify(verdict.findings, null, 2)}`,
      );
      assert.ok(verdict.cannotWork >= 1, "a reported sentence that cannot work must be counted, not only printed");
      t.diagnostic(`state-sentences.shipped.${locale}: ${reported.map((entry) => entry.detail).join(" | ")}`);
    });
  }

  test("a press on a handoff the Host says is over is reported by name", (t) => {
    const lifecycle = copy(SOURCES.lifecycle, "moved-in-offers-confirm.ts", [
      ['moved_in: ["terminal"],', 'moved_in: ["terminal", "confirm"],'],
    ]);
    const verdict = checkStateSentencesOf({ lifecycle });
    assert.equal(verdict.status, "failed");
    const [reported] = verdict.findings.filter((entry) => entry.code === "step_offered_for_an_action_that_is_finished");
    assert.ok(reported !== undefined, JSON.stringify(verdict.findings, null, 2));
    assert.match(reported.detail, /cabin\/moved_in offers "confirm"/u);
    t.diagnostic(`state-sentences.3: ${reported.detail}`);
  });

  test("a sentence naming a step its state does not offer is reported by name", (t) => {
    const catalogue = withSentence(
      SOURCES.catalogue,
      "names-the-cabin-read.ts",
      "stardewCabinCheckGameHint",
      "Read cabins again and this line will tell you where she is.",
    );
    const verdict = checkStateSentencesOf({ catalogue });
    assert.equal(verdict.status, "failed");
    const reported = verdict.findings.filter(
      (entry) => entry.code === "sentence_names_a_step_the_phase_does_not_offer",
    );
    assert.ok(
      reported.some((entry) => entry.detail.includes("cabin/uncertain") && entry.detail.includes("read_cabins_again")),
      JSON.stringify(verdict.findings, null, 2),
    );
    t.diagnostic(`state-sentences.4: ${reported.map((entry) => entry.detail).join(" | ")}`);
  });

  test("a state that offers nothing and says nothing is reported as a dead end stated as a choice", (t) => {
    const lifecycle = copy(SOURCES.lifecycle, "confirming-offers-nothing.ts", [
      ['confirming: ["wait_for_read"],', "confirming: [],"],
      [
        "confirming: [],",
        'confirming: [{ key: "stardewCabinsLoading", as: "note", tone: "progress", when: "always" }],',
      ],
    ]);
    const verdict = checkStateSentencesOf({ lifecycle });
    assert.equal(verdict.status, "failed");
    const reported = verdict.findings.filter((entry) => entry.code === "sentence_names_no_step_but_offers_none");
    assert.ok(
      reported.some((entry) => entry.detail.startsWith("cabin/confirming")),
      JSON.stringify(verdict.findings, null, 2),
    );
    t.diagnostic(`state-sentences.5: ${reported.map((entry) => entry.detail).join(" | ")}`);
  });

  test("a tree with no retirement declared is blocked instead of passing over what it cannot see", (t) => {
    const lifecycle = copy(SOURCES.lifecycle, "no-retirement.ts", [
      [
        "export const CABIN_HANDOFF_FINISHED_BY = Object.freeze({",
        "export const CABIN_HANDOFF_FINISHED_BY_GONE = Object.freeze({",
      ],
    ]);
    const verdict = checkStateSentencesOf({ lifecycle });
    assert.equal(verdict.status, "blocked");
    assert.ok(
      codesOf(verdict).includes("cabin_handoff_finish_not_declared"),
      JSON.stringify(verdict.findings, null, 2),
    );
    t.diagnostic(`state-sentences.6: ${verdict.findings[0].detail}`);
  });

  test("a module declaring no state and no sentence is blocked at zero, not green", (t) => {
    const lifecycle = join(scratch, "nothing-declared.ts");
    writeFileSync(
      lifecycle,
      [
        "export const GAME_SESSION_PHASES = [];",
        "export const GAME_PHASE_SENTENCE = {};",
        'export const CABIN_HANDOFF_ACTIONS = { moved_in: ["terminal"] };',
        "export const CABIN_HANDOFF_SENTENCE = {};",
        'export const CABIN_HANDOFF_FINISHED_BY = { fact: "companionInFarm", becomes: "moved_in" };',
        "export const STEP_LABELS = {};",
        "export type CabinHandoffPress = never;",
        "",
      ].join("\n"),
      "utf8",
    );
    const verdict = checkStateSentencesOf({ lifecycle });
    assert.equal(verdict.status, "blocked");
    assert.equal(verdict.examined, 0);
    assert.ok(codesOf(verdict).includes("population_empty"), JSON.stringify(verdict.findings, null, 2));
    t.diagnostic(`state-sentences.7: ${verdict.findings.map((entry) => entry.code).join(", ")}`);
  });

  test("a phase the table forgot is reported, so the two declarations cannot drift", (t) => {
    const lifecycle = copy(SOURCES.lifecycle, "phase-forgotten.ts", [
      ["  game_not_read: Object.freeze(", "  game_not_read_gone: Object.freeze("],
    ]);
    const verdict = checkStateSentencesOf({ lifecycle });
    assert.equal(verdict.status, "failed");
    assert.ok(
      verdict.findings.some(
        (entry) =>
          entry.code === "phase_sentence_not_declared" &&
          entry.detail === "phase/game_not_read is a phase this surface can be in and states no sentence",
      ),
      JSON.stringify(verdict.findings, null, 2),
    );
    t.diagnostic(`state-sentences.8: ${verdict.findings.map((entry) => entry.code).join(", ")}`);
  });
});

/**
 * The probe's answers are a population the gate derives, so an answer added to the vocabulary cannot arrive
 * unspelled - and an answer that loses its sentence is reported by name rather than leaving the player on a screen
 * that changed for no stated reason.
 */
describe("check-state-sentences: the cabin probe's answers", () => {
  test("the real tree declares one sentence per answer, so none of the three is silent", (t) => {
    const text = readFileSync(SOURCES.lifecycle, "utf8");
    const answers = [...text.matchAll(/when: "occupancy_([a-z_]+)",/gu)].map((match) => match[1]);
    assert.deepEqual(
      [...new Set(answers)].sort(),
      ["already_bound", "not_bound", "unknown"],
      "the three answers the probe can give are the three the state declares a sentence for",
    );
    t.diagnostic(`state-sentences.answers: ${[...new Set(answers)].join(", ")}`);
  });

  test("an answer whose sentence was lost is reported by name", (t) => {
    const lifecycle = copy(SOURCES.lifecycle, "answer-without-a-sentence.ts", [
      ['when: "occupancy_already_bound",', 'when: "always",'],
    ]);
    const verdict = checkStateSentencesOf({ lifecycle });
    assert.equal(verdict.status, "failed");
    const [reported] = verdict.findings.filter((entry) => entry.code === "cabin_occupancy_answer_states_no_sentence");
    assert.ok(reported !== undefined, JSON.stringify(verdict.findings, null, 2));
    assert.match(reported.detail, /cabin\/uncertain carries the answer "already_bound"/u);
    t.diagnostic(`state-sentences.answers.red: ${reported.detail}`);
  });

  test("a tree that declares no answers at all is blocked rather than green over a question nobody answered", (t) => {
    const lifecycle = copy(SOURCES.lifecycle, "no-answer-vocabulary.ts", [
      ["export type CabinOccupancyAnswer =", "export type CabinOccupancyAnswerGone ="],
    ]);
    const verdict = checkStateSentencesOf({ lifecycle });
    assert.equal(verdict.status, "blocked");
    assert.ok(
      verdict.findings.some(
        (entry) => entry.code === "population_empty" && entry.detail.includes("CabinOccupancyAnswer was not read"),
      ),
      JSON.stringify(verdict.findings, null, 2),
    );
    t.diagnostic(`state-sentences.answers.blocked: ${verdict.findings.map((entry) => entry.code).join(", ")}`);
  });
});
