import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { publishProductionArtifact, reachableProductionModules, readArtifactConfig, verifyWindowsReparseInspectorPair, verifyWindowsStardewFolderPickerPair } from "./production-artifact.mjs";
import { buildWindowsReparseInspector, outputRoot as windowsReparseInspectorBuildRoot } from "./build-windows-reparse-inspector.mjs";
import { buildWindowsStardewFolderPicker, outputRoot as windowsStardewFolderPickerBuildRoot } from "./build-windows-stardew-folder-picker.mjs";
import { runBoundedChild } from "./test-supervisor.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const hostRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(hostRoot, "..");
const magicContextPackage = "@cortexkit/pi-magic-context";
const magicContextSourceRoot = resolve(repositoryRoot, "vendor", "magic-context", "packages", "pi-plugin");
const magicContextSourceEntry = resolve(magicContextSourceRoot, "dist", "index.js");
const dialogueWebRoot = resolve(repositoryRoot, "dialogue-web");
const browserStagingParent = resolve(dialogueWebRoot, ".build-staging");
const emittedStaticArtifactVerifier = "tavern/static-artifact/index.js";
const browserIdentity = Object.freeze({
  browserContract: "tavern_browser_api/v1",
  profileId: "gamebuddy.tavern.browser.v1",
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function isContained(root, path) {
  const remainder = relative(root, path);
  return remainder !== "" && !isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}

/**
 * Verify that the declared local Magic Context package resolves to the freshly
 * built, approved plugin artifact.  The package remains a normal Host
 * dependency; this check refuses stale pnpm file-package copies rather than
 * falling back to a vendor source path at runtime.
 */
export async function verifyDeclaredMagicContextArtifact({
  root = hostRoot,
  sourceEntry = magicContextSourceEntry,
} = {}) {
  let resolvedEntry;
  try {
    // This module resides under host/scripts, so resolution is anchored to the
    // declared Host dependency rather than the caller's cwd or user state.
    resolvedEntry = fileURLToPath(import.meta.resolve(magicContextPackage));
  } catch (error) {
    throw new Error("magic_context_declared_package_unresolvable", { cause: error });
  }
  const resolvedRoot = resolve(root);
  const declaredPackagePath = resolve(resolvedRoot, "node_modules", "@cortexkit", "pi-magic-context");
  let declaredPackageRoot;
  let canonicalResolvedEntry;
  let sourceState;
  let resolvedState;
  try {
    [declaredPackageRoot, canonicalResolvedEntry, sourceState, resolvedState] = await Promise.all([
      realpath(declaredPackagePath),
      realpath(resolvedEntry),
      stat(sourceEntry),
      stat(resolvedEntry),
    ]);
  } catch (error) {
    throw new Error("magic_context_declared_package_artifact_missing", { cause: error });
  }
  if (
    !isContained(declaredPackageRoot, canonicalResolvedEntry) ||
    relative(declaredPackageRoot, canonicalResolvedEntry) !== `dist${sep}index.js`
  ) throw new Error("magic_context_declared_package_entry_invalid");
  if (!sourceState.isFile() || !resolvedState.isFile()) throw new Error("magic_context_declared_package_artifact_invalid");
  const [source, resolved] = await Promise.all([readFile(sourceEntry), readFile(resolvedEntry)]);
  const sourceSha256 = sha256(source);
  const resolvedSha256 = sha256(resolved);
  if (sourceSha256 !== resolvedSha256) throw new Error("magic_context_declared_package_artifact_stale");
  return Object.freeze({ entry: resolvedEntry, sha256: resolvedSha256 });
}

/** Resolve the repository's TypeScript entry without a shell wrapper. */
export async function resolveTypeScriptInvocation({ root = hostRoot, project }) {
  if (typeof project !== "string" || project.length === 0 || project.includes("\0")) {
    throw new Error("invalid_typescript_project");
  }
  const resolvedRoot = resolve(root);
  const repositoryRoot = resolve(resolvedRoot, "..");
  const projectPath = resolve(resolvedRoot, project);
  if (!isContained(resolvedRoot, projectPath)) throw new Error("typescript_project_outside_host_root");
  let projectDetails;
  try {
    projectDetails = await lstat(projectPath);
  } catch (error) {
    throw new Error("typescript_project_missing", { cause: error });
  }
  if (projectDetails.isSymbolicLink() || !projectDetails.isFile()) throw new Error("typescript_project_not_regular_file");
  const tscPath = resolve(resolvedRoot, "node_modules", "typescript", "lib", "tsc.js");
  if (!isContained(resolvedRoot, tscPath)) throw new Error("typescript_entry_outside_host_root");
  let details;
  try {
    details = await lstat(tscPath);
  } catch (error) {
    throw new Error("typescript_entry_missing", { cause: error });
  }
  if (details.isSymbolicLink() || !details.isFile()) throw new Error("typescript_entry_not_regular_file");
  let canonicalPath;
  try {
    canonicalPath = await realpath(tscPath);
  } catch (error) {
    throw new Error("typescript_entry_unresolvable", { cause: error });
  }
  if (!isContained(repositoryRoot, canonicalPath)) throw new Error("typescript_entry_escapes_repository_root");
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([canonicalPath, "--project", project]),
    cwd: resolvedRoot,
  });
}

