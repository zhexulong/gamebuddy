/**
 * Normalises the CJS shim `bun build` inlines into vendored ESM bundles.
 *
 * For a bundled CommonJS dependency, bun emits:
 *
 *     var __dirname = "E:\\projects\\...\\node_modules\\.bun\\@huggingface+transformers@...\\dist",
 *         __filename  = "...\\transformers.node.mjs";
 *
 * The value is the **build machine's** directory. It cannot exist on a player's machine, so the code that reads it is
 * already broken there; this rewrite cannot make it worse. The emitted files are ESM, where `import.meta.dirname` and
 * `import.meta.filename` resolve to the bundle's own location - a real path, and the one a bundled asset lookup wants.
 *
 * Why it lives here rather than in the submodule: the submodule's `dist` is gitignored and is built *by this pipeline*
 * (that is the only reason it exists in CI), so normalising the output before it is snapshotted is a step this repository
 * owns. When the submodule's own build stops inlining, this becomes a no-op - it only rewrites the inlined form.
 *
 * Population is the same discovery the leak gate uses (every `dist` under `vendor/`), so the fixer and the checker can
 * never disagree about what they are looking at.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

const PAIR = /var __dirname = "(?:[^"\\]|\\.)*", __filename = "(?:[^"\\]|\\.)*";/gu;
const ONLY_DIRNAME = /var __dirname = "(?:[^"\\]|\\.)*";/gu;
const ONLY_FILENAME = /var __filename = "(?:[^"\\]|\\.)*";/gu;

const PAIR_REPLACEMENT = "var __dirname = import.meta.dirname, __filename = import.meta.filename;";
const DIRNAME_REPLACEMENT = "var __dirname = import.meta.dirname;";
const FILENAME_REPLACEMENT = "var __filename = import.meta.filename;";

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Every `dist` directory under `vendor/`, discovered rather than listed - the same population the gate examines. */
export async function bundleRoots(vendorRoot) {
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.name === "dist") found.push(path);
      else await walk(path);
    }
  }
  if (await isDirectory(vendorRoot)) await walk(vendorRoot);
  return found.sort();
}

/**
 * Rewrites one file's text. Returns the new text and whether anything changed, so the caller can report a count rather
 * than claim success.
 */
export function normaliseShim(text) {
  let result = text;
  result = result.replace(PAIR, PAIR_REPLACEMENT);
  result = result.replace(ONLY_DIRNAME, DIRNAME_REPLACEMENT);
  result = result.replace(ONLY_FILENAME, FILENAME_REPLACEMENT);
  return { text: result, changed: result !== text };
}

export async function normaliseVendoredBundles({ vendorRoot = join(repositoryRoot, "vendor") } = {}) {
  const roots = await bundleRoots(vendorRoot);
  const changed = [];
  let examined = 0;
  for (const root of roots) {
    for (const file of await collect(root)) {
      examined += 1;
      const text = await readFile(file, "utf8");
      const result = normaliseShim(text);
      if (!result.changed) continue;
      await writeFile(file, result.text, "utf8");
      changed.push(file);
    }
  }
  return Object.freeze({ roots: Object.freeze(roots), examined, changed: Object.freeze(changed) });
}

async function collect(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:mjs|cjs|js)$/iu.test(entry.name)) files.push(path);
    }
  }
  await walk(root);
  return files.sort();
}

async function main() {
  const vendorRoot = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
  const result = await normaliseVendoredBundles(vendorRoot === undefined ? {} : { vendorRoot });
  process.stdout.write(
    `examined ${result.examined} file(s) in ${result.roots.length} dist root(s); normalised ${result.changed.length}\n`,
  );
  for (const file of result.changed) {
    process.stdout.write(`  ${relative(repositoryRoot, file).replaceAll("\\", "/")}\n`);
  }
  // Zero population means the build has not run yet; saying so is better than reporting "0 normalised" as success.
  if (result.examined === 0) {
    process.stderr.write("vendored_bundles_absent: no dist tree to normalise, so the build has not run\n");
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  await main();
}
