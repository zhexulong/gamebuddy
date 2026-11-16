#!/usr/bin/env node
/**
 * Persona examples: every behaviour a shipped example demonstrates is tied to the sentence that permits or forbids it.
 *
 * WHY (measured 2026-11-16). The card's `system_prompt` gained a permission on 2026-11-12 (`f731fbb9`):
 *
 *   `动作回执是内部认知，绝不翻成台词广播；但对手头东西的评价、对工具的嫌弃不用回执，直接说。`
 *
 * An uncommitted edit deleted that second clause. Afterwards `git grep '对工具的嫌弃|评价'` found it in NO file - not
 * `default-companion/card.json`, not `amber-chat.json`, not `amber-game.json`, not `amber-deepseek-v4.1.json`, not
 * either world book, not any gate - while the card's own `mes_example` went on demonstrating both behaviours it
 * permitted (`这泥巴比水泥还黏靴子`, `震得我手腕生疼，火星子直冒`). The only thing that caught it was a lane reading the
 * diff, and the answer to "what refuses this next time" was nothing. This gate is that refusal.
 *
 * THE PROPERTY. For every behaviour a shipped example exhibits, a sentence somewhere in the persona corpus either
 * permits it or forbids it. The corpus is the card's rule fields, the preset documents' `prompts[*].content`, and every
 * world book's `alwaysOnPremise` + `entries[*].content` - all four sources the persona is assembled from, which is why a
 * permission cannot live only in the card.
 *
 * WHAT IS DERIVED AND WHAT IS DECLARED, because the split is the whole design and it is the thing a reader will want to
 * argue with:
 *
 *   derived  the EXAMPLE POPULATION. A directory scan of `assets/tavern/presets/**` finds every `card.json`; each one
 *            contributes every `{{char}}` turn it ships, parsed out of `data.mes_example` (the CCv2 string this card
 *            uses) or `data.mes_examples` (the array form), split on `<START>` and on newlines, keyed by the card that
 *            ships it. A new example, or a second card, joins the population with no edit anywhere.
 *   derived  the CLAIM CORPUS, the same scan: `card.json`'s rule fields, every other preset document's prompt contents,
 *            and every `worldbook*.json`'s premise and entries. The census line counts the fields so a file that stops
 *            contributing prose is visible rather than absent.
 *   derived  the LOCATION of each claim sentence, so a finding prints `file field: sentence` and no declared path goes
 *            stale when a clause moves between files.
 *   declared `tools/lib/persona-behaviour-vocabulary.mjs`: which behaviour a fragment of her speech exhibits, and the
 *            sentence that permits or forbids it. That file's docblock carries the limit; this one carries the machinery.
 *
 * Splitting Chinese dialogue into behaviours is a semantic judgement, so the split cannot be derived, and a declared
 * table is a list - which in this repository is a test, not a gate. What makes it a gate is that the list is closed
 * from both ends and expires. The four findings are the four cells of a truth table over (is this row's sample still
 * shipped?) x (is this row's sentence still in the corpus?), so every row lands in exactly one of them:
 *
 *   sample shipped, sentence shipped   the row holds; printed with its count
 *   sample shipped, sentence gone      `example_demonstrates_a_behaviour_no_claim_permits:<sample>:<behaviour>:<sentence>`
 *                                      THE INCIDENT. The card still shows the behaviour and nothing allows or bans it.
 *   sample gone,    sentence shipped   `behaviour_claim_unmatched:<behaviour>:<sentence>` - the corpus makes a promise
 *                                      the examples no longer demonstrate. Add an example or drop the sentence.
 *   sample gone,    sentence gone      `behaviour_claim_stale:<behaviour>:<sample>` - the row is a fossil; delete it.
 *
 * The sample is the verbatim FRAGMENT of an example line that carries the behaviour, not the whole line, because one
 * line carries two or three behaviours (`拔完了，沉得跟秤砣似的，这泥巴比水泥还黏靴子。` files a receipt, evaluates the
 * object and complains about the mud) and a finding has to name which. Two more findings close the population's other
 * ends: `example_unclassified:<example>` for a turn no row covers - the arm that makes the population derived rather
 * than listed, since appending an example to the card reds it - and `behaviour_declaration_invalid:<behaviour>:<mode>`
 * for a `mode` outside `permitted` / `forbidden`, which keeps the closed pair a closed pair.
 *
 * WHAT IT DOES NOT ADJUDICATE. Whether a row's behaviour name is the right reading of the line. Nor whether a
 * `forbidden` row is contradicted by the examples that demonstrate it: `files_an_action_receipt` is banned by
 * `动作回执是内部认知，绝不翻成台词广播` and demonstrated by three shipped examples, which is a real tension in the card
 * and a product decision rather than a gate's verdict. The table records the polarity so the reader meets it as a fact.
 *
 * WHAT IS NOT READ, by name, so the exclusion is visible rather than silent: `first_mes` and `alternate_greetings` are
 * authored OPENINGS shown once before the player speaks, not samples of how she answers him; `creator_notes`, `tags`,
 * `extensions` and the sampler block are metadata and binding, not conduct; `data.character_book` duplicates
 * `default-companion/worldbook.json` entry for entry, and one fact gets one spelling.
 *
 * BLOCKED, NEVER GREEN. No card, no example turn, an empty vocabulary, or a corpus that yielded no prose is exit 2 with
 * a named reason - a gate whose population is empty agrees with itself. The census prints `cards` / `examples` /
 * `behaviours` / `findings` and one line per behaviour with its example count, so `0 findings` never stands alone.
 *
 * WHAT CALLS IT. `check:persona-example-behaviours` in `package.json`, which puts it in the population
 * `tools/lib/gate-population.mjs` derives; the harness conformance suite then runs it and reads this report. Read-only
 * over `assets/tavern/**` - the corpus belongs to its owner, and this gate never writes it.
 *
 * red-proof: history  `6107a8dd`, the card that shipped before the permission was written: its examples demonstrate
 *                     `这泥巴比水泥还黏靴子` and `震得我手腕生疼` while no sentence in the corpus states that either is
 *                     said, so the gate exits 1 with
 *                     `example_demonstrates_a_behaviour_no_claim_permits:这泥巴比水泥还黏靴子:evaluates_the_thing_in_hand:…`
 *                     and `behaviour_claim_unmatched:comforts_with_her_own_scar:…`, both replayed out of the object store
 *                     (tools/check-persona-example-behaviours.test.mjs)
 * red-proof: inject   the incident itself, on a copy of the shipped presets: deleting
 *                     `对手头东西的评价、对工具的嫌弃不用回执，直接说` from `data.system_prompt` exits 1 naming all five
 *                     anchored demonstrations, and writing the bytes back exits 0. Appending a `{{char}}` turn carrying
 *                     no declared sample exits 1 with `example_unclassified:早啊，粥在锅里温着，自己盛。`, which is the
 *                     population being derived rather than listed (tools/check-persona-example-behaviours.test.mjs)
 */

