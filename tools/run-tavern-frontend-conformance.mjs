#!/usr/bin/env node
/**
 * The Tavern frontend conformance gate.
 *
 * Authority: design/architecture/tavern-frontend-criteria.md.
 *
 * A journey proves a screen works today. This gate makes the *criteria* those
 * journeys are instances of - accessibility baseline, keyboard reach, layout
 * floor, a quiet walk - into something a frontend change cannot quietly drop, and
 * it makes the corpus and the surface inventory part of the contract:
 *
 *   - the surface list must equal the pane inventory derived from the shell entry,
 *     so a new pane has to be declared (with a suite and criteria, or a recorded
 *     deferral and a reason) before the gate can pass;
 *   - a declared suite that disappears, shrinks below its minimum, or loses a
 *     headline journey fails;
 *   - a test that was disabled (skipped) fails, except the declared non-Windows
 *     reason and - only with --allow-credentialless - the journeys whose declared
 *     prerequisite is the provider credential, reported as declared skips;
 *   - every declared criterion must actually be exercised, which the conformance
 *     tests themselves assert through the criteria ledger.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
    "  --output-root <dir>     generation root holding current.json (default: env GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT or host/dist)",
    "  --report <path>         write the JSON report here",
    "  --allow-credentialless  downgrade the credential-dependent journeys to declared skips (local runs only; the release lane never passes this)",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { outputRoot: undefined, reportPath: undefined, allowCredentialless: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    if (flag === "--allow-credentialless") {
      options.allowCredentialless = true;
      continue;
    }
    if (flag !== "--output-root" && flag !== "--report") throw new Error(usage());
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(usage());
    if (flag === "--output-root") options.outputRoot = value;
    else options.reportPath = value;
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
 * The pane inventory the shell itself declares: every `profile` branch in the
 * entry maps to the component it renders. Each branch is isolated first (up to the
 * next branch), because a component imported near the top of the file would
 * otherwise be attributed to whichever branch happens to come first.
 */