async function emittedFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const item = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await emittedFiles(root, item));
    else if (entry.isFile()) result.push(item);
    else throw new Error(`production_emitted_entry_not_regular_file:${item}`);
  }
  return result.sort();
}

async function retainEntrypointClosure({ emittedRoot, closureRoot, entryRoots }) {
  const emitted = await emittedFiles(emittedRoot);
  const reachable = await reachableProductionModules({ artifactRoot: emittedRoot, artifactFiles: emitted, entryRoots });
  for (const item of reachable) {
    const source = resolve(emittedRoot, item);
    const destination = resolve(closureRoot, item);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

const BROWSER_BUILD_TIMEOUT_MS = 15 * 60_000;
const BROWSER_BUILD_OUTPUT_LIMIT_BYTES = 64 * 1024;

const cmdMetacharacter = /[&|<>^()%!\r\n]/;
const stagingLeaf = /^[a-f0-9]{32}$/;
const trustedWindowsRoot = "C:\\Windows";

function isPrivateBrowserStagingRoot(stagingRoot) {
  return typeof stagingRoot === "string" &&
    isAbsolute(stagingRoot) && stagingRoot === resolve(stagingRoot) &&
    relative(browserStagingParent, stagingRoot) !== "" &&
    stagingLeaf.test(relative(browserStagingParent, stagingRoot));
}

function assertCommandPath(path, errorCode) {
  if (typeof path !== "string" || !isAbsolute(path) || cmdMetacharacter.test(path)) throw new Error(errorCode);
  return path;
}

async function resolvedRegularRepositoryCommand(path, errorCode) {
  try {
    assertCommandPath(path, errorCode);
    const state = await lstat(path);
    if (state.isSymbolicLink() || !state.isFile()) throw new Error(errorCode);
    const canonicalPath = await realpath(path);
    if (!isContained(repositoryRoot, canonicalPath)) throw new Error(errorCode);
    return assertCommandPath(canonicalPath, errorCode);
  } catch (error) {
    if (error?.message === errorCode) throw error;
    throw new Error(errorCode, { cause: error });
  }
}

async function resolvedTrustedWindowsCommandProcessor() {
  // SystemRoot is only an identity assertion: no environment-provided path is used.
  if (typeof process.env.SystemRoot !== "string" || process.env.SystemRoot.toLowerCase() !== trustedWindowsRoot.toLowerCase())
    throw new Error("browser_build_system_root_invalid");
  const command = `${trustedWindowsRoot}\\System32\\cmd.exe`;
  try {
    const state = await lstat(command);
    if (state.isSymbolicLink() || !state.isFile()) throw new Error("browser_build_command_processor_unresolvable");
    const canonicalPath = await realpath(command);
    if (canonicalPath.toLowerCase() !== command.toLowerCase()) throw new Error("browser_build_command_processor_unresolvable");
    return command;
  } catch (error) {
    if (error?.message === "browser_build_command_processor_unresolvable") throw error;
    throw new Error("browser_build_command_processor_unresolvable", { cause: error });
  }
}

// Quote one already-validated cmd token. Backslashes preceding a quote are doubled
// so the resulting command line remains one argv token when cmd dispatches vite.CMD.
function quoteWindowsCommandToken(token) {
  if (typeof token !== "string" || token.includes("\0") || cmdMetacharacter.test(token))
    throw new Error("invalid_browser_build_command_token");
  return `"${token.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

export async function browserBuildInvocation({ stagingRoot }) {
  if (!isPrivateBrowserStagingRoot(stagingRoot)) throw new Error("invalid_browser_staging_root");
  const args = ["build", "--config", "vite.config.ts", "--outDir", stagingRoot];
  if (process.platform !== "win32") return Object.freeze({ command: "pnpm", args: Object.freeze(["exec", "vite", ...args]), cwd: dialogueWebRoot });
  const vite = await resolvedRegularRepositoryCommand(resolve(dialogueWebRoot, "node_modules", ".bin", "vite.CMD"), "browser_build_vite_unresolvable");
  // cmd.exe is explicit .CMD mediation; neither command is resolved through PATH.
  const commandText = `call ${[vite, ...args].map(quoteWindowsCommandToken).join(" ")}`;
  return Object.freeze({
    command: await resolvedTrustedWindowsCommandProcessor(),
    args: Object.freeze(["/d", "/s", "/c", commandText]),
    cwd: dialogueWebRoot,
  });
}

function browserBuildEnvironment(inherited = process.env) {
  const path = inherited.PATH ?? inherited.Path;
  if (typeof path !== "string" || path.length === 0) throw new Error("browser_build_path_missing");
  const environment = { PATH: path, LANG: "C", LC_ALL: "C" };
  for (const key of ["SystemRoot", "LOCALAPPDATA", "TEMP", "TMP"])
    if (typeof inherited[key] === "string" && inherited[key].length > 0) environment[key] = inherited[key];
  return environment;
}

export async function runBrowserBuild(invocation, { timeoutMs = BROWSER_BUILD_TIMEOUT_MS, spawnProcess = spawn } = {}) {
  if (!invocation || typeof invocation.command !== "string" || !Array.isArray(invocation.args) || typeof invocation.cwd !== "string")
    throw new Error("invalid_browser_build_invocation");
  let child;
  const stdout = []; const stderr = []; let outputBytes = 0; let timedOut = false; let failure;
  const terminate = () => {
    if (child?.pid === undefined) return;
    if (process.platform === "win32") {
      try { spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false, detached: false }); }
      catch { child.kill(); }
    } else child.kill("SIGKILL");
  };
  return await new Promise((resolveRun, rejectRun) => {
    try {
      child = spawnProcess(invocation.command, invocation.args, {
        cwd: invocation.cwd, env: browserBuildEnvironment(), stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true, shell: false, detached: false,
        windowsVerbatimArguments: process.platform === "win32",
      });
    } catch (error) { rejectRun(error); return; }
    const deadline = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const capture = (target, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > BROWSER_BUILD_OUTPUT_LIMIT_BYTES) { failure ??= new Error("browser_build_output_too_large"); terminate(); }
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (failure) { rejectRun(failure); return; }
      if (timedOut) { rejectRun(new Error("browser_build_timeout")); return; }
      if (code !== 0 || signal !== null) {
        rejectRun(new Error(`browser_build_failed:code=${code}:signal=${signal}:${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      resolveRun(Object.freeze({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
  });
}

async function browserOwnedVerifier() {
  const module = await import(pathToFileURL(resolve(dialogueWebRoot, "scripts", "browser-artifact-manifest.mjs")).href);
  if (typeof module.verifyProductionArtifactManifest !== "function") throw new Error("browser_artifact_verifier_unavailable");
  return module.verifyProductionArtifactManifest;
}

async function emittedHostStaticVerifier(stagingRoot) {
  const path = resolve(stagingRoot, emittedStaticArtifactVerifier);
  if (!isContained(stagingRoot, path)) throw new Error("emitted_static_artifact_verifier_escapes_staging");
  const module = await import(pathToFileURL(path).href);
  if (typeof module.verifyTavernStaticArtifact !== "function") throw new Error("emitted_static_artifact_verifier_unavailable");
  return module.verifyTavernStaticArtifact;
}

function builtWindowsReparseInspectorDescriptor(descriptor) {
  return { ...descriptor, destination: "win-x64" };
}

async function verifyBuiltWindowsReparseInspector(descriptor) {
  return await verifyWindowsReparseInspectorPair({
    root: resolve(windowsReparseInspectorBuildRoot, ".."),
    descriptor: builtWindowsReparseInspectorDescriptor(descriptor),
    requireProbeEvidence: false,
  });
}

async function copyVerifiedWindowsReparseInspector({ closureRoot, config }) {
  if (process.platform !== "win32") return undefined;
  const descriptor = config.windowsReparseInspector;
  if (descriptor === undefined) throw new Error("windows_reparse_inspector_descriptor_missing");
  const verified = await verifyBuiltWindowsReparseInspector(descriptor);
  const destinationRoot = resolve(closureRoot, descriptor.destination.replaceAll("/", sep));
  for (const name of [descriptor.helper, descriptor.manifest]) {
    const destination = resolve(destinationRoot, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(verified.pairRoot, name), destination);
  }
  await verifyWindowsReparseInspectorPair({ root: closureRoot, descriptor });
  return destinationRoot;
}

async function copyVerifiedBrowserTree({ browserRoot, closureRoot, descriptor, manifest }) {
  if (
    descriptor?.destination !== "browser/tavern/v1" ||
    descriptor.browserContract !== browserIdentity.browserContract ||
    descriptor.profileId !== browserIdentity.profileId ||
    descriptor.manifest !== "tavern-browser-artifact-manifest.json" ||
    manifest?.browserContract !== browserIdentity.browserContract ||
    manifest.profileId !== browserIdentity.profileId ||
    manifest.entryHtml !== "index.html" ||
    !Array.isArray(manifest.assets)
  ) throw new Error("invalid_declared_browser_artifact");
  const destinationRoot = resolve(closureRoot, descriptor.destination.replaceAll("/", sep));
  if (!isContained(closureRoot, destinationRoot)) throw new Error("browser_artifact_destination_escapes_closure");
  const paths = [manifest.entryHtml, descriptor.manifest, ...manifest.assets.map((asset) => asset.path)];
  if (new Set(paths).size !== paths.length) throw new Error("browser_artifact_copy_paths_not_unique");
  for (const path of paths) {
    if (typeof path !== "string") throw new Error("browser_artifact_copy_path_invalid");
    const source = resolve(browserRoot, path.replaceAll("/", sep));
    const destination = resolve(destinationRoot, path.replaceAll("/", sep));
    if (!isContained(browserRoot, source) || !isContained(destinationRoot, destination))
      throw new Error("browser_artifact_copy_path_escapes_root");
    const sourceState = await lstat(source);
    if (sourceState.isSymbolicLink() || !sourceState.isFile()) throw new Error("browser_artifact_copy_source_not_regular_file");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return destinationRoot;
}

export async function buildProductionArtifact({
  outputRoot = resolve(hostRoot, "dist"),
  runChild = runBoundedChild,
  verifyMagicContext = verifyDeclaredMagicContextArtifact,
  publish = publishProductionArtifact,
  afterBrowserBuild = undefined,
  onCompositionVerified = undefined,
  onBrowserBuildInvocation = undefined,
} = {}) {
  if (afterBrowserBuild !== undefined && typeof afterBrowserBuild !== "function")
    throw new Error("invalid_after_browser_build_hook");
  if (onCompositionVerified !== undefined && typeof onCompositionVerified !== "function")
    throw new Error("invalid_composition_verified_observer");
  if (onBrowserBuildInvocation !== undefined && typeof onBrowserBuildInvocation !== "function")
    throw new Error("invalid_browser_build_invocation_observer");
  const buildId = randomUUID().replaceAll("-", "");
  // Lane C resolves its adapter only from this exact private Host path.
  const stagingRoot = process.platform === "win32"
    ? resolve(hostRoot, ".dist-production-emitted")
    : resolve(hostRoot, `.dist-production-emitted-${process.pid}-${buildId}`);
  const closureRoot = resolve(hostRoot, `.dist-production-closure-${process.pid}-${buildId}`);
  const browserStagingRoot = resolve(browserStagingParent, buildId);
  await rm(stagingRoot, { recursive: true, force: true });
  await rm(closureRoot, { recursive: true, force: true });
  await rm(browserStagingRoot, { recursive: true, force: true });
  try {
    await verifyMagicContext();
    // The version-locked native provenance and emitted policy adapter must exist
    // before Vite imports Lane C's manifest generator on Windows.
    if (process.platform === "win32") {
      await buildWindowsReparseInspector();
      const config = await readArtifactConfig(hostRoot);
      if (config.windowsReparseInspector === undefined) throw new Error("windows_reparse_inspector_descriptor_missing");
      await verifyBuiltWindowsReparseInspector(config.windowsReparseInspector);
      await buildWindowsStardewFolderPicker();
      if (config.windowsStardewFolderPicker === undefined) throw new Error("windows_stardew_folder_picker_descriptor_missing");
      await verifyWindowsStardewFolderPickerPair({ root: resolve(windowsStardewFolderPickerBuildRoot, ".."), descriptor: { ...config.windowsStardewFolderPicker, destination: "win-x64" } });
    }
    const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.production.json" });
    await runChild({ ...invocation, args: [...invocation.args, "--outDir", stagingRoot] });
    await lstat(stagingRoot);
    await mkdir(browserStagingParent, { recursive: true });
    await mkdir(browserStagingRoot);
    const browserInvocation = await browserBuildInvocation({ stagingRoot: browserStagingRoot });
    await onBrowserBuildInvocation?.(Object.freeze({ stagingRoot: browserStagingRoot, invocation: browserInvocation }));
    await runBrowserBuild(browserInvocation);
    await afterBrowserBuild?.(browserStagingRoot);
    const verifyBrowserArtifact = await browserOwnedVerifier();
    const browserManifest = await verifyBrowserArtifact(browserStagingRoot);
    const config = await readArtifactConfig(hostRoot);
    if (config.browserArtifact === undefined) throw new Error("browser_artifact_descriptor_missing");
    await retainEntrypointClosure({
      emittedRoot: stagingRoot,
      closureRoot,
      entryRoots: [...config.entryRoots, ...config.verificationRoots],
    });
    await copyVerifiedWindowsReparseInspector({ closureRoot, config });
    const copiedBrowserRoot = await copyVerifiedBrowserTree({
      browserRoot: browserStagingRoot,
      closureRoot,
      descriptor: config.browserArtifact,
      manifest: browserManifest,
    });
    const verifyTavernStaticArtifact = await emittedHostStaticVerifier(stagingRoot);
    const { createPublishedWindowsReparseInspector } = process.platform === "win32"
      ? await import(pathToFileURL(resolve(stagingRoot, "windows-reparse-inspector", "index.js")).href)
      : {};
    const inspector = process.platform === "win32" ? await createPublishedWindowsReparseInspector(closureRoot) : undefined;
    await verifyTavernStaticArtifact(copiedBrowserRoot, browserIdentity, inspector);
    await onCompositionVerified?.(Object.freeze({ browserRoot: copiedBrowserRoot, identity: browserIdentity }));
    return await publish({ hostRoot, emittedRoot: closureRoot, outputRoot });
  } finally {
    await rm(browserStagingRoot, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(closureRoot, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) await buildProductionArtifact();
