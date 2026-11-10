#!/usr/bin/env node
/**
 * Every artifact path a tracked document hands a maintainer must be the output of a build script.
 *
 * The defect this closes, measured on 2026-10-31: `tools/sandbox/README.md` told a maintainer to
 * run `pnpm build:player-distribution` and then pass `desktop/dist/setup/GameBuddy.Setup.exe` to
 * the acceptance drivers. No script, workflow or project published to `desktop/dist/setup`; the
 * directory on this machine held an artifact from a manual `dotnet publish` nobody had recorded,
 * so the runbook's two commands could not work from a fresh clone and nothing said so. A document
 * naming a path is not evidence that the path is buildable.
 *
 * POPULATION, from the authority: every `--setup <path>` argument in a TRACKED file. `git
 * ls-files` is the authority for "tracked", so the gitignored `design/` mount never contributes,
 * and a runbook added tomorrow joins by being tracked rather than by being listed here.
 *
 * PRODUCER, also derived, never listed: the `-o`/`--output` directory every root `package.json`
 * `build*` script publishes into, plus every `(desktop|host)/dist/<file>` token such a script
 * writes. `build:desktop-launcher` declares `desktop/dist/launcher` from its own command line, so
 * the launcher and the installer are held to the same rule and neither is restated here.
 *
 *   node tools/check-build-artifact-producers.mjs          # the verdict; exit 1 on a gap
 *   node tools/check-build-artifact-producers.mjs --list   # the population and the declared outputs
 *
 * It is install-free: git and `package.json`, nothing else.
 *
 * red-proof: self-check  a scratch tree whose runbook names desktop/dist/setup/GameBuddy.Setup.exe with
 *                    no producing build script -> `build_artifact_unproduced:` names that path and the
 *                    file, while the control with the producer added is silent (tools/check-build-artifact-producers.mjs)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTENSIONS = /\.(?:md|mjs|cjs|js|ts|tsx|json|cmd|ps1|py|cs|yml|yaml)$/u;
const SETUP_ARGUMENT = /--setup\s+"?([^\s"'`]+)/gu;
// The documents that declare how an artifact is produced are not consumers of it: the
// project file that embeds the payload is a producer's own statement.
const DECLARATIONS = Object.freeze(["tools/check-build-artifact-producers.mjs"]);

/** Every `--setup <path>` a tracked document hands a maintainer, with the file that names it. */
export function setupArguments({ trackedFiles, read }) {
  const named = [];
  for (const file of trackedFiles) {
    if (DECLARATIONS.includes(file) || !TEXT_EXTENSIONS.test(file)) continue;
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    for (const match of text.matchAll(SETUP_ARGUMENT)) {
      const path = match[1].replace(/[.,;:)\]]+$/u, "").replaceAll("\\", "/");
      // `<path>` and `<GameBuddy.Setup.exe>` are usage prose - a placeholder is not a claim that
      // an artifact exists. A real expectation names a path.
      if (path.includes("<") || path.includes(">") || !path.includes("/")) continue;
      named.push({ path, file });
    }
  }
  return named;
}

/**
 * What the `build*` scripts publish, read from their own commands. A directory output is
 * `-o <dir>`/`--output <dir>`; a file output is any `dist/<name>.<ext>` token a build script
 * writes. Neither list is written down here.
 */
export function declaredOutputs({ scripts }) {
  const outputs = new Map();
  const record = (path) => {
    const clean = path
      .replace(/["']/gu, "")
      .replace(/[.,;:)\]]+$/u, "")
      .replaceAll("\\", "/")
      .replace(/^\.\//u, "");
    outputs.set(clean, { path: clean, file: /[^/]+\.[A-Za-z0-9]+$/u.test(clean) });
  };
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith("build")) continue;
    for (const match of command.matchAll(/(?:-o|--output)\s+(\S+)/gu)) record(match[1]);
    for (const match of command.matchAll(/(?:desktop|host)\/dist\/[A-Za-z0-9_.@+/-]+/gu)) record(match[0]);
  }
  return [...outputs.values()];
}

/** Whether a declared output covers `path` - as the file itself, or as the directory above it. */
export function producedBy(path, outputs) {
  return outputs.filter((output) => (output.file ? output.path === path : path.startsWith(`${output.path}/`)));
}

