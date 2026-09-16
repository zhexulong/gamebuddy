import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { runBoundedChild } from "@gamebuddy/game-action-devkit/process-supervisor";
import {
  assertChatLiveArtifactRoot,
  chatLiveDependencyClosureDigest,
  createChatLiveArtifactManifest,
  materializeChatLiveArtifactDependencyClosure,
  resolveChatLiveArtifactDependencyClosure,
  writeChatLiveArtifactAdmission,
  writeChatLiveArtifactInventory,
  writeChatLiveArtifactManifest,
  writeChatLiveArtifactMarker,
} from "./chat-live-artifact-support.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const HOST_ROOT = resolve(dirname(scriptPath), "..");
export const REPOSITORY_ROOT = resolve(HOST_ROOT, "..");
export const CHAT_LIVE_OUTPUT_ROOT = resolve("D:\\GameBuddy-chat-live-tmp");
export const CHAT_LIVE_TSCONFIG = resolve(HOST_ROOT, "tsconfig.chat-live.json");
export const CHAT_LIVE_SOURCE = resolve(HOST_ROOT, "src", "dialogue-web-main.ts");
const CHAT_LIVE_PROJECT = "tsconfig.chat-live.json";
const CHAT_LIVE_OUTPUT_DECLARATION = "D:/GameBuddy-chat-live-tmp";
const CHAT_LIVE_ENTRY = "dialogue-web-main.js";
const CHAT_LIVE_MUTEX_BROKER_ASSET = "windows-named-mutex-broker.ps1";
const CHAT_LIVE_RECLAIMER_DIR = "native/windows-stale-lock-reclaimer/win-x64";
const CHAT_LIVE_RECLAIMER_FILES = ["GameBuddy.WindowsStaleLockReclaimer.exe", "windows-stale-lock-reclaimer.manifest.json"];
const CHAT_LIVE_INSPECTOR_DIR = "native/windows-reparse-inspector/win-x64";
const CHAT_LIVE_INSPECTOR_FILES = ["GameBuddy.WindowsReparseInspector.exe", "windows-reparse-inspector.manifest.json"];
const CHAT_LIVE_BROWSER_STAGING_PARENT = resolve(REPOSITORY_ROOT, "dialogue-web", ".build-staging");
const CHAT_LIVE_BROWSER_MANIFEST = "tavern-browser-artifact-manifest.json";
const CHAT_LIVE_BROWSER_BUILD_CONFIG = "chat-live-browser.vite.config.mjs";
const CHAT_LIVE_BROWSER_VITE_CONFIG = resolve(REPOSITORY_ROOT, "dialogue-web", "vite.config.ts");
const CHAT_LIVE_BROWSER_MANIFEST_MODULE = resolve(REPOSITORY_ROOT, "dialogue-web", "scripts", "browser-artifact-manifest.mjs");
const BUILD_TIMEOUT_MS = 15 * 60_000;
const MAX_EMITTED_FILES = 20_000;
const CHAT_LIVE_SHA256 = /^[a-f0-9]{64}$/;
const CHAT_LIVE_BROWSER_STAGING_LEAF = /^[a-f0-9]{32}$/;
const chatLiveSha256 = (value) => createHash("sha256").update(value).digest("hex");

function contained(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder !== "" && !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}

function normalizedAbsolute(value, error) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error(error);
  return value;
}

async function regularFile(path, error) {
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error(error);
  return path;
}

