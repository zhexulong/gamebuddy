/**
 * The ONE gate population and the ONE place a gate says what it is.
 *
 * WHY (measured 2026-11-14). Eight readings called themselves "the gates" and each built its number from its own glob
 * or regex over file names: `invoked 26 · ci-coverage scripts 133 · corpus names 184 · census scripts 354 · gate files
 * 148 · prelive members 152 · census gates 395 · register members 159` (`tools/check-gate-population-agreement.mjs`).
 * Two of them spelled the same rule twice - `tools/lib/gate-population.mjs` as `GATE_FILE` and
 * `tools/check-prelive-gate-registry.mjs` as its own `include` - so the day one of them learns a suffix the other keeps
 * its old answer. That is why `tools/` cannot be reorganised while this stands: move a gate out of the directory a
 * scanner globs and that scanner silently stops seeing it, which is a gate that stops running with no symptom.
 *
 * WHAT THIS MODULE OWNS, and therefore what a directory move touches:
 *
 *   `GATE_DIRECTORIES`  the directories a gate file may live in, DERIVED from the domain list: `tools/` plus
 *                       `tools/gates/<domain>/` for every domain. Filing a domain in its own directory is therefore a
 *                       `git mv` and no edit here - and every consumer below reads this scan, not a glob of its own.
 *   `isGateFile`        the name rule: `check-*.mjs` / `audit-*.mjs`, minus the falsifier suffixes that live beside
 *                       their gate. A path is a gate when its own directory is one of `GATE_DIRECTORIES`.
 *   `gateFiles`         the population: that rule applied to those directories, sorted, relative to the repository root.
 *   `directoryDomain`   which domain a gate's own directory files it under, so that the layout and the declaration
 *                       cannot say two different things about the same gate.
 *
 * WHY THE DECLARATION IS READ FROM THE SYNTAX TREE AND NOT BY IMPORTING THE MODULE. A loader that imports each gate
 * runs each gate: measured on this tree, importing all 148 took 90.6 s, exited non-zero on 16 of them (argument
 * requirements, missing fixtures), ran three past a 15 s timeout, and executed `check-head-typecheck.mjs`, which
 * compiles the Host. A population tool that needs a TypeScript compiler and ninety seconds to count files is not a
 * population tool. So the declaration is a STATIC export read through `tools/lib/javascript-ast.mjs`, the grammar seam
 * the static gates already share - which is also why a comment mentioning the declaration is not a declaration
 * (`scratch/probe-ast.mjs` measured a comment-only file at 0 export nodes).
 *
 * WHY THE EXPORT IS NAMED `gateDeclaration` AND NOT `gate`. This tree already binds `gate` to mean something else:
 * `const gate = "stardew_open_ground_claims/v1"` is the REPORT ID in the files that print a self-verification report,
 * and `tools/audit-run-reading-shape.mjs` exports `async function gate(root)`. Declaring `export const gate = {...}`
 * in those files is a duplicate declaration, and in the rest it gives one word two meanings in the same directory -
 * the "no fact gets two spellings" defect this repository names, applied to an identifier.
 *
 * WHAT A DECLARATION IS, and the three closed sets it is checked against:
 *
 *   export const gateDeclaration = { id, domain, tier, kind };
 *
 *   id      the gate's stable identity, and it must be the file name without `.mjs`. A rename that leaves the
 *           declaration behind is therefore `gate_declaration_invalid:<path>:id` rather than a silent new member.
 *   domain  product | data | arch | stardew | meta   - the subject the gate judges, and the bucket a move sorts by.
 *   tier    l0 | l1 | l2                             - what it needs to run: `l0` static text/AST reads and
 *           comparisons, `l1` imports this repository's modules and executes their logic, `l2` something outside the
 *           process (a child process, a build artifact, a live-run bundle, the game).
 *   kind    contract | totality | ratchet            - what it asserts: `contract` a shape or pairing between two
 *           authorities, `totality` that every member of a population is accounted for, `ratchet` that a recorded
 *           baseline did not regress.
 *
 * WHAT IT REFUSES, each naming its member:
 *
 *   gate_without_a_declaration:<path>              a gate file that declares nothing.
 *   gate_id_collision:<id>:<pathA>:<pathB>         two gates claiming one identity.
 *   gate_declaration_invalid:<path>:<field>        a field outside its closed set, a missing field, an `id` that is
 *                                                  not the file's slug, a declaration that is not a literal object,
 *                                                  or a `domain` that contradicts the directory the file is filed in.
 *   gate_registry_no_population                    the scan found no gate file at all - BLOCKED, exit 2, never green,
 *                                                  because an empty population agrees with itself.
 *
 * USAGE:
 *   node tools/gates/registry.mjs           # the reading; exit 1 on a finding, 2 when it measured nothing
 *   node tools/gates/registry.mjs --json    # the report the conformance suite reads
 *
 * No game, no network, no model, no child process. It reads files and parses them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJavaScript } from "../lib/javascript-ast.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/** The three closed sets a declaration is checked against, in the order a reader wants them. */
