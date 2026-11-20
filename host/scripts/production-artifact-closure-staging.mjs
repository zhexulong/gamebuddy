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
 *
 * The deployed tree is CACHED BY CONTENT, because the deploy is the one step of
 * the release-shaped build that reaches a package registry:
 *
 *  - `pnpm deploy --legacy` re-RESOLVES the graph it deploys instead of
 *    installing from the frozen lockfile (it prints "The current configuration
 *    prohibits to read or write a lockfile" and then asks for packuments; a
 *    recorder registry measured 60 names for one deploy, most of them the
 *    repository root's own devDependencies — eslint, jscpd, knip, stylelint,
 *    sharp, onnxruntime — none of which belong to the runtime closure). On a
 *    machine whose registry is unreachable that is 15 minutes of retries and
 *    then `ECONNRESET`, on every build, because the scratch workspace is new
 *    every time.
 *  - The cache key is a digest of the deploy's real inputs (lockfile, the
 *    manifests the scratch workspace is built from, every `file:` target's
 *    file contents) plus the deploy filter, the platform and the pnpm version.
 *    Same key means same tree, so the tree is stored once and reused.
 *  - A stored tree is REUSED ONLY IF IT VERIFIES: the entry records a digest
 *    over every file path and file content in it, and a hit re-derives that
 *    digest from the files on disk. This is the same discipline the native
 *    helper builders apply to their `.dist` pairs (`readVerifiedPair`): present
 *    is not the claim, matching content is.
 *  - A FIRST-EVER BUILD ON THIS MACHINE still needs the registry: a cache miss
 *    deploys for real. That is not hidden — the miss prints the key and the
 *    entry it will write, and a miss whose deploy cannot reach the registry
 *    fails as `runtime_closure_cache_missing: <key>` naming the entry, instead
 *    of surfacing a registry error 15 minutes later.
 */
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
/** The cache entry layout: `<cacheRoot>/<key>/closure.json` + `<cacheRoot>/<key>/tree`. */
const CACHE_SCHEMA = "host_runtime_closure_cache/v1";
const CACHE_RECORD = "closure.json";
const CACHE_TREE = "tree";
/** A cache entry is assembled here and renamed into place, so a killed write is never an entry. */
const CACHE_WRITING_SUFFIX = ".writing";
/** How many entries survive the age floor; entries are 0.6 GB each. */
const CACHE_KEEP_ENTRIES = 3;
/** Nothing is removed while a build on this machine could still be adopting it. */
const CACHE_MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;

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

/**
 * The pnpm that will produce the tree, as a string that changes whenever the
 * tool that lays the tree out changes. On a host where the CLI package cannot be
 * located the marker says so rather than pretending the deploy is
 * inter-version compatible.
 */
function pnpmVersion() {
  const cli = pnpmCliPath();
  if (cli === undefined) return "pnpm:unresolved";
  try {
    return `pnpm:${JSON.parse(readFileSync(resolve(cli, "..", "..", "package.json"), "utf8")).version}`;
  } catch {
    return "pnpm:unresolved";
  }
}

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
 * Every file the deployed tree is a function of: the workspace manifests pnpm
 * needs to resolve the graph, and every `file:` target the Host declares. One
 * list serves both the cache key and the scratch copy, so the cache can never be
 * keyed on something the deploy does not read, nor miss something it does.
 */
async function closureInputs({ hostRoot }) {
  const repositoryRoot = resolve(hostRoot, "..");
  const inputs = [];
  for (const name of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "package.json"]) {
    const source = resolve(repositoryRoot, name);
    if (existsSync(source)) inputs.push({ target: name, source, directory: false });
  }
  for (const member of ["host", "dialogue-web", "integrations/stardew/action-development"]) {
    const source = resolve(repositoryRoot, member, "package.json");
    if (existsSync(source)) inputs.push({ target: `${member}/package.json`, source, directory: false });
  }
  const hostManifest = JSON.parse(await readFile(resolve(hostRoot, "package.json"), "utf8"));
  for (const specifier of Object.values(hostManifest.dependencies ?? {})) {
    if (typeof specifier !== "string" || !specifier.startsWith("file:")) continue;
    // `file:` targets are repository-relative to host/, e.g. `..\vendor\...`.
    const repositoryRelative = specifier.slice(5).replaceAll("\\", "/").replace(/^\.\.\//, "");
    const source = resolve(repositoryRoot, repositoryRelative);
    if (!existsSync(source)) throw new Error(`closure_staging_file_dependency_missing:${repositoryRelative}`);
    inputs.push({ target: repositoryRelative, source, directory: true });
  }
  return inputs;
}

