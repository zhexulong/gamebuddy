#!/usr/bin/env node
/**
 * A player sentence may not name a step the state it stands in cannot perform.
 *
 * WHY. Measured 2026-11-24 on a real run: after a cabin confirmation was published but never answered, the panel said
 * "Confirmation is still awaiting verification. Do not confirm again. Wait for recovery or reload the page to recover
 * manually." (`i18n.ts`, `stardewCabinConfirmationUncertain`). Both named steps were unperformable. Reloading talks to
 * the same GameBuddy, and the attempt the state was born from is released only when GameBuddy itself starts again
 * (`reconcileHeldBootstrapRegistration`, the Host's boot pass); and "recovery" is refused for a terminal record, so a
 * player who waited waited for something the product had already declined to do. The one step that could work - quit
 * GameBuddy from the tray and open it again - was not in the sentence at all.
 *
 * The class is not that sentence. It is: a state that offers steps, and copy that names different ones. No gate could see
 * it, because the copy was markup in one file and the steps a derivation in another, so "does this sentence name a step
 * this state has" had no population to ask.
 *
 * SO THE COPY IS A DECLARATION NOW. `dialogue-web/src/game-lifecycle-controls.ts` states, per session phase
 * (`GAME_PHASE_SENTENCE`) and per cabin-handoff kind (`CABIN_HANDOFF_SENTENCE`), the exact catalogue key(s) the panel
 * draws - and the panel renders THAT table, so the words and the steps are one fact rather than two that agree today.
 * The steps are the same module's own declarations (`GAME_SESSION_PHASES` with the derivation's `build(...)` calls, and
 * `CABIN_HANDOFF_ACTIONS`), and how a step is named is declared beside them (`STEP_LABELS`: the label of the control
 * that presses it, or the tray's own words).
 *
 * WHAT IT ASSERTS, per (state, sentence) member:
 *
 *   1. the sentence exists in every catalogue, so a state cannot point at a key nobody wrote (`sentence_key_missing`);
 *   2. a sentence that names a step - by a declared step's own label, matched case-insensitively - names one the state
 *      offers (`sentence_names_a_step_the_phase_does_not_offer`);
 *   3. a sentence that names a step NO STATE OFFERS - the declared lexicon below, each entry carrying the reason it
 *      cannot work - is reported whatever state it stands in (`sentence_names_a_step_the_product_cannot_perform`). This
 *      is the code the shipped sentence is red on;
 *   4. a state that offers nothing and whose sentence names nothing is a dead end stated as if it were a choice
 *      (`sentence_names_no_step_but_offers_none`);
 *   5. the handoff's FINISHED state (`CABIN_HANDOFF_FINISHED_BY`) offers no press on the handoff
 *      (`step_offered_for_an_action_that_is_finished`). The state is reached once the Host's own attachment says the
 *      companion is in this save, so a confirm drawn there is a press whose action is over - the shape a player met by
 *      reopening the page on a farm she was already in.
 *
 * THE POPULATION IS DERIVED, never listed: the phases are `GAME_SESSION_PHASES`, their steps are the derivation's own
 * `build(...)` calls (read by `phaseMembers`, the reader `check-fail-closed-forward-path.mjs` already owns), the cabin
 * kinds are the keys of `CABIN_HANDOFF_ACTIONS`, and the sentences are those two tables. A phase or kind added anywhere
 * joins this gate without an edit here, and an empty population is `blocked` with exit 1 - a gate that examined nothing
 * has not passed.
 *
 * WHAT IT DOES NOT ASSERT, stated so a green run is not read as more than it is: that the named control is enabled in
 * the state the sentence describes, or that pressing it reaches the Host. Nor that a sentence names EVERY step its state
 * offers - `gameNotRead` says "Read it again" without using the button's own words, and the button is drawn beside it.
 * The rule is one-way on purpose: a step the sentence names must exist, and a step name is matched only against the
 * products' own labels, so the detector cannot flag a sentence for choosing different words.
 *
 * red-proof: inject  `stardewCabinConfirmationUncertain` restored to the text that shipped ("Wait for recovery or reload
 *                    the page to recover manually.") -> `sentence_names_a_step_the_product_cannot_perform` naming
 *                    cabin/uncertain and both phrases, exit 1
 *                    (gates/product/check-state-sentences.test.mjs)
 * red-proof: inject  `CABIN_HANDOFF_ACTIONS.moved_in` offering `confirm` -> `step_offered_for_an_action_that_is_finished`,
 *                    naming the state and the press (same falsifier)
 * red-proof: history HEAD before this lane declares no `CABIN_HANDOFF_FINISHED_BY` and no finished state, so the run is
 *                    `blocked` naming the missing retirement instead of green over a handoff nobody finishes
 *                    (gates/product/check-state-sentences.test.mjs)
 */
