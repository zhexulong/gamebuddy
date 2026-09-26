/**
 * Ruling 1 — self-contained generation: the Host production publisher is the
 * only artifact/runtime authority, so it physically stages the declared
 * `externalRuntimeClosure` into the generation it publishes. Desktop consumes
 * fixed sidecar fields only and never rebuilds a supply chain, and there is no
 * repo / system-PATH / ancestor-`node_modules` fallback at runtime.
 *
 * Mechanics are load-bearing and were verified by experiment:
 *
 *  - `pnpm deploy` MUTATES the workspace it runs in (it rewrites
 *    `node_modules/.pnpm-workspace-state-v1.json`, after which every later pnpm
 *    command aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` and wants
 *    to purge `node_modules`). It therefore runs in a scratch workspace OUTSIDE
 *    the repository, built from manifests + lockfile + the `file:` vendor
 *    targets, and the scratch tree is removed on every path.
 *  - `--config.node-linker=hoisted` is required: the default isolated linker
 *    emits Windows junction reparse points, which the artifact scan rejects.
 *  - The deployed closure contains package-internal test sources (zod ships them
 *    in its published tarball). The artifact's own `TEST_ARTIFACT` rule is
 *    applied unconditionally to every artifact file, so the staged tree is
 *    pruned with that exact rule rather than a second, drifting copy.
 */
import { cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const CLOSURE_ORIGIN_SCHEMA = "host_production_dependency_closure";
/** The one closure artifact directory inside a generation. */
const CLOSURE_MODULES_DIRECTORY = "node_modules";
/** The generation's own manifest, which makes the closure resolvable in place. */
const CLOSURE_MANIFEST = "package.json";
/** pnpm command shims and store metadata are not runtime resolution inputs. */
const NON_RUNTIME_MODULES_ENTRIES = new Set([".bin", ".modules.yaml", ".pnpm-workspace-state-v1.json"]);
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

function closureOrigin() {
  return Object.freeze({ kind: "declared_external_runtime_closure", source: CLOSURE_ORIGIN_SCHEMA });
}

/**
 * Rebuild the closure claim for an already-published generation from its own
 * recorded inventory, so a recheck verifies the same claim the publisher made
 * rather than silently re-deriving resolution from the developer repository.
 */
export function closureOriginsFromInventory(entries) {
  if (!Array.isArray(entries)) throw new Error("closure_inventory_invalid");
  return new Map(entries
    .filter((entry) => typeof entry?.path === "string" && entry.origin?.kind === "declared_external_runtime_closure")
    .map((entry) => [entry.path, entry.origin]));
}

const slash = (path) => path.replaceAll("\\", "/");
const pnpmCliPath = () => process.platform === "win32"
  ? resolve(process.env.APPDATA ?? resolve(process.env.USERPROFILE ?? process.cwd(), "AppData", "Roaming"), "npm", "node_modules", "pnpm", "bin", "pnpm.cjs")
  : undefined;

function runPnpm(args, cwd, timeoutMs = DEPLOY_TIMEOUT_MS) {
  const cli = pnpmCliPath();
  return new Promise((settle) => {
    const child = spawn(cli ? process.execPath : "pnpm", cli ? [cli, ...args] : args, {
      cwd,
      shell: false,
      // CI keeps pnpm non-interactive; it has no terminal to confirm a purge with.
      env: { ...process.env, CI: "true" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let failure;
    const deadline = setTimeout(() => { failure ??= new Error("closure_pnpm_timeout"); child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (failure !== undefined || code !== 0) {
        settle({ ok: false, reason: `${failure?.message ?? `exit_${code}`}:${(stderr || stdout).slice(-800)}` });
        return;
      }
      settle({ ok: true });
    });
  });
}

// A source package is copied as a published package would be: its own installed
// dependencies and VCS metadata are never part of the package content. The
// scratch install resolves dependencies from the lockfile instead, so a linked
// `node_modules` inside a `file:` target must not be followed or copied.
const NON_PACKAGE_SOURCE_ENTRIES = new Set(["node_modules", ".git"]);

async function copyPackageSource(source, destination) {
  const state = await lstat(source);
  if (state.isSymbolicLink()) throw new Error(`closure_staging_link_forbidden:${slash(source)}`);
  if (state.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) {
      if (NON_PACKAGE_SOURCE_ENTRIES.has(name)) continue;
      await copyPackageSource(join(source, name), join(destination, name));
    }
    return;
  }
  if (!state.isFile()) throw new Error(`closure_staging_nonregular_entry:${slash(source)}`);
  await cp(source, destination);
}

/**
 * Copy the deployed closure into the generation, prune the artifact's own test
 * artifacts, and adopt every staged path as one claim. The claim is per-tree,
 * never per path prefix: each file's digest is bound by the artifact inventory.
 */
async function adoptDeployedClosure({ deployedModules, stagingRoot, declaredPackages, testArtifact, origin }) {
  const targetModules = resolve(stagingRoot, CLOSURE_MODULES_DIRECTORY);
  const origins = new Map();
  const visit = async (sourceDirectory, relativeDirectory) => {
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      const item = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!relativeDirectory && NON_RUNTIME_MODULES_ENTRIES.has(entry.name)) continue;
      const source = join(sourceDirectory, entry.name);
      const state = await lstat(source);
      if (state.isSymbolicLink()) throw new Error(`closure_staging_link_forbidden:${item}`);
      if (state.isDirectory()) { await visit(source, item); continue; }
      if (!state.isFile()) throw new Error(`closure_staging_nonregular_entry:${item}`);
      if (testArtifact.test(item)) continue;
      const destination = join(targetModules, ...item.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
      origins.set(`${CLOSURE_MODULES_DIRECTORY}/${item}`, origin);
    }
  };
  await visit(deployedModules, "");
  // The generation is its own ESM resolution parent root. Without this manifest
  // the closure is present but unresolvable, and `type: module` keeps the
  // emitted Host graph resolving as ESM once it is outside the repository.
  const manifest = { name: "gamebuddy-host-generation", private: true, type: "module",
    dependencies: Object.fromEntries(declaredPackages.map((name) => [name, "*"])) };
  await writeFile(resolve(stagingRoot, CLOSURE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  origins.set(CLOSURE_MANIFEST, origin);
  return origins;
}

/**
 * Build a scratch workspace outside the repository containing only the inputs
 * pnpm needs to resolve the Host closure, so repo module state is never touched.
 */
async function prepareScratchWorkspace({ hostRoot, scratch }) {
  const repositoryRoot = resolve(hostRoot, "..");
  for (const name of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "package.json"]) {
    const source = resolve(repositoryRoot, name);
    if (existsSync(source)) await cp(source, resolve(scratch, name));
  }
  for (const member of ["host", "dialogue-web", "integrations/stardew/action-development"]) {
    const manifest = resolve(repositoryRoot, member, "package.json");
    if (!existsSync(manifest)) continue;
    await mkdir(resolve(scratch, member), { recursive: true });
    await cp(manifest, resolve(scratch, member, "package.json"));
  }
  const hostManifest = JSON.parse(await readFile(resolve(hostRoot, "package.json"), "utf8"));
  for (const specifier of Object.values(hostManifest.dependencies ?? {})) {
    if (typeof specifier !== "string" || !specifier.startsWith("file:")) continue;
    // `file:` targets are repository-relative to host/, e.g. `..\vendor\...`.
    const repositoryRelative = specifier.slice(5).replaceAll("\\", "/").replace(/^\.\.\//, "");
    const source = resolve(repositoryRoot, repositoryRelative);
    if (!existsSync(source)) throw new Error(`closure_staging_file_dependency_missing:${repositoryRelative}`);
    await copyPackageSource(source, resolve(scratch, repositoryRelative));
  }
}

/**
 * Stage the declared external runtime closure into `stagingRoot`.
 *
 * Returns the artifact-relative origin map for every staged path, so the caller
 * registers the claim through the same origin channel as every other artifact
 * input.
 */
export async function stageDeclaredRuntimeClosure({ hostRoot, stagingRoot, externalRuntimeClosure, scratchRoot, testArtifact, deployFilter = "@gamebuddy/companion-host" }) {
  const declaredPackages = externalRuntimeClosure?.packages;
  if (!Array.isArray(declaredPackages) || declaredPackages.length === 0)
    throw new Error("closure_staging_declaration_required");
  if (!(testArtifact instanceof RegExp)) throw new Error("closure_staging_test_artifact_rule_required");
  // The deploy target is the Host workspace package. It is an explicit input so
  // the stager never has to read a manifest from a directory that may be a
  // disposable test copy rather than the real Host root.
  if (typeof deployFilter !== "string" || deployFilter.length === 0) throw new Error("closure_staging_deploy_filter_required");
  const scratch = scratchRoot ?? join(tmpdir(), `gamebuddy-closure-staging-${process.pid}-${Date.now().toString(36)}`);
  const deployedRoot = join(scratch, "deployed");
  try {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    await prepareScratchWorkspace({ hostRoot, scratch });
    const install = await runPnpm(["install", "--frozen-lockfile", "--config.node-linker=hoisted"], scratch);
    if (!install.ok) throw new Error(`closure_staging_install_failed:${install.reason}`);
    const deploy = await runPnpm(["deploy", "--filter", deployFilter, "--prod", "--legacy",
      "--config.node-linker=hoisted", deployedRoot], scratch);
    if (!deploy.ok) throw new Error(`closure_staging_deploy_failed:${deploy.reason}`);
    const deployedModules = join(deployedRoot, CLOSURE_MODULES_DIRECTORY);
    const state = await stat(deployedModules).catch(() => null);
    if (state === null || !state.isDirectory()) throw new Error("closure_staging_deploy_target_missing");
    for (const name of declaredPackages) {
      const staged = resolve(deployedModules, ...name.split("/"));
      if (!existsSync(staged)) throw new Error(`closure_staging_declared_package_missing:${name}`);
    }
    const origins = await adoptDeployedClosure({ deployedModules, stagingRoot, declaredPackages, testArtifact, origin: closureOrigin() });
    if (origins.size === 0) throw new Error("closure_staging_produced_no_files");
    return origins;
  } finally {
    // A 0.5 GB scratch tree is never allowed to outlive the attempt.
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

/** Strict containment helper used by tests and callers that relocate a generation. */
function inside(root, path) {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !remainder.includes(`..${sep}`));
}
