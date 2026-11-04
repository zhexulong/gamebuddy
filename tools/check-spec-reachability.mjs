#!/usr/bin/env node
/**
 * Reachability gate: a spec or a `node --test` suite that no command runs is a file nobody reads.
 *
 * WHY (measured 2026-11-04)
 *
 * Three shapes of the same defect were live in one tree. `tools/journey-walker.mjs` still imported
 * `./shots/lib/config.mjs` from a directory that had been renamed, and nothing noticed because no
 * command, script or workflow named `journey-walker` at all - a broken entry point cannot fail a check
 * that never loads it. `dialogue-web`'s static zone is a HAND-WRITTEN list of 36 suites in
 * `test:static`, so the thirty-seventh joins no list and runs nowhere. And 187 `tools/**\/*.test.mjs`
 * suites are named by no `node --test` command: the aggregate runner (`tools/run-tool-test-corpus.mjs`)
 * derives its corpus from `test:*` scripts, so a suite without its own script is invisible to the
 * aggregate too. Measured, not assumed: `--gaps` names all of them.
 *
 * THE POPULATION is three scans, so a new spec, a new static suite or a new tools suite joins on its
 * own and no list has to be kept in step:
 *
 *   A. every `*.spec.ts` under the Playwright config's own `testDir`, judged by that config's
 *      `testMatch`/`testIgnore` - the runner's declaration, not a pattern repeated here;
 *   B. every `*.test.mjs` under `dialogue-web/tests`;
 *   C. every `*.test.mjs` under `tools/` (hidden files and `fixtures/` trees excluded: a fixture tree is
 *      data a gate reads, not a suite).
 *
 * THE COMMAND SET is derived the way a runner resolves it: the workflow `run:` steps are the only
 * roots, a `pnpm`/`npm` invocation inside a step names a script of the package the step runs in, a
 * script's own command line names further scripts of ITS package, and a reachable `node --test`
 * command contributes the paths it names (resolved against its package directory). A file is reached
 * when some reachable command names it. The mounted zone is reached when the script whose command runs
 * `playwright test` is reached - deleting that step is the defect, and it makes every spec unreached.
 *
 * THE BASELINE. Group C is red at HEAD: 187 suites are named by no reachable command, which is measured
 * debt in a corpus this gate did not create. Writing 187 reachability scripts would be inventing a fix
 * for someone else's layer, so the reading is published instead: `tools/spec-reachability-baseline.json`
 * records those files, and the ratchet over that recording is the gate -
 *
 *   * an unreached file that is NOT in the baseline is a finding (a suite cannot arrive running nowhere);
 *   * a baseline entry that is reached now, or whose file is gone, is a finding (the baseline only
 *     tightens: delete the entry by making the file reachable);
 *   * a population that cannot be derived at all - no Playwright config, no `testDir` - is a finding,
 *     never a silent pass. It is also printed as `unassessed: <thing> - <reason>`.
 *
 * Usage:
 *   node tools/check-spec-reachability.mjs            # the ratchet; exit 1 on a new or stale entry
 *   node tools/check-spec-reachability.mjs --gaps     # every file no command reaches
 *   node tools/check-spec-reachability.mjs --json     # the whole reading, baseline included
 *   node tools/check-spec-reachability.mjs --update   # re-record the baseline, in its own commit
 *   node tools/check-spec-reachability.mjs --root <dir>   # the gate's own fixture
 *
 * red-proof: inject  a `tools/` suite added to a synthetic tree that no reachable `node --test` command
 *            names -> `unreached_suite` names that file, while the aggregate-run suite beside it stays
 *            green (tools/check-spec-reachability.test.mjs). The mounted half is falsified too: a spec
 *            the config's `testIgnore` excludes is named `unreached_spec`, and deleting the
 *            `playwright test` script's caller leaves `mounted_zone_unreached` with every spec behind it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { untrackedFiles } from "./lib/journey-source.mjs";
import { corpusFiles } from "./run-tool-test-corpus.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "tools/spec-reachability-baseline.json";
const PLAYWRIGHT_CONFIG = "dialogue-web/playwright.config.ts";

const finding = (code, detail, file = null) => ({ code, detail, file });

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const toPosix = (path) => path.split(sep).join("/");

/** Every file under `directory` whose name matches `accept`, as paths relative to `root`. */
function scan(directory, accept, root, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path, accept, root, out);
    else if (accept(entry.name)) out.push(toPosix(relative(root, path)));
  }
  return out;
}

