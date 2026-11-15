#!/usr/bin/env node
/**
 * Gate: refusal_names_an_action_the_catalog_lacks/<code>/<action> - a refusal that names an action must name one the
 * catalog declares, and a token that names a HOLD must not read as an action name.
 *
 * WHY (measured, round60). The engine's bed prompt stood on screen, the pump held the `sleep` node with
 * `held_by=dialogue_box;answer_it=answer_dialogue`, `answer_dialogue` refused the one answer with
 * `native_sleep_prompt_owned_by_advance_day`, and the retried `sleep` was refused `body_owned_by_day_advance`. Three
 * sentences, no exit - because `advance_day` is an action id this catalog does not have (it was renamed `sleep`) and the
 * two codes that name it, plus the remedy that named a route the refusal forbids, kept the night from beginning.
 *
 * THE PROPERTY, and the three positions an action id can occupy. Each position is declared here because it is where the
 * product tells a reader to DISPATCH something or says which execution owns it:
 *
 *   1. ACTION POSITION - a `key=value` field whose key is one of ACTION_POSITION_KEYS: `answer_it`, `dismiss_it`,
 *      `dispatch_it`, `next_action`, `retry_action` (remedies), and `owning_action`, `owner_action` (ownership). A value
 *      that is CONCATENATED rather than literal (`"...;answer_it=" + catalog.DayCrossingActionId`) is reported as
 *      `unmeasured`, never as clean: this gate cannot read it, and a claim it cannot read is not a claim it checked.
 *      `unknown` is the one non-action value, because the Mod publishes it when an uninitialised slot is described.
 *   2. OWNER POSITION - a code shaped `<prefix>_owned_by_<owner>` whose `<prefix>` is NOT `body`: the owner of a body or
 *      of a prompt is an execution of an action, so `<owner>` must be a catalog id.
 *   3. HOLD KIND POSITION - a code shaped `body_owned_by_<owner>`. That family names the KIND of hold the actor's body is
 *      in (navigation, ride, activity...), and a kind is ONE word, so a multi-word owner there claims to be an action id
 *      and must be one the catalog declares. This is what `day_advance` fails: it is `advance_day` word-swapped, the same
 *      missing action as the refusal above, and the family's single-word convention is the ONLY thing that lets a reader
 *      tell a hold kind from an action id in one glance.
 *
 * POPULATION. Derived, never listed: every `.cs` file under `integrations/stardew` that ships (comments stripped, so a
 * quoted transcript of a defect is not read as the defect) x the catalog's own vocabulary
 * (`tools/lib/stardew-published-action-registry.mjs`'s `readStardewActionIds`, which fails closed on an empty catalog)
 * x the Mod's declared hold kinds (`internal const string BodyOwnedBy*`). A new refusal, a new hold kind and a new
 * action all join by existing.
 *
 * VERDICT. `codes examined N · name an action M · exists K · missing J · unmeasured U`, exit 1 on any missing name, exit
 * 2 when the population is empty - zero codes examined agrees with itself and is a blocked reading, never a clean tree.
 *
 * The falsifier ledger and the red proof live in `tools/check-refusal-action-names.test.mjs`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: prose. A `hint:` sentence is not a closed vocabulary, and this gate would rather say
 * it does not read hints than guess which backticked word is an action id. The advice that MATTERS is the evidence a
 * hold carries (`answer_it=`), and that is position 1.
 *
 * Usage:
 *   node tools/check-refusal-action-names.mjs            # the repository's tree
 *   node tools/check-refusal-action-names.mjs <dir>      # another scope, e.g. a pre-fix checkout
 *   node tools/check-refusal-action-names.mjs --json
 */

export const gateDeclaration = {
  id: "check-refusal-action-names",
  domain: "product",
  tier: "l0",
  kind: "contract",
};

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readStardewActionIds } from "./lib/stardew-published-action-registry.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCES = Object.freeze({
  modRoot: "integrations/stardew",
  catalog: "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
  holdKinds: "integrations/stardew/farmhandexecutioncontroller.cs",
});

/** Directories under the Mod root that are not shipped refusal surfaces. */
const NOT_SHIPPED = new Set(["obj", "bin", "tests", "action-development"]);

/**
 * The fields that place a value in ACTION POSITION. Each one is a sentence the product writes for a caller: what answers
 * this box, what closes it, what owns the body, what to dispatch next.
 */
export const ACTION_POSITION_KEYS = Object.freeze([
  "owning_action",
  "owner_action",
  "answer_it",
  "dismiss_it",
  "dispatch_it",
  "next_action",
  "retry_action",
]);

/** The one owner value that is not an action id: the Mod's own "an uninitialised slot is described" token. */
export const UNKNOWN_OWNER = "unknown";

/** The finding id. `<code>` is the code or field that claimed the name, `<action>` the name it claimed. */
export const FINDING = "refusal_names_an_action_the_catalog_lacks";

/** A reason code: `snake_case`, no punctuation, no spaces. Prose and formats fail this. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{3,}$/u;

/** `<key>=<value>` at the start of a string field or after a `;`. The value may be empty (a concatenated claim). */
const FIELD = /(?:^|;)([a-z][a-z0-9_]*)=([a-z0-9_]*)/gu;

