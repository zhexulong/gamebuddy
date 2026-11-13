#!/usr/bin/env node
/**
 * Four populations call themselves "every gate". This asks whether they also mean the same one.
 *
 * WHY (measured 2026-11-13, before the gate-file/namespace widening landed in `f02b0699`):
 *
 *   `check-ci-coverage.mjs`         129 gate scripts in CI's namespace
 *   `check-prelive-gate-registry.mjs` 143 population members
 *   `tools/lib/gate-population.mjs` 371 gates, read by `audit-gate-red-proofs.mjs` and by
 *                                     `tools/lib/harness-conformance.mjs`
 *   `run-tool-test-corpus.mjs`       169 members + 12 notTaken + 18 elsewhere + 12 packages
 *
 * No two of those numbers describe the same set, and nothing compared them: 9 scripts that CI runs were outside the
 * derivation, 18 gate files prelive read were outside it too, and 5 `suite:` scripts the corpus reads are outside the
 * census by a deliberate choice nobody had written beside the number. Each reader was answering its own question
 * correctly; the tree was answering "how many gates are there" four ways.
 *
 * This gate does not merge them - they answer different questions, and merging them would make one of the answers
 * wrong. It asks the one question they all have to agree on: is every member accounted for?
 *
 * THE AUTHORITY is derived here, once, from what the tree already invokes:
 *
 *   A. SCRIPTS - every `.github/workflows/*.yml` step written `pnpm <script>` / `bun run <script>`, kept when the name
 *      is in the gate namespace `check-ci-coverage.mjs` exports (`GATE_NAME`, imported rather than restated: two
 *      spellings of that list disagree the first time one learns a member).
 *   B. FILES - every gate file on disk by the ONE rule `tools/lib/gate-population.mjs` exports (`isGateFile`), which is
 *      also what the census and the conformance suite filter by.
 *   C. REGISTERS - every member the four register files name: `tools/check-prelive-gate-registry.mjs`'s `EXEMPTIONS`,
 *      `tools/gate-red-proof-baseline.json`, `tools/gate-population-baseline.json`,
 *      `tools/tool-test-corpus-quarantine.json`.
 *
 * THE CONSUMERS are read through their own entry points - `deriveCiCoverage`, `derivePopulation`, `auditGateRedProofs`,
 * `corpusMembers` - never re-derived, so a consumer that changes its reading changes this gate's verdict the same day
 * instead of drifting from a copy.
 *
 * WHAT IT ASKS, and each finding names its member:
 *
 *   `gate_population_unread_script:<script>`      a workflow invokes it, and no consumer reads it. A gate CI runs for
 *                                                nobody's ledger is a gate nobody notices going quiet.
 *   `gate_population_unread_file:<path>`          a gate file the index carries that neither the census nor the
 *                                                prelive register reads.
 *   `gate_population_reads_a_falsifier:<by>:<p>`  a consumer's population holds a file `isGateFile` calls a falsifier
 *                                                (a `.test.mjs` / `.mutation.mjs`). A falsifier owes no red proof, so
 *                                                counting one as a gate asks the census for a proof of the proof.
 *   `gate_population_invented_member:<reg>:<m>`   a register names a member that is not a gate at all: not a
 *                                                `package.json` script and not a path on disk.
 *
 * ZERO IS BLOCKED, never green: an empty half means the derivation read nothing, which agrees with itself.
 *
 * USAGE:
 *   node tools/check-gate-population-agreement.mjs           # the reading; exit 1 on a disagreement
 *   node tools/check-gate-population-agreement.mjs --json    # machine output
 *
 * red-proof: history  before this file's own fix landed, the real tree was red by exactly one member of exactly this
 *   shape: `gate_population_reads_a_falsifier: check-prelive-gate-registry.mjs:
 *   tools/check-stardew-loop-closure.mutation.mjs`, exit 1 - the register counted a mutation driver as a gate while its
 *   own exemption entry for that path called it "a mutation driver, not a gate"
 *   (tools/check-gate-population-agreement.test.mjs)
 *
 * No game, no network, no model. It reads files and four export functions.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditGateRedProofs } from "./audit-gate-red-proofs.mjs";
import { deriveCiCoverage, GATE_NAME } from "./check-ci-coverage.mjs";
import { derivePopulation, EXEMPTIONS } from "./check-prelive-gate-registry.mjs";
import { deriveGatePopulation, isGateFile } from "./lib/gate-population.mjs";
import { corpusMembers } from "./run-tool-test-corpus.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";
const REGISTERS = Object.freeze({
  "gate-red-proof-baseline.json": "tools/gate-red-proof-baseline.json",
  "gate-population-baseline.json": "tools/gate-population-baseline.json",
  "tool-test-corpus-quarantine.json": "tools/tool-test-corpus-quarantine.json",
});
const BASELINE_ROW = /^(gate_without_population|gate_skip_can_pass|gate_pairs_a_subset_and_passes)\s+(\S+)$/u;

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Every word a workflow step hands to `pnpm` / `bun` / `npm`, up to the next `&&`, pipe or line end.
 *
 * The words are candidates, not answers: `pnpm --filter @gamebuddy/companion-host typecheck` and
 * `bun run --cwd tools test:corpus` both put their script last, behind flags whose values are not scripts, so the
 * caller filters the candidates against `package.json`'s script table instead of this function guessing the grammar.
 */
