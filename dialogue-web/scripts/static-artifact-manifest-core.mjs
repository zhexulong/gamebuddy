import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIME_BY_EXTENSION = new Map([
  [".js", "text/javascript"], [".css", "text/css"], [".svg", "image/svg+xml"],
  [".png", "image/png"], [".webp", "image/webp"], [".woff2", "font/woff2"],
]);
const HASHED_ASSET_NAME = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|webp|woff2)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

const fixedPackageName = String.fromCharCode(64, 103, 97, 109, 101, 98, 117, 100, 100, 121, 47, 100, 105, 97, 108, 111, 103, 117, 101, 45, 119, 101, 98);
const relativePath = (root, path) => path.slice(root.length + 1).split(sep).join(posix.sep);
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");
const unavailable = () => new TypeError("windows_reparse_inspection_unavailable");

function assertPolicyIdentity(identity) {
  if (
    identity === null || typeof identity !== "object" || Array.isArray(identity)
    || Object.keys(identity).length !== 3
    || typeof identity.manifestFile !== "string" || !MANIFEST_FILE_NAME.test(identity.manifestFile)
    || typeof identity.browserContract !== "string" || identity.browserContract.length === 0
    || typeof identity.profileId !== "string" || identity.profileId.length === 0
  ) throw new TypeError("Static artifact manifest policy identity is invalid");
  return Object.freeze({
    manifestFile: identity.manifestFile,
    browserContract: identity.browserContract,
    profileId: identity.profileId,
  });
}

async function fixedEmittedPolicyAdapter(sourceModuleUrl) {
  if (typeof sourceModuleUrl !== "string" || !sourceModuleUrl.startsWith("file:")) throw unavailable();
  // Vite may bundle the domain entry module into a package-local temporary
  // directory. Anchor to that caller's fixed module URL (never cwd, PATH, env,
  // or CLI), find its package ancestor, then select one exact emitted file.
  let cursor = dirname(fileURLToPath(sourceModuleUrl));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = resolve(cursor, "package.json");
    try {
      const packageState = await lstat(candidate);
      const packageName = packageState.isFile() && !packageState.isSymbolicLink()
        ? JSON.parse(await readFile(candidate, "utf8"))?.name
        : undefined;
      if (packageName === fixedPackageName) {
        for (const dirName of [".dist-production-emitted", "dist", "dist-test"]) {
          const emittedRoot = resolve(cursor, "..", "host", dirName);
          const adapter = resolve(emittedRoot, "windows-reparse-inspector", "index.js");
          try {
            const state = await lstat(adapter);
            if (!state.isFile() || state.isSymbolicLink()) continue;
            const [physicalRoot, physicalAdapter] = await Promise.all([realpath(emittedRoot), realpath(adapter)]);
            if (!physicalAdapter.startsWith(`${physicalRoot}${sep}`)) continue;
            return adapter;
          } catch {
            continue;
          }
        }
        throw unavailable();
      }
    } catch (error) {
      if (error?.message === "windows_reparse_inspection_unavailable") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw unavailable();
}

function rejectLinkOrNonDirectory(path) {
  return new TypeError(`Production artifact contains a symlink or reparse point: ${path}`);
}

async function assertRegularDirectory(path, policy) {
  await policy.inspect(path);
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isDirectory()) throw rejectLinkOrNonDirectory(path);
  await policy.inspect(path);
  return state;
}

async function validatedArtifactRoot(artifactRoot, policy) {
  if (typeof artifactRoot !== "string" || !isAbsolute(artifactRoot) || artifactRoot !== resolve(artifactRoot)) {
    throw new TypeError("Production artifact root must be a normalized absolute directory");
  }
  await assertRegularDirectory(artifactRoot, policy);
  await policy.inspect(artifactRoot);
  if (await realpath(artifactRoot) !== artifactRoot) throw rejectLinkOrNonDirectory(artifactRoot);
  return artifactRoot;
}

async function assertRegularFile(path, policy) {
  await policy.inspect(path);
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) throw new TypeError(`Production artifact contains a non-regular entry: ${path}`);
  return state;
}

async function readInspectedFile(path, encoding, policy) {
  await policy.inspect(path);
  return await readFile(path, encoding);
}

