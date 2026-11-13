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
 *   B. every `tools/check-*.mjs` / `tools/audit-*.mjs` file no script names - a gate that exists on disk and that nobody
 *      types. This is the half a script list cannot see, and it is mandatory: a gate nothing runs is the one that stops
 *      working without a symptom.
 *
 * AND WHAT NEITHER HALF TAKES IS NAMED, NOT DROPPED. The derivation reads two further kinds of member - a `suite:` script
 * and a gate-shaped file under a `tools/` subdirectory - and puts each in `dropped` with the rule that left it out, beside
 * `examined`, the raw size it read. A prefix that removes a member and prints nothing is how a corpus announced `untaken 0`
 * while discarding 42 scripts (measured 2026-11-13 in `tools/run-tool-test-corpus.mjs`); the census publishes the
 * complement so `gates + dropped = examined` is a line an operator can check.
 *
 * The halves are merged on the entry file, so a gate both a script and a file name is ONE record, whose id is the
 * script - what an operator types and what CI's derived job step names.
 */
import { readdirSync, readFileSync } from "node:fs";
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
/**
 * A script that names a library's own suites. The census reads it and leaves it out - and says so, by name, in `dropped`,
 * because a prefix that removes a member without a word is how the census stopped being able to state its own size.
 */
const SUITE_SCRIPT = /^suite:/u;
/** A gate file: `tools/check-*.mjs` or `tools/audit-*.mjs`, minus its own falsifiers, which are not gates. */
const GATE_FILE = /^(?:check|audit)-.*\.mjs$/u;
/** A falsifier that lives beside its gate: the project rule is "the falsifier is part of the gate's own test". */
const SIBLING_FALSIFIER = /\.(?:test\.mjs|test\.ts|mutation\.mjs)$/u;
/** The directory a gate lives in. A gate-shaped file under one of its subdirectories is named in `dropped`, not judged. */
const GATE_DIRECTORY = "tools";
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

/** Why a `suite:` script is read and left out: the prefix names a library's own suites, and this judges gates. */
const SUITE_REASON =
  "a `suite:` script names a library's own suites rather than a gate, and `tools/run-tool-test-corpus.mjs` runs it";
/** Why a gate-shaped file under a `tools/` subdirectory is read and left out: the gate directory is `tools/` itself. */
const NESTED_FILE_REASON =
  "gate-shaped but outside the gate directory `tools/` - a subdirectory holds run-harness helpers and modules - and no " +
  "`package.json` script names it";

/**
 * What each gate-shaped file outside the gate directory IS, because "no script names it" states the rule and not the
 * verdict: a reader still has to open the file to learn whether it is an unwired gate or not a gate at all.
 *
 * These are the tree's own three members of that shape (measured 2026-11-13). The entries are not a population - they
 * cannot add a member - and each one EXPIRES: `deriveGatePopulation` throws `dropped_verdict_stale` for a path that is no
 * longer a dropped member, so a file that joins a script or leaves the tree takes its verdict with it.
 */
const DROPPED_FILE_VERDICTS = new Map([
  [
    "tools/live-run/chat/audit-trace.mjs",
    "not a gate: the audit recorder, validator and writer the chat live-run harness imports; its `audit-` name is a " +
      "coincidence of the glob",
  ],
  [
    "tools/live-run/chat/check-post-history-instructions-live.mjs",
    "a live probe rather than a tree gate: it needs a real runtime root and a served provider endpoint, so the run " +
      "harness owns when it runs and the census has no tree state to judge",
  ],
  [
    "tools/scripts/check-lockfile-freeze.mjs",
    "not a tree gate: it fires from the commit hook when THIS commit changes a lockfile and runs `check:dependency-risk`, " +
      "so its subject is the staged set rather than the tree",
  ],
]);

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

/** The `suite:` scripts the derivation reads and leaves out, so the exclusion is a line of output rather than a prefix. */
function droppedSuiteScripts(root) {
  const parsed = read(join(root, "package.json"));
  if (parsed === null) return [];
  return Object.keys(JSON.parse(parsed).scripts ?? {})
    .filter((name) => SUITE_SCRIPT.test(name))
    .sort()
    .map((name) => ({ member: name, reason: SUITE_REASON }));
}