export function workflowInvocations(text) {
  const names = new Set();
  for (const match of text.matchAll(/\b(?:pnpm|bun|npm)\s+([^\n&|;]*)/gu))
    for (const token of match[1].split(/\s+/u)) if (/^[a-zA-Z][\w:-]*$/u.test(token)) names.add(token);
  return names;
}

/** The scripts the workflows invoke that the gate namespace claims: the half of the authority CI itself decides. */
export function invokedGateScripts({ scripts, workflowTexts }) {
  const invoked = new Set();
  for (const text of workflowTexts) for (const name of workflowInvocations(text)) invoked.add(name);
  return [...invoked].filter((name) => scripts[name] !== undefined && GATE_NAME.test(name)).sort();
}

/** Every member a register names, with the register that names it. */
export function registerMembers({ root, exemptions }) {
  const members = [];
  for (const entry of exemptions) members.push({ register: "prelive EXEMPTIONS", member: entry.path });
  for (const [label, path] of Object.entries(REGISTERS)) {
    const text = read(join(root, path));
    if (text === null) continue;
    const parsed = JSON.parse(text);
    const rows = label === "tool-test-corpus-quarantine.json" ? (parsed.exclusions ?? []) : (parsed.gates ?? []);
    for (const row of rows) {
      const raw = typeof row === "string" ? row : (row.path ?? row.suite ?? row.gate ?? "");
      const member = label === "gate-population-baseline.json" ? (BASELINE_ROW.exec(raw)?.[2] ?? raw) : raw;
      if (member.length > 0) members.push({ register: label, member });
    }
  }
  return members;
}

/**
 * The reading, from readings rather than from the file system: the consumers' own answers plus the three surfaces.
 *
 * `census` is `auditGateRedProofs`'s result, `prelive` is `derivePopulation()`'s list, `corpus` is `corpusMembers`'s
 * result, and `disk` is the gate files on disk. Everything here is a set comparison, so the test can drive it with
 * synthetic trees without touching the repository.
 */