async function deriveShellSurfaces(relativeEntry) {
  const entry = await readFile(join(repositoryRoot, relativeEntry), "utf8");
  const branches = entry.split(/\} else if \(profile === |if \(profile === /u).slice(1);
  const derived = [];
  for (const branch of branches) {
    const segment = branch.split(/\} else/u)[0];
    const id = /^"([a-z0-9-]+)"/u.exec(segment)?.[1];
    if (id === undefined) continue;
    const lazy = /import\("\.\/components\/([A-Za-z0-9_]+)"/u.exec(segment)?.[1];
    const eager = /render\(<([A-Za-z0-9_]+)/u.exec(segment)?.[1];
    derived.push({ id, pane: lazy ?? eager ?? "unknown" });
  }
  return derived;
}

const options = parseArguments(process.argv.slice(2));
if (options.help === true) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const contract = JSON.parse(await readFile(contractPath, "utf8"));
const outputRoot = resolve(
  options.outputRoot ??
    process.env.GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT ??
    join(repositoryRoot, "host", "dist"),
);
if (!existsSync(join(outputRoot, "current.json")))
  throw new Error(`no bootable generation at ${outputRoot} (current.json missing)`);

const credential = process.env[contract.credentialEnvironment];
const failures = [];
const declaredSkips = [];

// 1. Surface inventory: the contract must account for exactly the shell's panes,
// and every declared suite must exist on disk (a deferral cannot name a suite
// that was deleted).
const declared = new Map(contract.surfaces.map((surface) => [surface.id, surface]));
const derivedSurfaces = await deriveShellSurfaces(contract.surfaceInventory.derivedFrom);
for (const surface of derivedSurfaces) {
  const entry = declared.get(surface.id);
  if (entry === undefined) {
    failures.push(
      `the shell renders the ${surface.id} pane (${surface.pane}) but the contract does not declare it: declare its suite and criteria, or record a deferral with a reason`,
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
const enforcedSuites = [];
for (const surface of contract.surfaces) {
  for (const suite of surface.suites ?? []) {
    if (!existsSync(join(repositoryRoot, "dialogue-web", suite.file))) {
      failures.push(`${surface.id}: the declared suite ${suite.file} does not exist`);
      continue;
    }
    enforcedSuites.push({ surface, suite });
  }
  if (surface.deferredReason !== undefined)
    declaredSkips.push(`${surface.id}: criteria deferred - ${surface.deferredReason}`);
}
const enforcedSurfaces = contract.surfaces.filter(
  (surface) => surface.deferredReason === undefined && (surface.suites ?? []).length > 0,
);

// A contract that disagrees with the shell is not a contract: stop here rather
// than spending minutes proving things about a surface set nobody agreed on.
if (failures.some((failure) => /^the (shell|contract) /u.test(failure))) {
  const inventoryReport = Object.freeze({
    schema: "tavern_frontend_conformance/v1",
    generation: outputRoot,
    credentialPresent: credential !== undefined,
    shellSurfaces: Object.freeze(derivedSurfaces.map((surface) => surface.id)),
    failures: Object.freeze(failures),
    verdict: "failed",
  });
  if (options.reportPath !== undefined)
    await writeFile(options.reportPath, `${JSON.stringify(inventoryReport, null, 2)}\n`, "utf8");
  process.stderr.write(
    `[frontend-conformance] failed (surface inventory): the contract and the shell disagree, so no suite was run\n`,
  );
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(2);
}

// 2. Run the enforced suites against the real generation.
const files = enforcedSuites.map(({ suite }) => suite.file);
process.stderr.write(
  `[frontend-conformance] generation=${outputRoot} credential=${credential === undefined ? "absent" : "present"} surfaces=${derivedSurfaces.map((surface) => surface.id).join(",")}\n`,
);
const runResult = await run(
  "pnpm",
  [
    "--dir",
    "dialogue-web",
    "exec",
    "playwright",
    "test",
    ...files,
    "--project=chromium",
    "--workers=1",
    "--reporter=json",
  ],
  {
    cwd: repositoryRoot,
    env: { ...process.env, GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT: outputRoot },
  },
);
let document;
try {
  document = JSON.parse(runResult.stdout.slice(runResult.stdout.indexOf("{")));
} catch {
  throw new Error(
    `the suites produced no parseable report (exit ${runResult.code}): ${runResult.stderr.slice(-400)}`,
  );
}

const observed = collectTests(document);
const byFile = new Map();
for (const row of observed) {
  const list = byFile.get(row.file) ?? [];
  list.push(row);
  byFile.set(row.file, list);
}

// 3. Per-suite: enough tests. Then per-surface: the declared criteria test
// present and green, and nothing disabled anywhere.
for (const { surface, suite } of enforcedSuites) {
  const rows = byFile.get(basenameOf(suite.file)) ?? [];
  if (rows.length < suite.minimumTests) {
    failures.push(
      `${suite.file}: ${rows.length} test(s) ran, the contract requires at least ${suite.minimumTests} (${suite.capability})`,
    );
  }
}
for (const surface of enforcedSurfaces) {
  const rows = (surface.suites ?? []).flatMap((suite) => byFile.get(basenameOf(suite.file)) ?? []);
  if (
    surface.criteriaTitle !== undefined &&
    !rows.some((row) => row.title.startsWith(surface.criteriaTitle))
  ) {
    failures.push(
      `${surface.id}: the declared criteria test is missing: ${surface.criteriaTitle}`,
    );
  }
  for (const row of rows) {
    if (row.status === "skipped" || row.lastResultStatus === "skipped") {
      const isPlatform = /requires real Windows/u.test(row.title) || /win32/u.test(row.error ?? "");
      const isCredential = contract.credentialTestTitles.some((title) => row.title.startsWith(title));
      if (isPlatform) continue;
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
}

// 4. The corpus itself: a headline journey may not vanish.
for (const title of contract.requiredTitles) {
  if (!observed.some((row) => row.title.startsWith(title)))
    failures.push(`required journey is missing from the corpus: ${title}`);
}

const report = Object.freeze({
  schema: "tavern_frontend_conformance/v1",
  generation: outputRoot,
  credentialPresent: credential !== undefined,
  shellSurfaces: Object.freeze(derivedSurfaces.map((surface) => surface.id)),
  suites: contract.surfaces.flatMap((surface) =>
    (surface.suites ?? []).map((suite) => ({
      id: surface.id,
      pane: surface.pane,
      file: suite.file,
      capability: suite.capability,
      obligations: surface.obligations ?? [],
      deferred: surface.deferredReason !== undefined,
      observed: (byFile.get(basenameOf(suite.file)) ?? []).length,
      required: suite.minimumTests,
    })),
  ),
  requiredTitles: contract.requiredTitles.length,
  declaredSkips: Object.freeze(declaredSkips),
  failures: Object.freeze(failures),
  verdict: failures.length === 0 ? "passed" : "failed",
});
if (options.reportPath !== undefined)
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stderr.write(
  `[frontend-conformance] ${report.verdict}: ${observed.length} test(s) observed, ${declaredSkips.length} declared deferral/skip(s), ${failures.length} failure(s)\n`,
);
for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
for (const skip of declaredSkips) process.stderr.write(`  . declared: ${skip}\n`);
process.exit(failures.length === 0 ? 0 : 2);
