import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The zero-repository assertion for one published Host generation.
 *
 * The publisher verifies a generation's closure through its own staging root,
 * which lives inside the developer repository. That is necessary but not the
 * owner's acceptance: the folder must also start once the repository is gone.
 * This script therefore copies the published output root to a path outside the
 * repository, resolves and loads the generation from there with the generation's
 * OWN `runtime/node.exe`, and refuses to report success unless nothing it used
 * came from the repository.
 *
 * It never uses a system `node` for the artifact under test: the only executor
 * of generation code here is the packaged runtime, and a PATH node is exactly
 * the fallback this stage exists to remove.
 */

const scriptPath = fileURLToPath(import.meta.url);
const hostRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(hostRoot, "..");
const POINTER_SCHEMA = "gamebuddy-host-production-current/v2";
const RUNTIME_ADMISSION_SCHEMA = "host-runtime-admission/v1";
const BOOTSTRAP_STATUS_SCHEMA = "gamebuddy-desktop-host-bootstrap-status/v1";
const STARDEW_MOD_ENTRY = "native/stardew-mod/GameBuddy/GameBuddy.Stardew.dll";
const DESKTOP_BUNDLE_ENTRY = "GameBuddy.Desktop.exe";
const BOOTSTRAP_PROBE_TIMEOUT_MS = 60_000;

const slash = (value) => value.replaceAll("\\", "/");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function isInside(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder !== "" && remainder !== ".." && !isAbsolute(remainder) && !remainder.startsWith(`..${sep}`);
}

function fail(reason) {
  throw new Error(`self_contained_generation_failed:${reason}`);
}

async function regularFile(path) {
  try {
    const bytes = await readFile(path);
    return bytes;
  } catch {
    return undefined;
  }
}

export function parseCurrentPointer(text) {
  const pointer = JSON.parse(text);
  if (pointer === null || typeof pointer !== "object" || Array.isArray(pointer)
    || pointer.schema !== POINTER_SCHEMA
    || typeof pointer.generation !== "string" || !/^[A-Za-z0-9._-]+$/.test(pointer.generation)) {
    fail("invalid_current_pointer");
  }
  return pointer;
}

export function parseRuntimeAdmission(text) {
  const admission = JSON.parse(text);
  if (admission === null || typeof admission !== "object" || Array.isArray(admission)
    || admission.schema !== RUNTIME_ADMISSION_SCHEMA
    || typeof admission.runtimePath !== "string" || typeof admission.runtimeSha256 !== "string"
    || typeof admission.bootstrapPath !== "string"
    || !Array.isArray(admission.runtimeClosure?.files)) {
    fail("invalid_runtime_admission");
  }
  return admission;
}

/**
 * Enumerates the artifact set the owner's acceptance depends on, by name, and
 * refuses with the exact missing piece rather than a generic failure.
 */
export async function assertGenerationArtifactSet({ generationRoot, runtimeAdmission, declaredPackages }) {
  const required = [
    ["package.json", "missing_generation_manifest"],
    ["production-inventory.json", "missing_production_inventory"],
    ["host-runtime-admission.json", "missing_runtime_admission"],
    [runtimeAdmission.runtimePath, "missing_bundled_runtime"],
    [runtimeAdmission.bootstrapPath, "missing_host_bootstrap"],
    [STARDEW_MOD_ENTRY, "missing_stardew_mod_package"],
  ];
  for (const [path, reason] of required) {
    const bytes = await regularFile(resolve(generationRoot, path.replaceAll("/", sep)));
    if (bytes === undefined) fail(reason);
    if (path === runtimeAdmission.runtimePath && digest(bytes) !== runtimeAdmission.runtimeSha256) fail("runtime_digest_mismatch");
  }
  for (const entry of runtimeAdmission.runtimeClosure.files) {
    if (typeof entry?.path !== "string") fail("invalid_runtime_closure_entry");
    if (await regularFile(resolve(generationRoot, entry.path.replaceAll("/", sep))) === undefined) {
      fail(`runtime_closure_incomplete:${entry.path}`);
    }
  }
  for (const name of declaredPackages) {
    if (await regularFile(resolve(generationRoot, "node_modules", ...name.split("/"), "package.json")) === undefined) {
      fail(`missing_external_package:${name}`);
    }
  }
}

