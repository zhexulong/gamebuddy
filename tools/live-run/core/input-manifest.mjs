/**
 * The exact input a run handed the model, written beside its result so two runs can be compared line by line.
 *
 * WHY THIS EXISTS (measured 2026-11-14). `round53` -> `round54` changed her behaviour completely - 0 submitted plans
 * against 10 - and no artifact held the input that explains it. The prompt, the conduct rules, the tool descriptions,
 * the vocabulary rows and the world block were only reconstructible by hand from a session jsonl, and that
 * reconstruction produced three wrong causes in one day (`isInBed` read as a sleep state, `revision` read as a world
 * version, a submission receipt read as a `plan_shape` query). Each time the answer was in the input; nobody diffed it.
 *
 * WHAT IT READS: the run's own Pi session record - the runtime's record of what it DELIVERED, never what this tree would
 * deliver today. `message.sections` carries the runtime's own named prompt sections (`preamble`, `cwd`,
 * `magic_context`); the preamble is then split by its own structure into the shared floor, one section per conduct rule
 * (labelled by the id the rule's declaration gives it, not by a line offset) and the authored remainder; every
 * `toolsAdded` entry is a tool section in delivery order, so a tool mounted mid-run is part of the input from the moment
 * it mounts; the first delivery's `<world-state>` / `<world-facts>` blocks are recorded as delivered; and the
 * `model_change` entry supplies the provider and model id.
 *
 * WHY NO HASHES: a digest cannot tell a reader which line moved, and this repository's rules refuse ritualistic digests.
 * A section is the exact text, so `tools/compare-run-inputs.mjs` prints the line that changed under the section's name.
 *
 * WHY THE SPLIT USES THE DECLARATION: `tools/check-game-surface-conduct-classes.mjs` reads the floor's composed rule
 * list by declaration name and pairs each rule with its class table positionally. The ids therefore exist already, and
 * a rule added tomorrow is labelled without an edit here. The one assumption is that the composed conduct block is the
 * first blank-line-delimited block whose line count equals the number of declared rules; when no block matches, the
 * whole preamble is recorded as `prompt:preamble` and `prompt_conduct_block_unmatched` says why it was not split. A
 * manifest that named 19 offsets as 19 rules would be worse than one that admits it could not.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditConductClasses } from "../../check-game-surface-conduct-classes.mjs";

export const INPUT_MANIFEST_SCHEMA = "gamebuddy-run-input-manifest/v1";

/** The suffix a result bundle carries, and the suffix the manifest beside it carries. */
const RESULT_SUFFIX = ".result.json";
const MANIFEST_SUFFIX = ".input-manifest.json";

/** The tool whose description carries the vocabulary block: the plan builder's family rows. */
const PLAN_WORK_TOOL_NAME = "stardew_plan_work";

/** A vocabulary row: a family id, a colon, then whatever the declaration gives each action. */
const VOCABULARY_ROW = /^[a-z][a-z0-9_]*: /u;

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * The manifest that belongs beside a result bundle: the result's own stem, the manifest's suffix.
 *
 * `_<run>.result.json` becomes `_<run>.input-manifest.json`; any other `.json` result name keeps its stem too, because the
 * runner's result path is an environment binding and an operator-set name is still a result. Anything that is not a
 * `.json` file is refused rather than guessed at, and the caller answers that refusal by name instead of throwing out of
 * the assembly that is writing the run's only artifact.
 */
export function inputManifestPathForResult(resultPath) {
  if (typeof resultPath !== "string" || !resultPath.endsWith(".json"))
    throw new Error(`not a result bundle name: ${String(resultPath)}`);
  const stem = resultPath.endsWith(RESULT_SUFFIX)
    ? resultPath.slice(0, -RESULT_SUFFIX.length)
    : resultPath.slice(0, -5);
  return `${stem}${MANIFEST_SUFFIX}`;
}

/** The rule ids the delivered conduct blocks are labelled with, in the order the model reads them. */
export function declaredConductRuleIds({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  return auditConductClasses({ root: repositoryRoot }).rules.map((rule) => rule.id);
}

/** Every entry of a Pi session record, with a half-written last line skipped rather than repaired. */
export function readSessionEntries(sessionPath) {
  if (typeof sessionPath !== "string" || sessionPath.length === 0) return null;
  let raw;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return null;
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}

/** A message's text, whether the runtime stored one string or the parts of a multi-part content array. */
function messageText(message) {
  const content = message?.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** The blank-line-delimited blocks of a text, as index ranges into its lines. */
function blankDelimitedBlocks(lines) {
  const blocks = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().length === 0) {
      current = null;
      continue;
    }
    if (current === null) {
      current = { from: index, to: index };
      blocks.push(current);
    }
    current.to = index;
  }
  return blocks;
}

