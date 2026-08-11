import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOST_VERIFICATION_ARTIFACT_MANIFEST = "verification-artifact-manifest.json";
export const HOST_VERIFICATION_ARTIFACT_SCHEMA = "gamebuddy-host-verification-artifact/v1";
export const HOST_TEST_ARTIFACT_TOPOLOGY = "host_test_verification/v1";

const slash = (value) => value.replaceAll("\\", "/");
const digest = (value) => createHash("sha256").update(value).digest("hex");

function manifestError(code) {
  return new Error(`host_verification_artifact_${code}`);
}

function assertInside(root, candidate, code) {
  const value = relative(root, candidate);
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) throw manifestError(code);
}

async function regularFile(path, code) {
  let state;
  try { state = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") throw manifestError(code);
    throw error;
  }
  if (state.isSymbolicLink() || !state.isFile()) throw manifestError(code);
}

async function regularDirectory(path, code) {
  let state;
  try { state = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") throw manifestError(code);
    throw error;
  }
  if (state.isSymbolicLink() || !state.isDirectory()) throw manifestError(code);
}

async function collectRegularFiles(root, code, ignored = new Set()) {
  await regularDirectory(root, code);
  const files = [];
  async function walk(directory) {
    assertInside(root, directory, code);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      assertInside(root, absolute, code);
      const path = slash(relative(root, absolute));
      if (ignored.has(path)) continue;
      const state = await lstat(absolute);
      if (state.isSymbolicLink()) throw manifestError(code);
      if (state.isDirectory()) await walk(absolute);
      else if (state.isFile()) files.push({ path, sha256: digest(await readFile(absolute)) });
      else throw manifestError(code);
    }
  }
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function sourceSnapshot(root) {
  const configs = ["package.json", "tsconfig.json", "tsconfig.test.json"];
  const configEntries = [];
  for (const path of configs) {
    const absolute = resolve(root, path);
    await regularFile(absolute, "source_config_invalid");
    configEntries.push({ path, sha256: digest(await readFile(absolute)) });
  }
  // `dist-test` contains emitted TypeScript plus a small explicit set of
  // copied PowerShell fixtures/resources. Snapshot every regular Host source
  // input, not merely `.ts`, so a source asset cannot silently outlive its
  // manifest-bound test output.
  const sourceRoot = resolve(root, "src");
  const sources = (await collectRegularFiles(sourceRoot, "source_tree_invalid"))
    .map((entry) => ({ path: `src/${entry.path}`, sha256: entry.sha256 }));
  const resourceRoot = resolve(root, "resources");
  const resources = (await collectRegularFiles(resourceRoot, "resource_tree_invalid"))
    .map((entry) => ({ path: `resources/${entry.path}`, sha256: entry.sha256 }));
  const scriptRoot = resolve(root, "scripts");
  const runnerScripts = (await collectRegularFiles(scriptRoot, "runner_tree_invalid"))
    .filter((entry) => entry.path.endsWith(".mjs"))
    .map((entry) => ({ path: `scripts/${entry.path}`, sha256: entry.sha256 }));
  if (sources.length === 0 || resources.length === 0 || runnerScripts.length === 0) throw manifestError("source_tree_empty");
  const entries = [...configEntries, ...sources, ...resources, ...runnerScripts];
  return Object.freeze({ digest: digest(JSON.stringify(entries)), entries });
}

async function compilerConfig(root) {
  const configPath = resolve(root, "tsconfig.test.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) throw manifestError("compiler_config_invalid");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length > 0) throw manifestError("compiler_config_invalid");
  return Object.freeze({
    path: "tsconfig.test.json",
    sha256: digest(await readFile(configPath)),
    typescriptVersion: ts.version,
  });
}

function isExactRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validInventory(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isExactRecord(entry, ["path", "sha256"])
    && typeof entry.path === "string" && entry.path.length > 0 && !entry.path.includes("\\")
    && !entry.path.startsWith("/") && !entry.path.split("/").includes("..")
    && typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256));
}

function validateManifest(value) {
  if (!isExactRecord(value, ["schema", "topology", "outputRoot", "builtAtMs", "toolchain", "source", "output"])) throw manifestError("manifest_invalid");
  if (value.schema !== HOST_VERIFICATION_ARTIFACT_SCHEMA || value.topology !== HOST_TEST_ARTIFACT_TOPOLOGY
    || value.outputRoot !== "dist-test" || !Number.isSafeInteger(value.builtAtMs) || value.builtAtMs <= 0) throw manifestError("manifest_invalid");
  if (!isExactRecord(value.toolchain, ["node", "typescriptVersion", "compilerConfig"]) || typeof value.toolchain.node !== "string"
    || typeof value.toolchain.typescriptVersion !== "string" || !isExactRecord(value.toolchain.compilerConfig, ["path", "sha256"])
    || value.toolchain.compilerConfig.path !== "tsconfig.test.json" || !/^[a-f0-9]{64}$/.test(value.toolchain.compilerConfig.sha256)) throw manifestError("manifest_invalid");
  if (!isExactRecord(value.source, ["digest", "entries"]) || !/^[a-f0-9]{64}$/.test(value.source.digest) || !validInventory(value.source.entries)) throw manifestError("manifest_invalid");
  if (!isExactRecord(value.output, ["digest", "entries"]) || !/^[a-f0-9]{64}$/.test(value.output.digest) || !validInventory(value.output.entries)) throw manifestError("manifest_invalid");
  return value;
}

