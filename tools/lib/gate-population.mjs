/**
 * The ONE gate population this repository has, derived once and read by both gate-meta tools:
 *
 *   - `tools/audit-gate-red-proofs.mjs` asks "has this gate been seen red?"
 *   - `tools/lib/harness-conformance.mjs` asks "does this gate's default run print a self-verification report, and
 *     if not, has someone said why?"
 *
 * WHY THIS FILE EXISTS (measured 2026-11-20): the two tools read the same word two ways - 106 gate files in the
 * conformance suite and 330 gates in the red-proof audit - so "we have N gates and M red proofs" had no single
 * answer, and 203 gates without a demonstrated red case were invisible to the run that was supposed to enforce it.
 * A population derived twice drifts silently, because each derivation only answers the question its own reader asked.
 * So the derivation lives here, and a tool that cannot judge every member prints the bucket it excluded and why.
 *
 * THE DERIVATION is a union of two halves, neither of them a hand-written list:
 *
 *   A. every `package.json` script in the gate namespace (`audit:` / `check:` / `test:`), with the files its command
 *      runs as that gate's entry points. This is the population CI actually runs: `tools/check-ci-coverage.mjs`
 *      derives the `gates` job from the same namespace, so a script is a gate by being named like one.
 *   B. every `tools/check-*.mjs` file no script names - a gate that exists on disk and that nobody types. This is the
 *      half a script list cannot see, and it is mandatory: a gate nothing runs is the one that stops working without
 *      a symptom.
 *
 * The halves are merged on the entry file, so a gate both a script and a file name is ONE record, whose id is the
 * script - what an operator types and what CI's derived job step names.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { GATE_NAME as CI_COVERAGE_NAMESPACE } from "../check-ci-coverage.mjs";

/**
 * A `package.json` script named like a gate: the union of the two namespaces that name gates.
 *
 * `check-ci-coverage`'s is imported rather than restated, because it is the namespace that decides what runs in the CI
 * `gates` job - and two spellings of it disagreed the first time measured: 9 scripts it covers (`lint`, `lint:eslint`,
 * `lint:ast-grep`, `typecheck`, `typecheck:voice-protocol`, `format:check`, `dependency-audit`, `report:clones`,
 * `report:stardew-remaining-actions`) are gates by its own contract and were outside the population this file derived,
 * so the red-proof census could not see them.
 */
const GATE_SCRIPT = CI_COVERAGE_NAMESPACE;
/**
 * The half `check-ci-coverage` leaves to `tools/run-tool-test-corpus.mjs`: a `test:` script runs a gate's own suite.
 * `suite:` is deliberately absent - that prefix names a library's tests, and `tools/run-tool-test-corpus.mjs` says so
 * beside the two: only `test:` carries the meta-gate's obligation to state a falsifier.
 */
const TEST_SCRIPT = /^test:/u;
/** A gate file: `tools/check-*.mjs` or `tools/audit-*.mjs`, minus its own falsifiers, which are not gates. */
const GATE_FILE = /^(?:check|audit)-.*\.mjs$/u;
/** A falsifier that lives beside its gate: the project rule is "the falsifier is part of the gate's own test". */
const SIBLING_FALSIFIER = /\.(?:test\.mjs|test\.ts|mutation\.mjs)$/u;
/** A path a command runs: that gate's entry points. Longest extension first, or `main.tsx` resolves to `main.ts`. */
const COMMAND_PATH = /[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|tsx|ts|cjs|js|ps1|py)/gu;
/** A command may change directory first; its paths then resolve from there, not from the repository root. */
const COMMAND_CWD = /^(?:cd|pushd)\s+(\S+)\s*&&/u;

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Half A: every declared gate script, with the paths its command runs. */
function declaredGateScripts(root) {
  const parsed = read(join(root, "package.json"));
  if (parsed === null) throw new Error("gate_red_proofs_package_json_missing");
  const scripts = JSON.parse(parsed).scripts ?? {};
  return Object.keys(scripts)
    .filter((name) => GATE_SCRIPT.test(name) || TEST_SCRIPT.test(name))
    .sort()
    .map((name) => {
      const command = scripts[name];
      // `cd host && bun test src/x.test.ts` names a file that only exists under `host/`; joining the
      // directory onto the path keeps the record resolvable instead of reporting a gate as unassessable.
      const prefix = COMMAND_CWD.exec(command)?.[1] ?? "";
      const entryFiles = [...new Set(command.match(COMMAND_PATH) ?? [])].map((file) =>
        prefix === "" ? file : `${prefix.replace(/\/$/u, "")}/${file}`,
      );
      return { id: name, kind: "script", command, entryFiles };
    });
}

/** Half B: every `tools/check-*.mjs` gate file, minus its own falsifiers, which are not gates. */
function unwiredGateFiles(root) {
  const toolsDir = join(root, "tools");
  if (!existsSync(toolsDir)) return [];
  return readdirSync(toolsDir)
    .filter((name) => isGateFile(name))
    .sort()
    .map((name) => ({
      id: `tools/${name}`,
      kind: "gate-file",
      command: `node tools/${name}`,
      entryFiles: [`tools/${name}`],
    }));
}

/**
 * The one rule for "this path is a gate, not a falsifier": `tools/check-*.mjs` minus `.test.mjs` / `.mutation.mjs`.
 *
 * Exported because the conformance suite asks the same question of a record's entry file when it decides what it can
 * run, and two spellings of this rule disagree the first time one of them learns about a new suffix.
 */
export function isGateFile(path) {
  const name = path.replace(/^tools\//u, "");
  return GATE_FILE.test(name) && !SIBLING_FALSIFIER.test(name);
}

/**
 * The population: `{ gates, scripts, gateFiles, unclaimedByScript }`, where `gates` is the merged union sorted by id
 * and `unclaimedByScript` is the gate files no script names - the size the census reports, because it is the number
 * of gates only a directory scan can see.
 */
export function deriveGatePopulation({ root }) {
  const scripts = declaredGateScripts(root);
  const gateFiles = unwiredGateFiles(root);
  const claimed = new Set(scripts.flatMap((gate) => gate.entryFiles));
  const unclaimed = gateFiles.filter((file) => !claimed.has(file.entryFiles[0]));
  const gates = [...scripts, ...unclaimed].sort((left, right) => left.id.localeCompare(right.id));
  return { gates, scripts, gateFiles, unclaimedByScript: unclaimed.length };
}

/** The `tools/check-*.mjs` file names in the population: the unit the conformance registry declares by. */
export function gateFileNames(population) {
  return population.gateFiles.map((file) => file.entryFiles[0].replace(/^tools\//u, ""));
}

/**
 * The names a record is known by, for a declarer that uses another spelling of the same gate: its id (`check:a`,
 * `tools/check-a.mjs`) and the base name of each file it owns (`check-a.mjs`).
 */
export function gateMemberNames(gate) {
  return [gate.id, ...gate.entryFiles.map((file) => file.replace(/^tools\//u, "").replace(/^.*\//u, ""))];
}