export const gateDeclaration = {
  id: "check-persona-example-behaviours",
  domain: "product",
  tier: "l2",
  kind: "contract",
};

import { globSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BEHAVIOURS, CLAIM_MODES } from "./lib/persona-behaviour-vocabulary.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The corpus. A directory scan of it is the population: no card, preset or world book is named below. */
const PRESETS_GLOB = "assets/tavern/presets/**/*.json";

/** The finding this gate exists for: an example demonstrates a behaviour nothing in the corpus permits or forbids. */
export const VIOLATION = "example_demonstrates_a_behaviour_no_claim_permits";

/**
 * The card's rule fields. `mes_example`/`mes_examples` are the population, `first_mes`/`alternate_greetings` are
 * openings, and `creator_notes`/`tags`/`extensions`/`character_book` are metadata, binding and lore - see the header.
 */
const CARD_RULE_FIELDS = Object.freeze([
  "description",
  "personality",
  "scenario",
  "system_prompt",
  "post_history_instructions",
]);

/** The two fields a card ships its examples in; the array form is the CCv2 alternative to the string. */
const CARD_EXAMPLE_FIELDS = Object.freeze(["mes_example", "mes_examples"]);

const isWorldBook = (name) => /^worldbook.*\.json$/u.test(name);

/**
 * One card's example turns, `{{char}}` only: a `{{user}}:` line is the player speaking, so it is the prompt a behaviour
 * answers and never the behaviour. The array form is joined with newlines so both shapes go through one split.
 */
export function exampleTurns(value) {
  const blocks = Array.isArray(value) ? value.map((entry) => String(entry)) : [String(value)];
  const turns = [];
  for (const line of blocks.join("\n").split(/\r?\n/u)) {
    const match = /^\s*\{\{char\}\}\s*[:：]\s*(.*)$/u.exec(line);
    const text = match === null ? "" : match[1].trim();
    if (text.length > 0) turns.push(text);
  }
  return turns;
}

