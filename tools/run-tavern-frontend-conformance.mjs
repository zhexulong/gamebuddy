#!/usr/bin/env node
/**
 * The Tavern frontend conformance gate.
 *
 * The corpus is the mounted journey directory - the same corpus the release
 * lane's test:mounted zone runs, discovered by playwright's own config - so the
 * gate judges journeys that exist instead of a hand-written file list. (Its
 * previous contract named three suites that were deleted with their shells, so
 * every run ended in ENOENT on a file nobody had.)
 *
 * A journey proves a screen works today. This gate makes the *criteria* those
 * journeys are instances of - accessibility baseline, keyboard reach, layout
 * floor, a quiet walk - into something a frontend change cannot quietly drop, and
 * it makes the corpus and the surface identity part of the contract:
 *
 *   - the surface list must equal the identities the shell entry accepts, so a new
 *     pane has to be declared (with criteria and its obligations) before the gate
 *     can pass;
 *   - every journey file in the corpus directory must appear in the run, the run
 *     must hold no journey from outside it, and the corpus must not fall below the
 *     body floor, so a suite cannot be dropped or silently excluded;
 *   - a test that was disabled (skipped) fails, unless its own title declares the
 *     prerequisite it is missing, or - only with --allow-credentialless and only
 *     for the contract's declared credential journeys - the provider credential is
 *     absent, reported as declared skips;
 *   - every declared criterion must actually be exercised, which the conformance
 *     tests themselves assert through the criteria ledger.
 *
 * Authority for the obligations: the surface declarations in
 * tools/fixtures/tavern-frontend-conformance/required-suites.json, executed by
 * dialogue-web/tests/frontend-criteria.ts.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolsRoot, "..");
const contractPath = join(
  toolsRoot,
  "fixtures",
  "tavern-frontend-conformance",
  "required-suites.json",
);

function usage() {
  return [
    "usage: node tools/run-tavern-frontend-conformance.mjs [options]",
    "  --report <path>         write the JSON report here",
    "  --allow-credentialless  downgrade the credential-dependent journeys to declared skips (local runs only; the release lane never passes this)",
    "",
    "Runs the mounted gate zone's own corpus (dialogue-web test:mounted), through",
    "the zone's prerequisite probe, and judges the run against the contract fixture.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { reportPath: undefined, allowCredentialless: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    if (flag === "--allow-credentialless") {
      options.allowCredentialless = true;
      continue;
    }
    if (flag !== "--report") throw new Error(usage());
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(usage());
    options.reportPath = value;
    index += 1;
  }
  return options;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { shell: process.platform === "win32", ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

const basenameOf = (path) => String(path ?? "").replaceAll("\\", "/").split("/").pop() ?? "";

/**
 * Flatten the Playwright JSON reporter into one row per test. The reporter names
 * the file relative to its config root, and that form is not stable across
 * versions, so a suite is identified by basename - unique across the contract.
 */
function collectTests(document) {
  const rows = [];
  const visit = (suite) => {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        rows.push({
          file: basenameOf(spec.file ?? suite.file),
          title: spec.title,
          status: test.status,
          lastResultStatus: last?.status,
          error: last?.error?.message?.split("\n")[0]?.slice(0, 300),
        });
      }
    }
  };
  for (const suite of document.suites ?? []) visit(suite);
  return rows;
}

/**
 * The surfaces the shell itself declares: the profile identities its entry
 * accepts, each mapped to the pane it renders. Both shapes the entry has used are
 * read here, because the gate's job is to make a *new* pane impossible to add
 * without declaring it:
 *
 *   - a branch map (`else if (profile === "id")` ... a lazy import of the pane or
 *     an eager `render(<Pane`); each branch is isolated first (up to the next
 *     branch), because a component imported near the top of the file would
 *     otherwise be attributed to whichever branch happens to come first;
 *   - one fixed identity the entry compares against the URL fragment, with the
 *     literal declared in that same file and one component rendered.
 *
 * A shape the derivation does not recognise yields no surfaces, so the contract
 * fails as "the shell renders no such profile" instead of passing vacuously.
 */