async function regularDirectory(path, error) {
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error(error);
  return path;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertChatLiveTsconfigShape(config) {
  if (!exactObject(config) || Object.keys(config).sort().join(",") !== "compilerOptions,extends,files,include")
    throw new Error("chat_live_tsconfig_shape_invalid");
  if (config.extends !== "./tsconfig.json" || !Array.isArray(config.files) || JSON.stringify(config.files) !== JSON.stringify(["src/dialogue-web-main.ts", "src/magic-context-authored-context-bridge.d.ts"]) || !Array.isArray(config.include) || config.include.length !== 0)
    throw new Error("chat_live_tsconfig_source_invalid");
  const options = config.compilerOptions;
  if (!exactObject(options) || Object.keys(options).sort().join(",") !== "declaration,declarationMap,incremental,noEmit,noEmitOnError,outDir,rootDir,sourceMap")
    throw new Error("chat_live_tsconfig_options_invalid");
  if (options.outDir !== CHAT_LIVE_OUTPUT_DECLARATION || options.rootDir !== "src" || options.noEmit !== false || options.noEmitOnError !== true || options.declaration !== false || options.declarationMap !== false || options.sourceMap !== false || options.incremental !== false)
    throw new Error("chat_live_tsconfig_output_invalid");
  return config;
}

async function readAndValidateTsconfig(configPath) {
  await regularFile(configPath, "chat_live_tsconfig_not_regular_file");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (cause) {
    throw new Error("chat_live_tsconfig_invalid", { cause });
  }
  return assertChatLiveTsconfigShape(parsed);
}

async function validateBuildInputs({ hostRoot, outputRoot }) {
  const checkedHostRoot = normalizedAbsolute(hostRoot, "chat_live_host_root_invalid");
  if (checkedHostRoot !== HOST_ROOT) throw new Error("chat_live_host_root_not_canonical");
  const checkedOutputRoot = normalizedAbsolute(outputRoot, "chat_live_output_root_invalid");
  if (checkedOutputRoot !== CHAT_LIVE_OUTPUT_ROOT) throw new Error("chat_live_output_root_not_canonical");
  await regularDirectory(checkedHostRoot, "chat_live_host_root_invalid");
  await readAndValidateTsconfig(CHAT_LIVE_TSCONFIG);
  await regularFile(CHAT_LIVE_SOURCE, "chat_live_source_not_regular_file");
  const canonicalSource = await realpath(CHAT_LIVE_SOURCE);
  if (!contained(resolve(HOST_ROOT, "src"), canonicalSource) || canonicalSource !== CHAT_LIVE_SOURCE)
    throw new Error("chat_live_source_identity_invalid");

  const tscPath = resolve(HOST_ROOT, "node_modules", "typescript", "lib", "tsc.js");
  await regularFile(tscPath, "chat_live_typescript_not_regular_file");
  const canonicalTscPath = await realpath(tscPath);
  if (!contained(REPOSITORY_ROOT, canonicalTscPath)) throw new Error("chat_live_typescript_identity_invalid");
  return Object.freeze({ hostRoot: checkedHostRoot, outputRoot: checkedOutputRoot, tscPath: canonicalTscPath });
}

async function emittedFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = resolve(root, relativePath);
    if (!contained(root, absolutePath)) throw new Error("chat_live_emitted_path_escapes_root");
    const state = await lstat(absolutePath);
    if (state.isSymbolicLink()) throw new Error(`chat_live_emitted_symbolic_link:${relativePath}`);
    if (state.isDirectory()) result.push(...await emittedFiles(root, relativePath));
    else if (state.isFile()) {
      result.push(relativePath);
      if (result.length > MAX_EMITTED_FILES) throw new Error("chat_live_emitted_file_count_exceeded");
    } else throw new Error(`chat_live_emitted_entry_invalid:${relativePath}`);
  }
  return result.sort();
}

async function prepareOutputRoot(outputRoot) {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await regularDirectory(outputRoot, "chat_live_output_root_invalid");
  if (await realpath(outputRoot) !== outputRoot) throw new Error("chat_live_output_root_identity_invalid");
}

function privateBrowserStagingLeaf(stagingRoot) {
  const parent = CHAT_LIVE_BROWSER_STAGING_PARENT;
  if (!isAbsolute(stagingRoot) || resolve(stagingRoot) !== stagingRoot
    || !contained(parent, stagingRoot) || dirname(stagingRoot) !== parent
    || !CHAT_LIVE_BROWSER_STAGING_LEAF.test(stagingRoot.slice(parent.length + 1)))
    throw new Error("chat_live_browser_staging_root_invalid");
  return stagingRoot;
}

