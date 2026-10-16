// The evidence-bundle gate: a run that cannot describe itself is not evidence.
//
// Two modes, one validator. With `--run-dir` it validates one run's bundle against what is on disk
// (the mode the lanes use). Without it, it validates the documented bundle shape, so a contract
// change that stops accepting the very shape the plan specifies fails in CI rather than in a run.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readEvidenceBundle, validateEvidenceBundle } from "./lib/evidence-bundle.mjs";

const CANONICAL_DIR = "fixtures/stardew/evidence-bundle";

function parseCli(argv) {
  const options = { runDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--run-dir") {
      options.runDir = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`unknown_argument:${String(argv[index])}`);
    }
  }
  return options;
}

async function contractCheck() {
  const path = join(CANONICAL_DIR, "manifest.json");
  let bundle;
  try {
    bundle = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return {
      status: "failed",
      violations: [{ code: "canonical_bundle_unreadable", where: path }],
      detail: error.message,
    };
  }
  const trace = await readFile(join(CANONICAL_DIR, "actionTrace.jsonl"), "utf8")
    .then((text) =>
      text
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line)),
    )
    .catch(() => null);
  const result = validateEvidenceBundle(bundle, { actionTrace: trace });
  return {
    status: result.ok ? "passed" : "failed",
    violations: result.violations,
    obligationsChecked: result.checkedObligations.length,
    traceEntries: trace === null ? null : trace.length,
  };
}

async function runDirCheck(runDir) {
  const result = await readEvidenceBundle(runDir);
  return { status: result.violations.length === 0 ? "passed" : "failed", violations: result.violations };
}

async function main(argv) {
  const options = parseCli(argv);
  const report =
    options.runDir === null
      ? { gate: "evidence_bundle/v1", mode: "contract", ...(await contractCheck()) }
      : { gate: "evidence_bundle/v1", mode: "run_dir", runDir: options.runDir, ...(await runDirCheck(options.runDir)) };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status !== "passed") process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
