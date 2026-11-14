#!/usr/bin/env node
/**
 * Every source gate's INPUTS exist. A gate whose premise was deleted is red for a reason nobody can see, so the
 * premise itself is the thing measured here.
 *
 * WHY (measured 2026-11-13). `host/src/snapshot-hud.ts` was retired on purpose (`213cde50`: the `[State HUD: …]` block
 * was deleted and its facts were split by audience). Two source gates still named it, and both had been red ever since:
 *
 *   tools/check-stardew-observation-consumers.mjs   blocked  missing_input:host/src/snapshot-hud.ts
 *   tools/check-stardew-observation-gap.mjs         failed   ENOENT: host/src/snapshot-hud.ts, from the analyzer it spawns
 *
 * The second one is the reason this file exists rather than a convention. `check-stardew-observation-gap.mjs` contains
 * no reference to the HUD at all - it runs `stardew-action-inventory-reconciliation.mjs`'s CLI, and THAT module reads
 * the deleted path in a default parameter, so the gate inherits a premise from a module it does not name. A registry of
 * "the files each gate reads" written by hand would have listed the first gate and missed the second, which is exactly
 * how the defect survived: nothing declared the input, so nothing could check it.
 *
 * THE POPULATION IS DERIVED FROM THE DECLARATION, not from a second list. A `.mjs` source declares the files it reads
 * in one of three shapes, and all three are read here:
 *
 *   export const HUD_SOURCE = "host/src/snapshot-hud.ts";      an UPPER_CASE constant holding a repo-relative path
 *   { path: "host/src/fact-brief.ts", audience: COMPANION }    a `path:` key in a declared renderer/table row
 *   export const REQUIRED_INPUTS = Object.freeze([...])        a frozen array of repo-relative paths
 *
 * The per-gate registry (`GATE_PREMISES`) therefore names only WHICH GATES there are and which MODULES each one drives
 * or imports - never the inputs. An input added to a gate joins this check without an edit here, and an input deleted
 * from the tree reddens it without an edit either. A glob (`tools/lib/**`) is expanded and must match at least one
 * file: a pattern that matches nothing is a missing input, not an empty set.
 *
 * FINDINGS, all naming the gate and the path, because the reader has to open the file:
 *   `gate_premise_missing:<gate>:<path>`       the input is gone; the gate is red for a reason that is not its subject
 *   `gate_premise_gate_missing:<gate>`         the gate itself is gone; a registry row that outlived its gate
 *   `gate_premise_unread:<gate>`               the gate declares no input this reader can find - a check that examined
 *                                              nothing agrees with itself, so it is reported rather than passed
 *   `gate_premise_registry_empty`              no gate is registered at all
 *
 * ZERO POPULATION IS BLOCKED, never green: the verdict line prints `gates examined N · inputs checked M · missing K`,
 * and `examined 0` exits 2 with a named reason. `missing 0` means nothing without the first two numbers.
 *
 *   node tools/gates/meta/check-gate-premises.mjs            # the verdict; exit 1 on a missing input, 2 on no population
 *   node tools/gates/meta/check-gate-premises.mjs --root DIR # the same reading of a copied tree
 *   node tools/gates/meta/check-gate-premises.mjs --json     # every gate's derived input list, machine-readable
 *
 * red-proof: history  the deletion commit's own copy of a consumer gate still declares the HUD module it deleted, and
 *            this gate reddens on that text with `gate_premise_missing` - replayed from git, not from a fixture
 *            (tools/gates/meta/check-gate-premises.test.mjs, "the deletion commit's own gate text").
 * red-proof: inject  a registry row whose gate declares a path that is not on disk reddens
 *            `gate_premise_missing:<gate>:<path>` (the same suite, the mechanism on its own).
 */

export const gateDeclaration = {
  id: "check-gate-premises",
  domain: "meta",
  tier: "l0",
  kind: "totality",
};

import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The analyzer the observation-gap gate spawns: it inherits that module's inputs, so they are its premise too. */
const OBSERVATION_GAP_ANALYZER =
  "integrations/stardew/action-development/src/analysis/stardew-action-inventory-reconciliation.mjs";

/** The module that owns the renderer declaration the consumers gate imports its per-turn text from. */
const RENDERER_DECLARATION = "tools/check-snapshot-field-rendering.mjs";

/**
 * One row per source gate that reads files: the gate, and the modules whose declarations it inherits.
 *
 * `reads` is the fix for the defect this file was written for: a gate that spawns a CLI or imports a declaration reads
 * whatever THAT module declares, and a registry that only looked at the gate's own text would call the gate whole.
 */
export const GATE_PREMISES = Object.freeze([
  { gate: "tools/check-stardew-observation-gap.mjs", reads: [OBSERVATION_GAP_ANALYZER] },
  { gate: "tools/check-stardew-observation-consumers.mjs", reads: [RENDERER_DECLARATION] },
  // Both gates below declare their inputs as UPPER_CASE constants and `path:` rows, so their premise lists are derived
  // rather than restated here: the wire schema, the Host validator, the contract and the producer it judges.
  { gate: "tools/check-inventory-row-field-rendering.mjs" },
  { gate: "tools/check-browser-state-projection-fields.mjs" },
]);