/**
 * Every example turn the corpus ships, as `{ card, text }`. A path that is not JSON, or a document with no example
 * field, contributes nothing - which is named by the caller rather than passed over.
 */
export function readExamples(documents) {
  const turns = [];
  for (const { path, document } of documents) {
    const data = document?.data ?? document;
    const name = basename(path);
    if (name !== "card.json") continue;
    for (const field of CARD_EXAMPLE_FIELDS)
      for (const text of exampleTurns(data?.[field] ?? "")) turns.push({ card: path, text });
  }
  return turns;
}

/**
 * The claim corpus: `{ location, text }` for every field that can state a rule. The location is `file field`, which is
 * what a finding quotes beside the sentence.
 */
export function readClaimCorpus(documents) {
  const corpus = [];
  for (const { path, document } of documents) {
    const name = basename(path);
    if (name === "card.json") {
      for (const field of CARD_RULE_FIELDS)
        if (typeof document?.data?.[field] === "string")
          corpus.push({ location: `${path} ${field}`, text: document.data[field] });
      continue;
    }
    if (isWorldBook(name)) {
      const premise = document?.alwaysOnPremise;
      if (typeof premise === "string") corpus.push({ location: `${path} alwaysOnPremise`, text: premise });
      (Array.isArray(document?.entries) ? document.entries : []).forEach((entry, index) => {
        if (typeof entry?.content === "string")
          corpus.push({ location: `${path} entries.${index}.content`, text: entry.content });
      });
      continue;
    }
    (Array.isArray(document?.prompts) ? document.prompts : []).forEach((prompt, index) => {
      if (typeof prompt?.content === "string" && prompt.content.trim().length > 0)
        corpus.push({ location: `${path} prompts.${index}.content`, text: prompt.content });
    });
  }
  return corpus;
}

const shows = (text, sample) => text.includes(sample);

/**
 * The rule, as a function of the three facts it reads - the declared rows, the derived turns and the derived corpus - so
 * every arm can be driven without a card. Returns the findings and, per row, the count and location a reader wants.
 *
 * The four cells of (sample shipped?) x (sentence shipped?) are disjoint by construction, so one row cannot report two
 * of them; `covered` counts turns, not samples, so a behaviour demonstrated twice on one line does not inflate it.
 */
export function judgeBehaviours({ behaviours, turns, corpus }) {
  const findings = [];
  const rows = [];
  for (const row of behaviours) {
    const label = String(row?.behaviour ?? "");
    if (!CLAIM_MODES.includes(row?.mode)) findings.push(`behaviour_declaration_invalid:${label}:${String(row?.mode)}`);
    const sentence = String(row?.claim ?? "");
    const claimAt = corpus.find((field) => shows(field.text, sentence)) ?? null;
    const samples = (Array.isArray(row?.samples) ? row.samples : []).map((sample) => String(sample));
    const shipped = samples.filter((sample) => turns.some((turn) => shows(turn.text, sample)));
    if (sentence.trim().length === 0) findings.push(`behaviour_declaration_invalid:${label}:claim`);
    if (shipped.length === 0) {
      if (claimAt === null) findings.push(`behaviour_claim_stale:${label}:${samples.join("|")}`);
      else findings.push(`behaviour_claim_unmatched:${label}:${sentence}`);
    } else if (claimAt === null) {
      for (const sample of shipped) findings.push(`${VIOLATION}:${sample}:${label}:${sentence}`);
    }
    rows.push({
      behaviour: label,
      mode: String(row?.mode),
      claim: sentence,
      claimAt: claimAt === null ? null : claimAt.location,
      examples: shipped.length,
    });
  }
  for (const turn of turns)
    if (!behaviours.some((row) => (row?.samples ?? []).some((sample) => shows(turn.text, String(sample)))))
      findings.push(`example_unclassified:${turn.text}`);
  return { findings: [...new Set(findings)], rows };
}

const blocked = (reason) => ({ status: "blocked", reason, lines: [], findings: [] });

/** Every `*.json` the corpus ships on disk, parsed; an unreadable document is a blocked reading, not a silence. */
function readDocuments(root) {
  const documents = [];
  const unreadable = [];
  for (const path of globSync(PRESETS_GLOB, { cwd: root }).sort()) {
    const location = path.replace(/\\/gu, "/");
    try {
      documents.push({ path: location, document: JSON.parse(readFileSync(join(root, location), "utf8")) });
    } catch (error) {
      unreadable.push(`${location}: ${error.message}`);
    }
  }
  return { documents, unreadable };
}