/** `<prefix>_owned_by_<owner>` anywhere in a literal. */
const OWNER_CODE = /([a-z0-9_]+)_owned_by_([a-z0-9_]+)/gu;

/** The Mod's declaration of its body-hold kinds, one named constant each. */
const HOLD_KIND_CONSTANT = /internal const string BodyOwnedBy[A-Za-z]* = "(body_owned_by_[a-z_]+)";/gu;

function readSource(root, relativePath, overrides) {
  if (overrides[relativePath] !== undefined) return overrides[relativePath];
  return readFileSync(path.join(root, relativePath), "utf8");
}

/**
 * The source with its comments blanked, LENGTH-PRESERVING so every index and line number still points at the file a
 * reader opens. Strings are copied verbatim (a defect quoted in a string is the defect; a defect quoted in a comment is
 * history).
 */
export function stripComments(source) {
  const out = source.split("");
  let index = 0;
  while (index < source.length) index = skipToken(source, out, index);
  return out.join("");
}

/** Blank the comment at `index` and answer where the code resumes; a literal or an ordinary character is stepped over. */
function skipToken(source, out, index) {
  const two = source.slice(index, index + 2);
  if (two === "//") return blankUntil(source, out, index, source.indexOf("\n", index));
  if (two === "/*") return blankUntil(source, out, index, source.indexOf("*/", index + 2), 2);
  const verbatim = verbatimOpen(two, source, index);
  if (verbatim > 0) return skipVerbatim(source, index + verbatim);
  if (two === '$"') return skipQuoted(source, index + 2);
  if (source[index] === '"') return skipQuoted(source, index + 1);
  return index + 1;
}

/** How many characters open a verbatim literal at `index` (2 for `@"`, 3 for `$@"`), or 0. */
function verbatimOpen(two, source, index) {
  if (two === '@"') return 2;
  return source[index] === "$" && source.slice(index + 1, index + 3) === '@"' ? 3 : 0;
}

/** `<from>..<to>` blanked in place, keeping the newlines a line number is counted from. */
function blankUntil(source, out, from, to, tail = 0) {
  const stop = to === -1 ? source.length : to + tail;
  for (let at = from; at < stop; at += 1) if (out[at] !== "\n" && out[at] !== "\r") out[at] = " ";
  return stop;
}

/** Past a verbatim literal (`@"..."`, where the only escape is a doubled quote). */
function skipVerbatim(source, open) {
  let at = open;
  while (at < source.length) {
    if (source[at] !== '"') {
      at += 1;
      continue;
    }
    if (source[at + 1] === '"') {
      at += 2;
      continue;
    }
    break;
  }
  return at + 1;
}

/** Past a quoted literal whose body has already started at `at` (backslash escapes included). */
function skipQuoted(source, at) {
  let index = at;
  while (index < source.length && source[index] !== '"') index += source[index] === "\\" ? 2 : 1;
  return index + 1;
}

/** Every regular string literal in comment-free source, as `{ text, line }`. */
export function stringLiterals(source) {
  const literals = [];
  const text = stripComments(source);
  let index = 0;
  let line = 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (character !== '"') {
      index += 1;
      continue;
    }
    let at = index + 1;
    let value = "";
    while (at < text.length && text[at] !== '"') {
      if (text[at] === "\\") {
        value += text.slice(at, at + 2);
        at += 2;
        continue;
      }
      if (text[at] === "\n") line += 1;
      value += text[at];
      at += 1;
    }
    literals.push({ text: value, line });
    index = at + 1;
  }
  return literals;
}

/** The Mod's own declaration of which `body_owned_by_*` kinds exist. */
export function readHoldKinds({ root = REPOSITORY_ROOT, overrides = {} } = {}) {
  const source = readSource(root, SOURCES.holdKinds, overrides);
  return Object.freeze([...source.matchAll(HOLD_KIND_CONSTANT)].map((match) => match[1]));
}

/** Every `.cs` file the Mod ships, as repository-relative paths. */
export function shippedModSources({ root = REPOSITORY_ROOT } = {}) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, current), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (NOT_SHIPPED.has(entry.name)) continue;
        walk(relative);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".cs")) found.push(relative);
    }
  };
  walk(SOURCES.modRoot);
  return found.sort();
}

function finding(code, action, detail) {
  return Object.freeze({ id: FINDING, code, action, detail });
}

/**
 * The claims one source makes, and the finding for every claim whose name the catalog does not declare.
 *
 * `actionIds` is the catalog's own vocabulary; `holdKinds` the Mod's declared body-hold kinds.
 */
