import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * The Chat Live runtime has one deliberately small external package boundary.
 * These are Host dependencies, not a request to resolve whatever happens to be
 * installed for the invoking user.
 */
export const CHAT_LIVE_ARTIFACT_ROOT_PACKAGES = Object.freeze([
  "@cortexkit/pi-magic-context",
  "@earendil-works/pi-coding-agent",
  "@gamebuddy/voice-protocol",
  "typebox",
]);

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const MAX_PACKAGE_COUNT = 512;
const MAX_PACKAGE_DEPTH = 32;
const MAX_PACKAGE_FILES = 100_000;
const STAGING_PREFIX = ".chat-live-node-modules-";
const slash = (value) => value.replaceAll("\\", "/");
const inside = (root, candidate) => {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
};
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const clone = (value) => JSON.parse(JSON.stringify(value));

function assertAbsoluteRoot(value, error) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(error);
  return resolve(value);
}

async function regularFile(path, error) {
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error(error);
  return state;
}

async function regularDirectory(path, error) {
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error(error);
  return state;
}

async function optionalRegularDirectory(path, error) {
  try {
    return await regularDirectory(path, error);
  } catch (cause) {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  }
}

function validatePackageName(name, error = "chat_live_package_name_invalid") {
  if (typeof name !== "string" || !PACKAGE_NAME.test(name)) throw new Error(error);
  return name;
}

function validateDependencyMap(value, key, packageName) {
  if (value === undefined) return {};
  if (!plainObject(value)) throw new Error(`chat_live_package_manifest_${key}_invalid:${packageName}`);
  const result = {};
  for (const [name, range] of Object.entries(value)) {
    validatePackageName(name, `chat_live_package_manifest_dependency_name_invalid:${packageName}:${name}`);
    if (typeof range !== "string" || range.length === 0 || range.length > 512)
      throw new Error(`chat_live_package_manifest_dependency_range_invalid:${packageName}:${name}`);
    result[name] = range;
  }
  return result;
}

function manifestDependencyNames(manifest) {
  const dependencies = validateDependencyMap(manifest.dependencies, "dependencies", manifest.name);
  const optionalDependencies = validateDependencyMap(manifest.optionalDependencies, "optionalDependencies", manifest.name);
  const peerDependencies = validateDependencyMap(manifest.peerDependencies, "peerDependencies", manifest.name);
  const peerDependenciesMeta = manifest.peerDependenciesMeta === undefined ? {} : manifest.peerDependenciesMeta;
  if (!plainObject(peerDependenciesMeta)) throw new Error(`chat_live_package_manifest_peerDependenciesMeta_invalid:${manifest.name}`);
  const optionalPeers = new Set();
  for (const [name, metadata] of Object.entries(peerDependenciesMeta)) {
    validatePackageName(name, `chat_live_package_manifest_peer_name_invalid:${manifest.name}:${name}`);
    if (!Object.hasOwn(peerDependencies, name)) {
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) || metadata.optional !== true)
        throw new Error(`chat_live_package_manifest_peer_metadata_unknown:${manifest.name}:${name}`);
      optionalPeers.add(name);
      continue;
    }
    if (!plainObject(metadata)) throw new Error(`chat_live_package_manifest_peer_metadata_invalid:${manifest.name}:${name}`);
    if (metadata.optional === true) optionalPeers.add(name);
    else if (metadata.optional !== undefined) throw new Error(`chat_live_package_manifest_peer_optional_invalid:${manifest.name}:${name}`);
  }
  const required = new Set(Object.keys(dependencies));
  const optional = new Set(Object.keys(optionalDependencies));
  for (const name of Object.keys(peerDependencies)) {
    if (optionalPeers.has(name)) optional.add(name);
    else required.add(name);
  }
  // npm treats a name present in optionalDependencies as optional even when a
  // package manager also repeats it in dependencies.
  for (const name of optional) required.delete(name);
  return Object.freeze({ required: Object.freeze([...required].sort()), optional: Object.freeze([...optional].sort()) });
}

async function readManifest(packageRoot, expectedName) {
  const manifestPath = resolve(packageRoot, "package.json");
  await regularFile(manifestPath, `chat_live_package_manifest_missing:${expectedName}`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(`chat_live_package_manifest_invalid:${expectedName}`);
  }
  if (!plainObject(manifest) || manifest.name !== expectedName || typeof manifest.version !== "string" || manifest.version.length === 0)
    throw new Error(`chat_live_package_manifest_identity_invalid:${expectedName}`);
  manifestDependencyNames(manifest);
  return manifest;
}

async function assertPackageAncestors(packageLink, nodeModulesRoot, error) {
  const parent = dirname(packageLink);
  if (!inside(nodeModulesRoot, parent)) throw new Error(error);
  const segments = relative(nodeModulesRoot, parent).split(sep).filter(Boolean);
  let current = nodeModulesRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    await regularDirectory(current, error);
  }
}