const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/**
 * The `/`-joined relative paths of every file under `root`, sorted, links refused. `skip` mirrors what
 * a copy will not carry (a `file:` target's own `node_modules` is not part of the package).
 */
async function filesUnder(root, skip = null, prefix = "") {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (skip !== null && skip.has(entry.name)) continue;
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(root, entry.name);
    const state = await lstat(path);
    if (state.isSymbolicLink()) throw new Error(`closure_staging_link_forbidden:${name}`);
    if (state.isDirectory()) { files.push(...await filesUnder(path, skip, name)); continue; }
    if (!state.isFile()) throw new Error(`closure_staging_nonregular_entry:${name}`);
    files.push(name);
  }
  return files.sort();
}

/**
 * One digest over every path and every file's content, in sorted order: the
 * stored tree's verification subject and, for a tree, its identity.
 */
async function treeDigest(root) {
  const hash = createHash("sha256");
  for (const file of await filesUnder(root)) hash.update(`${file}\u0000${await sha256File(join(root, ...file.split("/")))}\n`);
  return hash.digest("hex");
}

/**
 * The cache key: the deploy's inputs, the project it deploys, and the toolchain
 * that lays the tree out. Nothing else — a key that moved for anything else
 * would rebuild the whole closure on an unrelated edit.
 */
async function keyOf({ inputs, deployFilter }) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ schema: CACHE_SCHEMA, deployFilter, platform: process.platform,
    arch: process.arch, pnpm: pnpmVersion() }));
  for (const input of [...inputs].sort((left, right) => left.target.localeCompare(right.target))) {
    if (input.directory) {
      const files = await filesUnder(input.source, NON_PACKAGE_SOURCE_ENTRIES);
      if (files.length === 0) hash.update(`\n${input.target}\u0000(empty directory)`);
      for (const file of files)
        hash.update(`\n${input.target}/${file}\u0000${await sha256File(join(input.source, ...file.split("/")))}`);
      continue;
    }
    hash.update(`\n${input.target}\u0000${await sha256File(input.source)}`);
  }
  return hash.digest("hex");
}

/** The machine-wide cache directory; the deployed tree is a build input, not a repo artifact. */
function defaultCacheRoot() {
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? resolve(process.env.USERPROFILE ?? process.cwd(), "AppData", "Local")
    : process.env.XDG_CACHE_HOME ?? resolve(process.env.HOME ?? process.cwd(), ".cache");
  return resolve(base, "gamebuddy", "runtime-closure-cache");
}

/**
 * The identity of the closure this Host root would deploy, and the directory its
 * stored tree lives in. Exported so a caller can ask what the cache is keyed on
 * — and so the cache's own tests record a tree the production path will read —
 * without a second copy of the key's rules.
 */
export async function closureCacheIdentity({ hostRoot, deployFilter = "@gamebuddy/companion-host", cacheRoot = defaultCacheRoot() }) {
  const inputs = await closureInputs({ hostRoot });
  const key = await keyOf({ inputs, deployFilter });
  return { key, cacheDir: resolve(cacheRoot, key), inputs };
}

/**
 * The cached tree for `key`, or `null` when there is none. An entry that exists
 * and does not verify is neither used nor overwritten silently: it is named,
 * because a stored tree that no longer matches its own record is either rot or a
 * foreign write, and both want the operator's eyes rather than a quiet rebuild.
 */