/** A `#` comment is a YAML comment only at line start or after whitespace. */
function workflowText(root) {
  const directory = join(root, ".github", "workflows");
  if (!existsSync(directory)) return "";
  return readdirSync(directory)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => read(join(directory, name)) ?? "")
    .join("\n")
    .split("\n")
    .map((line) => (/^\s*#/u.test(line) ? "" : line.replace(/\s#.*$/u, "")))
    .join("\n");
}

/** One package, or null when the directory holds no manifest. */
function packageIn(root, directory) {
  const manifest = read(join(root, directory, "package.json"));
  return manifest === null
    ? null
    : { name: JSON.parse(manifest).name ?? "", dir: directory, scripts: JSON.parse(manifest).scripts ?? {} };
}

/** The workspace packages, from the workspace file's own `packages:` list, plus the root itself. */
export function workspacePackages(root) {
  const text = read(join(root, "pnpm-workspace.yaml"));
  const packages = [];
  for (const pattern of text === null
    ? []
    : [...text.matchAll(/^\s*-\s*'?([^'\n]+)'?\s*$/gmu)].map((m) => m[1].trim())) {
    if (pattern.startsWith("!")) continue;
    const parent = pattern.slice(0, -2);
    const directories = pattern.endsWith("/*")
      ? existsSync(join(root, parent))
        ? readdirSync(join(root, parent), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${parent}/${entry.name}`)
        : []
      : [pattern];
    for (const directory of directories) {
      const found = packageIn(root, directory);
      if (found !== null) packages.push(found);
    }
  }
  const rootPackage = packageIn(root, "");
  if (rootPackage !== null) packages.push(rootPackage);
  return packages;
}

/** Every `pnpm`/`npm`/`yarn` invocation in one command line, with its own flag targets. */
function invocations(command) {
  const tokens = command.split(/\s+/u).filter((token) => token !== "");
  const found = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!["pnpm", "npm", "yarn"].includes(tokens[index])) continue;
    let dir = null;
    let filter = null;
    let cursor = index + 1;
    while (cursor < tokens.length && tokens[cursor].startsWith("-")) {
      if (tokens[cursor] === "--dir" || tokens[cursor] === "-C") {
        dir = tokens[cursor + 1] ?? null;
        cursor += 2;
      } else if (tokens[cursor] === "--filter" || tokens[cursor] === "-F") {
        filter = tokens[cursor + 1] ?? null;
        cursor += 2;
      } else cursor += 1;
    }
    let name = tokens[cursor] ?? "";
    if (name === "run" || name === "run-script") name = tokens[cursor + 1] ?? "";
    if (name !== "" && name !== "exec" && name !== "dlx") found.push({ dir, filter, name });
    index = cursor;
  }
  return found;
}

/** The paths one `node --test` command names, resolved against the directory it runs in. */
function testPaths(command, packageDir) {
  const tokens = command.split(/\s+/u).filter((token) => token !== "");
  if (tokens[0] !== "node" && tokens[0] !== "nodejs") return [];
  const testFlag = tokens.indexOf("--test");
  if (testFlag < 0) return [];
  return tokens
    .slice(testFlag + 1)
    .filter((token) => !token.startsWith("-"))
    .map((token) => (packageDir === "" ? token : `${packageDir}/${token}`))
    .filter((token) => !/[&|]$/u.test(token));
}

/**
 * The commands a checkout actually runs: the workflow steps are the roots, and a script a reached
 * command names joins them, resolving `--filter`/`--dir` against the workspace's own packages.
 *
 * `--dir` names a directory, not a package: `vendor/pi-koe` is outside the workspace and still owns
 * scripts, so the directory's own manifest is read rather than looked up in the workspace list. A
 * directory with no manifest is recorded as unassessed instead of being silently skipped.
 */
export function reachableCommands({ root, packages, workflow }) {
  const rootPackage = packages.find((entry) => entry.dir === "");
  const reached = new Set();
  const commands = [];
  const testCommands = [];
  const unresolved = [];

  const packageAt = (directory, from) => {
    const normalised = toPosix(join(from.dir, directory)).replace(/\/$/u, "") || ".";
    if (normalised === ".") return rootPackage;
    const manifest = read(join(root, normalised, "package.json"));
    if (manifest === null) return null;
    return { name: JSON.parse(manifest).name ?? "", dir: normalised, scripts: JSON.parse(manifest).scripts ?? {} };
  };

  const resolveTarget = (invocation, from) => {
    if (invocation.dir !== null) return packageAt(invocation.dir, from);
    if (invocation.filter !== null) return packages.find((entry) => entry.name === invocation.filter) ?? null;
    return from;
  };

  const visit = (command, from) => {
    commands.push(command);
    for (const path of testPaths(command, from.dir)) testCommands.push(path);
    for (const invocation of invocations(command)) {
      const target = resolveTarget(invocation, from);
      if (target === null || target === undefined) {
        unresolved.push({ name: invocation.name, dir: invocation.dir ?? invocation.filter ?? "" });
        continue;
      }
      if (!(invocation.name in target.scripts)) continue;
      const key = `${target.dir}\u0000${invocation.name}`;
      if (reached.has(key)) continue;
      reached.add(key);
      visit(target.scripts[invocation.name], target);
    }
  };

  for (const line of workflow.split("\n")) {
    const step = /^\s*(?:-\s*)?run:\s*(.+)$/u.exec(line);
    if (step !== null) visit(step[1], rootPackage);
  }
  return { reached, commands, testCommands, unresolved };
}

/** `**\/*.spec.ts` as a `testDir`-relative matcher: `**\/` spans directories, `*` never does. */
function globToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*" && glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${source}$`, "u");
}

/** The Playwright declaration: where its specs live and which of them it will run. */
export function playwrightDeclaration(root) {
  const text = read(join(root, PLAYWRIGHT_CONFIG));
  if (text === null) return null;
  const string = (key) => new RegExp(`${key}:\\s*"([^"]+)"`, "u").exec(text)?.[1] ?? null;
  const list = (key) => {
    const literal = string(key);
    if (literal !== null) return [literal];
    const array = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`, "u").exec(text);
    if (array === null) return [];
    return [...array[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  };
  const testDir = string("testDir");
  if (testDir === null) return null;
  return { testDir: testDir.replace(/^\.\//u, ""), testMatch: list("testMatch"), testIgnore: list("testIgnore") };
}

/**
 * The whole reading: the three populations, the commands that reach them, and every file none reaches.
 *
 * `groups` carries each population's own name so a finding says which rule it broke, and
 * `header` says why the reading could not be taken when it could not.
 */
export function auditSpecReachability({ root = REPOSITORY_ROOT } = {}) {
  const packages = workspacePackages(root);
  const workflow = workflowText(root);
  const { reached, commands, testCommands, unresolved } = reachableCommands({ root, packages, workflow });
  // The aggregate runner derives its own corpus from `test:*` scripts and runs it in CI, so a suite the
  // aggregate takes is reached even though no single command line names it. That derivation is imported
  // rather than repeated: one authority for the corpus, not two that agree today.
  const corpusRunner = "tools/run-tool-test-corpus.mjs";
  const aggregate = commands.some((command) => command.includes(corpusRunner))
    ? new Set(corpusFiles({ root }))
    : new Set();
  const named = new Set([...testCommands.map((path) => toPosix(path)), ...aggregate]);
  // An untracked file is not in the commit this gate judges: judging one would fail another lane's
  // in-flight work, and recording one in the baseline would go stale the moment that lane lands it.
  const untracked = untrackedFiles(root);
  const committed = (file) => !untracked.has(file);
  const findings = [];
  const unassessed = [];
  if (untracked.size > 0)
    unassessed.push(`unassessed: ${untracked.size} untracked file(s) - not part of the commit this gate judges`);

  const declaration = playwrightDeclaration(root);
  const mountedScripts = packages.flatMap((entry) =>
    Object.entries(entry.scripts)
      .filter(([, command]) => /\bplaywright\s+test\b/u.test(command))
      .map(([name]) => ({ packageDir: entry.dir, name })),
  );
  const mountedReached = mountedScripts.filter((script) => reached.has(`${script.packageDir}\u0000${script.name}`));

  const specs = [];
  if (declaration === null) {
    unassessed.push(
      `unassessed: ${PLAYWRIGHT_CONFIG} - no config with a \`testDir\`, so the spec population cannot be derived`,
    );
    findings.push(
      finding("spec_population_unassessable", `${PLAYWRIGHT_CONFIG} declares no \`testDir\`, so no spec can be judged`),
    );
  } else {
    const directory = join(root, "dialogue-web", declaration.testDir);
    const matches = declaration.testMatch.map(globToRegExp);
    const ignored = declaration.testIgnore.map(globToRegExp);
    for (const file of existsSync(directory) ? scan(directory, (name) => name.endsWith(".spec.ts"), root) : []) {
      if (!committed(file)) continue;
      const local = file.slice(`dialogue-web/${declaration.testDir}/`.length);
      if (!matches.some((pattern) => pattern.test(local))) {
        specs.push({ file, reached: false, reason: "spec_not_matched_by_testMatch" });
        continue;
      }
      if (ignored.some((pattern) => pattern.test(local))) {
        specs.push({ file, reached: false, reason: "spec_excluded_by_testIgnore" });
        continue;
      }
      specs.push({
        file,
        reached: mountedReached.length > 0,
        reason: mountedReached.length > 0 ? "mounted_zone_reached" : "mounted_zone_unreached",
      });
    }
    if (mountedScripts.length === 0) {
      findings.push(
        finding(
          "mounted_runner_missing",
          "no package script runs `playwright test`, so the config's specs are run by nothing",
        ),
      );
    } else if (mountedReached.length === 0) {
      findings.push(
        finding(
          "mounted_zone_unreached",
          `no workflow step reaches ${mountedScripts.map((script) => script.name).join(", ")}, so all ${specs.length} specs run nowhere`,
        ),
      );
    }
  }

  const staticSuites = existsSync(join(root, "dialogue-web", "tests"))
    ? scan(join(root, "dialogue-web", "tests"), (name) => name.endsWith(".test.mjs"), root)
        .filter(committed)
        .map((file) => ({
          file,
          reached: named.has(file),
          reason: named.has(file) ? "named_by_a_reachable_node_test" : "named_by_no_reachable_node_test",
        }))
    : [];
  if (staticSuites.length === 0)
    unassessed.push("unassessed: dialogue-web/tests - no `*.test.mjs` found, so its suites cannot be judged");

  const toolsSuites = existsSync(join(root, "tools"))
    ? scan(join(root, "tools"), (name) => name.endsWith(".test.mjs") && !name.startsWith("."), root)
        .filter((file) => !file.split("/").includes("fixtures"))
        .filter(committed)
        .map((file) => ({
          file,
          reached: named.has(file),
          reason: named.has(file) ? "named_by_a_reachable_node_test" : "named_by_no_reachable_node_test",
        }))
    : [];

  const groups = [
    { id: "specs", population: specs, rule: "/**/*.spec.ts under the Playwright testDir" },
    { id: "static_suites", population: staticSuites, rule: "dialogue-web/tests/**/*.test.mjs" },
    { id: "tools_suites", population: toolsSuites, rule: "tools/**/*.test.mjs" },
  ];
  return {
    groups,
    unreached: groups.flatMap((group) =>
      group.population.filter((entry) => !entry.reached).map((entry) => ({ ...entry, group: group.id })),
    ),
    reachedCommands: reached.size,
    testCommands: named.size,
    mountedReached,
    unresolved,
    unassessed,
    findings,
  };
}

/** The recorded unreached set: readings measured and not yet closed, one path per line in the file. */
export function readBaseline(root) {
  const text = read(join(root, BASELINE_PATH));
  if (text === null) return { files: [], note: null };
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.files)) throw new Error("spec_reachability_baseline_malformed:files");
  return { files: parsed.files, note: parsed.note };
}