export const gateDeclaration = {
  id: "check-state-sentences",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { blockedOnEmptyPopulation } from "../../tools/lib/gate-population.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";
import {
  constantsOf,
  SOURCES as FORWARD_PATH_SOURCES,
  objectProperties,
  parseFile,
  phaseMembers,
  stringArray,
  stringLiterals,
  unionTypeMembers,
  unwrap,
} from "./check-fail-closed-forward-path.mjs";

const ROOT = repositoryRoot(import.meta.url);
const WEB_ROOT = join(ROOT, "dialogue-web");
const typescript = createRequire(join(WEB_ROOT, "package.json"))("typescript");

export const SOURCES = {
  lifecycle: join(WEB_ROOT, "src", "game-lifecycle-controls.ts"),
  catalogue: join(WEB_ROOT, "src", "i18n.ts"),
};

/**
 * The steps no state offers, declared with the reason each cannot work.
 *
 * An entry is not an exemption: it names a class of step a sentence must not ask for, and the reason is what a reader
 * needs to tell a true entry from a stale one. The shipped copies of both (measured 2026-11-24) are replayed by the
 * falsifier, so the entries are shown live rather than assumed.
 */
export const UNPERFORMABLE_STEPS = Object.freeze([
  Object.freeze({
    step: "reload the page to recover",
    en: /reload(?:ing)? (?:this |the )?page[^.]{0,40}(?:recover|restore)/iu,
    zh: /重新加载(?:这一|本)?(?:页面|页)[^。]{0,20}(?:恢复|修复)/u,
    why:
      "a reload talks to the same GameBuddy, and the attempt it would have to release is released by that process " +
      "starting again, not by a page load (`reconcileHeldBootstrapRegistration`)",
  }),
  Object.freeze({
    step: "wait for recovery",
    en: /\bwait(?:ing)? for recovery\b/iu,
    zh: /等待恢复/u,
    why:
      "the recovery path refuses a terminal attempt record and names that refusal (`STARDEW_BOOTSTRAP_OWNER_RECOVERY_" +
      "TERMINAL_REFUSAL`), so nothing arrives for the player to wait on",
  }),
]);

export const CODES = Object.freeze([
  "sentence_key_missing",
  "sentence_names_a_step_the_phase_does_not_offer",
  "sentence_names_a_step_the_product_cannot_perform",
  "sentence_names_no_step_but_offers_none",
  "step_offered_for_an_action_that_is_finished",
  "phase_sentence_not_declared",
  "cabin_handoff_finish_not_declared",
  "population_empty",
]);

/** The falsifier seam: run the same readers over another tree, exactly as the forward-path gate does. */
export function checkStateSentencesOf(overrides) {
  const saved = { ...SOURCES, lifecycle: FORWARD_PATH_SOURCES.lifecycle };
  Object.assign(SOURCES, overrides);
  FORWARD_PATH_SOURCES.lifecycle = SOURCES.lifecycle;
  try {
    return checkStateSentences();
  } finally {
    Object.assign(SOURCES, { lifecycle: saved.lifecycle, catalogue: saved.catalogue });
    FORWARD_PATH_SOURCES.lifecycle = saved.lifecycle;
  }
}

/**
 * The catalogue's string values by key, per catalogue binding (`en`, `zh`, ...).
 *
 * A key whose value is not a string literal is skipped rather than guessed at: the two catalogues are one `Messages`
 * record at compile time, so the compiler owns that shape and this gate only needs the text.
 */
function catalogueTexts(path) {
  const file = parseFile(path);
  const texts = new Map();
  for (const [name, initializer] of constantsOf(file)) {
    const properties = objectProperties(initializer);
    if (properties === null) continue;
    const values = new Map();
    for (const [key, value] of properties) {
      const unwrapped = unwrap(value);
      if (typescript.isStringLiteral(unwrapped)) values.set(key, unwrapped.text);
    }
    if (values.size > 0) texts.set(name, values);
  }
  return texts;
}

/** The `{ key: "<catalogue key>", ... }` a sentence-table entry resolves to, through identifier indirection. */
function sentenceKeyOf(node, constants) {
  let value = unwrap(node);
  for (let hops = 0; hops < 8 && typescript.isIdentifier(value); hops += 1) {
    const declaration = constants.get(value.text);
    if (declaration === undefined) break;
    value = unwrap(declaration);
  }
  const properties = objectProperties(value);
  const key = properties?.get("key");
  return key === undefined ? null : (stringLiterals(key).find((text) => text.length > 0) ?? null);
}

/** The session phases and the one sentence key each states - `null` is a phase that states none, and it is a
 * declaration all the same: a phase missing from the table is the drift `phase_sentence_not_declared` names. */
function declaredPhaseSentences(file) {
  const constants = constantsOf(file);
  const declaration = constants.get("GAME_PHASE_SENTENCE");
  const table = declaration === undefined ? null : objectProperties(declaration);
  if (table === null) return null;
  const sentences = new Map();
  for (const [phase, node] of table) sentences.set(phase, sentenceKeyOf(node, constants));
  return sentences;
}

/** The string members of an array literal: its own elements, never a string inside one of them. */
function elementsOf(node) {
  const literal = unwrap(node);
  if (!typescript.isArrayLiteralExpression(literal)) return [];
  return literal.elements.flatMap((element) => {
    const value = unwrap(element);
    return typescript.isStringLiteral(value) ? [value.text] : [];
  });
}

/** The cabin kinds, their steps, and the sentence keys each states - all three from one module's declarations. */
function declaredCabin(file) {
  const constants = constantsOf(file);
  const table = (name) => {
    const declaration = constants.get(name);
    return declaration === undefined ? null : objectProperties(declaration);
  };
  const stepsTable = table("CABIN_HANDOFF_ACTIONS");
  const sentenceTable = table("CABIN_HANDOFF_SENTENCE");
  const finish = table("CABIN_HANDOFF_FINISHED_BY");
  if (stepsTable === null || sentenceTable === null || finish === null) return null;
  const presses = new Set(stringLiterals(unionTypeMembers(file, "CabinHandoffPress")));
  const finishes = finish.get("becomes");
  return {
    steps: new Map([...stepsTable].map(([kind, node]) => [kind, elementsOf(node)])),
    sentences: new Map(
      [...sentenceTable].map(([kind, node]) => [
        kind,
        [...(unwrap(node).elements ?? [])]
          .map((entry) => sentenceKeyOf(entry, constants))
          .filter((key) => key !== null),
      ]),
    ),
    presses,
    becomes: finishes === undefined ? null : (stringLiterals(finishes)[0] ?? null),
  };
}

/** Every way a step is named in copy: the label of the control that presses it, or the words of its own menu item. */
function declaredStepLabels(file, catalogues) {
  const declaration = constantsOf(file).get("STEP_LABELS");
  const properties = declaration === undefined ? null : objectProperties(declaration);
  if (properties === null) return null;
  const labels = new Map();
  for (const [step, node] of properties) {
    const value = unwrap(node);
    const fields = objectProperties(value);
    const labelKey = fields?.get("labelKey");
    const phrase = fields?.get("phrase");
    if (labelKey !== undefined) {
      const key = stringLiterals(labelKey)[0];
      labels.set(
        step,
        key === undefined
          ? []
          : [...catalogues.values()].map((texts) => texts.get(key)).filter((text) => typeof text === "string"),
      );
    } else if (phrase !== undefined) {
      const text = stringLiterals(phrase)[0];
      labels.set(step, text === undefined ? [] : [text]);
    } else {
      labels.set(step, []);
    }
  }
  return labels;
}

const finding = (code, detail) => ({ code, detail });

/** One sentence's own words, per catalogue, joined so a match never has to know which language it is reading. */
function sentenceTexts(catalogues, key) {
  const texts = [];
  for (const [name, values] of catalogues) {
    const text = values.get(key);
    if (text !== undefined) texts.push({ locale: name, text });
  }
  return texts;
}

export function checkStateSentences() {
  const findings = [];
  const file = parseFile(SOURCES.lifecycle);
  const phases = stringArray(file, "GAME_SESSION_PHASES") ?? [];
  const phaseSentences = declaredPhaseSentences(file);
  const cabin = declaredCabin(file);
  const catalogues = catalogueTexts(SOURCES.catalogue);
  const labels = declaredStepLabels(file, catalogues);

  const blocked = [];
  if (phaseSentences === null)
    blocked.push(finding("population_empty", "GAME_PHASE_SENTENCE was not read from the lifecycle module"));
  if (cabin === null)
    blocked.push(
      finding(
        "cabin_handoff_finish_not_declared",
        "CABIN_HANDOFF_ACTIONS, CABIN_HANDOFF_SENTENCE and CABIN_HANDOFF_FINISHED_BY are one declaration; at least " +
          "one of them was not read, so no finished handoff can be held to offering no press",
      ),
    );
  if (labels === null) blocked.push(finding("population_empty", "STEP_LABELS was not read, so no step can be named"));
  if (catalogues.size === 0)
    blocked.push(finding("population_empty", "no catalogue was read, so no sentence has any words"));
  if (blocked.length > 0) return { status: "blocked", findings: blocked, examined: 0, naming: 0, cannotWork: 0 };

  // Population: one member per (state, declared sentence). The phases come from the phase list, and their steps from
  // the derivation's own `build(...)` calls - the reader the forward-path gate owns, over the same module.
  const phaseSteps = new Map(phaseMembers().members.map((member) => [member.member, member.actions]));
  const members = [];
  for (const phase of phases) {
    const key = phaseSentences.get(phase) ?? null;
    if (key === null) continue;
    members.push({ axis: "phase", state: phase, steps: phaseSteps.get(phase) ?? [], key });
  }
  for (const [kind, keys] of cabin.sentences)
    for (const key of keys) members.push({ axis: "cabin", state: kind, steps: cabin.steps.get(kind) ?? [], key });

  const declared = new Set([...phaseSentences.keys()]);
  for (const phase of phases)
    if (!declared.has(phase))
      findings.push(
        finding(
          "phase_sentence_not_declared",
          `phase/${phase} is a phase this surface can be in and states no sentence`,
        ),
      );

  // The one press a finished handoff may not offer: the state is reached once the Host's own attachment says she is in
  // this save, so the confirm and both reads have already had their effect.
  if (cabin.becomes === null || !cabin.steps.has(cabin.becomes))
    blocked.push(
      finding(
        "cabin_handoff_finish_not_declared",
        `CABIN_HANDOFF_FINISHED_BY.becomes names ${String(cabin.becomes)}, which is not a cabin state with steps`,
      ),
    );
  else
    for (const step of cabin.steps.get(cabin.becomes))
      if (cabin.presses.has(step))
        findings.push(
          finding(
            "step_offered_for_an_action_that_is_finished",
            `cabin/${cabin.becomes} offers "${step}", a press on a handoff the Host's own attachment says is over: ` +
              `the companion is already in this save, so the press can only be refused`,
          ),
        );

  let naming = 0;
  let cannotWork = 0;
  for (const member of members) {
    const label = `${member.axis}/${member.state}`;
    const texts = sentenceTexts(catalogues, member.key);
    if (texts.length !== catalogues.size) {
      const missing = [...catalogues]
        .filter(([, values]) => values.get(member.key) === undefined)
        .map(([name]) => name);
      findings.push(
        finding(
          "sentence_key_missing",
          `${label} names ${member.key}, and catalogue(s) ${missing.join(", ")} declare no such sentence`,
        ),
      );
      continue;
    }
    const named = [];
    for (const [step, words] of labels)
      if (
        texts.some(({ text }) =>
          words.some((word) => word.length > 0 && text.toLowerCase().includes(word.toLowerCase())),
        )
      )
        named.push(step);
    if (named.length > 0) naming += 1;
    for (const step of named)
      if (!member.steps.includes(step)) {
        cannotWork += 1;
        findings.push(
          finding(
            "sentence_names_a_step_the_phase_does_not_offer",
            `${label} states ${member.key}, which names "${step}", and this state offers ` +
              `${member.steps.length === 0 ? "nothing" : member.steps.join("/")}`,
          ),
        );
      }
    for (const entry of UNPERFORMABLE_STEPS) {
      const carried = texts.filter(({ locale, text }) =>
        locale.startsWith("zh") ? entry.zh.test(text) : entry.en.test(text),
      );
      if (carried.length === 0) continue;
      cannotWork += 1;
      findings.push(
        finding(
          "sentence_names_a_step_the_product_cannot_perform",
          `${label} states ${member.key}, which asks the player to "${entry.step}" (${carried.map(({ locale }) => locale).join(", ")}): ${entry.why}`,
        ),
      );
    }
    if (
      member.steps.length === 0 &&
      named.length === 0 &&
      !UNPERFORMABLE_STEPS.some((entry) =>
        texts.some(({ locale, text }) => (locale.startsWith("zh") ? entry.zh : entry.en).test(text)),
      )
    )
      findings.push(
        finding(
          "sentence_names_no_step_but_offers_none",
          `${label} offers no step at all, and ${member.key} names none either: a dead end stated as if it were a choice`,
        ),
      );
  }

  if (members.length === 0)
    blocked.push(
      finding(
        "population_empty",
        `examined ${phases.length} phase(s) and ${cabin.sentences.size} cabin kind(s) and found no declared sentence, so ` +
          `this gate agreed with itself`,
      ),
    );
  if (blocked.length > 0)
    return { status: "blocked", findings: [...blocked, ...findings], examined: members.length, naming, cannotWork };

  return {
    status: findings.length === 0 ? "passed" : "failed",
    findings,
    examined: members.length,
    naming,
    cannotWork,
    members,
  };
}

function main() {
  const verdict = checkStateSentences();
  console.log(
    `[state-sentences] sentences examined ${verdict.examined} · naming a step ${verdict.naming} · naming a step that ` +
      `cannot work ${verdict.cannotWork}`,
  );
  for (const member of verdict.members ?? [])
    console.log(
      `[state-sentences] ${member.axis}/${member.state} -> ${member.key} (steps: ${member.steps.join("/") || "none"})`,
    );
  for (const entry of UNPERFORMABLE_STEPS)
    console.log(`[state-sentences] unperformable step declared: "${entry.step}" - ${entry.why}`);
  for (const entry of verdict.findings) console.log(`[state-sentences] ${entry.code}: ${entry.detail}`);
  const failed = (code) => verdict.findings.some((entry) => entry.code === code);
  console.log(
    JSON.stringify({
      gate: "state-sentences",
      status: verdict.status,
      examined: verdict.examined,
      counts: { naming: verdict.naming, cannotWork: verdict.cannotWork },
      checks: [
        { id: "sentence_declared", status: failed("sentence_key_missing") ? "failed" : "passed" },
        {
          id: "sentence_names_a_step_the_state_offers",
          status: failed("sentence_names_a_step_the_phase_does_not_offer") ? "failed" : "passed",
        },
        {
          id: "sentence_names_no_unperformable_step",
          status: failed("sentence_names_a_step_the_product_cannot_perform") ? "failed" : "passed",
        },
        {
          id: "no_dead_end_stated_as_a_choice",
          status: failed("sentence_names_no_step_but_offers_none") ? "failed" : "passed",
        },
        {
          id: "finished_handoff_offers_no_press",
          status: failed("step_offered_for_an_action_that_is_finished") ? "failed" : "passed",
        },
        {
          id: "every_phase_states_its_sentence",
          status: failed("phase_sentence_not_declared") ? "failed" : "passed",
        },
      ],
      findings: verdict.findings,
    }),
  );
  if (verdict.status === "blocked")
    process.exit(blockedOnEmptyPopulation("state-sentences", "this gate examined nothing"));
  process.exit(verdict.findings.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