export function agree({ root, invoked, scripts, disk, census, prelive, corpus, registers, untracked = [] }) {
  const findings = [];
  const censusFiles = new Set(census.records.flatMap((record) => record.entryFiles));
  const censusScripts = new Set(census.records.filter((record) => scripts[record.id] !== undefined).map((r) => r.id));
  const corpusNames = new Set([
    ...corpus.members.map((member) => member.name),
    ...corpus.notTaken.map((entry) => entry.name),
    ...corpus.elsewhere.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    ...corpus.packages.map((entry) => (typeof entry === "string" ? entry : entry.name)),
  ]);
  const preliveSet = new Set(prelive);
  const ciNames = new Set(census.ciGateScripts);

  for (const name of invoked)
    if (!ciNames.has(name) && !corpusNames.has(name) && !censusScripts.has(name))
      findings.push({ code: "gate_population_unread_script", id: name, detail: "no consumer reads it" });

  const untrackedSet = new Set(untracked);
  for (const file of disk)
    if (!untrackedSet.has(file) && !censusFiles.has(file) && !preliveSet.has(file))
      findings.push({
        code: "gate_population_unread_file",
        id: file,
        detail: "neither the census nor prelive reads it",
      });

  for (const member of prelive)
    if (member.startsWith("tools/") && !isGateFile(member.replace(/^tools\//u, "")))
      findings.push({
        code: "gate_population_reads_a_falsifier",
        id: `check-prelive-gate-registry.mjs:${member}`,
        detail: "a falsifier is not a gate, so it owes no red proof",
      });

  for (const { register, member } of registers) {
    const onDisk = existsSync(join(root, member));
    const isScript = scripts[member] !== undefined;
    if (!onDisk && !isScript)
      findings.push({
        code: "gate_population_invented_member",
        id: `${register}:${member}`,
        detail: "not a package.json script and not a path on disk",
      });
  }

  return {
    findings,
    counts: {
      invoked: invoked.length,
      gateScripts: ciNames.size,
      corpusScripts: corpusNames.size,
      censusScripts: censusScripts.size,
      diskFiles: disk.length,
      preliveMembers: prelive.length,
      censusGates: census.records.length,
      registers: registers.length,
    },
    coverage: {
      unreadScripts: invoked.filter((name) => !ciNames.has(name) && !corpusNames.has(name) && !censusScripts.has(name)),
      unreadFiles: disk.filter((file) => !untrackedSet.has(file) && !censusFiles.has(file) && !preliveSet.has(file)),
    },
  };
}

/** Read the real tree: the consumers through their own entry points, the surfaces through their own files. */
export function readAgreement({ root = REPOSITORY_ROOT } = {}) {
  const packageText = read(join(root, "package.json"));
  if (packageText === null) throw new Error("gate_population_agreement_package_json_missing");
  const scripts = JSON.parse(packageText).scripts ?? {};
  const workflowDir = join(root, WORKFLOW_DIR);
  const workflowTexts = existsSync(workflowDir)
    ? readdirSync(workflowDir)
        .filter((name) => /\.ya?ml$/u.test(name))
        .sort()
        .map((name) => read(join(workflowDir, name)) ?? "")
    : [];
  const ci = deriveCiCoverage({ scripts, workflowText: workflowTexts.join("\n") });
  const census = auditGateRedProofs({ root });
  const population = deriveGatePopulation({ root });
  const untracked = population.gateFiles
    .map((file) => file.entryFiles[0])
    .filter((file) => !census.records.some((record) => record.entryFiles.includes(file)));
  return agree({
    root,
    invoked: invokedGateScripts({ scripts, workflowTexts }),
    scripts,
    disk: population.gateFiles
      .map((file) => file.entryFiles[0])
      .filter((file) => isGateFile(file.replace(/^tools\//u, ""))),
    census: { ...census, ciGateScripts: ci.gateScripts.map((gate) => gate.name ?? gate) },
    prelive: derivePopulation(),
    corpus: corpusMembers({ root }),
    registers: registerMembers({ root, exemptions: EXEMPTIONS }),
    untracked,
  });
}

/** The self-verification report the conformance suite reads: a `gate` id, a population, and one entry per question. */
export function buildReport({ counts, findings }) {
  const status = counts.gateScripts + counts.diskFiles === 0 ? "blocked" : findings.length === 0 ? "passed" : "failed";
  return {
    gate: "gate_population_agreement/v1",
    status,
    population: counts.gateScripts + counts.diskFiles,
    examined: counts.invoked + counts.diskFiles + counts.registers,
    consumers: counts,
    checks: [
      "gate_population_unread_script",
      "gate_population_unread_file",
      "gate_population_reads_a_falsifier",
      "gate_population_invented_member",
    ].map((code) => ({
      id: code,
      status: findings.some((finding) => finding.code === code) ? "failed" : "passed",
      detail: `${findings.filter((finding) => finding.code === code).length} member(s)`,
    })),
  };
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex < 0 ? REPOSITORY_ROOT : resolve(argv[rootIndex + 1] ?? "");
  const { findings, counts, coverage } = readAgreement({ root });
  const report = buildReport({ counts, findings });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...report }, null, 2)}\n`);
    return report.status === "blocked" ? 2 : report.status === "passed" ? 0 : 1;
  }

  process.stdout.write(
    `gate populations: invoked ${counts.invoked} · ci-coverage scripts ${counts.gateScripts} · corpus names ${counts.corpusScripts} · census scripts ${counts.censusScripts} · gate files ${counts.diskFiles} · prelive members ${counts.preliveMembers} · census gates ${counts.censusGates} · register members ${counts.registers}\n`,
  );
  process.stdout.write(
    `gate_population_agreement coverage: scripts every consumer reads ${counts.invoked - coverage.unreadScripts.length} of ${counts.invoked} · gate files ${counts.diskFiles - coverage.unreadFiles.length} of ${counts.diskFiles}\n`,
  );
  if (counts.gateScripts + counts.diskFiles === 0) {
    process.stdout.write(`gate_population_agreement_population_empty: the derivation read nothing under ${root}\n`);
    return 2;
  }
  for (const finding of findings) process.stdout.write(`${finding.code}: ${finding.id} - ${finding.detail}\n`);
  if (findings.length === 0) process.stdout.write("gate_population_agreement: passed\n");
  else process.stdout.write(`gate_population_agreement: failed - ${findings.length} member(s) disagree\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