/** The generation's own dependency manifest is the only source of the packages it promises to resolve. */
export function declaredPackagesOf(manifestText) {
  const manifest = JSON.parse(manifestText);
  const dependencies = manifest?.dependencies;
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) fail("missing_generation_dependencies");
  return Object.keys(dependencies).sort();
}

/* ------------------------------------------------------------------------- *
 * Static half
 *
 * The launch half proves the moved tree STARTS; this half proves the moved
 * tree cannot reach back for anything it no longer has. It reads the artifact
 * bytes directly, so it keeps its teeth on a host that cannot run the bundle,
 * and it names every hit by class, file and the offending string:
 *
 *   repository_path             an absolute path into this repository         blocking
 *   machine_profile_path        an absolute path into this machine's profile   blocking
 *   user_home_path              a concrete C:\Users\<account>\ path            blocking in generation-owned files
 *   launch_surface_interpreter  a bare node/npm/npx/pnpm spawn or shebang      blocking in generation-owned files
 *   vendored_interpreter_reference  the same inside runtime/ or a package      reported
 *
 * The stock bundled runtime (corepack's own npm/npx/pnpm shims and npm's docs)
 * and third-party packages legitimately mention interpreter names; those are
 * reported rather than blocking because the runtime is a hash-attested upstream
 * download and the packages are sealed, neither authored on the launch path.
 * ------------------------------------------------------------------------- */
const TEXT_EXTENSION = new Set([".js", ".mjs", ".cjs", ".json", ".ps1", ".cmd", ".bat", ".html", ".md", ".txt", ".ts", ".map"]);
// Far above every emitted bundle, and low enough to read one file at a time. A
// text file that still exceeds it is counted in `oversizedFiles` rather than
// silently skipped, so the scan cannot report green over a file it never read.
const MAX_SCANNED_TEXT_BYTES = 64_000_000;
// A spawn/exec of an interpreter BY NAME resolves from PATH; the packaged
// runtime is the only legally reachable executor.
const INTERPRETER_INVOCATION = /(?:spawn|spawnSync|exec|execFile|execFileSync|execSync|Command)\s*\(\s*["'`](?:node|npm|npx|pnpm)["'`]/;
// A `#!/usr/bin/env node` shebang reaches the same PATH lookup through exec.
const INTERPRETER_SHEBANG = /^#!.*\b(?:node|npm|npx|pnpm)\b/;
// One concrete home directory. Documentation placeholders (`C:\Users\...`,
// `C:\Users\{User}`, `C:\Users\%USERNAME%`) and the well-known non-account
// profiles never match, so a hit is a real account path.
const CONCRETE_HOME_DIRECTORY = /[A-Za-z]:[\\/]Users[\\/](?!Public\b|Default\b)[A-Za-z][A-Za-z0-9._-]*[\\/]/;
const BLOCKING_ALWAYS = Object.freeze(["repository_path", "machine_profile_path", "launch_surface_interpreter"]);
const BLOCKING_IN_GENERATION = Object.freeze(["user_home_path"]);
const ALL_CLASSES = Object.freeze(["repository_path", "machine_profile_path", "user_home_path", "launch_surface_interpreter", "vendored_interpreter_reference"]);

/** Which part of the artifact a relative path belongs to. */
export function artifactZone(relativePath) {
  const path = slash(relativePath);
  if (path.startsWith("runtime/")) return "runtime";
  if (path.startsWith("node_modules/")) return "vendored";
  return "generation";
}

/** Every absolute spelling of the repository root, including the file-URL form
 * and the JSON/JavaScript-escaped form (`E:\\projects\\...`) that an emitted
 * string literal or manifest carries. */
export function repositoryAbsolutePaths(repositoryRoot) {
  const absolute = resolve(repositoryRoot);
  const posix = slash(absolute);
  return Object.freeze([...new Set([absolute, posix, absolute.replaceAll("\\", "\\\\"), `file:///${posix}`])]);
}

/** Every absolute spelling of this machine's user profile, including the file-URL form. */
export function machineProfileAbsolutePaths(environment = process.env, home = homedir()) {
  const values = new Set();
  for (const key of ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH"]) {
    if (typeof environment[key] === "string" && environment[key].length > 3) values.add(environment[key]);
  }
  if (typeof home === "string" && home.length > 3) values.add(home);
  const spellings = new Set();
  for (const value of values) {
    const posix = slash(value);
    spellings.add(value);
    spellings.add(posix);
    spellings.add(value.replaceAll("\\", "\\\\"));
    spellings.add(`file:///${posix}`);
  }
  return Object.freeze([...spellings]);
}

async function artifactFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    fail("artifact_unreadable");
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath ?? entry.path;
    if (typeof parent !== "string") fail("artifact_walk_unsupported");
    files.push(slash(relative(root, resolve(parent, entry.name))));
  }
  return files.sort();
}