async function resolvePackageLink({ parentRoot, packageName, hostRoot, isPeer }) {
  // Resolve like Node from the package directory, but with an explicit stop at
  // the Host-owned workspace. This handles pnpm's virtual-store layout where a
  // package-local dependency link lives in an ancestor virtual-store
  // node_modules directory rather than inside the real package directory.
  const candidates = [];
  let current = resolve(parentRoot);
  while (true) {
    candidates.push(resolve(current, "node_modules", ...packageName.split("/")));
    if (current === hostRoot || current === dirname(current)) break;
    current = dirname(current);
    if (!inside(resolve(hostRoot, ".."), current)) break;
  }
  if (isPeer) candidates.push(resolve(hostRoot, "node_modules", ...packageName.split("/")));
  for (const candidate of candidates) {
    try {
      const nodeModulesRoot = packageName.startsWith("@") ? dirname(dirname(candidate)) : dirname(candidate);
      // `node_modules/@scope` is a namespace directory, never a link. This
      // keeps package resolution from accepting an arbitrary redirected tree.
      await assertPackageAncestors(candidate, nodeModulesRoot, `chat_live_package_link_ancestor_invalid:${packageName}`);
      const link = await lstat(candidate);
      if (!link.isSymbolicLink() && !link.isDirectory()) throw new Error(`chat_live_package_link_invalid:${packageName}`);
      const packageRoot = await realpath(candidate);
      await regularDirectory(packageRoot, `chat_live_package_root_invalid:${packageName}`);
      return packageRoot;
    } catch (error) {
      if (error?.code !== "ENOENT" && !String(error?.message ?? "").includes("chat_live_package_link_ancestor_invalid")) throw error;
    }
  }
  if (isPeer) throw new Error(`chat_live_package_peer_missing:${packageName}`);
  throw new Error(`chat_live_package_dependency_missing:${packageName}`);
}

function allowedSourceRoot(hostRoot) {
  const workspaceRoot = resolve(hostRoot, "..");
  return [
    resolve(hostRoot, "node_modules"),
    resolve(hostRoot, "node_modules", ".pnpm"),
    resolve(workspaceRoot, "node_modules", ".pnpm"),
    resolve(workspaceRoot, "vendor"),
    resolve(workspaceRoot, "packages", "voice-protocol"),
  ];
}

function assertSourceRootAllowed(hostRoot, packageRoot, packageName) {
  if (!allowedSourceRoot(hostRoot).some((root) => inside(root, packageRoot)))
    throw new Error(`chat_live_package_source_outside_host:${packageName}`);
}

async function readHostManifest(hostRoot) {
  const manifestPath = resolve(hostRoot, "package.json");
  await regularFile(manifestPath, "chat_live_host_manifest_missing");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("chat_live_host_manifest_invalid");
  }
  if (!plainObject(manifest)) throw new Error("chat_live_host_manifest_invalid");
  validateDependencyMap(manifest.dependencies, "dependencies", "host");
  return manifest;
}

async function resolveRootPackage({ hostRoot, packageName, hostManifest }) {
  const dependencyRange = hostManifest.dependencies?.[packageName];
  if (typeof dependencyRange !== "string" || dependencyRange.length === 0)
    throw new Error(`chat_live_host_dependency_not_declared:${packageName}`);
  const nodeModulesRoot = resolve(hostRoot, "node_modules");
  await regularDirectory(nodeModulesRoot, "chat_live_host_node_modules_invalid");
  const packageLink = resolve(nodeModulesRoot, ...packageName.split("/"));
  await assertPackageAncestors(packageLink, nodeModulesRoot, `chat_live_package_link_ancestor_invalid:${packageName}`);
  let link;
  try {
    link = await lstat(packageLink);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`chat_live_root_package_missing:${packageName}`);
    throw error;
  }
  if (!link.isSymbolicLink() && !link.isDirectory()) throw new Error(`chat_live_root_package_invalid:${packageName}`);
  const packageRoot = await realpath(packageLink);
  await regularDirectory(packageRoot, `chat_live_root_package_invalid:${packageName}`);
  assertSourceRootAllowed(hostRoot, packageRoot, packageName);
  const manifest = await readManifest(packageRoot, packageName);
  return Object.freeze({ packageName, packageRoot, manifest, dependencyRange });
}

function destinationFor(parentDestination, packageName) {
  return parentDestination === ""
    ? `node_modules/${packageName}`
    : `${parentDestination}/node_modules/${packageName}`;
}

function freezePackageRecord(record) {
  return Object.freeze({
    name: record.name,
    version: record.version,
    sourceRoot: record.sourceRoot,
    destination: record.destination,
    manifest: Object.freeze(clone(record.manifest)),
    dependencies: Object.freeze([...record.dependencies]),
  });
}

function validateClosureOptions(options = {}) {
  if (!plainObject(options)) throw new Error("chat_live_dependency_closure_options_invalid");
  const hostRoot = assertAbsoluteRoot(options.hostRoot, "chat_live_host_root_required");
  const rootPackages = options.rootPackages ?? CHAT_LIVE_ARTIFACT_ROOT_PACKAGES;
  if (!Array.isArray(rootPackages) || rootPackages.length === 0 || new Set(rootPackages).size !== rootPackages.length)
    throw new Error("chat_live_root_packages_invalid");
  rootPackages.forEach((name) => validatePackageName(name, "chat_live_root_package_name_invalid"));
  const maxPackages = options.maxPackages ?? MAX_PACKAGE_COUNT;
  const maxDepth = options.maxDepth ?? MAX_PACKAGE_DEPTH;
  if (!Number.isSafeInteger(maxPackages) || maxPackages < rootPackages.length || maxPackages > MAX_PACKAGE_COUNT)
    throw new Error("chat_live_dependency_closure_bound_invalid");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_PACKAGE_DEPTH)
    throw new Error("chat_live_dependency_closure_depth_bound_invalid");
  return Object.freeze({ hostRoot, rootPackages: Object.freeze([...rootPackages]), maxPackages, maxDepth });
}

