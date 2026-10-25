#!/usr/bin/env node
/**
 * CI coverage gate: a gate script either runs in a workflow, runs in the `gates` job derived here,
 * or is registered below with a reason.
 *
 * The gate set is read from package.json by name - `check:*`, `audit:*`, `report:*`, `lint*`,
 * `typecheck*`, `format:check`, `dependency-audit` - so a new gate is a candidate by being named
 * like one, and no second list has to be kept in step with it. `test:*` scripts are not this gate's
 * business: `tools/run-tool-test-corpus.mjs` derives those from the same file.
 *
 * Coverage is a workflow file, never an aggregate script: `quality:check` names gates that no job
 * runs, which is the drift this gate exists to stop (design/research/system-reflection-build.md,
 * finding 2). A step covers a script when it names the script or names the file its command runs.
 * YAML comments are stripped first, so a step discussed in prose does not read as a step.
 *
 * The derived set is what the workflows do not already run. It is install-free by construction -
 * the job that runs it installs nothing - so a gate needing the installed workspace, the game, the
 * decompiled tree, the `design/` mount or a built generation is registered with that reason
 * instead of being silently absent.
 *
 *   node tools/check-ci-coverage.mjs          # the verdict; exit 1 on a stale or unreasoned entry
 *   node tools/check-ci-coverage.mjs --list   # the derived set, one script name per line
 *   node tools/check-ci-coverage.mjs --run    # run that set, one named line per gate
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";
const GATE_TIMEOUT_MS = 10 * 60_000;

const GATE_NAME = /^(?:check[:-]|audit:|report:|format:check$|dependency-audit$|lint(?::|$)|typecheck(?::|$))/u;
const SCRIPT_PATH = /[\w.-]+(?:\/[\w.-]+)+\.(?:mjs|cjs|js|ts|ps1)/gu;

/** Why a gate that exists does not run on a fresh checkout. */
const REASONS = new Map([
  ["arguments", "reads caller-supplied inputs and refuses to run without them, so it is a verifier, not a job step"],
  [
    "environment",
    "needs an input a hosted checkout has not got: the licensed game, the decompiled tree, the design/ mount, run artifacts or a built generation",
  ],
  ["installed", "needs the installed workspace (a devDependency binary or a TypeScript import the install provides)"],
  ["debt", "a standalone gate that is red at HEAD: adopting it needs the fix, not the wiring"],
  ["superseded", "the same checks run through another script or job"],
]);