/**
 * Reads the artifact bytes and returns each hit with the file, the line and the
 * string, in a stable order. This never throws on a finding: the caller decides
 * the gate, so the same scan can be reported or enforced.
 */
export async function scanGenerationEnvironmentCoupling({ generationRoot, repositoryRoot, environment = process.env, home = homedir(), maxTextBytes = MAX_SCANNED_TEXT_BYTES } = {}) {
  if (typeof generationRoot !== "string" || generationRoot.length === 0) fail("scan_generation_root_required");
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) fail("scan_repository_root_required");
  const root = resolve(generationRoot);
  const repositoryPaths = repositoryAbsolutePaths(repositoryRoot);
  const profilePaths = machineProfileAbsolutePaths(environment, home);
  const files = await artifactFiles(root);
  const hits = [];
  let textFiles = 0;
  let oversizedFiles = 0;
  for (const file of files) {
    if (!TEXT_EXTENSION.has(extname(file).toLowerCase())) continue;
    let bytes;
    try { bytes = await readFile(resolve(root, file.replaceAll("/", sep))); } catch { continue; }
    if (bytes.length > maxTextBytes) { oversizedFiles += 1; continue; }
    textFiles += 1;
    const content = bytes.toString("utf8");
    const zone = artifactZone(file);
    if (!repositoryPaths.some((value) => content.includes(value))
      && !profilePaths.some((value) => content.includes(value))
      && !CONCRETE_HOME_DIRECTORY.test(content)
      && !INTERPRETER_INVOCATION.test(content)
      && !INTERPRETER_SHEBANG.test(content)) continue;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const classes = [];
      if (repositoryPaths.some((value) => line.includes(value))) classes.push("repository_path");
      if (profilePaths.some((value) => line.includes(value))) classes.push("machine_profile_path");
      else if (CONCRETE_HOME_DIRECTORY.test(line)) classes.push("user_home_path");
      if (INTERPRETER_INVOCATION.test(line) || INTERPRETER_SHEBANG.test(line)) {
        classes.push(zone === "generation" ? "launch_surface_interpreter" : "vendored_interpreter_reference");
      }
      if (classes.length === 0) continue;
      hits.push(Object.freeze({ class: classes[0], classes: Object.freeze(classes), zone, file, line: index + 1, snippet: line.trim().slice(0, 240) }));
    }
  }
  hits.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.class.localeCompare(right.class));
  const counts = Object.fromEntries(ALL_CLASSES.map((name) => [name, hits.filter((hit) => hit.class === name).length]));
  return Object.freeze({ schema: "gamebuddy-generation-environment-coupling/v1", generationRoot: root, files: files.length, textFiles, oversizedFiles, hits: Object.freeze(hits), counts: Object.freeze(counts) });
}

function blockingHit(hit) {
  if (BLOCKING_ALWAYS.some((name) => hit.classes.includes(name))) return true;
  return BLOCKING_IN_GENERATION.some((name) => hit.classes.includes(name)) && hit.zone === "generation";
}

/** Splits a scan into the hits that fail the gate and the informational hits it reports. */
export function staticGateVerdict(scan) {
  const blocking = scan.hits.filter(blockingHit);
  const blocked = new Set(blocking);
  return Object.freeze({
    ok: blocking.length === 0,
    blocking: Object.freeze(blocking),
    reported: Object.freeze(scan.hits.filter((hit) => !blocked.has(hit))),
  });
}

/**
 * Reports which pieces of the owner's one-folder acceptance the published tree
 * actually carries. The Host generation is complete today; a Desktop launcher
 * bundle is a separate artifact and is reported as `absent` rather than assumed.
 */
