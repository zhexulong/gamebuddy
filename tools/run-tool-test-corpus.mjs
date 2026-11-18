#!/usr/bin/env node
/**
 * Aggregate entry point for the `tools/**` suite corpus.
 *
 * Every root `test:*`/`suite:*` script that runs `node --test` over files under `tools/` and is invoked by no
 * other entry point lands here. That corpus is large (160 scripts, 235 suite files, ~2500 tests) and, before this
 * step, no CI job ran a single one of them, so a suite could rot - or be deleted - without anything noticing.
 *
 * The corpus is DERIVED from package.json on every run, never pinned: a new `test:`/`suite:` script over a
 * `tools/` suite is wired in by existing. Scripts that another entry point already runs (`ci.yml`,
 * `release-windows.yml`, `test`, `test:all`, `test:dialogue-web`, `typecheck`) are not this
 * step's business, and neither are the `integrations/stardew/action-development` suites, which `ci.yml`'s
 * stardew-scaffold job runs through its own package.
 *
 * THE VERDICT HAS TWO HALVES, and they used to share one sentence. One red member made the aggregate red with
 * a wall of failures and no statement of which member was responsible - 85 failures of 2506, of which the
 * decisive one was `test:stardew-native-multiplayer-sensitivity` - and `test:dialogue-web-boundaries` was red
 * for the opposite reason, a hand list 30 entries behind the tree. Those are different defects with different
 * owners, so each member now runs on its own and the step reports:
 *
 *   corpus_population:<N> members (<F> suite files)   what the derivation found
 *   corpus_examined:<M> test:/suite: scripts            the population those members are read against
 *   corpus_derivation:ok|defect:<why>                whether the corpus itself is what it claims to be
 *   corpus_untaken:<n> of <M>                        `test:`/`suite:` scripts nothing in CI runs, named below
 *   members_failed:<N>                               how many members are red in their own run
 *   corpus_responsible:<member,member>               the members to blame, named once each
 *   member <name> · exit <n> · <first failing line>  at most five, then a count of the rest
 *
 * A red member is never reported as a derivation defect and a derivation defect is never hidden behind member
 * failures. A red member still fails the step, and a step with no members at all is a defect, never a pass:
 * this unit changes attribution, not the verdict. A script that is not a corpus member is a third reading again,
 * and it does not fail the step - it is named, with the run that would take it.
 *
 * Suites that already need an environment prerequisite skip themselves with a named reason (`{ skip }` on the
 * test). A suite that is red for an attributed reason stays out of the run through
 * `tool-test-corpus-quarantine.json`; that file is a list of defects with owners, not a mute button, so each
 * entry must name a corpus file and must still fail on its own. An entry that starts passing fails this step
 * until someone deletes it.
 *
 * Usage:
 *   node tools/run-tool-test-corpus.mjs                 # the aggregate
 *   node tools/run-tool-test-corpus.mjs --root <dir>    # the same reading of a copy of the tree
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { containedChildEnvironment } from "./lib/crash-report-containment.mjs";
import { cleanOutputLines } from "./lib/subprocess-output.mjs";
import { GATE_TREE_ROOTS } from "../gates/directories.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PER_TEST_TIMEOUT = "--test-timeout=120000";
const MEMBER_TIMEOUT_MS = 5 * 60_000;
// The single-file run this replaces let node's own runner decide how many files ran at once, and it spawns one
// child per file - `availableParallelism() - 1` of them. A member pool of the same width keeps that wall time,
// and still gives each member its own run to read.
const MEMBER_CONCURRENCY = Math.max(2, availableParallelism() - 1);
/** How many failing members the aggregate prints in full before it counts the rest. */
export const MEMBER_DETAIL_LIMIT = 5;
const QUARANTINE_PATH = "tools/tool-test-corpus-quarantine.json";
/** The `package.json` scripts treated as entry points: a script they name is a run that already happens. */
const ENTRY_POINT_SCRIPTS = Object.freeze(["test", "test:all", "test:dialogue-web", "typecheck"]);
/** The date the `untaken` exemption was recorded. Its EXPIRY is not the date: it is the claim, read on every run. */
const UNCLAIMED_EXEMPTION_DATED = "2026-11-14";
const ENTRY_POINT_FILES = Object.freeze([".github/workflows/ci.yml", ".github/workflows/release-windows.yml"]);
// A member is run, not reported to a test runner: a `node --test` child that inherits `NODE_TEST_CONTEXT` writes
// nothing and exits 0, so a red member read from inside a suite would look green.
const MEMBER_ENV = Object.fromEntries(
  Object.entries(containedChildEnvironment()).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
);

