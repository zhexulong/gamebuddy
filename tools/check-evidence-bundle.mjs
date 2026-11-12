// The evidence-bundle gate: a run that cannot describe itself is not evidence.
//
// Two modes, one validator. With `--run-dir` it validates one run's bundle against what is on disk
// (the mode the lanes use). Without it, it validates the documented bundle shape, so a contract
// change that stops accepting the very shape the plan specifies fails in CI rather than in a run.
// red-proof: inject  --run-dir over a directory holding only `{}` ->
//                    `"status":"failed"` with `schema_version_mismatch` and `timeline_sources_missing`, `examined":1`, exit 1
//                    (tools/check-evidence-bundle.mjs, the validator this marker names)
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EVIDENCE_BUNDLE_CANONICAL_DIR,
  EVIDENCE_BUNDLE_FILES,
  readEvidenceBundle,
  validateEvidenceBundle,
} from "./lib/evidence-bundle.mjs";

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
  const path = join(EVIDENCE_BUNDLE_CANONICAL_DIR, "manifest.json");
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
  const trace = await readFile(join(EVIDENCE_BUNDLE_CANONICAL_DIR, "actionTrace.jsonl"), "utf8")
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
    // The objects this gate examined: the obligations the documented shape is checked against. Zero of them means the
    // obligation list itself stopped being read.
    examined: result.checkedObligations.length,
    traceEntries: trace === null ? null : trace.length,
  };
}

async function runDirCheck(runDir) {
  const result = await readEvidenceBundle(runDir);
  // What was examined here: the bundle's own files that are on disk. A run directory holding none of them is named by
  // the violations, and `examined: 0` says the gate read nothing rather than that the bundle is clean.
  const filesExamined = Object.values(EVIDENCE_BUNDLE_FILES).filter((name) => existsSync(join(runDir, name))).length;
  return {
    status: result.violations.length === 0 ? "passed" : "failed",
    violations: result.violations,
    examined: filesExamined,
  };
}

async function main(argv) {
  const options = parseCli(argv);
  // The artifact this mode read: `mode: "contract"` alone named no file, so a red here read like a run's broken teardown
  // when it is the documented shape that is stale (measured 2026-11-10..12).
  const report =
    options.runDir === null
      ? {
          gate: "evidence_bundle/v1",
          mode: "contract",
          bundle: EVIDENCE_BUNDLE_CANONICAL_DIR,
          ...(await contractCheck()),
        }
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