export async function reportPackagingCompleteness({ outputRoot, generationRoot, desktopBundleRoot }) {
  const desktopCandidates = desktopBundleRoot === undefined
    ? [resolve(outputRoot, DESKTOP_BUNDLE_ENTRY), resolve(outputRoot, "desktop", DESKTOP_BUNDLE_ENTRY)]
    : [resolve(desktopBundleRoot, DESKTOP_BUNDLE_ENTRY)];
  let desktopBundle = "absent";
  for (const candidate of desktopCandidates) {
    if (await regularFile(candidate) !== undefined) desktopBundle = slash(relative(outputRoot, candidate));
  }
  const present = async (path) => (await regularFile(resolve(generationRoot, path.replaceAll("/", sep))) === undefined ? "absent" : slash(relative(outputRoot, resolve(generationRoot, path))));
  return Object.freeze({
    offlineRuntime: await present("runtime/node.exe"),
    hostBuild: await present("main.js"),
    modBuild: await present(STARDEW_MOD_ENTRY),
    desktopBundle,
  });
}

/**
 * Parses the runtime closure probe output: one `[specifier, resolvedUrl, exists]`
 * tuple per declared package or entry module.
 */
export function parseResolutionProbeOutput(output, expected) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("resolution_probe_output_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length !== expected.length
    || !parsed.every((entry, index) => Array.isArray(entry) && entry.length === 3
      && entry[0] === expected[index] && typeof entry[1] === "string" && typeof entry[2] === "boolean")) {
    fail("resolution_probe_output_invalid");
  }
  return parsed.map(([specifier, url, exists]) => Object.freeze({ specifier, url, exists }));
}

/**
 * The bootstrap entry writes one informational status frame before it reads its
 * bootstrap frame and then fails closed with one bounded code when there is no
 * frame. Reaching that status frame proves the whole static import graph of the
 * Host loaded; a closure hole surfaces as an unbounded module-resolution error
 * instead, which is what this rejects.
 */
export function parseBootstrapStart(status, stdout, stderr) {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  let reachedBootstrapFrame = false;
  for (const line of lines) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame?.schema === BOOTSTRAP_STATUS_SCHEMA && frame.stage === "bootstrap-frame") reachedBootstrapFrame = true;
  }
  const failure = stderr.trim();
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND/.test(stderr)) fail("host_entry_module_resolution_failed");
  if (!reachedBootstrapFrame) fail("host_entry_did_not_reach_bootstrap_frame");
  if (failure.length === 0) fail("host_entry_unbounded_failure");
  if (!/^[a-z][a-z0-9_.:-]{2,159}$/i.test(failure)) fail("host_entry_unbounded_failure");
  if (status === 0) fail("host_entry_unexpected_success");
  return Object.freeze({ reachedBootstrapFrame: true, boundedFailureCode: failure });
}

export function assertResolutionOutsideRepository({ entries, generationRoot, repository, label }) {
  for (const entry of entries) {
    if (!entry.exists) fail(`${label}_unresolved:${entry.specifier}`);
    if (!entry.url.startsWith("file:")) fail(`${label}_not_a_file:${entry.specifier}`);
    let file;
    try {
      file = fileURLToPath(entry.url);
    } catch {
      fail(`${label}_not_a_file:${entry.specifier}`);
    }
    if (isInside(repository, file)) fail(`${label}_inside_repository:${entry.specifier}:${slash(file)}`);
    if (!isInside(generationRoot, file)) fail(`${label}_outside_generation:${entry.specifier}:${slash(file)}`);
  }
}

// The probe lives in the scratch root, never in the repository: the artifact
// under test must not have any repository file on its resolution path.
const RESOLUTION_PROBE_SOURCE = `import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [root, ...specifiers] = process.argv.slice(2);
const parentURL = pathToFileURL(resolve(root, "package.json")).href;
const report = specifiers.map((specifier) => {
  try {
    const url = import.meta.resolve(specifier, parentURL);
    const file = url.startsWith("file:") ? fileURLToPath(url) : undefined;
    return [specifier, url, file !== undefined && statSync(file, { throwIfNoEntry: false })?.isFile() === true];
  } catch {
    return [specifier, "", false];
  }
});
process.stdout.write(JSON.stringify(report));
`;

/** A PATH with no Node on it: the packaged runtime is the only executor
 * allowed. Any retained value that still names the repository is dropped, so
 * the child cannot reach back through an inherited variable either. */