function main(
  argv,
  {
    root = ROOT,
    write = (line) => process.stdout.write(line),
    writeError = (line) => process.stderr.write(line),
    verifyRules = true,
  } = {},
) {
  const listing = argv.includes("--list");

  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file !== "");
  const named = setupArguments({ trackedFiles, read: (file) => readFileSync(resolve(root, file), "utf8") });
  const outputs = declaredOutputs({
    scripts: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {},
  });

  const unique = [...new Map(named.map((entry) => [entry.path, entry])).values()].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  if (listing) {
    for (const output of outputs) write(`output\t${output.path}\n`);
    for (const entry of unique) write(`named\t${entry.path}\t${entry.file}\n`);
    return 0;
  }

  const unproduced = unique.filter((entry) => producedBy(entry.path, outputs).length === 0);
  // The falsifier runs on every verdict, not once in a test file: a rule that has stopped being able to red this
  // gate must say so on the run that would otherwise print a clean count. `--list` is a listing, not a verdict, and
  // `verifyRules: false` is how the falsifier reaches the verdict path without re-entering itself.
  const checks = verifyRules ? selfCheck() : [];
  const failed = checks.filter((entry) => entry.status !== "passed");
  write(
    `${JSON.stringify({
      gate: "build_artifact_producers/v1",
      status: failed.length === 0 && unproduced.length === 0 ? "passed" : "failed",
      // The objects this gate examined: the setup paths tracked documents hand a maintainer. Zero of them means the
      // scan stopped reading the documents, not that every documented artifact is produced.
      examined: unique.length,
      ...(checks.length === 0 ? {} : { checks }),
    })}\n`,
  );
  if (failed.length > 0) {
    writeError(
      `build_artifact_producers_self_check_failed: ${failed.map((entry) => `${entry.id}: ${entry.detail}`).join("; ")}\n`,
    );
    return 1;
  }

  write(
    `build_artifact_producers setup_paths=${unique.length} outputs=${outputs.length} unproduced=${unproduced.length}\n`,
  );
  for (const entry of unproduced) {
    writeError(
      `build_artifact_unproduced:${entry.path} (named by ${entry.file}) - no build* script publishes it, so the ` +
        `documented command cannot work from a fresh checkout. Add the step that produces it, or point the ` +
        `document at an artifact one does.\n`,
    );
  }
  return unproduced.length === 0 ? 0 : 1;
}

/** The artifact the falsifier's runbook hands out, and the file that names it. */
const SELF_CHECK_ARTIFACT = "desktop/dist/setup/GameBuddy.Setup.exe";
const SELF_CHECK_RUNBOOK = "docs/runbook.md";

/**
 * A scratch repository shaped like the defect this gate was written for: one tracked runbook passing
 * `--setup <artifact>` to a maintainer, one build script publishing somewhere else, and `produce` deciding
 * whether a second build script publishes the artifact the runbook names.
 */
function selfCheckTree({ produce }) {
  const root = mkdtempSync(join(tmpdir(), "build-artifact-producers-"));
  mkdirSync(resolve(root, "docs"), { recursive: true });
  writeFileSync(
    resolve(root, SELF_CHECK_RUNBOOK),
    `# Sandbox acceptance\n\nRun \`pnpm build:installer\`, then hand the installer to the driver:\n\n` +
      `    node tools/driver.mjs --setup ${SELF_CHECK_ARTIFACT}\n`,
  );
  const scripts = { "build:launcher": "node tools/build-launcher.mjs -o desktop/dist/launcher" };
  if (produce) scripts["build:installer"] = "dotnet publish desktop/installer -c Release -o desktop/dist/setup";
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ name: "probe", scripts }, null, 2)}\n`);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in the falsifier tree: ${result.stderr}`);
  };
  git("init", "-q");
  git("add", "-A");
  return root;
}

/** Run the verdict over a tree, capturing what it printed and the exit code it returns. */
function runVerdict(root) {
  const printed = [];
  const errors = [];
  const exitCode = main([], {
    root,
    write: (line) => printed.push(line),
    writeError: (line) => errors.push(line),
    verifyRules: false,
  });
  return { exitCode, stdout: printed.join(""), stderr: errors.join("") };
}

/**
 * The falsifier, run on every verdict: the gate's own claim driven over two scratch trees.
 *
 * The defect tree's runbook names an artifact no build script publishes, so the documented command cannot work
 * from a fresh checkout - the exact situation `tools/sandbox/README.md` was in when this gate was written. The
 * gate must name the artifact AND the file that names it, not merely exit 1. The control is the same tree with
 * the producing script added: a gate that failed on any tree would pass the first check and fail this one.
 */
export function selfCheck() {
  const checks = [];
  const record = (id, ok, detail) => checks.push({ id, status: ok ? "passed" : "failed", detail });
  const defect = selfCheckTree({ produce: false });
  const control = selfCheckTree({ produce: true });
  try {
    const failed = runVerdict(defect);
    const finding = `build_artifact_unproduced:${SELF_CHECK_ARTIFACT} (named by ${SELF_CHECK_RUNBOOK})`;
    const reported = failed.exitCode === 1 && failed.stderr.includes(finding);
    record(
      "unproduced_artifact_is_named_with_the_file_that_names_it",
      reported,
      reported
        ? finding
        : `exit ${failed.exitCode}, printed ${JSON.stringify((failed.stderr || failed.stdout).slice(0, 300))}`,
    );

    const passed = runVerdict(control);
    const silent = passed.exitCode === 0 && passed.stderr === "";
    record(
      "the_same_tree_with_its_producer_is_silent",
      silent,
      silent
        ? "exit 0, no finding"
        : `exit ${passed.exitCode}, printed ${JSON.stringify((passed.stderr || passed.stdout).slice(0, 300))}`,
    );
  } finally {
    rmSync(defect, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
  return checks;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