/** A repo-relative path: the roots this tree's gates read from. A string outside these is prose, not an input. */
const REPO_PATH = /^(?:host|tools|integrations|dialogue-web|design|ref|protocol|desktop|docs)\//u;

/** A line comment, a block comment: text a reader wrote for a person, never a declaration of an input. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/u, ""))
    .join("\n");
}

/**
 * The repo-relative paths a module DECLARES it reads.
 *
 * Comments are stripped first, so a header that discusses a path does not become an input. Only declaration positions
 * are read: an UPPER_CASE constant, a `path:` key, or a frozen array of quoted paths. A path mentioned inside a message
 * ("render it in `host/src/fact-brief.ts`") is not a declaration, and counting it would redden a gate for its prose.
 */
export function deriveInputs(source) {
  const code = withoutComments(source);
  const inputs = new Set();
  const add = (value) => {
    if (REPO_PATH.test(value)) inputs.add(value);
  };
  for (const match of code.matchAll(/^\s*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*=\s*"([^"]+)"/gmu)) add(match[1]);
  for (const match of code.matchAll(/\bpath:\s*"([^"]+)"/gu)) add(match[1]);
  for (const match of code.matchAll(
    /^\s*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/gmu,
  ))
    for (const entry of match[1].matchAll(/"([^"]+)"/gu)) add(entry[1]);
  return [...inputs].sort();
}

/** Whether a declared input is there: a file, a directory, or a glob with at least one match under `root`. */
export function inputExists({ root = ROOT, path, exists = (target) => existsSync(target) } = {}) {
  if (path.includes("*")) return globSync(path, { cwd: root }).length > 0;
  return exists(resolve(root, path));
}

/**
 * The verdict. `read` and `exists` are injected so the suite can drive the mechanism without a tree, and `root` so the
 * CLI can read a copy - one function, so the CLI and its tests cannot read the tree two ways.
 */
export function checkPremises({
  root = ROOT,
  registry = GATE_PREMISES,
  read = (path) => readFileSync(resolve(root, path), "utf8"),
  exists = (path) => inputExists({ root, path }),
} = {}) {
  const findings = [];
  const derived = [];
  if (registry.length === 0) findings.push({ code: "gate_premise_registry_empty", detail: "no gate is registered" });
  for (const entry of registry) {
    const gate = entry.gate;
    let gateSource = null;
    try {
      gateSource = read(gate);
    } catch {
      findings.push({
        code: `gate_premise_gate_missing:${gate}`,
        gate,
        detail: "the registry names a gate that is gone",
      });
      continue;
    }
    const sources = [gateSource];
    let unreadable = null;
    for (const module of entry.reads ?? []) {
      try {
        sources.push(read(module));
      } catch {
        unreadable = module;
      }
    }
    if (unreadable !== null) {
      findings.push({
        code: `gate_premise_gate_missing:${gate}`,
        gate,
        detail: `it reads ${unreadable}, which is gone, so its own premise cannot be derived`,
      });
      continue;
    }
    const inputs = [...new Set(sources.flatMap((source) => deriveInputs(source)))].sort();
    if (inputs.length === 0) {
      findings.push({
        code: `gate_premise_unread:${gate}`,
        gate,
        detail: "no declared input this reader can find, so the gate's premise is unchecked",
      });
      continue;
    }
    derived.push({ gate, inputs });
    for (const path of inputs)
      if (!exists(path))
        findings.push({
          code: `gate_premise_missing:${gate}:${path}`,
          gate,
          path,
          detail:
            "the gate reads it and it is not in the tree; a gate red for a deleted input is not measuring its subject",
        });
  }
  const inputs = derived.reduce((total, row) => total + row.inputs.length, 0);
  return {
    status: findings.length === 0 ? (derived.length === 0 ? "blocked" : "passed") : "failed",
    gates: derived.length,
    inputs,
    missing: findings.filter((finding) => typeof finding.path === "string").length,
    findings,
    derived,
  };
}

/** The lines a reader sees, and the exit code, as data - so a falsifier can assert them without a subprocess. */
export function report(result, { write = (text) => process.stdout.write(`${text}\n`) } = {}) {
  write(`gate_premises: gates examined ${result.gates} · inputs checked ${result.inputs} · missing ${result.missing}`);
  for (const finding of result.findings) write(`${finding.code}: ${finding.detail}`);
  if (result.gates === 0) {
    write("gate_premises: no gate was examined, so nothing can be judged; a green run reads gates examined >= 1");
    return 2;
  }
  write(`gate_premises: ${result.status}`);
  return result.status === "passed" ? 0 : 1;
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : ROOT;
  const result = checkPremises({ root });
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({
        gate: "gate-premises",
        status: result.status,
        population: result.inputs,
        gates: result.gates,
        missing: result.missing,
        derived: result.derived,
      })}\n`,
    );
  }
  process.exitCode = report(result);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