async function prepareBrowserStagingParent() {
  await mkdir(CHAT_LIVE_BROWSER_STAGING_PARENT, { recursive: true });
  await regularDirectory(CHAT_LIVE_BROWSER_STAGING_PARENT, "chat_live_browser_staging_parent_invalid");
  if (await realpath(CHAT_LIVE_BROWSER_STAGING_PARENT) !== CHAT_LIVE_BROWSER_STAGING_PARENT)
    throw new Error("chat_live_browser_staging_parent_identity_invalid");
}

async function prepareBrowserStagingRoot() {
  await prepareBrowserStagingParent();
  const stagingRoot = privateBrowserStagingLeaf(resolve(CHAT_LIVE_BROWSER_STAGING_PARENT, randomBytes(16).toString("hex")));
  await mkdir(stagingRoot);
  await regularDirectory(stagingRoot, "chat_live_browser_staging_root_invalid");
  if (await realpath(stagingRoot) !== stagingRoot) throw new Error("chat_live_browser_staging_root_identity_invalid");
  return stagingRoot;
}

function browserBuildEnvironment(inherited = process.env) {
  const environment = { LANG: "C", LC_ALL: "C" };
  for (const key of ["SystemRoot", "LOCALAPPDATA", "TEMP", "TMP"])
    if (typeof inherited[key] === "string" && inherited[key].length > 0) environment[key] = inherited[key];
  return environment;
}

async function resolveRepositoryFile(path, error) {
  try {
    await regularFile(path, error);
    const canonical = await realpath(path);
    if (!contained(REPOSITORY_ROOT, canonical)) throw new Error(error);
    return canonical;
  } catch (cause) {
    if (cause?.message === error) throw cause;
    throw new Error(error, { cause });
  }
}

export async function resolveChatLiveBrowserBuildInvocation({ stagingRoot, configPath } = {}) {
  const checkedStagingRoot = privateBrowserStagingLeaf(stagingRoot);
  await regularDirectory(checkedStagingRoot, "chat_live_browser_staging_root_invalid");
  if (typeof configPath !== "string" || !isAbsolute(configPath) || resolve(configPath) !== configPath
    || !contained(REPOSITORY_ROOT, configPath)) throw new Error("chat_live_browser_build_config_invalid");
  const vite = await resolveRepositoryFile(
    resolve(REPOSITORY_ROOT, "dialogue-web", "node_modules", "vite", "bin", "vite.js"),
    "chat_live_browser_vite_unresolvable",
  );
  await regularFile(configPath, "chat_live_browser_build_config_invalid");
  if (!contained(REPOSITORY_ROOT, await realpath(configPath))) throw new Error("chat_live_browser_build_config_identity_invalid");
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([vite, "build", "--config", configPath, "--outDir", checkedStagingRoot]),
    cwd: resolve(REPOSITORY_ROOT, "dialogue-web"),
    outputRoot: checkedStagingRoot,
  });
}