export function isolatedEnvironment(inherited = process.env, repositoryRoot = undefined) {
  const environment = { PATH: `${inherited.SystemRoot ?? "C:" + sep + "Windows"}${sep}System32` };
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "WINDIR"]) {
    if (typeof inherited[key] === "string" && inherited[key].length > 0) environment[key] = inherited[key];
  }
  if (typeof repositoryRoot === "string" && repositoryRoot.length > 0) {
    const spellings = repositoryAbsolutePaths(repositoryRoot);
    for (const key of Object.keys(environment)) {
      if (spellings.some((value) => environment[key].includes(value))) delete environment[key];
    }
  }
  return environment;
}

/** The generation builder is repository-owned; this assertion never writes a second one. */
export function generationBuildInvocation({ root = hostRoot, runtimeTree, outputRoot }) {
  if (typeof runtimeTree !== "string" || runtimeTree.length === 0) fail("runtime_tree_required");
  if (typeof outputRoot !== "string" || outputRoot.length === 0) fail("build_output_root_required");
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([resolve(root, "scripts", "build-desktop-launcher-test-generation.mjs"), resolve(outputRoot), resolve(runtimeTree), "--full-runtime-tree"]),
    cwd: root,
  });
}

async function copyOutputRoot(outputRoot, scratchRoot) {
  for (const name of await readdir(outputRoot)) {
    await cp(resolve(outputRoot, name), resolve(scratchRoot, name), { recursive: true });
  }
}