export const GATE_DOMAINS = Object.freeze(["product", "data", "arch", "stardew", "meta"]);
export const GATE_TIERS = Object.freeze(["l0", "l1", "l2"]);
export const GATE_KINDS = Object.freeze(["contract", "totality", "ratchet"]);

/** The directory a domain's gates live in. One string per domain, derived from the domain list. */
const DOMAIN_ROOT = "tools/gates";

/**
 * The directories a gate file may live in: `tools/` for the gates no domain has claimed yet, and one directory per
 * domain beneath `tools/gates/`.
 *
 * DERIVED FROM `GATE_DOMAINS`, not written out, so filing a domain in its directory is a `git mv` and no edit at all.
 * Written out, the list was `["tools"]` and this scan is not recursive: measured on the `meta` pilot, moving 14 gates
 * into `tools/gates/meta/` took this registry from 148 declared to 134 with no finding, because a gate that leaves
 * every declared directory leaves the population and an empty answer agrees with itself.
 */
export const GATE_DIRECTORIES = Object.freeze(["tools", ...GATE_DOMAINS.map((domain) => `${DOMAIN_ROOT}/${domain}`)]);

/** A gate file's name, wherever it lives: the rule every consumer now reads instead of restating. */
const GATE_NAME = /^(?:check|audit)-.*\.mjs$/u;

/** A falsifier that lives beside its gate: not a gate, because its subject is the gate and not the product. */
const SIBLING_FALSIFIER = /\.(?:test\.mjs|test\.ts|mutation\.mjs)$/u;

/** The export a gate declares itself with. */
export const DECLARATION_EXPORT = "gateDeclaration";

/** The fields a declaration carries, and the set each one must be in. */
const DECLARATION_FIELDS = Object.freeze({
  id: null,
  domain: GATE_DOMAINS,
  tier: GATE_TIERS,
  kind: GATE_KINDS,
});

const normalize = (path) => String(path).replace(/\\/gu, "/");
const basename = (path) => normalize(path).replace(/^.*\//u, "");
const directoryOf = (path) => normalize(path).replace(/\/[^/]*$/u, "");

/**
 * The domain a gate's own directory files it under, or `null` when the gate sits directly in `tools/`.
 *
 * `tools/gates/meta/check-diff.mjs` is filed under `meta`. `tools/check-diff.mjs` is filed under nothing, because the
 * unsorted half of the population has no domain directory and its declaration is the only word on the subject.
 */
export function directoryDomain(path) {
  const match = /^tools\/gates\/([^/]+)\//u.exec(normalize(path));
  return match === null ? null : match[1];
}

/**
 * Is this path a gate file? The ONE spelling of the rule.
 *
 * Both halves matter: the name says what kind of file it is, and the directory says whether this repository publishes
 * it as a gate. `tools/scripts/check-format-ratchet.mjs` is a name match in an undeclared directory, and it is not a
 * gate today - a fact stated here once instead of being re-derived by each consumer from a different glob.
 */
export function isGateFile(path) {
  const name = basename(path);
  const directory = directoryOf(normalize(path));
  return GATE_DIRECTORIES.includes(directory) && GATE_NAME.test(name) && !SIBLING_FALSIFIER.test(name);
}

/**
 * The population: every gate file in `GATE_DIRECTORIES`, relative to `root`, sorted.
 *
 * A directory in the list that does not exist is not a finding on its own - the repository-root call passes every
 * directory the tree has - but an empty RESULT is, and `readDeclarations` refuses it.
 */
export function gateFiles({ root = REPOSITORY_ROOT } = {}) {
  const files = [];
  for (const directory of GATE_DIRECTORIES) {
    const path = join(root, directory);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      const relative = `${directory}/${name}`;
      if (isGateFile(relative)) files.push(relative);
    }
  }
  return files.sort();
}

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * The declaration a source tree carries, or the reason it carries none.
 *
 * The node shape is the one tree-sitter-javascript produces for `export const x = { ... }`: an `export_statement`
 * whose `declaration` is a `lexical_declaration`, whose first declarator names the export and whose value is an
 * `object` of `pair`s. Every value must be a plain string literal with no escape, because a computed declaration is
 * not a declaration a reader can check.
 */
