#!/usr/bin/env node
/**
 * The Tavern frontend conformance gate.
 *
 * Authority: design/architecture/tavern-frontend-criteria.md.
 *
 * A journey proves a screen works today. This gate makes the *criteria* those
 * journeys are instances of - accessibility baseline, keyboard reach, layout
 * floor, quiet walk, vocabulary equality - into something a frontend change
 * cannot quietly drop, and it makes the corpus itself part of the contract:
 *
 *   - a surface suite that disappears, shrinks below its declared minimum, or
 *     loses a headline journey fails here;
 *   - a test that was disabled (skipped) fails here, except the declared
 *     non-Windows reason and - only with --allow-credentialless - the journeys
 *     whose declared prerequisite is the provider credential, which is then
 *     reported as a declared skip rather than a silent one.
 *
 * It runs the real suites against a real generation and reports what it observed.
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
    "  --output-root <dir>   generation root holding current.json (default: env GAMEBUDDY_TAVERN_BROWSER_OUTPUT_ROOT or host/dist)",
    "  --report <path>       write the JSON report here",
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
    const child = spawn(command, args, { ...options, shell: process.platform === "win32" });
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

/** Flatten the Playwright JSON reporter into one row per test. */
function collectTests(document) {
  const rows = [];
  // The reporter names the file relative to its config root and that form has
  // changed between versions ('x.spec.ts' vs 'tests/x.spec.ts'), so identify a
  // suite by its basename - the contract's paths are unique per basename.
  const normalizeFile = (value) => String(value ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
  const visit = (suite) => {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        rows.push({
          file: normalizeFile(spec.file ?? suite.file),
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
const files = contract.surfaces.map((surface) => surface.file);
process.stderr.write(
  `[frontend-conformance] generation=${outputRoot} credential=${credential === undefined ? "absent" : "present"}\n`,
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
    shell: process.platform === "win32",
  },
);

let document;
try {
  const start = runResult.stdout.indexOf("{");
  document = JSON.parse(runResult.stdout.slice(start));
} catch (error) {
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
const basenameOf = (path) => path.replaceAll("\\", "/").split("/").pop();

const failures = [];
const declaredSkips = [];

for (const surface of contract.surfaces) {
  const rows = byFile.get(basenameOf(surface.file)) ?? [];
  if (rows.length < surface.minimumTests) {
    failures.push(
      `${surface.file}: ${rows.length} test(s) ran, the contract requires at least ${surface.minimumTests} (${surface.capability})`,
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
      failures.push(`${row.file} :: ${row.title} -> ${row.lastResultStatus ?? row.status}: ${row.error ?? ""}`);
    }
  }
}

for (const title of contract.requiredTitles) {
  if (!observed.some((row) => row.title.startsWith(title)))
    failures.push(`required journey is missing from the corpus: ${title}`);
}

const report = Object.freeze({
  schema: "tavern_frontend_conformance/v1",
  generation: outputRoot,
  credentialPresent: credential !== undefined,
  suites: contract.surfaces.map((surface) => ({
    file: surface.file,
    capability: surface.capability,
    observed: (byFile.get(basenameOf(surface.file)) ?? []).length,
    required: surface.minimumTests,
  })),
  requiredTitles: contract.requiredTitles.length,
  declaredSkips: Object.freeze(declaredSkips),
  failures: Object.freeze(failures),
  verdict: failures.length === 0 ? "passed" : "failed",
});
if (options.reportPath !== undefined)
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stderr.write(
  `[frontend-conformance] ${report.verdict}: ${observed.length} test(s) observed, ${declaredSkips.length} declared skip(s), ${failures.length} failure(s)\n`,
);
for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
for (const skip of declaredSkips) process.stderr.write(`  . declared skip: ${skip}\n`);
process.exit(failures.length === 0 ? 0 : 2);