/**
 * Resolves only manifest-declared dependencies reachable from the explicit Chat
 * roots. Package-local node_modules links are followed for dependencies, with
 * the Host root used only for declared peer resolution. No ambient resolver is
 * consulted. Optional dependencies absent from this platform are recorded and
 * omitted; required dependencies always fail closed.
 */
export async function resolveChatLiveArtifactDependencyClosure(options = {}) {
  const { hostRoot, rootPackages, maxPackages, maxDepth } = validateClosureOptions(options);
  const hostManifest = await readHostManifest(hostRoot);
  const queue = [];
  const omittedOptionalDependencies = [];
  const packageRecords = [];
  const packageDestinations = new Map();
  const rootRecords = new Map();
  const scheduledDestinations = new Set();

  for (const packageName of rootPackages) {
    const root = await resolveRootPackage({ hostRoot, packageName, hostManifest });
    const destination = destinationFor("", packageName);
    queue.push({
      name: packageName,
      sourceRoot: root.packageRoot,
      manifest: root.manifest,
      destination,
      depth: 0,
      ancestors: new Set([root.packageRoot]),
    });
    scheduledDestinations.add(destination);
    packageDestinations.set(`${packageName}@${root.manifest.version}`, destination);
    rootRecords.set(packageName, destination);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth > maxDepth) throw new Error(`chat_live_dependency_depth_exceeded:${current.name}`);
    if (packageRecords.length >= maxPackages) throw new Error("chat_live_dependency_count_exceeded");
    const dependencies = manifestDependencyNames(current.manifest);
    const childNames = [...dependencies.required, ...dependencies.optional];
    const childDestinations = [];
    for (const childName of childNames) {
      const isOptional = dependencies.optional.includes(childName);
      let childRoot;
      try {
        childRoot = await resolvePackageLink({
          parentRoot: current.sourceRoot,
          packageName: childName,
          hostRoot,
          isPeer: Object.hasOwn(current.manifest.peerDependencies ?? {}, childName),
        });
        assertSourceRootAllowed(hostRoot, childRoot, childName);
      } catch (error) {
        if (isOptional && (error?.message === `chat_live_package_dependency_missing:${childName}` || error?.message === `chat_live_package_peer_missing:${childName}`)) {
          omittedOptionalDependencies.push(`${current.name}:${childName}`);
          continue;
        }
        throw error;
      }
      const childManifest = await readManifest(childRoot, childName);
      const childIdentity = `${childName}@${childManifest.version}`;
      const existingChildDestination = packageDestinations.get(childIdentity);
      if (existingChildDestination !== undefined) {
        childDestinations.push(existingChildDestination);
        continue;
      }
      const childDestination = Object.hasOwn(current.manifest.peerDependencies ?? {}, childName)
        ? destinationFor("", childName)
        : destinationFor(current.destination, childName);
      childDestinations.push(childDestination);
      if (scheduledDestinations.has(childDestination)) continue;
      scheduledDestinations.add(childDestination);
      packageDestinations.set(childIdentity, childDestination);
      if (current.ancestors.has(childRoot)) {
        // Materialize the cycle edge, but do not expand it again. This keeps
        // the package-local layout usable without allowing an infinite tree.
        packageRecords.push(freezePackageRecord({
          name: childName,
          version: childManifest.version,
          sourceRoot: childRoot,
          destination: childDestination,
          manifest: childManifest,
          dependencies: [],
        }));
        continue;
      }
      queue.push({
        name: childName,
        sourceRoot: childRoot,
        manifest: childManifest,
        destination: childDestination,
        depth: current.depth + 1,
        ancestors: new Set([...current.ancestors, childRoot]),
      });
    }
    packageRecords.push(freezePackageRecord({
      name: current.name,
      version: current.manifest.version,
      sourceRoot: current.sourceRoot,
      destination: current.destination,
      manifest: current.manifest,
      dependencies: childDestinations.sort(),
    }));
  }

  // Root records are intentionally checked against the output records rather
  // than trusting queue construction, making a malformed traversal impossible
  // to pass as a valid closure.
  for (const [name, destination] of rootRecords) {
    if (!packageRecords.some((record) => record.name === name && record.destination === destination))
      throw new Error(`chat_live_root_package_not_in_closure:${name}`);
  }
  const packages = packageRecords.sort((left, right) => left.destination.localeCompare(right.destination));
  const closure = {
    schema: "gamebuddy-chat-live-dependency-closure/v1",
    hostRoot,
    rootPackages: [...rootPackages],
    packages,
    omittedOptionalDependencies: [...new Set(omittedOptionalDependencies)].sort(),
  };
  return Object.freeze({
    schema: closure.schema,
    hostRoot: closure.hostRoot,
    rootPackages: Object.freeze(closure.rootPackages),
    packages: Object.freeze(closure.packages),
    omittedOptionalDependencies: Object.freeze(closure.omittedOptionalDependencies),
  });
}

