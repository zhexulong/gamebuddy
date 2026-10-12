/**
 * The end-to-end gate for the companion's long-term memory: a real fold, a sealed chapter, and the
 * historian's own output measured against its obligations.
 *
 * This is the expensive half of the two-layer contract, and it is expensive for a reason no cheaper
 * check can remove: a compartment is MODEL OUTPUT. It decides what the companion remembers and in whose
 * voice, so a run without a real provider call can only prove that code paths still link - not that the
 * memory mechanism still works. The cheap half (`--contract`) proves the plumbing every commit; this
 * proves the behaviour on a release.
 *
 * What it asserts, all in one run:
 *   - the fold really happened (Magic Context's own `compartments` / `chapters` tables);
 *   - a chapter reached m[0] (the fixture's own assertion, plus its bytes-per-revision stability);
 *   - every obligation in design/architecture/historian-prompt-rubric.md held on the compartments that
 *     fold wrote, and which prompt variant the run actually carried.
 *
 * Exit codes: 0 passed, 2 failed, 3 blocked (no provider credential). Blocked is
 * distinct from failed on purpose: a missing credential must never look like a pass, and must never be
 * reported as a product defect either.
 *
 *   node tools/run-memory-fold-live-gate.mjs [--report <path>] [--keep-root]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHistorianRubric, identifyHistorianPrompt, readCompartments } from "./lib/historian-rubric.mjs";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const FIXTURE = "pi-magic-context-chapter-fold.test.ts";
const SCRATCH = join(repo, "host/.memory-fold-gate");
const CONFIG = join(repo, "host/tsconfig.memory-fold-gate.json");
// The fixture cannot fold a CI-sized conversation at Magic Context's production trigger, so it is given
// the thresholds its own fixture-only channel accepts. Same model, same provider: the only variable is
// WHEN a fold happens, which is the variable this gate needs to move.
const EXECUTE_THRESHOLD_TOKENS = "6000";
const PROTECTED_TOKENS = "4000";

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};

function blocked(report, reason) {
  process.stdout.write(`${JSON.stringify({ ...report, verdict: "blocked", reason })}\n`);
  process.exit(3);
}

const reportPath = flag("--report");
const keepRoot = argv.includes("--keep-root");

const write = (value) => {
  if (reportPath === undefined) return;
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(value, null, 2)}\n`);
};

if (process.env.CPA_OAI_API_KEY === undefined || process.env.CPA_OAI_API_KEY.trim().length === 0)
  blocked({ schema: "gamebuddy_memory_fold_gate/v1" }, "credential_absent");

// Which prompt this run carries, read from the package the fixture actually loads
// (`host/node_modules/@cortexkit/pi-magic-context` -> the vendored pi-plugin). A generation is not
// involved: the fixture constructs its runtime from this repository.
const prompt = identifyHistorianPrompt(join(repo, "host"));

// 1. Compile just this fixture. Other lanes' type errors are not this gate's business, so the emit is
// what matters (`noEmitOnError` stays off), and the scratch output is removed afterwards.
rmSync(SCRATCH, { recursive: true, force: true });
writeFileSync(
  CONFIG,
  `${JSON.stringify(
    {
      extends: "./tsconfig.json",
      include: [],
      files: [`src/${FIXTURE}`],
      compilerOptions: {
        noEmit: false,
        noEmitOnError: false,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        outDir: ".memory-fold-gate",
        rootDir: "src",
      },
    },
    null,
    2,
  )}\n`,
);

let compileOutput = "";
try {
  execFileSync(process.execPath, [join(repo, "host/node_modules/typescript/lib/tsc.js"), "-p", CONFIG], {
    cwd: join(repo, "host"),
    encoding: "utf8",
    stdio: "pipe",
  });
} catch (error) {
  compileOutput = String(error?.stdout ?? error?.message ?? error);
}

// Native helpers the runtime loads from beside the compiled entry (same reason the test lane copies it).
for (const helper of ["windows-named-mutex-broker.ps1"]) {
  const source = join(repo, "host", helper);
  if (existsSync(source)) cpSync(source, join(SCRATCH, helper));
}

// 2. Run it with real provider turns. The fixture keeps its runtime root when asked, because the fold's
// reasons live in Magic Context's own database rather than in the output.
let runOutput = "";
let runExit = 0;
try {
  runOutput = execFileSync(process.execPath, ["--test", join(SCRATCH, FIXTURE.replace(/\.ts$/u, ".js"))], {
    cwd: join(repo, "host"),
    encoding: "utf8",
    env: {
      ...process.env,
      GAMEBUDDY_CHAPTER_FOLD_FORCE: "1",
      GAMEBUDDY_CHAPTER_FOLD_KEEP_ROOT: "1",
      GAMEBUDDY_MAGIC_CONTEXT_TEST_EXECUTE_THRESHOLD_TOKENS: EXECUTE_THRESHOLD_TOKENS,
      GAMEBUDDY_MAGIC_CONTEXT_TEST_PROTECTED_TOKENS: PROTECTED_TOKENS,
    },
    stdio: "pipe",
  });
} catch (error) {
  runExit = typeof error?.status === "number" ? error.status : 1;
  runOutput = `${String(error?.stdout ?? "")}${String(error?.stderr ?? "")}${String(error?.message ?? "")}`;
}

// 3. Judge. The root comes from what the fixture printed - guessing at a temp directory is how an
// earlier attempt reported `compartments=0` for runs that had folded.
const kept = /kept root: (.+)/u.exec(runOutput);
const root = kept === null ? undefined : kept[1].trim();
const compartments = root === undefined ? [] : readCompartments(root);
const rubric = checkHistorianRubric(compartments);

const report = {
  schema: "gamebuddy_memory_fold_gate/v1",
  historianPrompt: prompt,
  fixture: { exit: runExit, keptRoot: root ?? null },
  compartmentsWritten: compartments.length,
  historianRubric: rubric,
};

const failures = [];
if (runExit !== 0) failures.push(`fold fixture failed (exit ${runExit})`);
if (root === undefined) failures.push("the fixture reported no kept runtime root");
if (rubric.compartmentsChecked === 0) failures.push("the fold wrote no compartment, so nothing was judged");
for (const violation of rubric.violations) failures.push(`${violation.obligation} at ${violation.where}`);

rmSync(CONFIG, { force: true });
if (!keepRoot && root !== undefined) rmSync(root, { recursive: true, force: true });
rmSync(SCRATCH, { recursive: true, force: true });

const verdict = failures.length === 0 ? "passed" : "failed";
write({ ...report, verdict, failures });
process.stdout.write(
  `${JSON.stringify({
    verdict,
    historianPrompt: prompt.variant,
    compartments: rubric.compartmentsChecked,
    violations: rubric.violations,
  })}\n`,
);
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`[memory-fold-gate] ${failure}\n`);
  if (compileOutput.trim().length > 0 && runExit !== 0)
    process.stderr.write(
      `[memory-fold-gate] fixture output tail:\n${runOutput.trim().split("\n").slice(-12).join("\n")}\n`,
    );
  process.exit(2);
}