export function declarationIn(source, fileName) {
  return parseJavaScript(source, fileName).then((tree) => {
    for (const statement of tree.rootNode.descendantsOfType("export_statement")) {
      const declaration = statement.childForFieldName("declaration");
      if (declaration === null || declaration === undefined) continue;
      const declarator = declaration.namedChild(0);
      if (declarator === null || declarator.type !== "variable_declarator") continue;
      if (declarator.childForFieldName("name")?.text !== DECLARATION_EXPORT) continue;
      const value = declarator.childForFieldName("value");
      if (value === null || value === undefined) return { declaration: null, reason: "shape" };
      if (value.type !== "object") return { declaration: null, reason: "shape" };
      const fields = {};
      for (const entry of value.namedChildren) {
        if (entry.type !== "pair") return { declaration: null, reason: "shape" };
        const key = entry.childForFieldName("key")?.text ?? null;
        const literal = entry.childForFieldName("value");
        if (key === null || literal === null || literal.type !== "string" || literal.text.includes("\\"))
          return { declaration: null, reason: "shape" };
        fields[key] = literal.text.slice(1, -1);
      }
      return { declaration: fields, reason: null };
    }
    return { declaration: null, reason: null };
  });
}

/**
 * Every gate file's declaration, read from the file's own syntax tree, with the findings that make one unusable.
 *
 * `declared` keeps only the gates that passed every check, because a consumer filtering by `domain` must not be
 * handed a gate whose domain is not in the closed set. Everything else is named in `undeclared` or `findings`, so the
 * count `examined - declared.length` is always readable as the sum of the two buckets rather than as a silent gap.
 */
export async function readDeclarations({ root = REPOSITORY_ROOT, files } = {}) {
  const examinedFiles = files ?? gateFiles({ root });
  const findings = [];
  const declared = [];
  const undeclared = [];
  const byId = new Map();

  for (const file of examinedFiles) {
    const source = read(join(root, file));
    if (source === null) {
      findings.push({ code: "gate_without_a_declaration", id: file, detail: "unreadable" });
      undeclared.push(file);
      continue;
    }
    let result;
    try {
      result = await declarationIn(source, basename(file));
    } catch (error) {
      findings.push({
        code: "gate_declaration_invalid",
        id: `${file}:shape`,
        detail: `not parseable: ${String(error?.message ?? error).split("\n")[0]}`,
      });
      undeclared.push(file);
      continue;
    }
    if (result.declaration === null) {
      if (result.reason !== null) {
        findings.push({
          code: "gate_declaration_invalid",
          id: `${file}:shape`,
          detail: `\`${DECLARATION_EXPORT}\` is not an object literal of string fields`,
        });
        undeclared.push(file);
        continue;
      }
      findings.push({
        code: "gate_without_a_declaration",
        id: file,
        detail: `no \`export const ${DECLARATION_EXPORT}\``,
      });
      undeclared.push(file);
      continue;
    }

    const fields = result.declaration;
    const filedUnder = directoryDomain(file);
    const invalid = [];
    for (const [field, allowed] of Object.entries(DECLARATION_FIELDS)) {
      const value = fields[field];
      if (typeof value !== "string" || value.length === 0) invalid.push(field);
      else if (allowed !== null && !allowed.includes(value)) invalid.push(field);
      else if (field === "id" && value !== basename(file).replace(/\.mjs$/u, "")) invalid.push(field);
      else if (field === "domain" && filedUnder !== null && value !== filedUnder) invalid.push(field);
    }
    const unknown = Object.keys(fields).filter((field) => DECLARATION_FIELDS[field] === undefined);
    for (const field of unknown)
      findings.push({
        code: "gate_declaration_invalid",
        id: `${file}:${field}`,
        detail: `not a declared field; the declaration is ${Object.keys(DECLARATION_FIELDS).join(", ")}`,
      });
    for (const field of invalid)
      findings.push({
        code: "gate_declaration_invalid",
        id: `${file}:${field}`,
        detail: invalidDetail({ file, field, fields, filedUnder }),
      });
    if (invalid.length > 0 || unknown.length > 0) {
      undeclared.push(file);
      continue;
    }

    const previous = byId.get(fields.id);
    if (previous !== undefined) {
      findings.push({
        code: "gate_id_collision",
        id: `${fields.id}:${previous}:${file}`,
        detail: "two gate files claim one identity",
      });
      undeclared.push(file);
      continue;
    }
    byId.set(fields.id, file);
    declared.push({ path: file, ...fields });
  }

  return { examined: examinedFiles.length, files: examinedFiles, declared, undeclared, findings };
}