export async function readVerifiedClosureCache({ cacheDir, key }) {
  if (!existsSync(cacheDir)) return null;
  const tree = resolve(cacheDir, CACHE_TREE);
  const invalid = (detail) => new Error(`runtime_closure_cache_invalid:${cacheDir} (${detail})`);
  let record;
  try {
    record = JSON.parse(await readFile(resolve(cacheDir, CACHE_RECORD), "utf8"));
  } catch {
    throw invalid(`no readable ${CACHE_RECORD}`);
  }
  if (record?.schema !== CACHE_SCHEMA) throw invalid(`record schema ${JSON.stringify(record?.schema ?? null)} is not ${CACHE_SCHEMA}`);
  if (record.key !== key) throw invalid(`record key ${String(record.key)} is not the key it is stored under`);
  if (typeof record.digest !== "string" || record.digest.length === 0) throw invalid("record carries no digest");
  if (!existsSync(resolve(tree, CLOSURE_MODULES_DIRECTORY))) throw invalid(`no ${CACHE_TREE}/${CLOSURE_MODULES_DIRECTORY} directory`);
  const digest = await treeDigest(resolve(tree, CLOSURE_MODULES_DIRECTORY));
  if (digest !== record.digest)
    throw invalid(`the stored tree digests to ${digest.slice(0, 16)} where the record says ${record.digest.slice(0, 16)}`);
  return resolve(tree, CLOSURE_MODULES_DIRECTORY);
}

/**
 * Keep the cache bounded. Every entry is a 0.6 GB tree and the key moves with the
 * lockfile, so a cache that only ever wrote would leave one behind per dependency
 * change. The newest few stay, and nothing is removed inside the age floor, so a
 * build that is reading an entry right now cannot be pruned out from under itself.
 */
async function pruneClosureCache({ cacheRoot }) {
  const entries = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(cacheRoot, entry.name);
    const state = await stat(path).catch(() => null);
    if (state !== null) entries.push({ name: entry.name, path, modified: state.mtimeMs });
  }
  entries.sort((left, right) => right.modified - left.modified);
  const now = Date.now();
  let removed = 0;
  for (const [index, entry] of entries.entries()) {
    if (index < CACHE_KEEP_ENTRIES || now - entry.modified < CACHE_MINIMUM_AGE_MS) continue;
    await rm(entry.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    removed += 1;
  }
  if (removed > 0)
    console.log(`runtime_closure_cache pruned removed=${removed} kept=${entries.length - removed} (entries older than ${CACHE_MINIMUM_AGE_MS / 3600000}h beyond the newest ${CACHE_KEEP_ENTRIES})`);
}