export async function verifySelfContainedGeneration({
  outputRoot,
  desktopBundleRoot = undefined,
  scratchRoot = undefined,
  spawn = spawnSync,
  probeTimeoutMs = BOOTSTRAP_PROBE_TIMEOUT_MS,
  environment = process.env,
  home = homedir(),
} = {}) {
  if (typeof outputRoot !== "string" || outputRoot.length === 0) fail("output_root_required");
  const resolvedOutputRoot = resolve(outputRoot);
  let pointerText;
  try {
    pointerText = await readFile(resolve(resolvedOutputRoot, "current.json"), "utf8");
  } catch {
    fail("missing_current_pointer");
  }
  const pointer = parseCurrentPointer(pointerText);
  const publishedGenerationRoot = resolve(resolvedOutputRoot, "generations", pointer.generation);
  const runtimeAdmission = parseRuntimeAdmission(await readFile(resolve(publishedGenerationRoot, "host-runtime-admission.json"), "utf8"));
  const declaredPackages = declaredPackagesOf(await readFile(resolve(publishedGenerationRoot, "package.json"), "utf8"));
  await assertGenerationArtifactSet({ generationRoot: publishedGenerationRoot, runtimeAdmission, declaredPackages });

  const scratch = scratchRoot === undefined
    ? await mkdtemp(join(tmpdir(), "gamebuddy-self-contained-"))
    : resolve(scratchRoot);
  if (isInside(repositoryRoot, scratch)) fail("scratch_root_inside_repository");
  try {
    await mkdir(scratch, { recursive: true });
    await copyOutputRoot(resolvedOutputRoot, scratch);
    await writeFile(resolve(scratch, "resolution-probe.mjs"), RESOLUTION_PROBE_SOURCE);

    const generationRoot = resolve(scratch, "generations", pointer.generation);
    const runtimeBinary = resolve(generationRoot, runtimeAdmission.runtimePath.replaceAll("/", sep));
    const childEnvironment = isolatedEnvironment(environment, repositoryRoot);

    // (1) The declared packages and the Host entry must resolve to exact files
    // inside the moved generation, from the moved generation's own manifest.
    const specifiers = [...declaredPackages, "./main.js"];
    // `import.meta.resolve` only honours its parent-URL argument behind this
    // flag, which is also how the publisher's own closure probe gets the ESM
    // `import` export condition rather than the CommonJS one.
    const resolution = spawn(runtimeBinary, ["--experimental-import-meta-resolve", resolve(scratch, "resolution-probe.mjs"), generationRoot, ...specifiers], {
      cwd: scratch, env: childEnvironment, encoding: "utf8", shell: false, windowsHide: true, timeout: probeTimeoutMs,
    });
    if (resolution.error !== undefined || resolution.status !== 0) fail("resolution_probe_failed");
    const entries = parseResolutionProbeOutput(resolution.stdout, specifiers);
    assertResolutionOutsideRepository({ entries, generationRoot, repository: repositoryRoot, label: "resolution_probe" });

    // (2) The packaged runtime must start the Host entry with the repository gone.
    const boot = spawn(runtimeBinary, [resolve(generationRoot, runtimeAdmission.bootstrapPath.replaceAll("/", sep))], {
      cwd: generationRoot, env: childEnvironment, encoding: "utf8", shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], timeout: probeTimeoutMs,
    });
    const start = parseBootstrapStart(boot.status, boot.stdout ?? "", boot.stderr ?? "");

    // (3) The static half reads the exact moved bytes and reports on any file that
    // reaches back into the repository, into this machine's user profile, or into
    // a PATH interpreter. The launch half never reads most of the tree, so this is
    // what makes the assertion hold beyond the booting import graph. Its verdict
    // rides in the result rather than aborting, so a launch that succeeded is still
    // reported alongside the static finding that fails it.
    const coupling = await scanGenerationEnvironmentCoupling({ generationRoot, repositoryRoot, environment, home });
    const couplingVerdict = staticGateVerdict(coupling);

    const packaging = await reportPackagingCompleteness({ outputRoot: resolvedOutputRoot, generationRoot: publishedGenerationRoot, desktopBundleRoot });
    return Object.freeze({
      schema: "gamebuddy-self-contained-generation/v1",
      ok: couplingVerdict.ok,
      outputRoot: resolvedOutputRoot,
      generation: pointer.generation,
      scratchRoot: scratch,
      executor: runtimeAdmission.runtimePath,
      resolvedFromGenerationRoot: Object.freeze(entries.map((entry) => Object.freeze({ specifier: entry.specifier, path: slash(fileURLToPath(entry.url)) }))),
      bootstrap: start,
      static: Object.freeze({ ...coupling, verdict: couplingVerdict }),
      packaging,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

/**
 * The static half alone, for a host that cannot run the bundle. It resolves the
 * published generation from the pointer and scans it in place; it never starts
 * a process and never leaves the repository, so it is the half that still runs
 * on a machine missing the launch preconditions. `verdict.ok === false` is a
 * named failure the caller reports; it does not throw, so every hit stays
 * visible in the printed result.
 */
export async function verifyGenerationStatic({ outputRoot, environment = process.env, home = homedir() } = {}) {
  if (typeof outputRoot !== "string" || outputRoot.length === 0) fail("output_root_required");
  const resolvedOutputRoot = resolve(outputRoot);
  let pointer;
  try {
    pointer = parseCurrentPointer(await readFile(resolve(resolvedOutputRoot, "current.json"), "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("self_contained_generation_failed:")) throw error;
    return fail("missing_current_pointer");
  }
  const generationRoot = resolve(resolvedOutputRoot, "generations", pointer.generation);
  const scan = await scanGenerationEnvironmentCoupling({ generationRoot, repositoryRoot, environment, home });
  return Object.freeze({
    schema: "gamebuddy-self-contained-generation-static/v1",
    outputRoot: resolvedOutputRoot,
    generation: pointer.generation,
    scan,
    verdict: staticGateVerdict(scan),
  });
}

if (process.argv[1] === scriptPath) {
  const args = process.argv.slice(2);
  let outputRoot;
  let runtimeTree;
  let staticOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--build-from-runtime-tree") {
      index += 1;
      runtimeTree = args[index];
    } else if (args[index] === "--static-only") {
      staticOnly = true;
    } else if (outputRoot === undefined) outputRoot = args[index];
  }
  const resolvedOutputRoot = outputRoot ?? resolve(hostRoot, "dist");
  if (staticOnly) {
    const result = await verifyGenerationStatic({ outputRoot: resolvedOutputRoot });
    console.log(JSON.stringify(result, null, 2));
    if (!result.verdict.ok) process.exitCode = 1;
  } else {
    if (runtimeTree !== undefined) {
      // The owner's acceptance starts from a folder this machine can produce. The
      // builder is the existing one and needs a pinned Node distribution tree
      // plus the repository toolchain (pnpm, dotnet); the release path remains the
      // protected-CI-only producer of a releasable generation.
      const invocation = generationBuildInvocation({ runtimeTree, outputRoot });
      const built = spawnSync(invocation.command, [...invocation.args], { cwd: invocation.cwd, stdio: "inherit", shell: false, windowsHide: true });
      if (built.status !== 0) fail("generation_build_failed");
    }
    const result = await verifySelfContainedGeneration({ outputRoot: resolvedOutputRoot });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