export function runCheck({ root = REPOSITORY_ROOT, behaviours = BEHAVIOURS } = {}) {
  const { documents, unreadable } = readDocuments(root);
  if (unreadable.length > 0) return blocked(`persona_example_unreadable:${unreadable.join("; ")}`);
  const cards = documents.filter(({ path }) => basename(path) === "card.json");
  if (cards.length === 0) return blocked(`persona_example_population_empty:no card.json under ${PRESETS_GLOB}`);
  const turnList = readExamples(documents);
  if (turnList.length === 0) return blocked("persona_example_population_empty:no {{char}}: example turn on any card");
  if (behaviours.length === 0) return blocked("persona_behaviour_vocabulary_empty");
  const corpus = readClaimCorpus(documents);
  if (corpus.length === 0) return blocked("persona_claim_corpus_empty");
  const { findings, rows } = judgeBehaviours({ behaviours, turns: turnList, corpus });
  const covered = turnList.filter((turn) =>
    behaviours.some((row) => (row?.samples ?? []).some((sample) => shows(turn.text, String(sample)))),
  ).length;
  const lines = [
    `files examined ${documents.length} · cards ${cards.length} · examples ${turnList.length} · covered ${covered} · claim fields ${corpus.length} · behaviours ${behaviours.length} · findings ${findings.length}`,
    ...rows.map(
      (row) =>
        `  ${row.behaviour} ${row.mode} · examples ${row.examples} · ${row.claimAt === null ? "no sentence" : row.claimAt}: ${row.claim}`,
    ),
    ...findings,
  ];
  return {
    status: findings.length > 0 ? "failed" : "passed",
    reason: null,
    lines,
    findings,
    rows,
    examples: turnList,
    cards: cards.length,
    covered,
    claimFields: corpus.length,
    behaviours: behaviours.length,
  };
}

export function parseArgs(argv) {
  const index = argv.indexOf("--root");
  return { root: index >= 0 && argv[index + 1] !== undefined ? resolve(argv[index + 1]) : REPOSITORY_ROOT };
}

/** The five rules the report enumerates, in the order the truth table above reads them. */
const RULES = Object.freeze([
  VIOLATION,
  "behaviour_claim_unmatched",
  "behaviour_claim_stale",
  "example_unclassified",
  "behaviour_declaration_invalid",
]);

/**
 * The self-verification report, one line of JSON, because the harness suite reads a gate by running it: `examined` is
 * the example turns this run read, so `passed` beside a zero cannot be mistaken for a measurement. A run that could
 * not measure prints `examined 0` with the reason, which `tools/lib/assert-non-vacuous.mjs` reads as `not_measured`
 * rather than as a pass.
 */
export function reportOf(result) {
  const codes = result.findings.map((finding) => finding.split(":")[0]);
  return {
    gate: "persona_example_behaviour_claim/v1",
    status: result.status,
    examined: result.examples?.length ?? 0,
    ...(result.status === "blocked" ? { allowEmpty: String(result.reason) } : {}),
    cards: result.cards ?? 0,
    covered: result.covered ?? 0,
    claimFields: result.claimFields ?? 0,
    behaviours: result.behaviours ?? 0,
    findings: result.findings.length,
    checks: RULES.map((rule) => ({
      id: rule,
      status: codes.includes(rule) ? "failed" : "passed",
      detail: `${codes.filter((code) => code === rule).length} member(s)`,
    })),
  };
}

function main(argv) {
  const options = parseArgs(argv);
  let result;
  try {
    result = runCheck(options);
  } catch (error) {
    console.log(`persona_example_not_measured:${error.message}`);
    process.exitCode = 2;
    return;
  }
  for (const line of result.lines) console.log(line);
  if (result.status === "blocked") {
    console.log(result.reason);
    console.log(JSON.stringify(reportOf(result)));
    process.exitCode = 2;
    return;
  }
  if (result.status === "failed") {
    console.log(
      "persona_example_behaviour_uncovered: every behaviour a shipped example demonstrates needs a sentence in the persona corpus that permits or forbids it; re-tie the row in tools/lib/persona-behaviour-vocabulary.mjs to the sentence that survived, or restore the sentence.",
    );
    console.log(JSON.stringify(reportOf(result)));
    process.exitCode = 1;
    return;
  }
  console.log("persona_example_behaviours_all_claimed");
  console.log(JSON.stringify(reportOf(result)));
  process.exitCode = 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2));