async function outputSnapshot(root) {
  const entries = await collectRegularFiles(root, "output_tree_invalid", new Set([HOST_VERIFICATION_ARTIFACT_MANIFEST]));
  if (entries.length === 0) throw manifestError("output_tree_empty");
  return Object.freeze({ digest: digest(JSON.stringify(entries)), entries });
}

/** Writes the sole declared verification identity for a freshly emitted dist-test tree. */
export async function writeHostVerificationArtifactManifest({ root = hostRoot, outputRoot = resolve(root, "dist-test"), now = Date.now() } = {}) {
  const resolvedRoot = resolve(root);
  const resolvedOutput = resolve(outputRoot);
  assertInside(resolvedRoot, resolvedOutput, "output_root_invalid");
  if (slash(relative(resolvedRoot, resolvedOutput)) !== "dist-test") throw manifestError("output_root_invalid");
  const [source, config, output] = await Promise.all([sourceSnapshot(resolvedRoot), compilerConfig(resolvedRoot), outputSnapshot(resolvedOutput)]);
  const manifest = Object.freeze({
    schema: HOST_VERIFICATION_ARTIFACT_SCHEMA,
    topology: HOST_TEST_ARTIFACT_TOPOLOGY,
    outputRoot: "dist-test",
    builtAtMs: now,
    toolchain: Object.freeze({ node: process.version, typescriptVersion: config.typescriptVersion, compilerConfig: Object.freeze({ path: config.path, sha256: config.sha256 }) }),
    source,
    output,
  });
  const finalPath = resolve(resolvedOutput, HOST_VERIFICATION_ARTIFACT_MANIFEST);
  const temporaryPath = resolve(resolvedOutput, `.${HOST_VERIFICATION_ARTIFACT_MANIFEST}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, finalPath);
  return manifest;
}

/** Fails closed unless this exact test output matches its source, compiler and inventory identity. */
export async function assertHostVerificationArtifactManifest({ root = hostRoot, outputRoot = resolve(root, "dist-test") } = {}) {
  const resolvedRoot = resolve(root);
  const resolvedOutput = resolve(outputRoot);
  assertInside(resolvedRoot, resolvedOutput, "output_root_invalid");
  if (slash(relative(resolvedRoot, resolvedOutput)) !== "dist-test") throw manifestError("output_root_invalid");
  const manifestPath = resolve(resolvedOutput, HOST_VERIFICATION_ARTIFACT_MANIFEST);
  await regularFile(manifestPath, "manifest_missing");
  let manifest;
  try { manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8"))); }
  catch (error) { if (String(error?.message ?? error).startsWith("host_verification_artifact_")) throw error; throw manifestError("manifest_invalid"); }
  const [currentSource, currentConfig, currentOutput] = await Promise.all([sourceSnapshot(resolvedRoot), compilerConfig(resolvedRoot), outputSnapshot(resolvedOutput)]);
  if (manifest.source.digest !== currentSource.digest || JSON.stringify(manifest.source.entries) !== JSON.stringify(currentSource.entries)) throw manifestError("source_snapshot_mismatch");
  if (manifest.toolchain.node !== process.version || manifest.toolchain.typescriptVersion !== currentConfig.typescriptVersion
    || manifest.toolchain.compilerConfig.sha256 !== currentConfig.sha256) throw manifestError("toolchain_mismatch");
  if (manifest.output.digest !== currentOutput.digest || JSON.stringify(manifest.output.entries) !== JSON.stringify(currentOutput.entries)) throw manifestError("output_inventory_mismatch");
  return manifest;
}

/** Test cleanup helper: only deletes a manifest path rooted under a disposable dist-test tree. */
export async function removeHostVerificationArtifactManifest({ root = hostRoot, outputRoot = resolve(root, "dist-test") } = {}) {
  const resolvedRoot = resolve(root); const resolvedOutput = resolve(outputRoot);
  assertInside(resolvedRoot, resolvedOutput, "output_root_invalid");
  if (slash(relative(resolvedRoot, resolvedOutput)) !== "dist-test") throw manifestError("output_root_invalid");
  await rm(resolve(resolvedOutput, HOST_VERIFICATION_ARTIFACT_MANIFEST), { force: true });
}