/** What one run says: a new unreached file, a recorded file that is reachable now, or an underivable set. */
export function evaluate({ reading, baseline }) {
  const recorded = new Set(baseline.files);
  const unreached = new Set(reading.unreached.map((entry) => entry.file));
  const findings = [...reading.findings];
  for (const entry of reading.unreached) {
    if (recorded.has(entry.file)) continue;
    findings.push(
      finding(
        entry.group === "specs" ? "unreached_spec" : "unreached_suite",
        `${entry.reason}: no reachable command names it (${entry.group})`,
        entry.file,
      ),
    );
  }
  for (const file of baseline.files) {
    if (unreached.has(file)) continue;
    findings.push(
      finding(
        "baseline_entry_stale",
        `this file is reached now (or no longer exists); delete its entry so the baseline only tightens`,
        file,
      ),
    );
  }
  return { findings, held: reading.unreached.filter((entry) => recorded.has(entry.file)).length };
}

function report({ reading, findings, held, gaps }) {
  const count = (group) => reading.groups.find((entry) => entry.id === group).population.length;
  const unreached = (group) =>
    reading.groups.find((entry) => entry.id === group).population.filter((row) => !row.reached);
  process.stdout.write(
    `spec_reachability specs=${count("specs")} dialogue_web_suites=${count("static_suites")} ` +
      `tools_suites=${count("tools_suites")} reached_commands=${reading.reachedCommands} ` +
      `node_test_targets=${reading.testCommands} unreached=${reading.unreached.length} held=${held}\n`,
  );
  for (const group of reading.groups) {
    const missing = unreached(group.id);
    process.stdout.write(`  ${group.id}: ${missing.length} of ${group.population.length} unreached (${group.rule})\n`);
  }
  for (const line of reading.unassessed) process.stdout.write(`  ${line}\n`);
  for (const entry of reading.unresolved)
    process.stdout.write(`  unassessed: ${entry.dir || "(root)"} ${entry.name} - not a script of that package\n`);
  if (gaps) for (const entry of reading.unreached) process.stdout.write(`  gap:${entry.group}:${entry.file}\n`);
  process.stdout.write(
    `  ${reading.unreached.length} file(s) no command reaches; ${held} of them are recorded in ${BASELINE_PATH}\n`,
  );
  for (const entry of findings)
    process.stderr.write(`spec_reachability_${entry.code}:${entry.file ?? "-"}: ${entry.detail}\n`);
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = auditSpecReachability({ root });
  if (argv.includes("--update")) {
    const files = reading.unreached.map((entry) => entry.file).sort();
    writeFileSync(
      join(root, BASELINE_PATH),
      `${JSON.stringify(
        {
          schema: "gamebuddy-spec-reachability-baseline/v1",
          note: "Files no reachable command names, measured at this commit. A record of debt, not an acceptance of it: delete an entry by making the file reachable, never by recording more.",
          files,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stdout.write(`spec_reachability_baseline_recorded files=${files.length} into ${BASELINE_PATH}\n`);
    return 0;
  }
  const { findings, held } = evaluate({ reading, baseline: readBaseline(root) });
  if (argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ ...reading, held, findings, baseline: readBaseline(root).files.length }, null, 2)}\n`,
    );
    return findings.length === 0 ? 0 : 1;
  }
  report({ reading, findings, held, gaps: argv.includes("--gaps") });
  if (findings.length > 0)
    process.stderr.write(
      "  fix: name the file from a `node --test` command a workflow reaches (or, for a spec, let the\n" +
        "       Playwright config's testMatch accept it). A file that runs nowhere is a file nobody reads.\n",
    );
  return findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