const REGISTER = Object.freeze([
  {
    script: "check:architecture",
    reason: "superseded",
    detail: "publint and report:clones each run on their own ci.yml step; the third member is an echo promising a gate",
  },
  {
    script: "typecheck:voice-protocol",
    reason: "superseded",
    detail: "the voice-gateway job already runs pi-koe's own `pnpm run typecheck`, which covers the protocol package",
  },
  {
    script: "check:gameplay-capability-catalog",
    reason: "environment",
    detail: "reads design/gameplay-capability-catalog.json from the design/ mount",
  },
  {
    script: "check:tavern-references",
    reason: "environment",
    detail: "reads design/references/tavern/st-semantic-references-v1.json; measured ENOENT on a checkout",
  },
  {
    script: "check:stardew-loop-closure",
    reason: "environment",
    detail: "measured stardew_decompile_root_missing: ref/external/StardewValleyDecompiled is gitignored",
  },
  {
    script: "check:stardew-native-notice-coverage",
    reason: "environment",
    detail: "counts call sites in the gitignored decompiled tree; a checkout reports 0 files and fails",
  },
  {
    script: "check:live-run-isolation",
    reason: "environment",
    detail:
      "builds lanes from %LOCALAPPDATA%/GameBuddy/stardew-profiles/native-local-stable and the Steam install at D:/Steam/...; a checkout has neither, so it exits 1 with live_run_isolation_source_profile_config_missing",
  },
  {
    script: "check:stardew-native-multiplayer-sensitivity",
    reason: "environment",
    detail: "reads the gitignored decompiled tree; it also reports 2 seam-call mismatches where the tree exists",
  },
  {
    script: "check:live-run-artifact-freshness",
    reason: "environment",
    detail: "compares live-run outputs against source age; there is no run to judge on a push",
  },
  {
    script: "check:live-run-isolation",
    reason: "environment",
    detail: "measured native_local_fixture_path_missing: it needs a Mod Release build and a game install",
  },
  {
    script: "check:production-pack-load",
    reason: "environment",
    detail: "measured pointer_missing: host/dist/current.json, a generation only the release lane assembles",
  },
  {
    script: "check:tavern-release-prerequisites",
    reason: "environment",
    detail: "needs live provider turns and an assembled generation; exits 2 (blocked) without them",
  },
  {
    script: "audit:chat-live-run",
    reason: "arguments",
    detail: "requires --audit <path> to an existing chat live-run directory",
  },
  { script: "audit:stardew-action-seam-terminals", reason: "arguments", detail: "requires --candidates" },
  { script: "report:stardew-remaining-actions", reason: "arguments", detail: "requires --candidates" },
  {
    script: "check:live-run-preflight",
    reason: "arguments",
    detail: "requires --mods-path (measured preflight_missing_argument:--mods-path)",
  },
  {
    script: "check:stardew-companion-production-admission",
    reason: "arguments",
    detail: "reports admission_cli_required_flag_missing without a caller's evidence paths",
  },
  {
    script: "check:stardew-gameplay-completeness",
    reason: "arguments",
    detail: "requires --report <direct-inspector-report.json>",
  },
  {
    script: "check:stardew-native-mechanism-review-register",
    reason: "arguments",
    detail: "requires --mechanism-report, --register and --source-root",
  },
  {
    script: "check:stardew-native-normal-player-ingress-register",
    reason: "arguments",
    detail: "requires --register, --mechanism-report and --source-root",
  },
  {
    script: "check:stardew-native-router-exit-classifier",
    reason: "arguments",
    detail: "requires --inventory and --classifier",
  },
  {
    script: "check:stardew-native-source-closure",
    reason: "arguments",
    detail: "requires a certificate, universe, boundary model, source root, assembly and content manifest",
  },
  {
    script: "check:stardew-native-transition-ledger",
    reason: "arguments",
    detail: "requires a ledger, mechanism report, review register, scope manifest and source root",
  },
  {
    script: "check:text-hygiene",
    reason: "debt",
    detail: "measured red at HEAD: committed C# files under desktop/ are missing a final newline",
  },
  {
    script: "check:tools-boundaries",
    reason: "debt",
    detail: "measured 37 dependency violations (25 errors) over tools/ at HEAD",
  },
  {
    script: "check:scope-references",
    reason: "debt",
    detail: "measured 4 findings (3 out_of_scope_reference, 1 read_before_declaration) over 731 files at HEAD",
  },
  { script: "lint:eslint", reason: "debt", detail: "measured 11 errors in dialogue-web/src at HEAD" },
]);

function readScripts(root) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
}

