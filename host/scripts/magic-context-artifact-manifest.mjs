import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Content manifests for the vendored Magic Context artifact.
 *
 * The Host ships `@cortexkit/pi-magic-context` as a `file:` dependency on the
 * vendored fork, so the payload the Host resolves is the fork's own `dist`
 * build. What matters is that the payload we ship is the payload we built; a
 * whole-file digest equality against the vendor directory cannot state that,
 * because bun's CJS interop bakes the build machine's repository path into
 * `__dirname`/`__filename` declarations and the fork's own post-process
 * (`packages/pi-plugin/scripts/neutralise-absolute-paths.mjs`) rewrites exactly
 * those values. A manifest states the same claim structurally - the file set,
 * per-file sizes and per-file content hashes of the produced output - with the
 * build machine's absolute paths neutralised first.
 */

const MAGIC_CONTEXT_ARTIFACT_MANIFEST_SCHEMA = "gamebuddy-magic-context-artifact-manifest/v1";

// The same declaration shape the fork's post-process rewrites; it targets the
// emitted `.js` chunks whose value is a build machine's `node_modules` path.
const neutralisableAbsolutePathDeclaration = /(__dirname|__filename) = "([^"]*node_modules[^"]*)"/gu;
const neutralisedAbsolutePathDeclaration = '$1 = "<neutralised-absolute-path>"';
const neutralisableExtension = ".js";

const digest = (content) => createHash("sha256").update(content).digest("hex");

export function neutraliseMagicContextArtifactContent(text) {
  return text.replace(neutralisableAbsolutePathDeclaration, neutralisedAbsolutePathDeclaration);
}

async function manifestEntry(root, path) {
  const content = await readFile(resolve(root, path));
  const normalised = path.endsWith(neutralisableExtension)
    ? Buffer.from(neutraliseMagicContextArtifactContent(content.toString("utf8")), "utf8")
    : content;
  return { path, size: normalised.byteLength, sha256: digest(normalised) };
}

async function manifestEntries(root, prefix, entries) {
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await manifestEntries(root, path, entries);
    else if (entry.isFile()) entries.push(await manifestEntry(root, path));
    else throw new Error(`magic_context_artifact_manifest_entry_not_regular_file:${path}`);
  }
  return entries;
}

export async function createMagicContextArtifactManifest(root) {
  const entries = (await manifestEntries(root, "", [])).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Object.freeze({
    schema: MAGIC_CONTEXT_ARTIFACT_MANIFEST_SCHEMA,
    entries: Object.freeze(entries),
    digest: digest(JSON.stringify({ schema: MAGIC_CONTEXT_ARTIFACT_MANIFEST_SCHEMA, entries })),
  });
}

/**
 * Name the first difference between the payload we ship (`shipped`) and the
 * artifact we built (`built`): a file only the shipped payload carries is
 * `unexpected-file`, a file only the build produced is `missing-file`.
 */
export function describeMagicContextArtifactManifestDifference(shipped, built) {
  const builtByPath = new Map(built.entries.map((entry) => [entry.path, entry]));
  const shippedByPath = new Map(shipped.entries.map((entry) => [entry.path, entry]));
  const unexpected = [...shippedByPath.keys()].filter((path) => !builtByPath.has(path));
  if (unexpected.length > 0) return `unexpected-file:${unexpected[0]}`;
  const missing = [...builtByPath.keys()].filter((path) => !shippedByPath.has(path));
  if (missing.length > 0) return `missing-file:${missing[0]}`;
  for (const [path, entry] of shippedByPath) {
    const produced = builtByPath.get(path);
    if (entry.sha256 === produced.sha256 && entry.size === produced.size) continue;
    return `changed-file:${path}:size=${entry.size}/${produced.size}:sha256=${entry.sha256}/${produced.sha256}`;
  }
  return "equivalent";
}