/** A script whose NAME claims it runs something: the corpus's population, whatever its command looks like. */
const TEST_NAMESPACE = /^(?:test|suite):/u;
/** A repo-relative file a command names: what `packageSuiteOwner` resolves an owner from. */
const COMMAND_FILE = /[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|cjs|js|tsx|ts|py|ps1)/gu;
/** The file shape a package's own test runner walks: `<package>/tests/<name>.test.mjs`. */
const PACKAGE_SUITE_FILE = /(?:^|\/)tests\/[a-z0-9][a-z0-9-]*\.test\.mjs$/u;

function invokedByAnEntryPoint(scriptName, entryPointBlob) {
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w:-])${escaped}([^\\w:-]|$)`).test(entryPointBlob);
}

function readIn(root, relative) {
  try {
    return readFileSync(resolve(root, relative), "utf8");
  } catch {
    return "";
  }
}

/**
 * The `gate suite` directories one script command runs - or null when the command is not `node --test …` over a
 * directory a gate suite lives in. Flags are kept in order and re-issued with the run; only the files are read as paths.
 *
 * THE ROOTS ARE DERIVED FROM `gates/directories.mjs`, not written here. Written out, this rule said `tools/` alone, and the
 * day twelve suites moved to `gates/meta/` the corpus lost them without a word: `corpusFiles` 400 -> 388 and no gate
 * could see the gap, because a command the rule rejects leaves both the run and the report. A file whose NAME says it is
 * a gate's falsifier but whose directory no root covers is therefore refused loudly rather than dropped.
 *
 * Two spellings are outside this rule and are named rather than guessed at, because a rule that silently drops
 * a script is a corpus that shrinks without saying so: `node --flag --test …` (a flag before `--test`, so the
 * command is not the runner's own form) and a chained line (`node --test a.mjs && node --test b.mjs`, one
 * script for two runs). Neither appears in package.json today.
 */
const GATE_FALSIFIER = /^(?:check|audit)-.*\.test\.mjs$/u;
const basenameOf = (file) => file.replace(/^.*\//u, "");
const inGateDirectory = (file) => GATE_TREE_ROOTS.some((root) => file.startsWith(`${root}/`));

function memberCommand(command) {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "node" || tokens[1] !== "--test") return null;
  const rest = tokens.slice(2);
  const files = rest.filter((token) => !token.startsWith("-"));
  if (files.length === 0) return null;
  if (!files.every(inGateDirectory)) {
    const unrooted = files.filter((file) => GATE_FALSIFIER.test(basenameOf(file)) && !inGateDirectory(file));
    return unrooted.length === 0 ? null : { unrooted };
  }
  return { flags: rest.filter((token) => token.startsWith("-")), files };
}

/**
 * The corpus, member by member: one package.json script per member, the gate-suite files it runs, the scripts that run
 * such a suite the derivation does not take, and the scripts naming a gate falsifier that no gate directory covers -
 * the reading that says whether the corpus is behind the tree rather than red.
 */
export function corpusMembers({ root = ROOT } = {}) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const workflowTexts = ENTRY_POINT_FILES.map((file) => [file, readIn(root, file)]);
  const entryPoints = [
    ...workflowTexts.map(([, text]) => text),
    ...ENTRY_POINT_SCRIPTS.map((name) => pkg.scripts[name]),
  ].join("\n");
  const members = [];
  const elsewhere = [];
  const packages = [];
  const notTaken = [];
  const unrooted = [];
  for (const [name, command] of Object.entries(pkg.scripts)) {
    const named = TEST_NAMESPACE.test(name);
    const run = memberCommand(command);
    if (run === null) continue;
    if (run.unrooted !== undefined) {
      unrooted.push({ name, command, files: run.unrooted });
      continue;
    }
    if (invokedByAnEntryPoint(name, entryPoints)) continue;
    // `suite:` names a library's own tests, `test:` names a gate's. Both run here; only `test:` carries the
    // meta-gate's obligation to state a falsifier, which is why the two prefixes exist separately.
    if (!named) {
      notTaken.push({
        name,
        command,
        why: "it runs a `tools/` suite but is not a `test:`/`suite:` script",
        kind: "suite-outside-namespace",
      });
      continue;
    }
    members.push({ name, flags: run.flags, files: run.files });
  }
  return { members, notTaken, unrooted };
}

/**
 * The `test:*`/`suite:*` suite files the corpus takes.
 *
 * Exported because `gates/meta/check-spec-reachability.mjs` asks the same question - which gate suites a
 * checkout runs - and a second derivation of the same population would be a second authority for it.
 */
export function corpusFiles({ root = ROOT } = {}) {
  return [...new Set(corpusMembers({ root }).members.flatMap((member) => member.files))].sort();
}

/**
 * The first line that says a test failed, which is the one to read first: node's spec reporter marks it U+2716.
 * A member that died before printing one is reported by its last line, because that is the evidence left, and
 * a member with no output at all says so instead of showing an empty detail.
 *
 * THE MARK IS AN ESCAPE, NEVER THE GLYPH. The pre-commit hook formats each staged blob through biome's stdin mode,
 * and biome rewrites U+2716 to U+00D7 there: a literal in this file committed as `×`, and the matcher stopped
 * matching what node prints (`member test:broken · exit 1 · last line: at startSubtestAfterBootstrap …` instead of
 * the failing test). The escape is not reformatted, so the reading survives the hook that ships it.
 */
function firstFailingLine(output) {
  const lines = cleanOutputLines(output);
  const failure = lines.find((line) => line.startsWith("\u2716"));
  if (failure !== undefined) return failure.replace(/\s+\([\d.]+m?s\)$/u, "");
  const last = [...lines].reverse().find((line) => line !== "");
  return last === undefined ? "(no output)" : `last line: ${last}`;
}

/** One member's own run: the exit status, its captured output, and whether the ceiling killed it. */
function runMember({ name, flags, files }, root) {
  return new Promise((settle) => {
    let output = "";
    let timedOut = false;
    const child = spawn(process.execPath, ["--test", PER_TEST_TIMEOUT, ...flags, ...files], {
      cwd: root,
      env: MEMBER_ENV,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: MEMBER_TIMEOUT_MS,
      killSignal: "SIGTERM",
    });
    const ceiling = setTimeout(() => {
      timedOut = true;
    }, MEMBER_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(ceiling);
      settle({ name, status: 1, output: `${output}\n${error.message}`, timedOut });
    });
    child.on("close", (status) => {
      clearTimeout(ceiling);
      settle({ name, status, output, timedOut });
    });
  });
}

/** Every member's own run, `MEMBER_CONCURRENCY` at a time, in a stable order. */
async function runMembers(members, root) {
  const queue = [...members];
  const runs = [];
  const lane = async () => {
    for (let member = queue.shift(); member !== undefined; member = queue.shift())
      runs.push(await runMember(member, root));
  };
  await Promise.all(Array.from({ length: Math.min(MEMBER_CONCURRENCY, queue.length) }, lane));
  return runs.sort((left, right) => left.name.localeCompare(right.name));
}

const failed = (run) => run.status !== 0 || run.timedOut;
const detail = (run) =>
  run.timedOut
    ? "killed at the 5m ceiling"
    : `exit ${run.status === null ? "none" : run.status} · ${firstFailingLine(run.output)}`;

async function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : ROOT;
  const { members, notTaken, unrooted } = corpusMembers({ root });
  const quarantine = JSON.parse(readFileSync(resolve(root, QUARANTINE_PATH), "utf8")).exclusions;
  const corpus = [...new Set(members.flatMap((member) => member.files))].sort();
  const quarantined = new Set(quarantine.map((entry) => entry.file));
  const unknown = quarantine.filter((entry) => !corpus.includes(entry.file));
  const runnable = members
    .map((member) => ({ ...member, files: member.files.filter((file) => !quarantined.has(file)) }))
    .filter((member) => member.files.length > 0);

  // The derivation's own verdict. An empty corpus, a `tools/` suite no member takes, and a gate falsifier outside
  // every gate directory are defects of the rule, not debts of the members: a tree whose scripts stopped matching would
  // otherwise report a clean run.
  const derivation = [];
  if (members.length === 0)
    derivation.push(
      "no members: no `test:`/`suite:` script in package.json runs `node --test` over a gate directory's files",
    );
  for (const script of notTaken)
    derivation.push(
      `untaken ${script.name}: runs a gate suite but is neither a \`test:\`/\`suite:\` script nor run by an entry point (${script.command})`,
    );
  for (const script of unrooted)
    derivation.push(
      `unrooted ${script.name}: names a gate falsifier that no \`GATE_DIRECTORIES\` entry covers, so no command takes it (${script.files.join(", ")})`,
    );

  process.stdout.write(
    `corpus_population:${members.length} members (${corpus.length} suite files) elsewhere:${elsewhere.length} ` +
      `package:${packages.length} untaken:${notTaken.length} quarantined:${quarantine.length} run:${runnable.length}\n`,
  );
  // A count without its population is a number nobody can check: `members` is read against the `test:`/`suite:`
  // names package.json declares, the buckets have to add up to it, and whatever does not is named in the derivation.
  process.stdout.write(
    `corpus_examined:${namespace.length} test:/suite: scripts · ${members.length} members + ` +
      `${inNamespace(elsewhere)} elsewhere + ${inNamespace(packages)} package + ${inNamespace(notTaken)} untaken ` +
      `= ${taken} · dropped ${dropped.length} of ${namespace.length} · ` +
      `untaken ${inNamespace(notTaken)} of ${namespace.length}\n`,
  );
  if (outside.length > 0)
    process.stdout.write(
      `corpus_outside_namespace:${outside.length} script(s) this derivation reads that are not ` +
        `\`test:\`/\`suite:\` scripts: ${outside.join(",")}\n`,
    );
  for (const script of elsewhere)
    process.stdout.write(`corpus_elsewhere:${script.name}: an entry point names it, so this step would duplicate it\n`);
  for (const script of packages)
    process.stdout.write(`corpus_package:${script.name}: ${script.owner}'s own test script runs its files\n`);
  if (derivation.length === 0) process.stdout.write("corpus_derivation:ok\n");
  else {
    process.stdout.write(`corpus_derivation:defect:${derivation.length} script(s) the corpus does not take\n`);
    for (const line of derivation) process.stdout.write(`  ${line}\n`);
  }
  if (excused.length > 0) {
    process.stdout.write(
      `corpus_untaken:${inNamespace(notTaken)} of ${namespace.length} test:/suite: scripts nothing in this ` +
        `tree's CI runs; each is named below with the run that would take it, or with the date it was exempted\n`,
    );
    for (const script of excused) process.stdout.write(`  untaken ${script.name}: ${script.why} (${script.command})\n`);
  }

  const runs = await runMembers(runnable, root);
  const reds = runs.filter(failed);
  process.stdout.write(`members_failed:${reds.length}\n`);
  if (reds.length > 0) process.stdout.write(`corpus_responsible:${reds.map((run) => run.name).join(",")}\n`);
  for (const run of reds.slice(0, MEMBER_DETAIL_LIMIT)) process.stdout.write(`  member ${run.name} · ${detail(run)}\n`);
  if (reds.length > MEMBER_DETAIL_LIMIT)
    process.stdout.write(`  … and ${reds.length - MEMBER_DETAIL_LIMIT} more members failed, run them individually\n`);

  // The quarantine may only hold defects that are still there: run each excluded suite alone and refuse the
  // step if one has gone green.
  const stale = [];
  for (const entry of quarantine) {
    const [alone] = await runMembers([{ name: entry.file, flags: [], files: [entry.file] }], root);
    if (!failed(alone)) stale.push(entry);
  }
  if (unknown.length > 0)
    process.stderr.write(`tool_test_corpus_quarantine_unknown_file:${unknown.map((entry) => entry.file).join(",")}\n`);
  for (const entry of stale)
    process.stderr.write(
      `tool_test_corpus_quarantine_stale:${entry.file} passes now; delete it from ${QUARANTINE_PATH}\n`,
    );

  return derivation.length === 0 && reds.length === 0 && unknown.length === 0 && stale.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