/** A `#` comment is a YAML comment only at line start or after whitespace. */
function stripYamlComments(text) {
  return text
    .split("\n")
    .map((line) => (/^\s*#/u.test(line) ? "" : line.replace(/\s#.*$/u, "")))
    .join("\n");
}

function workflowText(root) {
  const dir = resolve(root, WORKFLOW_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => readFileSync(resolve(dir, name), "utf8"))
    .join("\n");
}

function workflowTokens(text) {
  return new Set(
    stripYamlComments(text)
      .split(/[^A-Za-z0-9_.@:/-]+/u)
      .filter((token) => token !== ""),
  );
}

function entryFiles(command) {
  return command.match(SCRIPT_PATH) ?? [];
}

/**
 * Split the gate scripts into what a workflow runs, what the derived job must run, and what is
 * registered, and report every register entry that no longer earns its place.
 */
export function deriveCiCoverage({ scripts, workflowText: text, register = REGISTER }) {
  const tokens = workflowTokens(text);
  const gateScripts = Object.keys(scripts)
    .filter((name) => GATE_NAME.test(name))
    .sort();
  const runsInWorkflow = (name) => tokens.has(name) || entryFiles(scripts[name] ?? "").some((path) => tokens.has(path));
  const registered = new Map(register.map((entry) => [entry.script, entry]));
  const workflow = [];
  const derived = [];
  for (const name of gateScripts) {
    if (registered.has(name)) continue;
    (runsInWorkflow(name) ? workflow : derived).push(name);
  }
  const problems = [];
  for (const entry of register) {
    const known = gateScripts.includes(entry.script);
    if (!known) problems.push({ code: "register_stale", script: entry.script });
    else if (runsInWorkflow(entry.script)) problems.push({ code: "register_redundant", script: entry.script });
    else if (!REASONS.has(entry.reason))
      problems.push({ code: "register_unreasoned", script: entry.script, detail: entry.reason });
    else if (typeof entry.detail !== "string" || entry.detail.trim() === "") {
      problems.push({ code: "register_undetailed", script: entry.script });
    }
  }
  // The derived half only exists if a workflow runs it; without that step every script in it runs
  // nowhere, which is exactly the state this gate is meant to make impossible.
  const runnerWired = tokens.has("--run") && tokens.has("tools/check-ci-coverage.mjs");
  if (!runnerWired) problems.push({ code: "runner_unwired", script: "tools/check-ci-coverage.mjs --run" });
  return { gateScripts, workflow, derived, register, problems, runnerWired };
}

function report(coverage) {
  const byReason = [...REASONS.keys()]
    .map((reason) => [reason, coverage.register.filter((entry) => entry.reason === reason).length])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(",");
  process.stdout.write(
    `ci_coverage gate_scripts=${coverage.gateScripts.length} workflow=${coverage.workflow.length} ` +
      `gates_job=${coverage.derived.length} registered=${coverage.register.length}` +
      `${byReason === "" ? "" : ` (${byReason})`}\n`,
  );
  for (const problem of coverage.problems) {
    switch (problem.code) {
      case "register_stale":
        process.stderr.write(`ci_coverage_register_stale:${problem.script} is not a gate script; delete the entry\n`);
        break;
      case "register_redundant":
        process.stderr.write(
          `ci_coverage_register_redundant:${problem.script} runs in a workflow now; delete the entry\n`,
        );
        break;
      case "register_unreasoned":
        process.stderr.write(
          `ci_coverage_register_unreasoned:${problem.script}:${problem.detail} must name one of ${[...REASONS.keys()].join("|")}\n`,
        );
        break;
      case "register_undetailed":
        process.stderr.write(`ci_coverage_register_undetailed:${problem.script} must say why, with the measurement\n`);
        break;
      default:
        process.stderr.write(
          `ci_coverage_runner_unwired:no workflow step runs \`node tools/check-ci-coverage.mjs --run\`, so ${coverage.derived.length} gates run nowhere\n`,
        );
    }
  }
  return coverage.problems.length === 0 ? 0 : 1;
}

function runGates(names, scripts) {
  const failed = [];
  const started = Date.now();
  for (const name of names) {
    const command = scripts[name];
    process.stdout.write(`ci_gate:${name}:start\n`);
    const began = Date.now();
    const result = spawnSync(command, { cwd: ROOT, shell: true, stdio: "inherit", timeout: GATE_TIMEOUT_MS });
    const seconds = Math.round((Date.now() - began) / 1000);
    if (result.status === 0) {
      process.stdout.write(`ci_gate:${name}:passed:${seconds}s\n`);
      continue;
    }
    failed.push(name);
    process.stdout.write(`ci_gate:${name}:failed:${result.status === null ? "timeout" : result.status}:${seconds}s\n`);
  }
  process.stdout.write(
    `ci_gates_run total=${names.length} failed=${failed.length} ${Math.round((Date.now() - started) / 1000)}s` +
      `${failed.length === 0 ? "" : ` failing=${failed.join(",")}`}\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  const scripts = readScripts(ROOT);
  const coverage = deriveCiCoverage({ scripts, workflowText: workflowText(ROOT) });
  if (argv.includes("--list")) {
    for (const name of coverage.derived) process.stdout.write(`${name}\n`);
    return 0;
  }
  if (argv.includes("--run")) return runGates(coverage.derived, scripts);
  return report(coverage);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