async function writeChatLiveBrowserViteConfig({ configPath, sourceRoot }) {
  const config = await resolveRepositoryFile(CHAT_LIVE_BROWSER_VITE_CONFIG, "chat_live_browser_vite_config_unresolvable");
  const adapter = await resolveRepositoryFile(
    resolve(sourceRoot, "windows-reparse-inspector", "index.js"),
    "chat_live_browser_reparse_adapter_unresolvable",
  );
  const configImport = relative(dirname(configPath), config).split(sep).join("/");
  const adapterImport = relative(dirname(configPath), adapter).split(sep).join("/");
  if (!configImport.startsWith("../") || resolve(dirname(configPath), configImport) !== config
    || !adapterImport.startsWith("../") || resolve(dirname(configPath), adapterImport) !== adapter)
    throw new Error("chat_live_browser_vite_config_invalid");
  await writeFile(
    configPath,
    `import * as reparseInspectorAdapter from ${JSON.stringify(adapterImport)};\nimport { createDialogueWebViteConfig } from ${JSON.stringify(configImport)};\nexport default createDialogueWebViteConfig({ schemaVersion: 1, kind: "gamebuddy.windows_reparse_inspector.v1", adapter: reparseInspectorAdapter });\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await regularFile(configPath, "chat_live_browser_vite_config_invalid");
  if (await realpath(configPath) !== configPath) throw new Error("chat_live_browser_vite_config_identity_invalid");
  return configPath;
}

async function verifyChatLiveBrowserManifest(stagingRoot, adapterPath) {
  const browserManifestModule = await import(pathToFileURL(CHAT_LIVE_BROWSER_MANIFEST_MODULE).href);
  if (typeof browserManifestModule.createBuildArtifactInspectionPolicy !== "function"
    || typeof browserManifestModule.verifyProductionArtifactManifest !== "function")
    throw new Error("chat_live_browser_manifest_api_unavailable");
  const adapter = await import(pathToFileURL(adapterPath).href);
  const policy = await browserManifestModule.createBuildArtifactInspectionPolicy({
    schemaVersion: 1,
    kind: "gamebuddy.windows_reparse_inspector.v1",
    adapter,
  });
  const manifest = await browserManifestModule.verifyProductionArtifactManifest(stagingRoot, policy);
  const manifestPath = resolve(stagingRoot, CHAT_LIVE_BROWSER_MANIFEST);
  return Object.freeze({ manifest, sha256: chatLiveSha256(await readFile(manifestPath)) });
}

async function prepareBrowserBuildSupport(sourceRoot) {
  const sourceAdapterRoot = resolve(sourceRoot, "windows-reparse-inspector");
  await regularDirectory(sourceAdapterRoot, "chat_live_browser_reparse_adapter_root_invalid");
  const supportRoot = resolve(HOST_ROOT, `.chat-live-browser-build-${process.pid}-${randomBytes(16).toString("hex")}`);
  await mkdir(supportRoot);
  try {
    const destinationAdapterRoot = resolve(supportRoot, "windows-reparse-inspector");
    await mkdir(destinationAdapterRoot);
    for (const file of ["index.js", "internal.js"]) {
      const source = resolve(sourceAdapterRoot, file);
      const destination = resolve(destinationAdapterRoot, file);
      await regularFile(source, `chat_live_browser_reparse_adapter_missing:${file}`);
      await copyFile(source, destination);
      await regularFile(destination, `chat_live_browser_reparse_adapter_copy_invalid:${file}`);
    }
    const configPath = resolve(supportRoot, CHAT_LIVE_BROWSER_BUILD_CONFIG);
    const viteConfigImport = relative(dirname(configPath), CHAT_LIVE_BROWSER_VITE_CONFIG).split(sep).join("/");
    if (!viteConfigImport.startsWith("../") || resolve(dirname(configPath), viteConfigImport) !== CHAT_LIVE_BROWSER_VITE_CONFIG)
      throw new Error("chat_live_browser_vite_config_invalid");
    await writeFile(
      configPath,
      `import * as reparseInspectorAdapter from "./windows-reparse-inspector/index.js";\nimport { createDialogueWebViteConfig } from ${JSON.stringify(viteConfigImport)};\nexport default createDialogueWebViteConfig({ schemaVersion: 1, kind: "gamebuddy.windows_reparse_inspector.v1", adapter: reparseInspectorAdapter });\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await regularFile(configPath, "chat_live_browser_vite_config_invalid");
    return Object.freeze({ supportRoot, configPath, adapterPath: resolve(destinationAdapterRoot, "index.js") });
  } catch (error) {
    await rm(supportRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Builds the current dialogue-web source into a private Vite staging leaf and
 * keeps that verified leaf alive for one composition. The caller owns the
 * returned cleanup operation; a failed build cleans itself up before rejecting.
 * No stale browser dist or process environment resolver participates.
 */
export async function buildChatLiveBrowserArtifactForComposition({
  sourceRoot = CHAT_LIVE_OUTPUT_ROOT,
  runChild = runBoundedChild,
  timeoutMs = BUILD_TIMEOUT_MS,
} = {}) {
  const checkedSourceRoot = normalizedAbsolute(sourceRoot, "chat_live_source_root_invalid");
  if (checkedSourceRoot !== CHAT_LIVE_OUTPUT_ROOT) throw new Error("chat_live_source_root_not_canonical");
  if (typeof runChild !== "function") throw new Error("chat_live_run_child_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new Error("chat_live_build_timeout_invalid");
  await regularDirectory(checkedSourceRoot, "chat_live_source_root_invalid");
  await prepareBrowserStagingParent();
  let browserStagingRoot;
  let support;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (browserStagingRoot !== undefined) await rm(browserStagingRoot, { recursive: true, force: true });
    if (support !== undefined) await rm(support.supportRoot, { recursive: true, force: true });
  };
  try {
    browserStagingRoot = await prepareBrowserStagingRoot();
    support = await prepareBrowserBuildSupport(checkedSourceRoot);
    const invocation = await resolveChatLiveBrowserBuildInvocation({
      stagingRoot: browserStagingRoot,
      configPath: support.configPath,
    });
    await runChild({
      ...invocation,
      timeoutMs,
      stdio: "pipe",
      spawnOptions: { env: browserBuildEnvironment() },
    });
    const manifestResult = await verifyChatLiveBrowserManifest(browserStagingRoot, support.adapterPath);
    return Object.freeze({
      sourceRoot: checkedSourceRoot,
      stagingRoot: browserStagingRoot,
      manifest: manifestResult.manifest,
      manifestSha256: manifestResult.sha256,
      invocation,
      cleanup,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Builds and verifies the browser artifact, then disposes its private staging
 * leaf after the caller has received the same result shape as before.
 */
export async function buildChatLiveBrowserArtifact(options = {}) {
  const retained = await buildChatLiveBrowserArtifactForComposition(options);
  try {
    return Object.freeze({
      sourceRoot: retained.sourceRoot,
      stagingRoot: retained.stagingRoot,
      manifest: retained.manifest,
      manifestSha256: retained.manifestSha256,
      invocation: retained.invocation,
      cleanup: Object.freeze({ stagingRootRemoved: true, supportRootRemoved: true }),
    });
  } finally {
    await retained.cleanup();
  }
}

async function copyVerifiedChatLiveBrowserTree({ browserRoot, artifactRoot, manifest }) {
  if (!exactObject(manifest) || manifest.browserContract !== "tavern_browser_api/v1"
    || manifest.profileId !== "gamebuddy.tavern.browser.v1" || manifest.entryHtml !== "index.html"
    || !Array.isArray(manifest.assets)) throw new Error("chat_live_browser_manifest_invalid");
  const destinationRoot = resolve(artifactRoot, "browser", "tavern", "v1");
  if (!contained(artifactRoot, destinationRoot)) throw new Error("chat_live_browser_destination_escapes_root");
  const paths = [manifest.entryHtml, CHAT_LIVE_BROWSER_MANIFEST, ...manifest.assets.map((asset) => asset.path)];
  if (new Set(paths).size !== paths.length) throw new Error("chat_live_browser_copy_paths_not_unique");
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) throw new Error("chat_live_browser_copy_path_invalid");
    const source = resolve(browserRoot, path.replaceAll("/", sep));
    const destination = resolve(destinationRoot, path.replaceAll("/", sep));
    if (!contained(browserRoot, source) || !contained(destinationRoot, destination))
      throw new Error("chat_live_browser_copy_path_escapes_root");
    await regularFile(source, "chat_live_browser_copy_source_invalid");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await regularFile(destination, "chat_live_browser_copy_destination_invalid");
  }
  return destinationRoot;
}

async function readChatLiveBuildMetadata() {
  const tsconfigBytes = await readFile(CHAT_LIVE_TSCONFIG);
  return Object.freeze({
    tsconfig: CHAT_LIVE_PROJECT,
    tsconfigSha256: chatLiveSha256(tsconfigBytes),
    typescriptVersion: ts.version,
    node: process.version,
  });
}

/**
 * Composes one fresh disposable Chat Live root. The TypeScript runtime closure,
 * artifact-local dependency closure, and verified browser tree are all written
 * before the marker/manifest/inventory/admission chain is sealed and re-read.
 */
export async function buildChatLiveArtifact({
  hostRoot = HOST_ROOT,
  outputRoot = CHAT_LIVE_OUTPUT_ROOT,
  runChild = runBoundedChild,
  timeoutMs = BUILD_TIMEOUT_MS,
} = {}) {
  const checkedHostRoot = normalizedAbsolute(hostRoot, "chat_live_host_root_invalid");
  const checkedOutputRoot = normalizedAbsolute(outputRoot, "chat_live_output_root_invalid");
  if (checkedHostRoot !== HOST_ROOT) throw new Error("chat_live_host_root_not_canonical");
  if (checkedOutputRoot !== CHAT_LIVE_OUTPUT_ROOT) throw new Error("chat_live_output_root_not_canonical");
  if (typeof runChild !== "function") throw new Error("chat_live_run_child_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new Error("chat_live_build_timeout_invalid");

  await rm(checkedOutputRoot, { recursive: true, force: true });
  await mkdir(checkedOutputRoot, { recursive: true });
  await regularDirectory(checkedOutputRoot, "chat_live_artifact_root_invalid");
  if (await realpath(checkedOutputRoot) !== checkedOutputRoot) throw new Error("chat_live_artifact_root_invalid");

  let browser;
  let completed = false;
  try {
    const source = await buildChatLiveSourceClosure({
      hostRoot: checkedHostRoot,
      outputRoot: checkedOutputRoot,
      runChild,
      timeoutMs,
    });
    const mutexAssetSource = resolve(checkedHostRoot, "resources", CHAT_LIVE_MUTEX_BROKER_ASSET);
    const mutexAssetDestination = resolve(checkedOutputRoot, CHAT_LIVE_MUTEX_BROKER_ASSET);
    await regularFile(mutexAssetSource, "chat_live_mutex_broker_asset_missing");
    if (await realpath(mutexAssetSource) !== mutexAssetSource) throw new Error("chat_live_mutex_broker_asset_identity_invalid");
    await copyFile(mutexAssetSource, mutexAssetDestination);
    await regularFile(mutexAssetDestination, "chat_live_mutex_broker_asset_copy_invalid");
    const reclaimerSourceRoot = resolve(HOST_ROOT, "native", "windows-stale-lock-reclaimer", ".dist", "win-x64");
    const reclaimerDestinationRoot = resolve(checkedOutputRoot, CHAT_LIVE_RECLAIMER_DIR);
    await regularDirectory(reclaimerSourceRoot, "chat_live_reclaimer_root_missing");
    await mkdir(reclaimerDestinationRoot, { recursive: true });
    for (const file of CHAT_LIVE_RECLAIMER_FILES) {
      const sourcePath = resolve(reclaimerSourceRoot, file);
      const destinationPath = resolve(reclaimerDestinationRoot, file);
      await regularFile(sourcePath, `chat_live_reclaimer_source_missing:${file}`);
      if (await realpath(sourcePath) !== sourcePath) throw new Error(`chat_live_reclaimer_source_identity_invalid:${file}`);
      await copyFile(sourcePath, destinationPath);
      await regularFile(destinationPath, `chat_live_reclaimer_copy_invalid:${file}`);
    }
    const inspectorSourceRoot = resolve(HOST_ROOT, "native", "windows-reparse-inspector", ".dist", "win-x64");
    const inspectorDestinationRoot = resolve(checkedOutputRoot, CHAT_LIVE_INSPECTOR_DIR);
    await regularDirectory(inspectorSourceRoot, "chat_live_inspector_root_missing");
    await mkdir(inspectorDestinationRoot, { recursive: true });
    for (const file of CHAT_LIVE_INSPECTOR_FILES) {
      const sourcePath = resolve(inspectorSourceRoot, file);
      const destinationPath = resolve(inspectorDestinationRoot, file);
      await regularFile(sourcePath, `chat_live_inspector_source_missing:${file}`);
      if (await realpath(sourcePath) !== sourcePath) throw new Error(`chat_live_inspector_source_identity_invalid:${file}`);
      await copyFile(sourcePath, destinationPath);
      await regularFile(destinationPath, `chat_live_inspector_copy_invalid:${file}`);
    }
    const closure = await resolveChatLiveArtifactDependencyClosure({ hostRoot: checkedHostRoot });
    browser = await buildChatLiveBrowserArtifactForComposition({
      sourceRoot: checkedOutputRoot,
      runChild,
      timeoutMs,
    });
    await materializeChatLiveArtifactDependencyClosure({
      hostRoot: checkedHostRoot,
      artifactRoot: checkedOutputRoot,
      closure,
    });
    await copyVerifiedChatLiveBrowserTree({
      browserRoot: browser.stagingRoot,
      artifactRoot: checkedOutputRoot,
      manifest: browser.manifest,
    });

    const artifactId = randomBytes(16).toString("hex");
    const manifest = createChatLiveArtifactManifest({
      artifactId,
      entry: CHAT_LIVE_ENTRY,
      build: await readChatLiveBuildMetadata(),
      browserArtifactManifestSha256: browser.manifestSha256,
      dependencyClosureDigest: chatLiveDependencyClosureDigest(closure),
      disposableRoot: checkedOutputRoot,
    });
    await writeChatLiveArtifactMarker({ artifactRoot: checkedOutputRoot });
    await writeChatLiveArtifactManifest({ artifactRoot: checkedOutputRoot, manifest });
    await writeChatLiveArtifactInventory({ artifactRoot: checkedOutputRoot, artifactId });
    await writeChatLiveArtifactAdmission({ artifactRoot: checkedOutputRoot });
    const verified = await assertChatLiveArtifactRoot({ artifactRoot: checkedOutputRoot });
    completed = true;
    return Object.freeze({
      ...verified,
      source,
      browser: Object.freeze({
        stagingRoot: browser.stagingRoot,
        manifest: browser.manifest,
        manifestSha256: browser.manifestSha256,
      }),
      closure,
    });
  } finally {
    if (browser !== undefined) await browser.cleanup();
    if (!completed) await rm(checkedOutputRoot, { recursive: true, force: true });
  }
}

export async function resolveChatLiveTypeScriptInvocation({ hostRoot = HOST_ROOT, outputRoot = CHAT_LIVE_OUTPUT_ROOT } = {}) {
  const inputs = await validateBuildInputs({ hostRoot, outputRoot });
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([inputs.tscPath, "--project", CHAT_LIVE_PROJECT]),
    cwd: inputs.hostRoot,
    outputRoot: inputs.outputRoot,
  });
}

/**
 * Freshly emits only the dedicated dialogue-web Host entry and its TypeScript
 * import closure. Browser composition and Chat Live publication intentionally
 * remain later layers.
 */
export async function buildChatLiveSourceClosure({
  hostRoot = HOST_ROOT,
  outputRoot = CHAT_LIVE_OUTPUT_ROOT,
  runChild = runBoundedChild,
  timeoutMs = BUILD_TIMEOUT_MS,
} = {}) {
  if (typeof runChild !== "function") throw new Error("chat_live_run_child_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new Error("chat_live_build_timeout_invalid");
  const invocation = await resolveChatLiveTypeScriptInvocation({ hostRoot, outputRoot });
  await prepareOutputRoot(invocation.outputRoot);
  await runChild({ ...invocation, timeoutMs, stdio: "pipe" });
  const files = await emittedFiles(invocation.outputRoot);
  if (!files.includes(CHAT_LIVE_ENTRY)) throw new Error("chat_live_source_entry_not_emitted");
  if (files.some((file) => file.endsWith(".ts") || file.endsWith(".map") || file.endsWith(".d.ts")))
    throw new Error("chat_live_source_emit_contains_non_runtime_file");
  return Object.freeze({
    outputRoot: invocation.outputRoot,
    entryPath: resolve(invocation.outputRoot, CHAT_LIVE_ENTRY),
    emittedFiles: Object.freeze(files),
    invocation,
  });
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  const result = await buildChatLiveSourceClosure();
  process.stdout.write(`${JSON.stringify({ outputRoot: result.outputRoot, entryPath: result.entryPath, emittedFileCount: result.emittedFiles.length })}\n`);
}