/**
 * The preamble, split by its own structure: the floor, one section per conduct rule, and the authored remainder.
 *
 * The conduct block is found by its length against the declaration; every rule then takes the id at its own position,
 * which is the pairing the conduct-class gate already asserts between the composed list and the class tables.
 *
 * IT IS THE PREAMBLE'S FIRST BLOCK, AND THIS READER USED TO REFUSE THE FIRST ONE. `buildCompanionSystemPrompt` pushes
 * the surface block first (its own doc says why: the surface is what the request is ABOUT), so the six composed rules
 * arrive as block 0 - and the search skipped `index > 0` and reported `prompt_conduct_block_unmatched:6_declared_rules`
 * on every real run while the suite stayed green, because its fixture put two identity blocks above the conduct block
 * instead of below it from the assembly. Measured 2026-11-18 (`round73`): the delivered preamble's block 0 is six
 * lines, block 0's lines are the six rules, and the manifest named none of them.
 */
export function preambleSections(preamble, { conductIds, problems }) {
  const lines = preamble.split("\n");
  const blocks = blankDelimitedBlocks(lines);
  if (blocks.length === 0) return [];
  const conductIndex =
    conductIds.length === 0 ? -1 : blocks.findIndex((block) => block.to - block.from + 1 === conductIds.length);
  if (conductIndex < 0) {
    problems.push(`prompt_conduct_block_unmatched:${String(conductIds.length)}_declared_rules`);
    return [{ id: "prompt:preamble", text: preamble.trim() }];
  }
  const conduct = blocks[conductIndex];
  const sections = [];
  const floor = lines.slice(0, conduct.from).join("\n").trim();
  if (floor.length > 0) sections.push({ id: "prompt:floor", text: floor });
  conductIds.forEach((id, offset) => sections.push({ id: `prompt:conduct:${id}`, text: lines[conduct.from + offset] }));
  const authored = lines
    .slice(conduct.to + 1)
    .join("\n")
    .trim();
  if (authored.length > 0) sections.push({ id: "prompt:authored", text: authored });
  return sections;
}

/** The runtime's own named prompt sections, with the preamble split inside its own key. */
function promptSections(systemMessage, { conductIds, problems }) {
  const sections = [];
  for (const [name, text] of Object.entries(systemMessage?.sections ?? {})) {
    if (typeof text !== "string") continue;
    if (name === "preamble") sections.push(...preambleSections(text, { conductIds, problems }));
    else sections.push({ id: `prompt:${name}`, text });
  }
  return sections;
}

/** The longest run of vocabulary rows in a description: the family list the plan builder publishes. */
function vocabularyBlock(description) {
  let best = null;
  let run = [];
  for (const line of description.split("\n")) {
    if (!VOCABULARY_ROW.test(line)) {
      run = [];
      continue;
    }
    run.push(line);
    if (best === null || run.length > best.length) best = [...run];
  }
  return best === null ? null : best.join("\n");
}

/**
 * Every tool the run was handed, in delivery order, each with its full description as delivered.
 *
 * The population is every `toolsAdded` list in the session record, not just the first: `round54` received
 * `stardew_action_program_status` and `stardew_action_program_events` after its first submission while `round53` never
 * did, and that is an input difference a comparison of the first system message alone would have reported as none.
 */
function toolSections(systemMessages, { problems }) {
  const sections = [];
  const delivered = new Set();
  for (const entry of systemMessages) {
    for (const tool of entry.message.toolsAdded ?? []) {
      if (typeof tool?.name !== "string" || delivered.has(tool.name)) continue;
      delivered.add(tool.name);
      sections.push({ id: `tool:${tool.name}`, text: typeof tool.description === "string" ? tool.description : "" });
    }
  }
  const planWork = sections.find((section) => section.id === `tool:${PLAN_WORK_TOOL_NAME}`);
  if (planWork === undefined) {
    problems.push(`plan_work_tool_not_delivered:${PLAN_WORK_TOOL_NAME}`);
    return sections;
  }
  const vocabulary = vocabularyBlock(planWork.text);
  if (vocabulary === null) {
    problems.push(`tool_vocabulary_block_not_found:${PLAN_WORK_TOOL_NAME}`);
    return sections;
  }
  sections.splice(sections.indexOf(planWork) + 1, 0, {
    id: `tool:${PLAN_WORK_TOOL_NAME}:vocabulary`,
    text: vocabulary,
  });
  return sections;
}

/** The first `<world-state>` and `<world-facts>` blocks as delivered, tags included. */
function deliverySections(entries, { problems }) {
  const delivery = entries.find(
    (entry) =>
      entry?.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message).includes("<world-state>"),
  );
  if (delivery === undefined) {
    problems.push("world_state_not_delivered");
    return [];
  }
  const text = messageText(delivery.message);
  const sections = [];
  for (const block of ["world-state", "world-facts"]) {
    const found = new RegExp(`<${block}>[\\s\\S]*?</${block}>`, "u").exec(text)?.[0];
    if (found === undefined) problems.push(`delivery_block_malformed:${block}`);
    else sections.push({ id: `delivery:${block}:first`, text: found });
  }
  return sections;
}