/** Record a freshly deployed tree under its key, atomically: a killed write is not an entry. */
export async function writeClosureCache({ cacheDir, key, deployedModules }) {
  const writing = `${cacheDir}${CACHE_WRITING_SUFFIX}`;
  await rm(writing, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  await mkdir(resolve(writing, CACHE_TREE), { recursive: true });
  const stored = resolve(writing, CACHE_TREE, CLOSURE_MODULES_DIRECTORY);
  await cp(deployedModules, stored, { recursive: true });
  const digest = await treeDigest(stored);
  await writeFile(resolve(writing, CACHE_RECORD), `${JSON.stringify({ schema: CACHE_SCHEMA, key, digest }, null, 2)}\n`,
    { flag: "wx" });
  await rm(cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  await rename(writing, cacheDir);
  await pruneClosureCache({ cacheRoot: dirname(cacheDir) });
  return digest;
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
async function prepareScratchWorkspace({ scratch, inputs }) {
  for (const input of inputs) {
    const destination = resolve(scratch, ...input.target.split("/"));
    if (input.directory) { await copyPackageSource(input.source, destination); continue; }
    await mkdir(dirname(destination), { recursive: true });
    await cp(input.source, destination);
  }
}

/**
 * Deploy the closure for real, then record the tree under `key`. Only a cache
 * miss reaches this, which is why the registry is a first-build dependency and
 * not a per-build one.
 */
async function deployClosure({ scratchRoot, inputs, deployFilter, cacheDir, key }) {
  const started = Date.now();
  const scratch = scratchRoot ?? join(tmpdir(), `gamebuddy-closure-staging-${process.pid}-${Date.now().toString(36)}`);
  const deployedRoot = join(scratch, "deployed");
  try {
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    await prepareScratchWorkspace({ scratch, inputs });
    const install = await runPnpm(["install", "--frozen-lockfile", "--config.node-linker=hoisted"], scratch);
    if (!install.ok) throw new Error(`closure_staging_install_failed:${install.reason}`);
    // `--config.fetch-retries=0`: the deploy resolves its graph from the
    // registry even with a frozen lockfile, so an unreachable registry turns
    // into two minutes of backoff per package. The failure is reported below by
    // name, and a build is re-run rather than retried package by package - what
    // the default retries buy here is fifteen minutes before the same answer.
    const deploy = await runPnpm(["deploy", "--frozen-lockfile", "--filter", deployFilter, "--prod", "--legacy",
      "--config.node-linker=hoisted", "--config.fetch-retries=0", deployedRoot], scratch);
    if (!deploy.ok) return { failure: `the deploy failed (${deploy.reason})` };
    const deployedModules = join(deployedRoot, CLOSURE_MODULES_DIRECTORY);
    const state = await stat(deployedModules).catch(() => null);
    if (state === null || !state.isDirectory()) return { failure: "the deploy left no node_modules behind" };
    console.log(`runtime_closure_cache miss key=${key.slice(0, 12)} dir=${cacheDir} (deployed, now recording the tree)`);
    const digest = await writeClosureCache({ cacheDir, key, deployedModules });
    console.log(`runtime_closure_cache stored key=${key.slice(0, 12)} digest=${digest.slice(0, 16)} elapsed=${Math.round((Date.now() - started) / 1000)}s`);
    // The stored tree is what the artifact adopts on both paths: the scratch
    // copy is deleted below, and a hit must be the same tree a miss produced.
    return { modules: resolve(cacheDir, CACHE_TREE, CLOSURE_MODULES_DIRECTORY), digest };
  } finally {
    // A 0.5 GB scratch tree is never allowed to outlive the attempt.
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

/**
 * Stage the declared external runtime closure into `stagingRoot`.
 *
 * Returns the artifact-relative origin map for every staged path, so the caller
 * registers the claim through the same origin channel as every other artifact
 * input.
 */
export async function stageDeclaredRuntimeClosure({ hostRoot, stagingRoot, externalRuntimeClosure, scratchRoot, testArtifact, deployFilter = "@gamebuddy/companion-host", cacheRoot = defaultCacheRoot() }) {
  const declaredPackages = externalRuntimeClosure?.packages;
  if (!Array.isArray(declaredPackages) || declaredPackages.length === 0)
    throw new Error("closure_staging_declaration_required");
  if (!(testArtifact instanceof RegExp)) throw new Error("closure_staging_test_artifact_rule_required");
  // The deploy target is the Host workspace package. It is an explicit input so
  // the stager never has to read a manifest from a directory that may be a
  // disposable test copy rather than the real Host root.
  if (typeof deployFilter !== "string" || deployFilter.length === 0) throw new Error("closure_staging_deploy_filter_required");

  const { key, cacheDir, inputs } = await closureCacheIdentity({ hostRoot, deployFilter, cacheRoot });
  const verifyStarted = Date.now();
  let deployedModules = await readVerifiedClosureCache({ cacheDir, key });
  const verifiedMs = Date.now() - verifyStarted;
  if (deployedModules === null) {
    const deployed = await deployClosure({ scratchRoot, inputs, deployFilter, cacheDir, key });
    if (deployed.failure !== undefined)
      throw new Error(`runtime_closure_cache_missing:${key} - no verified tree at ${cacheDir} and no closure was deployed for it (${deployed.failure}); one build with the package registry reachable and this key records it`);
    deployedModules = deployed.modules;
  } else {
    console.log(`runtime_closure_cache hit key=${key.slice(0, 12)} dir=${cacheDir} (verified in ${Math.round(verifiedMs / 100) / 10}s, no registry request)`);
  }
  for (const name of declaredPackages) {
    const staged = resolve(deployedModules, ...name.split("/"));
    if (!existsSync(staged)) throw new Error(`closure_staging_declared_package_missing:${name}`);
  }
  const origins = await adoptDeployedClosure({ deployedModules, stagingRoot, declaredPackages, testArtifact, origin: closureOrigin() });
  if (origins.size === 0) throw new Error("closure_staging_produced_no_files");
  return origins;
}

/** Strict containment helper used by tests and callers that relocate a generation. */
function inside(root, path) {
  const remainder = relative(root, path);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !remainder.includes(`..${sep}`));
}
