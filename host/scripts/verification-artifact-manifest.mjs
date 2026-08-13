import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOST_VERIFICATION_ARTIFACT_MANIFEST = "verification-artifact-manifest.json";
export const HOST_VERIFICATION_ARTIFACT_SCHEMA = "gamebuddy-host-verification-artifact/v1";
export const HOST_TEST_ARTIFACT_TOPOLOGY = "host_test_verification/v1";

const slash = (value) => value.replaceAll("\\", "/");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const repositoryRoot = resolve(hostRoot, "..");

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

async function packageFiles(packageRoot) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const absolute = resolve(directory, entry.name);
      const state = await lstat(absolute);
      if (state.isSymbolicLink()) throw manifestError("dependency_tree_invalid");
      if (state.isDirectory()) await walk(absolute);
      else if (state.isFile()) files.push({ path: slash(relative(packageRoot, absolute)), sha256: digest(await readFile(absolute)) });
      else throw manifestError("dependency_tree_invalid");
    }
  }
  await walk(packageRoot);
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function dependencyNames(packageJson, includeDev = false) {
  return [...new Set([...(Object.keys(packageJson.dependencies ?? {})), ...(Object.keys(packageJson.optionalDependencies ?? {})), ...(includeDev ? Object.keys(packageJson.devDependencies ?? {}) : [])])].sort();
}

function optionalDependencyNames(packageJson) {
  return new Set(Object.keys(packageJson.optionalDependencies ?? {}));
}

async function resolveDependencyPackage(packageDirectory, name) {
  let directory = packageDirectory;
  for (;;) {
    const candidate = resolve(directory, "node_modules", name);
    try {
      const target = await realpath(candidate);
      const targetRelative = relative(repositoryRoot, target);
      if (isAbsolute(targetRelative) || targetRelative.startsWith(`..${sep}`) || targetRelative === "..") throw manifestError("dependency_outside_repository");
      await regularDirectory(target, "dependency_tree_invalid");
      return target;
    } catch (error) {
      if (error?.code !== "ENOENT" && !String(error?.message ?? error).startsWith("host_verification_artifact_")) throw error;
    }
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  throw manifestError("dependency_missing");
}

async function dependencySnapshot(root) {
  const lockCandidates = [resolve(root, "pnpm-lock.yaml"), resolve(root, "..", "pnpm-lock.yaml"), resolve(repositoryRoot, "pnpm-lock.yaml")];
  let lockPath;
  for (const candidate of lockCandidates) {
    try { await regularFile(candidate, "dependency_lock_missing"); lockPath = candidate; break; } catch (error) {
      if (!String(error?.message ?? error).endsWith("dependency_lock_missing")) throw error;
    }
  }
  if (lockPath === undefined) throw manifestError("dependency_lock_missing");
  const packages = [];
  const visited = new Set();
  async function visit(directory, name) {
    const target = await realpath(directory);
    if (visited.has(target)) return;
    visited.add(target);
    const packagePath = resolve(target, "package.json");
    await regularFile(packagePath, "dependency_package_invalid");
    let packageJson;
    try { packageJson = JSON.parse(await readFile(packagePath, "utf8")); } catch { throw manifestError("dependency_package_invalid"); }
    packages.push({ name, path: slash(relative(repositoryRoot, target)), packageJson: digest(await readFile(packagePath)), files: await packageFiles(target) });
    const optional = optionalDependencyNames(packageJson);
    for (const dependency of dependencyNames(packageJson)) {
      try { await visit(await resolveDependencyPackage(target, dependency), dependency); }
      catch (error) { if (!optional.has(dependency) || !String(error?.message ?? error).endsWith("dependency_missing")) throw error; }
    }
  }
  const hostPackagePath = resolve(root, "package.json");
  let hostPackage;
  try { hostPackage = JSON.parse(await readFile(hostPackagePath, "utf8")); } catch { throw manifestError("source_config_invalid"); }
  for (const name of dependencyNames(hostPackage, true)) await visit(await resolveDependencyPackage(root, name), name);
  packages.sort((left, right) => `${left.name}:${left.path}`.localeCompare(`${right.name}:${right.path}`, "en"));
  return Object.freeze({ lockfile: { path: "pnpm-lock.yaml", sha256: digest(await readFile(lockPath)) }, packages });
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
  const dependencies = await dependencySnapshot(root);
  return Object.freeze({ digest: digest(JSON.stringify({ entries, dependencies })), entries, dependencies });
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
  if (!isExactRecord(value.source, ["digest", "entries", "dependencies"]) || !/^[a-f0-9]{64}$/.test(value.source.digest) || !validInventory(value.source.entries)
    || !isExactRecord(value.source.dependencies, ["lockfile", "packages"]) || !isExactRecord(value.source.dependencies.lockfile, ["path", "sha256"])
    || value.source.dependencies.lockfile.path !== "pnpm-lock.yaml" || !/^[a-f0-9]{64}$/.test(value.source.dependencies.lockfile.sha256)
    || !Array.isArray(value.source.dependencies.packages) || !value.source.dependencies.packages.every((entry) => isExactRecord(entry, ["name", "path", "packageJson", "files"])
      && typeof entry.name === "string" && typeof entry.path === "string" && /^[a-f0-9]{64}$/.test(entry.packageJson) && validInventory(entry.files))) throw manifestError("manifest_invalid");
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
  if (manifest.source.digest !== currentSource.digest || JSON.stringify(manifest.source) !== JSON.stringify(currentSource)) throw manifestError("source_snapshot_mismatch");
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
