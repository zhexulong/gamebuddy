/**
 * Gate: a shipped bundle must not name the machine that built it.
 *
 * The release chain found this the hard way - six files inside `@cortexkit/pi-magic-context/dist` carried
 * `E:\\projects\\ai-game-companion\\vendor\\...` in `__filename`/`__dirname`, inlined by the submodule's `bun build` for
 * the CommonJS dependencies it bundles. That ships a path which means nothing on a player's machine, and it is the build
 * machine's directory layout in a public artifact. Finding it on the first tagged release is too late, so this gate runs
 * in ordinary CI.
 *
 * Population from the authority: every `dist` directory under `vendor/` that holds JavaScript, discovered by walking the
 * tree rather than listed here, so a submodule that starts publishing a bundle joins the gate automatically. Zero
 * population is blocked, never green.
 *
 * The matcher and the gate are two different claims, and CI depends on the second, so the sibling test drives the gate
 * itself over a synthetic bundle tree. Measured 2026-11-07:
 *
 * red-proof: inject  make `bundleFiles` return nothing, so the walk examines no file at all -> `examined 0` and both
 *                   end-to-end cases fail (`15 pass / 3 fail` across the two sibling test files); restoring the file
 *                   leaves `git diff` empty
 *
 * Two classes, because they fail differently:
 *
 *   - *build-machine paths* (the repository root, this user's home, or anything through `node_modules`/`vendor`/`.bun`)
 *     are blocking: they never mean anything useful in shipped code;
 *   - *any other absolute path* is reported with file:line for a human to judge. A library that strips `C:\\Users\\` from
 *     a string is doing something legitimate, and a gate that calls that a defect gets switched off.
 *
 * Matching is deliberately narrow. Measured on this tree: a greedy pattern matched wasm byte escapes and regex literals,
 * and the same over-long match made a legitimate `C:\\Users\\` pattern look like a build-machine path because unrelated
 * text further along the line contained `node_modules`. So separators are normalised, and a match has to be a run of
 * path-safe segments.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

/** Bundle text that is shipped to a player. A source map carries the same strings, so it is examined too. */
const BUNDLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".map"]);

/** A path segment: what a real directory name may contain. Everything else ends the match, which is what keeps regex
 * literals and code fragments out. */
const SEGMENT = "[A-Za-z0-9_.\\- ]+";
const WINDOWS_ABSOLUTE = new RegExp(`[A-Za-z]:\\\\${SEGMENT}(?:\\\\${SEGMENT})+`, "gu");
const POSIX_ABSOLUTE = new RegExp(`/(?:home|Users)/${SEGMENT}(?:/${SEGMENT})+`, "gu");

/**
 * A backslash escape that a bundler writes for binary content: `\\xNN`, `\\uNNNN`, or an octal `\\NNN`. A real path does
 * not contain one, and after separators are normalised these are exactly what makes wasm bytes look like directories.
 */
const ESCAPE_SEQUENCE = /\\[xu][0-9a-fA-F]|\\[0-7]/u;

/** Markers that only ever mean "somebody's build directory". */
const BUILD_MACHINE_MARKERS = ["\\node_modules\\", "\\.bun\\", "\\vendor\\", "/node_modules/", "/.bun/", "/vendor/"];

/** Normalises how a bundler writes a path: separators doubled, and `\\/` for a forward slash. */
const normalizeSeparators = (line) => line.replaceAll("\\\\", "\\").replaceAll("\\/", "/");

function fail(reason) {
  throw new Error(`vendored_bundle_leak_gate_failed:${reason}`);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Every `dist` directory under `vendor/`, discovered rather than listed. */
export async function bundleRoots(vendorRoot) {
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // `node_modules` is installed, not authored: the bundles in question are the ones the submodules build.
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.name === "dist") found.push(path);
      else await walk(path);
    }
  }
  if (await isDirectory(vendorRoot)) await walk(vendorRoot);
  return found.sort();
}

async function bundleFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (BUNDLE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase())) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}

export const isBuildMachinePath = (value, { repository = repositoryRoot, home = homedir() } = {}) =>
  value.startsWith(repository) ||
  value.startsWith(home) ||
  BUILD_MACHINE_MARKERS.some((marker) => value.includes(marker));

/**
 * Examines one bundle's text. Returns findings as `{file, line, value}` in two classes, so a failure names the member
 * instead of saying "expected true".
 */
export function inspectBundleText({ text, file, home = homedir(), repository = repositoryRoot }) {
  const blocking = [];
  const reported = [];
  for (const [index, line] of text.split("\n").entries()) {
    const normalized = normalizeSeparators(line);
    for (const pattern of [WINDOWS_ABSOLUTE, POSIX_ABSOLUTE]) {
      for (const match of normalized.matchAll(pattern)) {
        const value = match[0];
        // A template hole means the path is assembled at runtime; only an inlined literal is a defect.
        if (value.includes("${")) continue;
        if (ESCAPE_SEQUENCE.test(value)) continue;
        const finding = { file, line: index + 1, value: value.slice(0, 160) };
        if (isBuildMachinePath(value, { repository, home })) blocking.push(finding);
        else reported.push(finding);
      }
    }
  }
  return { blocking, reported };
}

export async function checkVendoredBundleLeaks({
  vendorRoot = join(repositoryRoot, "vendor"),
  roots = undefined,
} = {}) {
  const discovered = roots ?? (await bundleRoots(vendorRoot));
  let examined = 0;
  const blocking = [];
  const reported = [];

  for (const root of discovered) {
    for (const file of await bundleFiles(root)) {
      examined += 1;
      const result = inspectBundleText({ text: await readFile(file, "utf8"), file });
      blocking.push(...result.blocking);
      reported.push(...result.reported);
    }
  }
  return Object.freeze({
    roots: Object.freeze(discovered),
    examined,
    blocking: Object.freeze(blocking),
    reported: Object.freeze(reported),
  });
}

const describe = (finding) =>
  `${relative(repositoryRoot, finding.file).replaceAll("\\", "/")}:${finding.line}  ${finding.value}`;

async function main() {
  const vendorRoot = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
  const result = await checkVendoredBundleLeaks(vendorRoot === undefined ? {} : { vendorRoot });

  process.stdout.write(`examined ${result.examined} bundle file(s) in ${result.roots.length} dist root(s)\n`);
  for (const root of result.roots) process.stdout.write(`  ${relative(repositoryRoot, root).replaceAll("\\", "/")}\n`);

  if (result.reported.length > 0) {
    process.stdout.write(`\n${result.reported.length} absolute path(s) needing a human's judgement:\n`);
    for (const finding of result.reported.slice(0, 20)) process.stdout.write(`  ${describe(finding)}\n`);
    if (result.reported.length > 20) process.stdout.write(`  … ${result.reported.length - 20} more\n`);
  }

  // An empty scan agrees with itself: zero population is a blocked reading, not a pass.
  if (result.examined === 0) fail("no_bundle_files_examined");

  if (result.blocking.length > 0) {
    process.stdout.write(`\n${result.blocking.length} build-machine path(s) in a shipped bundle:\n`);
    for (const finding of result.blocking.slice(0, 20)) process.stdout.write(`  ${describe(finding)}\n`);
    fail(`build_machine_path:${result.blocking.length}`);
  }

  process.stdout.write("\nvendored_bundle_leaks_absent\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