/** Half B: the gate-shaped files directly in the gate directory, minus its own falsifiers, which are not gates. */
function gateFilesInGateDirectory({ shaped, claimed }) {
  return shaped
    .filter((file) => !file.slice(`${GATE_DIRECTORY}/`.length).includes("/"))
    .map((file) => ({ id: file, kind: "gate-file", command: `node ${file}`, entryFiles: [file] }));
}

/**
 * Every gate-shaped file under the gate directory, at any depth: the scan half B and `dropped` divide up between them.
 *
 * It walks rather than listing one directory, because a gate-shaped file one level down is a member this derivation
 * reads and then has to say something about. Measured 2026-11-13: `tools/scripts/check-lockfile-freeze.mjs` and the two
 * `tools/live-run/chat/` files were in no population and on no line of output, so "every gate" excluded them silently.
 */
function gateShapedFiles(root) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (isGateName(entry.name)) found.push(path);
    }
  };
  walk(GATE_DIRECTORY);
  return found.sort();
}

/**
 * The one rule for "this path is a gate, not a falsifier": `tools/check-*.mjs` minus `.test.mjs` / `.mutation.mjs`.
 *
 * Exported because the conformance suite asks the same question of a record's entry file when it decides what it can
 * run, and two spellings of this rule disagree the first time one of them learns about a new suffix.
 */
export function isGateFile(path) {
  return isGateName(path.replace(/^tools\//u, ""));
}

/** The name rule `isGateFile` applies to a `tools/`-relative path, applied to a bare file name instead. */
function isGateName(name) {
  return GATE_FILE.test(name) && !SIBLING_FALSIFIER.test(name);
}

/**
 * The population: `{ gates, scripts, gateFiles, unclaimedByScript, examined, dropped }`, where `gates` is the merged
 * union sorted by id, `unclaimedByScript` is the gate files no script names - the number of gates only a directory scan
 * can see - and `examined` is the raw size of what the derivation read.
 *
 * THE COMPLEMENT IS PUBLISHED, NOT IMPLIED. `examined - gates = dropped`, and every member of `dropped` is named with the
 * rule that left it out: a `suite:` script (a library's suites, not a gate) or a gate-shaped file under a `tools/`
 * subdirectory (a run-harness helper or a module, which no script names as a gate). A prefix that removes a member and
 * prints nothing is how a corpus reports `untaken 0` while discarding 42 scripts, which is the defect this field exists
 * for: an operator can only audit an exclusion they can see.
 */
export function deriveGatePopulation({ root, verdicts = DROPPED_FILE_VERDICTS }) {
  const scripts = declaredGateScripts(root);
  const suites = droppedSuiteScripts(root);
  const claimed = new Set(scripts.flatMap((gate) => gate.entryFiles));
  const shaped = gateShapedFiles(root);
  // A file no script names is the only half a directory scan can add; a claimed file is already one of `scripts`.
  const orphanFiles = shaped.filter((file) => !claimed.has(file));
  const gateFiles = gateFilesInGateDirectory({ shaped, claimed });
  const unclaimed = gateFiles.filter((file) => !claimed.has(file.entryFiles[0]));
  const gates = [...scripts, ...unclaimed].sort((left, right) => left.id.localeCompare(right.id));
  const dropped = [
    ...suites,
    ...orphanFiles
      .filter((file) => file.slice(`${GATE_DIRECTORY}/`.length).includes("/"))
      .map((file) => ({ member: file, reason: verdicts.get(file) ?? NESTED_FILE_REASON })),
  ];
  // A verdict that outlives its reason is the same defect as a filter that drops in silence: if the file is on disk and
  // is no longer dropped - a script now claims it, or it moved into the gate directory - the entry has to go.
  const names = new Set(dropped.map((entry) => entry.member));
  const shapedSet = new Set(shaped);
  for (const path of verdicts.keys())
    if (shapedSet.has(path) && !names.has(path)) throw new Error(`dropped_verdict_stale:${path}`);
  return {
    gates,
    scripts,
    gateFiles,
    unclaimedByScript: unclaimed.length,
    // Every raw member the derivation read: the namespace's scripts, plus the gate-shaped files no script names. So
    // `gates + dropped = examined` holds, and a member that is in neither list is a reading that cannot reconcile.
    examined: scripts.length + suites.length + orphanFiles.length,
    dropped,
  };
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