export function auditSource(source, fileName, { actionIds, holdKinds }) {
  const declaredKinds = new Set(holdKinds.map((code) => code.slice("body_owned_by_".length)));
  const examined = [];
  const unmeasured = [];
  const findings = [];
  const codes = new Set();

  const judgeAction = (code, action, where) => {
    // The Mod's own "an uninitialised slot is described" token names no execution, so it claims no action.
    if (action === UNKNOWN_OWNER) return;
    examined.push({ fileName, line: where, code, action });
    if (actionIds.has(action)) return;
    findings.push(
      finding(
        code,
        action,
        `${fileName}:${where}: \`${code}\` names action \`${action}\`, which the catalog does not declare - a reader sent to it has no request to make`,
      ),
    );
  };

  for (const literal of stringLiterals(source)) {
    if (CODE_SHAPE.test(literal.text)) codes.add(literal.text);

    for (const match of literal.text.matchAll(OWNER_CODE)) {
      const prefix = match[1];
      const owner = match[2];
      const code = `${prefix}_owned_by_${owner}`;
      if (prefix === "body") {
        // A HOLD KIND, unless it is spelled like an action id: the family's kinds are one word each, so a multi-word
        // owner is a claim about an action and is judged as one.
        if (!owner.includes("_")) {
          if (!declaredKinds.has(owner))
            findings.push(
              finding(
                code,
                owner,
                `${fileName}:${literal.line}: \`${code}\` is a body-hold kind the Mod does not declare (\`BodyOwnedBy*\`), so a reader cannot tell what owns the body`,
              ),
            );
          continue;
        }
      }
      judgeAction(code, owner, literal.line);
    }

    for (const match of literal.text.matchAll(FIELD)) {
      const key = match[1];
      const value = match[2];
      if (!ACTION_POSITION_KEYS.includes(key)) continue;
      if (value === "") {
        // A CONCATENATED claim (`"...;answer_it=" + catalog.DayCrossingActionId`): the name is not in this source, so
        // this gate did not read it. Reported as unmeasured, never as clean.
        unmeasured.push({ fileName, line: literal.line, code: `${key}=` });
        continue;
      }
      judgeAction(`${key}=`, value, literal.line);
    }
  }

  return Object.freeze({
    fileName,
    codes: Object.freeze([...codes]),
    claims: Object.freeze(examined),
    unmeasured: Object.freeze(unmeasured),
    findings: Object.freeze(findings),
  });
}

/**
 * @param {{ root?: string, overrides?: Record<string, string> }} options
 * `overrides` replaces a file's text: a test that replays a pre-fix blob should not have to reproduce the tree.
 */
export function checkRefusalActionNames({ root = REPOSITORY_ROOT, overrides = {} } = {}) {
  let actionIds;
  try {
    actionIds = readStardewActionIds({ registrationsPath: path.join(root, SOURCES.catalog) });
  } catch (error) {
    return Object.freeze({ blocked: `catalog_unreadable:${error?.message ?? error}` });
  }
  const holdKinds = readHoldKinds({ root, overrides });
  if (holdKinds.length === 0) return Object.freeze({ blocked: "hold_kinds_undeclared" });

  const files = shippedModSources({ root });
  if (files.length === 0) return Object.freeze({ blocked: "no_mod_sources" });

  const claims = [];
  const findings = [];
  const unmeasured = [];
  const codes = new Set();
  for (const file of files) {
    const result = auditSource(readSource(root, file, overrides), file, { actionIds, holdKinds });
    for (const code of result.codes) codes.add(code);
    claims.push(...result.claims);
    unmeasured.push(...result.unmeasured);
    findings.push(...result.findings);
  }

  const exists = claims.filter((claim) => actionIds.has(claim.action)).length;
  return Object.freeze({
    blocked: null,
    filesExamined: files.length,
    catalogActions: actionIds.size,
    holdKinds: Object.freeze(holdKinds),
    codesExamined: codes.size,
    named: claims.length,
    exists,
    missing: findings.length,
    unmeasured: unmeasured.length,
    unmeasuredSites: Object.freeze(unmeasured),
    findings: Object.freeze(findings),
  });
}

/** The one line that says what this run measured, and the verdict it drew from it. */
export function renderReport(report) {
  if (report.blocked) return `refusal action names: blocked · ${report.blocked}\n`;
  const lines = report.findings.map((item) => `✖ ${item.id}:${item.code}:${item.action}  ${item.detail}`);
  lines.push(
    `refusal action names: ${report.filesExamined} files · codes examined ${report.codesExamined} · ` +
      `name an action ${report.named} · exists ${report.exists} · missing ${report.missing} · ` +
      `unmeasured ${report.unmeasured} · catalog ${report.catalogActions} actions / ${report.holdKinds.length} hold kinds`,
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const json = arguments_.includes("--json");
  const paths = arguments_.filter((argument) => !argument.startsWith("--"));
  const scopes = paths.length === 0 ? [REPOSITORY_ROOT] : paths.map((entry) => path.resolve(REPOSITORY_ROOT, entry));

  let unhealthy = null;
  const reports = scopes.map((root) => {
    const report = checkRefusalActionNames({ root });
    if (report.blocked) unhealthy ??= report.blocked;
    return report;
  });

  if (json) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  else for (const report of reports) process.stdout.write(renderReport(report));

  const measuredNothing = reports.some((report) => !report.blocked && report.codesExamined === 0);
  const missing = reports.reduce((total, report) => total + (report.missing ?? 0), 0);
  if (unhealthy !== null) process.exitCode = 2;
  else if (measuredNothing) process.exitCode = 2;
  else process.exitCode = missing === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