function validateClosureShape(closure) {
  if (!plainObject(closure) || closure.schema !== "gamebuddy-chat-live-dependency-closure/v1"
    || !Array.isArray(closure.rootPackages) || !Array.isArray(closure.packages)
    || !Array.isArray(closure.omittedOptionalDependencies)) throw new Error("chat_live_dependency_closure_invalid");
  closure.rootPackages.forEach((name) => validatePackageName(name, "chat_live_root_package_name_invalid"));
  const destinations = new Set();
  const knownDestinations = new Set(closure.packages.map((item) => item?.destination));
  for (const packageRecord of closure.packages) {
    if (!plainObject(packageRecord) || typeof packageRecord.name !== "string" || !PACKAGE_NAME.test(packageRecord.name)
      || typeof packageRecord.version !== "string" || packageRecord.version.length === 0
      || typeof packageRecord.sourceRoot !== "string" || !isAbsolute(packageRecord.sourceRoot)
      || typeof packageRecord.destination !== "string" || !/^node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/i.test(packageRecord.destination)
      || !plainObject(packageRecord.manifest) || packageRecord.manifest.name !== packageRecord.name
      || packageRecord.manifest.version !== packageRecord.version || !Array.isArray(packageRecord.dependencies))
      throw new Error("chat_live_dependency_closure_package_invalid");
    if (destinations.has(packageRecord.destination)) throw new Error("chat_live_dependency_closure_duplicate_destination");
    destinations.add(packageRecord.destination);
    packageRecord.dependencies.forEach((destination) => {
      if (typeof destination !== "string" || !knownDestinations.has(destination))
        throw new Error("chat_live_dependency_closure_edge_invalid");
    });
  }
  for (const rootName of closure.rootPackages) {
    if (!closure.packages.some((item) => item.name === rootName && item.destination === `node_modules/${rootName}`))
      throw new Error(`chat_live_root_package_not_in_closure:${rootName}`);
  }
  return closure;
}

async function copyPackageTree(sourceRoot, destinationRoot) {
  let files = 0;
  async function copyDirectory(source, destination, isRoot = false) {
    await mkdir(destination, { recursive: true });
    await regularDirectory(destination, "chat_live_artifact_destination_invalid");
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (isRoot && entry.name === "node_modules") continue;
      const sourcePath = resolve(source, entry.name);
      const destinationPath = resolve(destination, entry.name);
      if (entry.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        files += 1;
        if (files > MAX_PACKAGE_FILES) throw new Error("chat_live_package_file_count_exceeded");
        await regularFile(sourcePath, "chat_live_package_source_file_invalid");
        await mkdir(dirname(destinationPath), { recursive: true });
        await copyFile(sourcePath, destinationPath);
        await regularFile(destinationPath, "chat_live_artifact_file_invalid");
      } else {
        throw new Error("chat_live_package_source_entry_invalid");
      }
    }
  }
  await regularDirectory(sourceRoot, "chat_live_package_source_invalid");
  await copyDirectory(sourceRoot, destinationRoot, true);
}

function packageDestinationPath(artifactRoot, destination) {
  const path = resolve(artifactRoot, ...destination.split("/"));
  if (!inside(artifactRoot, path) || !path.endsWith(destination.replaceAll("/", sep)))
    throw new Error("chat_live_artifact_destination_escape");
  return path;
}

async function assertDirectPackageLayout(artifactRoot, closure) {
  const expectedChildren = new Map();
  for (const packageRecord of closure.packages) {
    const parent = packageRecord.destination.includes("/node_modules/")
      ? packageRecord.destination.slice(0, packageRecord.destination.lastIndexOf("/node_modules/"))
      : "";
    const child = packageRecord.destination.slice(parent === "" ? "node_modules/".length : `${parent}/node_modules/`.length);
    const children = expectedChildren.get(parent) ?? new Set();
    children.add(child);
    expectedChildren.set(parent, children);
  }
  for (const [parent, children] of expectedChildren) {
    const parentPath = parent === "" ? artifactRoot : packageDestinationPath(artifactRoot, parent);
    const nodeModulesPath = resolve(parentPath, "node_modules");
    const directory = await optionalRegularDirectory(nodeModulesPath, "chat_live_artifact_node_modules_invalid");
    if (directory === undefined) throw new Error(`chat_live_artifact_dependency_directory_missing:${parent || "root"}`);
    const actual = new Set();
    for (const entry of await readdir(nodeModulesPath, { withFileTypes: true })) {
      if (entry.name === ".bin") throw new Error("chat_live_artifact_bin_directory_forbidden");
      if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error("chat_live_artifact_dependency_entry_invalid");
      actual.add(entry.name);
    }
    const expectedNames = new Set([...children].map((destination) => destination.split("/")[0]));
    if (actual.size !== expectedNames.size || [...actual].some((name) => !expectedNames.has(name)))
      throw new Error(`chat_live_artifact_dependency_layout_mismatch:${parent || "root"}`);
  }
}

/**
 * Validates that a materialized artifact contains exactly the package roots and
 * package-local dependency directories described by the closure. It does not
 * consult a parent project or attempt package discovery.
 */
export async function assertChatLiveArtifactDependencyClosure({ artifactRoot, closure } = {}) {
  const root = assertAbsoluteRoot(artifactRoot, "chat_live_artifact_root_required");
  const checked = validateClosureShape(closure);
  await regularDirectory(root, "chat_live_artifact_root_invalid");
  await assertDirectPackageLayout(root, checked);
  for (const packageRecord of checked.packages) {
    const packageRoot = packageDestinationPath(root, packageRecord.destination);
    await regularDirectory(packageRoot, `chat_live_artifact_package_missing:${packageRecord.name}`);
    const manifestPath = resolve(packageRoot, "package.json");
    await regularFile(manifestPath, `chat_live_artifact_manifest_missing:${packageRecord.name}`);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw new Error(`chat_live_artifact_manifest_invalid:${packageRecord.name}`);
    }
    if (!plainObject(manifest) || manifest.name !== packageRecord.name || manifest.version !== packageRecord.version
      || JSON.stringify(manifest.dependencies ?? {}) !== JSON.stringify(packageRecord.manifest.dependencies ?? {})
      || JSON.stringify(manifest.optionalDependencies ?? {}) !== JSON.stringify(packageRecord.manifest.optionalDependencies ?? {})
      || JSON.stringify(manifest.peerDependencies ?? {}) !== JSON.stringify(packageRecord.manifest.peerDependencies ?? {}))
      throw new Error(`chat_live_artifact_manifest_mismatch:${packageRecord.name}`);
  }
  return Object.freeze({ artifactRoot: root, closure: checked });
}