/**
 * Why one field was refused, in terms of what THIS file wrote - a closed set alone cannot tell a reader that the gate
 * is filed in the wrong directory, because the value it declared is a legal one.
 */
function invalidDetail({ file, field, fields, filedUnder }) {
  if (field === "id")
    return `must be the file's slug \`${basename(file).replace(/\.mjs$/u, "")}\`, got \`${fields.id}\``;
  if (field === "domain" && filedUnder !== null && GATE_DOMAINS.includes(fields.domain))
    return (
      `\`${fields.domain}\` is declared, but the file is filed under \`${filedUnder}\` - ` +
      `a gate in ${DOMAIN_ROOT}/<domain>/ declares that domain, so move the file or change the declaration`
    );
  return `\`${String(fields[field])}\` is not one of ${(DECLARATION_FIELDS[field] ?? []).join(" | ")}`;
}

/** The self-verification report: one entry per rule this registry can report red. */
export function buildReport({ examined, declared, undeclared, findings }) {
  const checks = ["gate_without_a_declaration", "gate_id_collision", "gate_declaration_invalid"].map((code) => ({
    id: code,
    status: findings.some((finding) => finding.code === code) ? "failed" : "passed",
    detail: `${findings.filter((finding) => finding.code === code).length} member(s)`,
  }));
  return {
    gate: "gate_registry/v1",
    status: examined === 0 ? "blocked" : findings.length === 0 ? "passed" : "failed",
    population: examined,
    examined,
    declared: declared.length,
    undeclared: undeclared.length,
    domains: Object.fromEntries(
      GATE_DOMAINS.map((domain) => [domain, declared.filter((gate) => gate.domain === domain).length]),
    ),
    checks,
  };
}

async function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex < 0 ? REPOSITORY_ROOT : resolve(argv[rootIndex + 1] ?? "");
  const files = gateFiles({ root });
  if (files.length === 0) {
    process.stdout.write(`gate_registry_no_population: no gate file under ${GATE_DIRECTORIES.join(", ")} in ${root}\n`);
    return 2;
  }
  const reading = await readDeclarations({ root, files });
  const report = buildReport(reading);

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return reading.findings.length === 0 ? 0 : 1;
  }

  process.stdout.write(
    `gate files examined ${report.examined} · declared ${report.declared} · undeclared ${report.undeclared}\n`,
  );
  for (const finding of reading.findings) process.stdout.write(`${finding.code}: ${finding.id} - ${finding.detail}\n`);
  process.stdout.write(
    reading.findings.length === 0
      ? "gate_registry: passed\n"
      : `gate_registry: failed - ${reading.findings.length} member(s) undeclared or invalid\n`,
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return reading.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