/** The provider and model id the runtime recorded for this run. */
function runtimeSections(entries, { problems }) {
  const change = entries.find((entry) => entry?.type === "model_change");
  if (change === undefined || typeof change.modelId !== "string") {
    problems.push("model_change_not_recorded");
    return [];
  }
  const sections = [{ id: "runtime:model", text: change.modelId }];
  if (typeof change.provider === "string" && change.provider.length > 0)
    sections.push({ id: "runtime:provider", text: change.provider });
  return sections;
}

/**
 * The input manifest for one session record: `{schema, session, model, provider, sections, problems}`.
 *
 * `sections` is the delivered input, one entry per named section, each holding the exact text. `problems` names every
 * section this could not label or find, so a reader can tell "this input did not contain it" from "the reader missed
 * it" - the two answer different questions about a run.
 */
export function buildInputManifest({ sessionPath, repositoryRoot = REPOSITORY_ROOT } = {}) {
  const entries = readSessionEntries(sessionPath);
  if (entries === null) throw new Error(`session record unreadable: ${String(sessionPath)}`);
  const problems = [];
  const conductIds = declaredConductRuleIds({ repositoryRoot });
  const systemMessages = entries.filter((entry) => entry?.type === "message" && entry.message?.role === "system");

  const sections = [
    ...(systemMessages.length === 0 ? [] : promptSections(systemMessages[0].message, { conductIds, problems })),
    ...toolSections(systemMessages, { problems }),
    ...deliverySections(entries, { problems }),
    ...runtimeSections(entries, { problems }),
  ];

  const model = sections.find((section) => section.id === "runtime:model")?.text ?? null;
  const provider = sections.find((section) => section.id === "runtime:provider")?.text ?? null;
  return Object.freeze({
    schema: INPUT_MANIFEST_SCHEMA,
    session: sessionPath,
    recordedAtMs: Date.now(),
    model,
    provider,
    declaredConductRules: conductIds.length,
    sections,
    problems,
  });
}

/** How many sections a manifest holds, and how many bytes of delivered text they are. */
export function measureManifest(manifest) {
  const sections = Array.isArray(manifest?.sections) ? manifest.sections : [];
  const bytes = sections.reduce((sum, section) => sum + Buffer.byteLength(String(section.text), "utf8"), 0);
  return { sections: sections.length, bytes };
}

/**
 * Write the manifest beside the run's result, or say by name why there is none.
 *
 * A manifest with zero sections is REFUSED rather than written empty: an empty file reads as "this run was handed
 * nothing", which is the opposite of the truth about a run whose record could not be bound or parsed. The same holds
 * for a result path this cannot place a manifest beside: that is a `not_measured` answer, never an exception out of the
 * assembly whose remaining job is to publish the run's result.
 */
export function writeInputManifest({ sessionPath, resultPath, log = (line) => process.stdout.write(`${line}\n`) }) {
  if (typeof sessionPath !== "string" || sessionPath.length === 0)
    return Object.freeze({
      state: "not_measured",
      reasonCode: "session_record_not_bound",
      path: null,
      sections: 0,
      bytes: 0,
    });
  let manifestPath;
  try {
    manifestPath = inputManifestPathForResult(resultPath);
  } catch {
    return Object.freeze({
      state: "not_measured",
      reasonCode: "input_manifest_path_underived",
      path: null,
      sections: 0,
      bytes: 0,
    });
  }
  const manifest = buildInputManifest({ sessionPath });
  const { sections, bytes } = measureManifest(manifest);
  if (sections === 0)
    return Object.freeze({ state: "not_measured", reasonCode: "input_manifest_empty", path: null, sections, bytes });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`, "utf8");
  log(`input sections ${String(sections)} · bytes ${String(bytes)}`);
  return Object.freeze({
    state: "written",
    reasonCode: null,
    path: manifestPath,
    sections,
    bytes,
    problems: manifest.problems,
  });
}

/**
 * `node tools/live-run/core/input-manifest.mjs --session <session.jsonl> --result <result.json>`
 *
 * The runner writes the manifest on every path through its own result assembly; this entry point exists for a record
 * whose run predates the manifest, so a historical pair can be compared by the same builder rather than by a second
 * reading written for the occasion. The result file need not exist: its PATH is what names the manifest beside it.
 */
function main(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index < 0 ? null : argv[index + 1];
  };
  const sessionPath = value("--session");
  const resultPath = value("--result");
  if (sessionPath === null || resultPath === null) {
    process.stderr.write("input-manifest: --session <session.jsonl> --result <result.json>\n");
    process.exitCode = 2;
    return;
  }
  const answer = writeInputManifest({ sessionPath, resultPath });
  if (answer.state !== "written") {
    process.stderr.write(`input_manifest_not_measured:${answer.reasonCode}\n`);
    process.exitCode = 2;
    return;
  }
  for (const problem of answer.problems) process.stderr.write(`input_manifest_problem:${problem}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