async function createWindowsReparsePolicy(sourceModuleUrl, platform = process.platform, loader = async () => await import(pathToFileURL(await fixedEmittedPolicyAdapter(sourceModuleUrl)).href)) {
  if (platform !== "win32") return Object.freeze({ inspect: async () => {} });
  try {
    const adapter = await loader();
    const boundary = adapter?.BUILD_ARTIFACT_REPARSE_INSPECTION;
    if (typeof boundary?.create !== "function" || typeof boundary?.assertNoReparse !== "function") throw unavailable();
    // The adapter mints one opaque capability for this complete operation. It
    // is never reconstructed from a path, environment, or CLI value.
    const capability = await boundary.create();
    return Object.freeze({ inspect: async (path) => await boundary.assertNoReparse(capability, path) });
  } catch {
    throw unavailable();
  }
}

function assertAssetPath(path) {
  if (!/^assets\/[A-Za-z0-9_.-]+$/.test(path) || path.includes("\\") || path.includes("..") || path.includes("?") || path.includes("#") || !HASHED_ASSET_NAME.test(basename(path))) throw new TypeError(`Production artifact has an invalid asset path: ${path}`);
}
function assetMime(path) {
  const mime = MIME_BY_EXTENSION.get(path.slice(path.lastIndexOf(".")));
  if (!mime) throw new TypeError(`Production artifact has an unsupported asset type: ${path}`);
  return mime;
}

async function listFiles(root, directory, visitedDirectories, policy) {
  const directoryState = await assertRegularDirectory(directory, policy);
  const directoryIdentity = directoryState.ino !== 0 ? `${directoryState.dev}:${directoryState.ino}` : resolve(directory);
  if (visitedDirectories.has(directoryIdentity)) throw new TypeError(`Production artifact contains a directory cycle: ${relativePath(root, directory)}`);
  visitedDirectories.add(directoryIdentity);

  await policy.inspect(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = resolve(directory, entry.name);
    await policy.inspect(entryPath);
    const state = await lstat(entryPath);
    if (state.isSymbolicLink()) throw rejectLinkOrNonDirectory(relativePath(root, entryPath));
    if (state.isDirectory()) files.push(...await listFiles(root, entryPath, visitedDirectories, policy));
    else if (state.isFile()) files.push(relativePath(root, entryPath));
    else throw new TypeError(`Production artifact contains a non-regular entry: ${relativePath(root, entryPath)}`);
  }
  return files;
}