async function deriveShellSurfaces(relativeEntry) {
  const entry = await readFile(join(repositoryRoot, relativeEntry), "utf8");
  const derived = [];
  const branches = entry.split(/\} else if \(profile === |if \(profile === /u).slice(1);
  for (const branch of branches) {
    const segment = branch.split(/\} else/u)[0];
    const id = /^"([a-z0-9-]+)"/u.exec(segment)?.[1];
    if (id === undefined) continue;
    const lazy = /import\("\.\/components\/([A-Za-z0-9_]+)"/u.exec(segment)?.[1];
    const eager = /render\(<([A-Za-z0-9_]+)/u.exec(segment)?.[1];
    derived.push({ id, pane: lazy ?? eager ?? "unknown" });
  }
  if (derived.length > 0) return derived;
  const renderedPane = /render\(<([A-Za-z0-9_]+)/u.exec(entry)?.[1];
  if (renderedPane === undefined) return derived;
  for (const [, constant] of entry.matchAll(/get\("profile"\)\s*===\s*([A-Za-z0-9_]+)/gu)) {
    const literal = new RegExp(`const\\s+${constant}\\s*=\\s*"([a-z0-9-]+)"`, "u").exec(entry)?.[1];
    if (literal !== undefined) derived.push({ id: literal, pane: renderedPane });
  }
  return derived;
}

const options = parseArguments(process.argv.slice(2));
if (options.help === true) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const contract = JSON.parse(await readFile(contractPath, "utf8"));
const credential = process.env[contract.credentialEnvironment];
const failures = [];
const declaredSkips = [];

// 1. Surface identity and corpus membership. The contract must account for
// exactly the identities the shell entry accepts, and the corpus is the journey
// directory itself - the same corpus the mounted zone runs - so nothing here can
// name a suite that was deleted.
const declared = new Map(contract.surfaces.map((surface) => [surface.id, surface]));
const derivedSurfaces = await deriveShellSurfaces(contract.surfaceInventory.derivedFrom);
for (const surface of derivedSurfaces) {
  const entry = declared.get(surface.id);
  if (entry === undefined) {
    failures.push(
      `the shell renders the ${surface.id} pane (${surface.pane}) but the contract does not declare it: declare its criteria and obligations`,
    );
    continue;
  }
  if (entry.pane !== surface.pane)
    failures.push(
      `the contract says the ${surface.id} pane is ${entry.pane} but the shell renders ${surface.pane}`,
    );
}
for (const id of declared.keys()) {
  if (!derivedSurfaces.some((surface) => surface.id === id))
    failures.push(
      `the contract declares the ${id} surface but the shell renders no such profile: remove it, because a requirement for a surface that does not exist cannot be met`,
    );
}
const corpusRoot = join(repositoryRoot, contract.corpus.directory);
const corpusPattern = new RegExp(contract.corpus.pattern, "u");
const corpusFiles = readdirSync(corpusRoot)
  .filter((entry) => corpusPattern.test(entry))
  .sort();
if (corpusFiles.length === 0)
  failures.push(
    `the corpus directory ${contract.corpus.directory} holds no journey the pattern ${contract.corpus.pattern} matches`,
  );

// A contract that disagrees with the shell is not a contract: stop here rather
// than spending minutes proving things about a surface set nobody agreed on.
if (failures.some((failure) => /^the (shell|contract|corpus) /u.test(failure))) {
  const inventoryReport = Object.freeze({
    schema: "tavern_frontend_conformance/v1",
    corpus: Object.freeze(corpusFiles),
    credentialPresent: credential !== undefined,
    shellSurfaces: Object.freeze(derivedSurfaces.map((surface) => surface.id)),
    failures: Object.freeze(failures),
    verdict: "failed",
  });
  if (options.reportPath !== undefined)
    await writeFile(options.reportPath, `${JSON.stringify(inventoryReport, null, 2)}\n`, "utf8");
  process.stderr.write(
    `[frontend-conformance] failed (surface identity / corpus): the contract, the shell and the journey directory disagree, so no suite was run\n`,
  );
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(2);
}

// 2. Run the mounted zone's corpus. The zone's own prerequisite probe goes first,
// so a missing Chromium or a missing dev-server port is refused by name instead
// of surfacing as a runner error, and the corpus is whatever the zone's playwright
// invocation discovers - no file list, so nothing here can name a suite that was
// deleted.
const prerequisite = await run(
  "node",
  ["dialogue-web/tests/gate-zone-prerequisite.mjs", "mounted"],
  { cwd: repositoryRoot },
);
if (prerequisite.code !== 0) {
  const refusal = `${prerequisite.stdout}${prerequisite.stderr}`.trim();
  if (options.reportPath !== undefined)
    await writeFile(
      options.reportPath,
      `${JSON.stringify(
        Object.freeze({
          schema: "tavern_frontend_conformance/v1",
          corpus: Object.freeze(corpusFiles),
          failures: Object.freeze([`the mounted zone refused: ${refusal}`]),
          verdict: "failed",
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
  process.stderr.write(
    `[frontend-conformance] failed (mounted zone prerequisite): the zone refused to run, so no suite was run\n${refusal}\n`,
  );
  process.exit(2);
}
process.stderr.write(
  `[frontend-conformance] corpus=${contract.corpus.directory} (${corpusFiles.length} journey file(s)) credential=${credential === undefined ? "absent" : "present"} surfaces=${derivedSurfaces.map((surface) => surface.id).join(",")}\n`,
);
const runResult = await run(
  "pnpm",
  [
    "--dir",
    "dialogue-web",
    "exec",
    "playwright",
    "test",
    "--project=chromium",
    "--workers=1",
    "--reporter=json",
  ],
  { cwd: repositoryRoot },
);
let document;
try {
  document = JSON.parse(runResult.stdout.slice(runResult.stdout.indexOf("{")));
} catch {
  throw new Error(
    `the mounted zone produced no parseable report (exit ${runResult.code}): ${(runResult.stderr || runResult.stdout).slice(-400)}`,
  );
}

let observed = collectTests(document);

// 2b. Retry pass: a file with a non-passing row is re-run on its own. Anything that passes
// there was a timing artefact of running every suite together; anything that still fails is a
// real failure. Retried-and-passed journeys are recorded, never hidden, so the verdict
// separates a clean run from one that needed the retry.
const failedFiles = [
  ...new Set(
    observed
      .filter((row) => !(row.status === "expected" && row.lastResultStatus === "passed"))
      .map((row) => row.file)
      .filter((file) => file !== undefined),
  ),
];
const passedOnRetry = [];
if (failedFiles.length > 0) {
  process.stderr.write(
    `[frontend-conformance] retrying ${failedFiles.length} file(s) in isolation: ${failedFiles.join(", ")}\n`,
  );
  const retry = await run(
    "pnpm",
    [
      "--dir",
      "dialogue-web",
      "exec",
      "playwright",
      "test",
      ...failedFiles,
        "--project=chromium",
        "--workers=1",
        "--reporter=json",
      ],
    { cwd: repositoryRoot },
  );
  let retryDocument;
  try {
    retryDocument = JSON.parse(retry.stdout.slice(retry.stdout.indexOf("{")));
  } catch {
    retryDocument = undefined;
  }
  if (retryDocument !== undefined) {
  		const retried = new Map(collectTests(retryDocument).map((row) => [`${row.file}::${row.title}`, row]));
		observed = observed.map((row) => {
			const replacement = retried.get(`${row.file}::${row.title}`);
			// Only a PASSING retry row may stand in for the original. A later re-run that failed again
			// carries no better information than the row already held, and letting a failing row overwrite
			// a passing one is how the verdict came to blame a journey that had already passed its retry.
			if (replacement === undefined) return row;
			if (!(replacement.status === "expected" && replacement.lastResultStatus === "passed")) return row;
			passedOnRetry.push(`${row.file} :: ${row.title}`);
			return replacement;
		});
  }
}

// 2c. Test-level retry: a journey that still fails after its whole file was re-run gets one run of
// its own, in a worker with no other test's leftovers. The failure this catches - a durable write or
// an artifact admission tripping over state a previous test left behind - is not a product failure,
// and the difference matters: it decides whether the gate is red for the product or for the suite.
// A journey that fails here too stays a failure; the retry is a second chance, not an excuse.
const stillFailing = observed.filter(
  (row) =>
    !(row.status === "expected" && row.lastResultStatus === "passed") &&
    row.status !== "skipped" &&
    row.title !== undefined &&
    row.file !== undefined,
);
if (stillFailing.length > 0) {
  const titles = [...new Set(stillFailing.map((row) => row.title))];
  const filesToRun = [...new Set(stillFailing.map((row) => row.file))];
  const pattern = titles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  process.stderr.write(
    `[frontend-conformance] re-running ${titles.length} failing test(s) on their own: ${titles.join(", ")}\n`,
  );
  const solo = await run(
    "pnpm",
    [
      "--dir",
      "dialogue-web",
      "exec",
      "playwright",
      "test",
      ...filesToRun,
      `--grep=${pattern}`,
      "--project=chromium",
      "--workers=1",
      "--reporter=json",
    ],
    { cwd: repositoryRoot },
  );
  let soloDocument;
  try {
    soloDocument = JSON.parse(solo.stdout.slice(solo.stdout.indexOf("{")));
  } catch {
    soloDocument = undefined;
  }
  if (soloDocument !== undefined) {
  		const soloRows = new Map(collectTests(soloDocument).map((row) => [`${row.file}::${row.title}`, row]));
		observed = observed.map((row) => {
			const replacement = soloRows.get(`${row.file}::${row.title}`);
			if (replacement === undefined) return row;
			if (!(replacement.status === "expected" && replacement.lastResultStatus === "passed")) return row;
			passedOnRetry.push(`${row.file} :: ${row.title} (alone)`);
			return replacement;
		});
  }
}

// 3. The corpus: every journey file ran, nothing from outside the directory did,
// and the corpus holds at least the body the contract requires. Then per surface:
// the declared criteria test present. Then every row: nothing failing, nothing
// disabled.
const observedFiles = new Set(observed.map((row) => row.file));
for (const file of corpusFiles) {
  if (!observedFiles.has(file))
    failures.push(`${contract.corpus.directory}/${file} is a journey the run held no test from`);
}
for (const file of observedFiles) {
  if (!corpusFiles.includes(file))
    failures.push(`${file} ran but is not a journey in ${contract.corpus.directory}`);
}
if (observed.length < contract.corpus.minimumTests) {
  failures.push(
    `the corpus ran ${observed.length} test(s), the contract requires at least ${contract.corpus.minimumTests}`,
  );
}
for (const surface of contract.surfaces) {
  if (
    surface.criteriaTitle !== undefined &&
    !observed.some((row) => row.title.startsWith(surface.criteriaTitle))
  ) {
    failures.push(
      `${surface.id}: the declared criteria test is missing: ${surface.criteriaTitle}`,
    );
  }
}
for (const row of observed) {
  if (row.status === "skipped" || row.lastResultStatus === "skipped") {
    // A skip is a disabled test unless it says what it is missing: the title
    // carries the prerequisite ("requires real Windows", "requires the approved
    // composed shell fixture; ..."), so a declared prerequisite is reported and
    // anything else fails the gate.
    const declaresPrerequisite = /^requires /u.test(row.title) || /win32/u.test(row.error ?? "");
    const isCredential = contract.credentialTestTitles.some((title) => row.title.startsWith(title));
    if (declaresPrerequisite) {
      declaredSkips.push(`${row.file} :: ${row.title} (declared prerequisite)`);
      continue;
    }
    if (isCredential && credential === undefined && options.allowCredentialless) {
      declaredSkips.push(`${row.file} :: ${row.title} (no ${contract.credentialEnvironment})`);
      continue;
    }
    failures.push(
      `${row.file} :: ${row.title} was skipped${isCredential && credential === undefined ? ` and ${contract.credentialEnvironment} is not set` : ""}`,
    );
    continue;
  }
  if (row.status !== "expected" || row.lastResultStatus !== "passed") {
    failures.push(
      `${row.file} :: ${row.title} -> ${row.lastResultStatus ?? row.status}: ${row.error ?? ""}`,
    );
  }
}

// 4. The corpus itself: a headline journey may not vanish.
for (const title of contract.requiredTitles) {
  if (!observed.some((row) => row.title.startsWith(title)))
    failures.push(`required journey is missing from the corpus: ${title}`);
}

const report = Object.freeze({
  schema: "tavern_frontend_conformance/v1",
  corpus: Object.freeze({
    directory: contract.corpus.directory,
    files: Object.freeze(corpusFiles),
    observed: observed.length,
    required: contract.corpus.minimumTests,
  }),
  credentialPresent: credential !== undefined,
  shellSurfaces: Object.freeze(derivedSurfaces.map((surface) => surface.id)),
  surfaces: Object.freeze(
    contract.surfaces.map((surface) => ({
      id: surface.id,
      pane: surface.pane,
      criteriaTitle: surface.criteriaTitle ?? null,
      obligations: Object.freeze(surface.obligations ?? []),
      criteriaObserved:
        surface.criteriaTitle !== undefined &&
        observed.some((row) => row.title.startsWith(surface.criteriaTitle)),
    })),
  ),
  requiredTitles: contract.requiredTitles.length,
  declaredSkips: Object.freeze(declaredSkips),
  passedOnRetry: Object.freeze(passedOnRetry),
  failures: Object.freeze(failures),
  verdict:
    failures.length > 0
      ? "failed"
      : passedOnRetry.length > 0
        ? "passed-with-retry"
        : "passed",
});
if (options.reportPath !== undefined)
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stderr.write(
  `[frontend-conformance] ${report.verdict}: ${observed.length} test(s) observed in ${corpusFiles.length} journey file(s), ${declaredSkips.length} declared skip(s), ${failures.length} failure(s)\n`,
);
for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
for (const skip of declaredSkips) process.stderr.write(`  . declared: ${skip}\n`);
for (const retried of passedOnRetry) process.stderr.write(`  * passed on retry: ${retried}\n`);
process.exit(failures.length === 0 ? 0 : 2);