/**
 * Copies the resolved package trees into an artifact-local node_modules tree.
 * The copy is staged under the artifact root and published only after layout
 * and manifest validation succeeds; source package symlinks are never copied.
 */
export async function materializeChatLiveArtifactDependencyClosure({ hostRoot, artifactRoot, closure } = {}) {
  const resolvedHostRoot = assertAbsoluteRoot(hostRoot, "chat_live_host_root_required");
  const resolvedArtifactRoot = assertAbsoluteRoot(artifactRoot, "chat_live_artifact_root_required");
  if (resolvedHostRoot === resolvedArtifactRoot) throw new Error("chat_live_artifact_root_must_be_distinct");
  await regularDirectory(resolvedHostRoot, "chat_live_host_root_invalid");
  await regularDirectory(resolvedArtifactRoot, "chat_live_artifact_root_invalid");
  const checked = closure === undefined
    ? await resolveChatLiveArtifactDependencyClosure({ hostRoot: resolvedHostRoot })
    : validateClosureShape(closure);
  if (checked.hostRoot !== resolvedHostRoot) throw new Error("chat_live_dependency_closure_host_mismatch");
  for (const packageRecord of checked.packages) assertSourceRootAllowed(resolvedHostRoot, resolve(packageRecord.sourceRoot), packageRecord.name);
  const finalNodeModules = resolve(resolvedArtifactRoot, "node_modules");
  try {
    await lstat(finalNodeModules);
    throw new Error("chat_live_artifact_node_modules_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const stage = await mkdtemp(resolve(resolvedArtifactRoot, STAGING_PREFIX));
  let published = false;
  try {
    const stageNodeModules = resolve(stage, "node_modules");
    await mkdir(stageNodeModules, { recursive: true });
    for (const packageRecord of checked.packages) {
      const sourceRoot = resolve(packageRecord.sourceRoot);
      const destination = packageDestinationPath(stage, packageRecord.destination);
      await regularDirectory(sourceRoot, `chat_live_package_source_invalid:${packageRecord.name}`);
      await copyPackageTree(sourceRoot, destination);
    }
    await assertChatLiveArtifactDependencyClosure({ artifactRoot: stage, closure: checked });
    await rename(stageNodeModules, finalNodeModules);
    published = true;
    await assertChatLiveArtifactDependencyClosure({ artifactRoot: resolvedArtifactRoot, closure: checked });
    return Object.freeze({ artifactRoot: resolvedArtifactRoot, closure: checked, nodeModulesRoot: finalNodeModules });
  } finally {
    if (!published) await rm(finalNodeModules, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
// ---------------------------------------------------------------------------
// Chat Live disposable artifact identity and admission contracts.
//
// These are deliberately separate from the production artifact authority: a
// Chat Live disposable root carries its own strict schemas and identity, never
// claims a production artifact identity, and never publishes a production
// current pointer. The schemas stay minimal: no signatures and no extra
// release gates.
// ---------------------------------------------------------------------------

export const CHAT_LIVE_IDENTITY = "gamebuddy.chat-live.v1";
export const CHAT_LIVE_MARKER_FILE = "chat-live-marker.json";
export const CHAT_LIVE_MANIFEST_FILE = "chat-live-manifest.json";
export const CHAT_LIVE_INVENTORY_FILE = "chat-live-inventory.json";
export const CHAT_LIVE_ADMISSION_FILE = "chat-live-admission.json";
export const CHAT_LIVE_SCHEMA = Object.freeze({
  marker: "gamebuddy-chat-live-marker/v1",
  manifest: "gamebuddy-chat-live-manifest/v1",
  inventory: "gamebuddy-chat-live-inventory/v1",
  admission: "gamebuddy-chat-live-admission/v1",
});

const CHAT_LIVE_SHA256 = /^[a-f0-9]{64}$/;
const CHAT_LIVE_ARTIFACT_ID = /^[a-f0-9]{32}$/;
const CHAT_LIVE_ENTRY_NAME = /^[A-Za-z0-9._-]+\.js$/;
const CHAT_LIVE_PATH_SEGMENT = /^[@A-Za-z0-9._+~-]+$/;

const chatLiveDigest = (value) => createHash("sha256").update(value).digest("hex");
const exactObjectKeys = (value, keys) =>
  plainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

async function atomicWriteChatLiveJson(root, fileName, value) {
  const finalPath = resolve(root, fileName);
  if (!inside(root, finalPath)) throw new Error("chat_live_artifact_file_escapes_root");
  await regularDirectory(root, "chat_live_artifact_root_invalid");
  const temporaryPath = resolve(root, `.${fileName}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await regularFile(temporaryPath, "chat_live_artifact_temporary_invalid");
    await rename(temporaryPath, finalPath);
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
  await regularFile(finalPath, `chat_live_artifact_file_missing:${fileName}`);
  return finalPath;
}

async function readChatLiveJson(root, fileName, validate, missingCode) {
  const path = resolve(root, fileName);
  try {
    await regularFile(path, missingCode);
  } catch (cause) {
    throw new Error(missingCode, { cause });
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(missingCode, { cause });
  }
  return validate(value);
}

// Marker

export function assertChatLiveArtifactMarker(value) {
  if (!exactObjectKeys(value, ["schema", "identity"])
    || value.schema !== CHAT_LIVE_SCHEMA.marker || value.identity !== CHAT_LIVE_IDENTITY)
    throw new Error("chat_live_marker_invalid");
  return Object.freeze({ schema: value.schema, identity: value.identity });
}

export async function writeChatLiveArtifactMarker({ artifactRoot } = {}) {
  const root = assertAbsoluteRoot(artifactRoot, "chat_live_artifact_root_required");
  await regularDirectory(root, "chat_live_artifact_root_invalid");
  const marker = assertChatLiveArtifactMarker({ schema: CHAT_LIVE_SCHEMA.marker, identity: CHAT_LIVE_IDENTITY });
  const path = await atomicWriteChatLiveJson(root, CHAT_LIVE_MARKER_FILE, marker);
  const onDisk = assertChatLiveArtifactMarker(JSON.parse(await readFile(path, "utf8")));
  if (JSON.stringify(onDisk) !== JSON.stringify(marker)) throw new Error("chat_live_marker_write_mismatch");
  return Object.freeze({ artifactRoot: root, marker, path });
}

// Manifest

/**
 * Strictly validates a Chat Live manifest. The manifest binds the exact entry
 * name, the source/build identity (tsconfig name and digest, TypeScript and
 * Node versions), the browser artifact manifest digest, the dependency closure
 * digest, and the disposable root ownership.
 */
export function assertChatLiveArtifactManifest(value) {
  if (!exactObjectKeys(value, ["schema", "identity", "artifactId", "entry", "build", "browserArtifactManifestSha256", "dependencyClosureDigest", "disposableRoot"])
    || value.schema !== CHAT_LIVE_SCHEMA.manifest || value.identity !== CHAT_LIVE_IDENTITY
    || !CHAT_LIVE_ARTIFACT_ID.test(value.artifactId) || !CHAT_LIVE_ENTRY_NAME.test(value.entry)
    || !CHAT_LIVE_SHA256.test(value.browserArtifactManifestSha256) || !CHAT_LIVE_SHA256.test(value.dependencyClosureDigest)
    || typeof value.disposableRoot !== "string" || !isAbsolute(value.disposableRoot))
    throw new Error("chat_live_manifest_invalid");
  const build = value.build;
  if (!exactObjectKeys(build, ["tsconfig", "tsconfigSha256", "typescriptVersion", "node"])
    || typeof build.tsconfig !== "string" || build.tsconfig.length === 0
    || !CHAT_LIVE_SHA256.test(build.tsconfigSha256)
    || typeof build.typescriptVersion !== "string" || build.typescriptVersion.length === 0
    || typeof build.node !== "string" || build.node.length === 0)
    throw new Error("chat_live_manifest_invalid");
  return Object.freeze({
    schema: value.schema,
    identity: value.identity,
    artifactId: value.artifactId,
    entry: value.entry,
    build: Object.freeze({
      tsconfig: build.tsconfig,
      tsconfigSha256: build.tsconfigSha256,
      typescriptVersion: build.typescriptVersion,
      node: build.node,
    }),
    browserArtifactManifestSha256: value.browserArtifactManifestSha256,
    dependencyClosureDigest: value.dependencyClosureDigest,
    disposableRoot: value.disposableRoot,
  });
}

export function createChatLiveArtifactManifest({
  artifactId, entry = "dialogue-web-main.js", build, browserArtifactManifestSha256, dependencyClosureDigest, disposableRoot,
} = {}) {
  return assertChatLiveArtifactManifest({
    schema: CHAT_LIVE_SCHEMA.manifest,
    identity: CHAT_LIVE_IDENTITY,
    artifactId,
    entry,
    build,
    browserArtifactManifestSha256,
    dependencyClosureDigest,
    disposableRoot,
  });
}

export async function writeChatLiveArtifactManifest({ artifactRoot, manifest } = {}) {
  const root = assertAbsoluteRoot(artifactRoot, "chat_live_artifact_root_required");
  await regularDirectory(root, "chat_live_artifact_root_invalid");
  const checked = assertChatLiveArtifactManifest(manifest);
  const path = await atomicWriteChatLiveJson(root, CHAT_LIVE_MANIFEST_FILE, checked);
  const onDisk = assertChatLiveArtifactManifest(JSON.parse(await readFile(path, "utf8")));
  if (JSON.stringify(onDisk) !== JSON.stringify(checked)) throw new Error("chat_live_manifest_write_mismatch");
  return Object.freeze({ artifactRoot: root, manifest: checked, path });
}

/**
 * Canonical dependency-closure digest over the identity-bearing projection of
 * the closure (schema, root packages, package layout/edges). Source roots and
 * host paths are deliberately excluded so the digest identifies the materialized
 * closure, not a checkout location.
 */
export function chatLiveDependencyClosureDigest(closure) {
  const checked = validateClosureShape(closure);
  const projection = {
    schema: checked.schema,
    rootPackages: [...checked.rootPackages],
    packages: checked.packages.map((item) => ({
      name: item.name,
      version: item.version,
      destination: item.destination,
      dependencies: [...item.dependencies],
    })),
  };
  return chatLiveDigest(JSON.stringify(projection));
}

// Inventory

const chatLiveExcludedInventoryPaths = new Set([CHAT_LIVE_INVENTORY_FILE, CHAT_LIVE_ADMISSION_FILE]);

async function chatLiveTreeEntries(root) {
  const entries = [];
  const visited = new Set();
  async function walk(directory) {
    const directoryIdentity =
      process.platform === "win32" || state.ino === 0 ? resolve(directory) : `${state.dev}:${state.ino}`;
    if (visited.has(directoryIdentity)) throw new Error("chat_live_artifact_directory_cycle");
    visited.add(directoryIdentity);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (!inside(root, path)) throw new Error("chat_live_artifact_entry_escapes_root");
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const fileState = await lstat(path);
      if (fileState.isSymbolicLink() || !fileState.isFile()) throw new Error("chat_live_artifact_nonregular_entry");
      const relativePath = slash(relative(root, path));
      if (chatLiveExcludedInventoryPaths.has(relativePath)) continue;
      const contents = await readFile(path);
      entries.push({ path: relativePath, sha256: chatLiveDigest(contents), bytes: contents.length });
    }
  }
  await walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

/**
 * Strictly validates a Chat Live inventory. Every entry is a regular file hash;
 * symlinks and non-regular entries are rejected and can never appear here.
 */
export function assertChatLiveArtifactInventory(value) {
  if (!exactObjectKeys(value, ["schema", "identity", "artifactId", "entries", "digest"])
    || value.schema !== CHAT_LIVE_SCHEMA.inventory || value.identity !== CHAT_LIVE_IDENTITY
    || !CHAT_LIVE_ARTIFACT_ID.test(value.artifactId) || !CHAT_LIVE_SHA256.test(value.digest)
    || !Array.isArray(value.entries) || value.entries.length === 0)
    throw new Error("chat_live_inventory_invalid");
  let previous;
  for (const entry of value.entries) {
    if (!exactObjectKeys(entry, ["path", "sha256", "bytes"])
      || typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.startsWith("/")
      || entry.path.split("/").some((segment) => !CHAT_LIVE_PATH_SEGMENT.test(segment))
      || !CHAT_LIVE_SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
      throw new Error("chat_live_inventory_entry_invalid");
    if (previous !== undefined && entry.path.localeCompare(previous, "en") <= 0)
      throw new Error("chat_live_inventory_not_sorted_or_duplicate");
    previous = entry.path;
  }
  if (chatLiveDigest(JSON.stringify({ entries: value.entries })) !== value.digest)
    throw new Error("chat_live_inventory_digest_mismatch");
  return Object.freeze({
    schema: value.schema,
    identity: value.identity,
    artifactId: value.artifactId,
    entries: Object.freeze(value.entries.map((entry) => Object.freeze({ ...entry }))),
    digest: value.digest,
  });
}

export async function createChatLiveArtifactInventory({ artifactRoot, artifactId } = {}) {
  const root = assertAbsoluteRoot(artifactRoot, "chat_live_artifact_root_required");
  await regularDirectory(root, "chat_live_artifact_root_invalid");
  if (typeof artifactId !== "string" || !CHAT_LIVE_ARTIFACT_ID.test(artifactId))
    throw new Error("chat_live_artifact_id_invalid");
  const entries = await chatLiveTreeEntries(root);
  return assertChatLiveArtifactInventory({
    schema: CHAT_LIVE_SCHEMA.inventory,
    identity: CHAT_LIVE_IDENTITY,
    artifactId,
    entries,
    digest: chatLiveDigest(JSON.stringify({ entries })),
  });
}

export async function writeChatLiveArtifactInventory({ artifactRoot, artifactId } = {}) {
  const root = assertAbsoluteRoot(artifactRoot, "chat_live_artifact_root_required");
  await regularDirectory(root, "chat_live_artifact_root_invalid");
  const inventory = await createChatLiveArtifactInventory({ artifactRoot: root, artifactId });
  const path = await atomicWriteChatLiveJson(root, CHAT_LIVE_INVENTORY_FILE, inventory);
  const onDisk = assertChatLiveArtifactInventory(JSON.parse(await readFile(path, "utf8")));
  if (JSON.stringify(onDisk) !== JSON.stringify(inventory)) throw new Error("chat_live_inventory_write_mismatch");
  return Object.freeze({ artifactRoot: root, inventory, path });
}

// Admission

export function assertChatLiveArtifactAdmission(value) {
  if (!exactObjectKeys(value, ["schema", "identity", "artifactId", "entry", "manifestSha256", "inventoryDigest", "dependencyClosureDigest"])
    || value.schema !== CHAT_LIVE_SCHEMA.admission || value.identity !== CHAT_LIVE_IDENTITY
    || !CHAT_LIVE_ARTIFACT_ID.test(value.artifactId) || !CHAT_LIVE_ENTRY_NAME.test(value.entry)
    || !CHAT_LIVE_SHA256.test(value.manifestSha256) || !CHAT_LIVE_SHA256.test(value.inventoryDigest)
    || !CHAT_LIVE_SHA256.test(value.dependencyClosureDigest))
    throw new Error("chat_live_admission_invalid");
  return Object.freeze({
    schema: value.schema,
    identity: value.identity,
    artifactId: value.artifactId,
    entry: value.entry,
    manifestSha256: value.manifestSha256,
    inventoryDigest: value.inventoryDigest,
    dependencyClosureDigest: value.dependencyClosureDigest,
  });
}

/**
 * Atomically publishes the admission binding the on-disk manifest, inventory
 * and dependency-closure digests. Every binding source is re-read from disk
 * and re-validated after publication; any mismatch fails closed.
 */
export async function writeChatLiveArtifactAdmission({ artifactRoot } = {}) {
  const root = assertAbsoluteRoot(artifactRoot, "chat_live_artifact_root_required");
  await regularDirectory(root, "chat_live_artifact_root_invalid");
  assertChatLiveArtifactMarker(await readChatLiveJson(root, CHAT_LIVE_MARKER_FILE, assertChatLiveArtifactMarker, "chat_live_marker_missing"));
  const manifest = assertChatLiveArtifactManifest(await readChatLiveJson(root, CHAT_LIVE_MANIFEST_FILE, assertChatLiveArtifactManifest, "chat_live_manifest_missing"));
  const inventory = assertChatLiveArtifactInventory(await readChatLiveJson(root, CHAT_LIVE_INVENTORY_FILE, assertChatLiveArtifactInventory, "chat_live_inventory_missing"));
  if (manifest.artifactId !== inventory.artifactId) throw new Error("chat_live_artifact_identity_mismatch");
  const admission = assertChatLiveArtifactAdmission({
    schema: CHAT_LIVE_SCHEMA.admission,
    identity: CHAT_LIVE_IDENTITY,
    artifactId: manifest.artifactId,
    entry: manifest.entry,
    manifestSha256: chatLiveDigest(await readFile(resolve(root, CHAT_LIVE_MANIFEST_FILE))),
    inventoryDigest: inventory.digest,
    dependencyClosureDigest: manifest.dependencyClosureDigest,
  });
  const path = await atomicWriteChatLiveJson(root, CHAT_LIVE_ADMISSION_FILE, admission);
  const manifestOnDisk = assertChatLiveArtifactManifest(JSON.parse(await readFile(resolve(root, CHAT_LIVE_MANIFEST_FILE), "utf8")));
  const inventoryOnDisk = assertChatLiveArtifactInventory(JSON.parse(await readFile(resolve(root, CHAT_LIVE_INVENTORY_FILE), "utf8")));
  const admissionOnDisk = assertChatLiveArtifactAdmission(JSON.parse(await readFile(path, "utf8")));
  if (admissionOnDisk.manifestSha256 !== chatLiveDigest(await readFile(resolve(root, CHAT_LIVE_MANIFEST_FILE))))
    throw new Error("chat_live_admission_manifest_binding_mismatch");
  if (admissionOnDisk.inventoryDigest !== inventoryOnDisk.digest)
    throw new Error("chat_live_admission_inventory_binding_mismatch");
  if (admissionOnDisk.dependencyClosureDigest !== manifestOnDisk.dependencyClosureDigest)
    throw new Error("chat_live_admission_closure_binding_mismatch");
  if (admissionOnDisk.artifactId !== manifestOnDisk.artifactId || admissionOnDisk.artifactId !== inventoryOnDisk.artifactId)
    throw new Error("chat_live_admission_identity_mismatch");
  return Object.freeze({ artifactRoot: root, admission, path });
}

/**
 * Full fail-closed verification of a published Chat Live disposable root: the
 * marker, manifest, inventory and admission must all be strictly valid and
 * cross-bound, and the whole tree must re-hash exactly to the declared
 * inventory (symlinks and non-regular entries never pass the walk).
 */
export async function assertChatLiveArtifactRoot({ artifactRoot } = {}) {
  const root = assertAbsoluteRoot(artifactRoot, "chat_live_artifact_root_required");
  await regularDirectory(root, "chat_live_artifact_root_invalid");
  if (await realpath(root) !== root) throw new Error("chat_live_artifact_root_invalid");
  const marker = assertChatLiveArtifactMarker(await readChatLiveJson(root, CHAT_LIVE_MARKER_FILE, assertChatLiveArtifactMarker, "chat_live_marker_missing"));
  const manifest = assertChatLiveArtifactManifest(await readChatLiveJson(root, CHAT_LIVE_MANIFEST_FILE, assertChatLiveArtifactManifest, "chat_live_manifest_missing"));
  const inventory = assertChatLiveArtifactInventory(await readChatLiveJson(root, CHAT_LIVE_INVENTORY_FILE, assertChatLiveArtifactInventory, "chat_live_inventory_missing"));
  const admission = assertChatLiveArtifactAdmission(await readChatLiveJson(root, CHAT_LIVE_ADMISSION_FILE, assertChatLiveArtifactAdmission, "chat_live_admission_missing"));
  if (admission.artifactId !== manifest.artifactId || admission.artifactId !== inventory.artifactId)
    throw new Error("chat_live_artifact_identity_mismatch");
  if (admission.entry !== manifest.entry) throw new Error("chat_live_manifest_entry_mismatch");
  if (admission.manifestSha256 !== chatLiveDigest(await readFile(resolve(root, CHAT_LIVE_MANIFEST_FILE))))
    throw new Error("chat_live_admission_manifest_binding_mismatch");
  if (admission.inventoryDigest !== inventory.digest)
    throw new Error("chat_live_admission_inventory_binding_mismatch");
  if (admission.dependencyClosureDigest !== manifest.dependencyClosureDigest)
    throw new Error("chat_live_admission_closure_binding_mismatch");
  const actual = await chatLiveTreeEntries(root);
  if (JSON.stringify(actual) !== JSON.stringify(inventory.entries))
    throw new Error("chat_live_inventory_mismatch_or_orphan");
  return Object.freeze({ artifactRoot: root, marker, manifest, inventory, admission });
}