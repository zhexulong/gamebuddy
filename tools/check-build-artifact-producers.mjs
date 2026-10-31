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
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

function main(argv) {
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file !== "");
  const named = setupArguments({ trackedFiles, read: (file) => readFileSync(resolve(ROOT, file), "utf8") });
  const outputs = declaredOutputs({
    scripts: JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).scripts ?? {},
  });

  const unique = [...new Map(named.map((entry) => [entry.path, entry])).values()].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  if (argv.includes("--list")) {
    for (const output of outputs) process.stdout.write(`output\t${output.path}\n`);
    for (const entry of unique) process.stdout.write(`named\t${entry.path}\t${entry.file}\n`);
    return 0;
  }

  const unproduced = unique.filter((entry) => producedBy(entry.path, outputs).length === 0);
  process.stdout.write(
    `build_artifact_producers setup_paths=${unique.length} outputs=${outputs.length} unproduced=${unproduced.length}\n`,
  );
  for (const entry of unproduced) {
    process.stderr.write(
      `build_artifact_unproduced:${entry.path} (named by ${entry.file}) - no build* script publishes it, so the ` +
        `documented command cannot work from a fresh checkout. Add the step that produces it, or point the ` +
        `document at an artifact one does.\n`,
    );
  }
  return unproduced.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