function createManifestPolicy(identityInput, sourceModuleUrl) {
  const identity = assertPolicyIdentity(identityInput);
  if (typeof sourceModuleUrl !== "string" || !sourceModuleUrl.startsWith("file:")) throw unavailable();
  let policyAdapterLoader;

  async function createBuildArtifactInspectionPolicy() {
    return await createWindowsReparsePolicy(sourceModuleUrl, process.platform, policyAdapterLoader);
  }

  async function createProductionArtifactManifestWithPolicy(artifactRoot, policy) {
    const root = await validatedArtifactRoot(artifactRoot, policy);
    const files = await listFiles(root, root, new Set(), policy);
    const assets = [];
    const indexPath = resolve(root, "index.html");
    await assertRegularFile(indexPath, policy);
    await readInspectedFile(indexPath, undefined, policy);

    for (const path of files) {
      if (path === "index.html") continue;
      if (!path.startsWith("assets/")) throw new TypeError(`Production artifact has an unexpected file: ${path}`);
      if (path.endsWith(".map")) throw new TypeError(`Production artifact must not contain source maps: ${path}`);
      assertAssetPath(path);
      const assetPath = resolve(root, path);
      await assertRegularFile(assetPath, policy);
      const contents = await readInspectedFile(assetPath, undefined, policy);
      if (contents.length <= 0 || !Number.isSafeInteger(contents.length)) throw new TypeError(`Production artifact asset has invalid byte length: ${path}`);
      assets.push({ path, sha256: sha256(contents), bytes: contents.length, mime: assetMime(path) });
    }
    if (assets.length === 0) throw new TypeError("Production artifact has no hashed assets");
    const manifest = { schemaVersion: 1, browserContract: identity.browserContract, profileId: identity.profileId, entryHtml: "index.html", assets };
    await writeFile(resolve(root, identity.manifestFile), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await verifyProductionArtifactManifestWithPolicy(root, policy);
    return manifest;
  }

  async function createProductionArtifactManifest(artifactRoot, policy) {
    return await createProductionArtifactManifestWithPolicy(artifactRoot, policy ?? await createBuildArtifactInspectionPolicy());
  }

  async function verifyProductionArtifactManifestWithPolicy(artifactRoot, policy) {
    const root = await validatedArtifactRoot(artifactRoot, policy);
    const manifestPath = resolve(root, identity.manifestFile);
    await assertRegularFile(manifestPath, policy);
    const manifest = JSON.parse(await readInspectedFile(manifestPath, "utf8", policy));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || Object.keys(manifest).length !== 5 || manifest.schemaVersion !== 1 || manifest.browserContract !== identity.browserContract || manifest.profileId !== identity.profileId || manifest.entryHtml !== "index.html" || !Array.isArray(manifest.assets)) throw new TypeError("Production artifact manifest has an invalid identity or shape");

    const indexPath = resolve(root, manifest.entryHtml);
    await assertRegularFile(indexPath, policy);
    await readInspectedFile(indexPath, undefined, policy);
    const actualFiles = new Set(await listFiles(root, root, new Set(), policy));
    const expectedFiles = new Set(["index.html", identity.manifestFile]);
    const paths = new Set();
    for (const asset of manifest.assets) {
      if (!asset || typeof asset !== "object" || Array.isArray(asset) || Object.keys(asset).length !== 4 || typeof asset.path !== "string" || typeof asset.sha256 !== "string" || typeof asset.bytes !== "number" || typeof asset.mime !== "string") throw new TypeError("Production artifact manifest has an invalid asset entry");
      assertAssetPath(asset.path);
      if (paths.has(asset.path) || !SHA256.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.mime !== assetMime(asset.path)) throw new TypeError(`Production artifact manifest has an invalid asset declaration: ${asset.path}`);
      paths.add(asset.path); expectedFiles.add(asset.path);
      const assetPath = resolve(root, asset.path);
      if (!assetPath.startsWith(`${root}${sep}`)) throw new TypeError(`Production artifact asset escapes root: ${asset.path}`);
      await assertRegularFile(assetPath, policy);
      const contents = await readInspectedFile(assetPath, undefined, policy);
      if (contents.length !== asset.bytes || sha256(contents) !== asset.sha256) throw new TypeError(`Production artifact asset does not match its manifest: ${asset.path}`);
    }
    if (paths.size === 0) throw new TypeError("Production artifact manifest has no assets");
    for (const path of actualFiles) {
      if (path.endsWith(".map")) throw new TypeError(`Production artifact must not contain source maps: ${path}`);
      if (!expectedFiles.has(path)) throw new TypeError(`Production artifact has an unexpected file: ${path}`);
    }
    for (const path of expectedFiles) if (!actualFiles.has(path)) throw new TypeError(`Production artifact is missing required file: ${path}`);
    return manifest;
  }

  async function verifyProductionArtifactManifest(artifactRoot, policy) {
    return await verifyProductionArtifactManifestWithPolicy(artifactRoot, policy ?? await createBuildArtifactInspectionPolicy());
  }

  return Object.freeze({
    createBuildArtifactInspectionPolicy,
    createProductionArtifactManifest,
    verifyProductionArtifactManifest,
    __testOnly: Object.freeze({
      createWindowsReparsePolicyForTest: async (loader) => await createWindowsReparsePolicy(sourceModuleUrl, "win32", loader),
      setPolicyAdapterLoaderForTest(loader) {
        const previous = policyAdapterLoader;
        policyAdapterLoader = loader;
        return () => { policyAdapterLoader = previous; };
      },
    }),
  });
}

/** Internal policy binder. Domain modules bind their constants before exposing operations. */
export function createStaticArtifactManifestPolicy(identity, sourceModuleUrl) {
  return createManifestPolicy(identity, sourceModuleUrl);
}
