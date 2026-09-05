import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  ARTIFACT_MANIFEST_FILE,
  BROWSER_CONTRACT,
  PROFILE_ID,
  createProductionArtifactManifest,
  verifyProductionArtifactManifest,
  __testOnly,
} from "../scripts/browser-artifact-manifest.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPath = resolve(packageRoot, "package.json");
const lockfilePath = resolve(packageRoot, "..", "pnpm-lock.yaml");
const privateStagingParent = resolve(packageRoot, ".build-staging");
const viteCliPath = resolve(packageRoot, "node_modules", "vite", "bin", "vite.js");
const viteConfigPath = resolve(packageRoot, "vite.config.ts");

const readPackageManifest = async () => JSON.parse(await readFile(packageManifestPath, "utf8"));
const readWorkspaceLockfile = async () => readFile(lockfilePath, "utf8");
const opaqueStagingLeaf = () => randomBytes(16).toString("hex");
const nodeDefensePolicy = Object.freeze({ inspect: async () => {} });

function runViteBuild(outputDirectory, cwd = packageRoot) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [viteCliPath, "build", "--config", viteConfigPath, "--outDir", outputDirectory], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, output }));
  });
}

async function expectPrivateBuildRejection(outputDirectory, expression) {
  const result = await runViteBuild(outputDirectory);
  assert.notEqual(result.code, 0, result.output);
  // Validation of an invalid caller-controlled path precedes capability
  // acquisition, so a missing Windows inspector cannot mask this error.
  assert.match(result.output, expression);
}

test("Dialogue Web runtime boundary keeps the Vite toolchain build-only", async () => {
  const manifest = await readPackageManifest();
  const lockfile = await readWorkspaceLockfile();
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).sort();
  const developmentDependencies = Object.keys(manifest.devDependencies ?? {}).sort();

  assert.deepEqual(runtimeDependencies, ["lucide-react", "react", "react-dom"]);
  assert.deepEqual(
    developmentDependencies,
    ["@playwright/test", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "tsx", "typescript", "vite"].sort(),
  );

  // Vite and its PostCSS/nanoid transitive closure are used only by these
  // build/dev entrypoints; the Host serves the generated dist/ files.
  assert.match(manifest.scripts.build, /\bvite\s+build\b/);
  assert.match(manifest.scripts.dev, /\bvite\b/);
  for (const packageName of ["@vitejs/plugin-react", "vite", "postcss", "nanoid"]) {
    assert.equal(runtimeDependencies.includes(packageName), false, `${packageName} must not be runtime-installed`);
  }

  const importer = lockfile.match(/  dialogue-web:\n([\s\S]*?)(?=\n  host:)/)?.[1];
  assert.ok(importer, "pnpm lockfile must contain the Dialogue Web importer");
  const dependencySection = importer.match(/    dependencies:\n([\s\S]*?)(?=    devDependencies:)/)?.[1];
  const devDependencySection = importer.match(/    devDependencies:\n([\s\S]*)/)?.[1];
  assert.ok(dependencySection, "pnpm importer must contain runtime dependencies");
  assert.ok(devDependencySection, "pnpm importer must contain development dependencies");
  assert.match(dependencySection, /      react:/);
  assert.doesNotMatch(dependencySection, /      (?:'@vitejs\/plugin-react'|vite):/);
  assert.match(devDependencySection, /      '@vitejs\/plugin-react':/);
  assert.match(devDependencySection, /      vite:/);
});

test("Windows Vite build succeeds with the exact emitted adapter and fixed helper pair", async () => {
  const privateOutput = resolve(privateStagingParent, opaqueStagingLeaf());
  try {
    await mkdir(privateStagingParent, { recursive: true });
    await mkdir(privateOutput);
    const result = await runViteBuild(privateOutput, resolve(packageRoot, ".."));
    assert.equal(result.code, 0, result.output);
    await verifyProductionArtifactManifest(privateOutput);
  } finally {
    await rm(privateOutput, { recursive: true, force: true });
  }
});

test("private Vite output rejects roots outside its browser-owned staging parent", async () => {
  const externalParent = await mkdtemp(join(tmpdir(), "gamebuddy-browser-build-invalid-"));
  const externalLeaf = join(externalParent, opaqueStagingLeaf());
  const invalidLeaf = resolve(privateStagingParent, "not-an-opaque-leaf");
  const missingLeaf = resolve(privateStagingParent, opaqueStagingLeaf());
  const nonEmptyLeaf = resolve(privateStagingParent, opaqueStagingLeaf());
  const linkedLeaf = resolve(privateStagingParent, opaqueStagingLeaf());
  try {
    await mkdir(privateStagingParent, { recursive: true });
    await mkdir(externalLeaf);
    await mkdir(nonEmptyLeaf);
    await writeFile(join(nonEmptyLeaf, "existing"), "existing", "utf8");
    await expectPrivateBuildRejection("relative-output", /normalized absolute directory/);
    await expectPrivateBuildRejection(resolve(packageRoot, "dist"), /opaque direct child/);
    await expectPrivateBuildRejection(resolve(packageRoot, ".."), /opaque direct child/);
    await expectPrivateBuildRejection(externalLeaf, /opaque direct child/);
    await expectPrivateBuildRejection(invalidLeaf, /opaque direct child/);
    await expectPrivateBuildRejection(missingLeaf, /must already exist/);
    await expectPrivateBuildRejection(nonEmptyLeaf, /must be empty/);
    try {
      await symlink(externalLeaf, linkedLeaf, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "ENOTSUP") throw error;
      return;
    }
    await expectPrivateBuildRejection(linkedLeaf, /must already exist as a non-link directory/);
  } finally {
    await rm(externalParent, { recursive: true, force: true });
    await rm(nonEmptyLeaf, { recursive: true, force: true });
    await rm(linkedLeaf, { recursive: true, force: true });
  }
});

test("production artifact manifest APIs reject cwd-relative roots", async () => {
  await assert.rejects(createProductionArtifactManifest("relative-artifact-root", nodeDefensePolicy), /normalized absolute directory/);
  await assert.rejects(verifyProductionArtifactManifest("relative-artifact-root", nodeDefensePolicy), /normalized absolute directory/);
});

test("production browser artifact manifest has a fixed identity and an exact hashed asset boundary", async () => {
  const artifactRoot = resolve(packageRoot, "dist");
  const manifest = await verifyProductionArtifactManifest(artifactRoot, nodeDefensePolicy);

  assert.equal(ARTIFACT_MANIFEST_FILE, "tavern-browser-artifact-manifest.json");
  assert.deepEqual(Object.keys(manifest), ["schemaVersion", "browserContract", "profileId", "entryHtml", "assets"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.browserContract, BROWSER_CONTRACT);
  assert.equal(manifest.profileId, PROFILE_ID);
  assert.equal(manifest.entryHtml, "index.html");
  assert.ok(manifest.assets.length > 0);
  for (const asset of manifest.assets) {
    assert.match(asset.path, /^assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|webp|woff2)$/);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
  }
});

async function createArtifactFixture(name) {
  const artifactRoot = resolve(packageRoot, "test-results", name);
  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(join(artifactRoot, "assets"), { recursive: true });
  await writeFile(join(artifactRoot, "index.html"), "<!doctype html>", "utf8");
  await writeFile(join(artifactRoot, "assets", "index-abcdefgh.js"), "console.log(1)", "utf8");
  await createProductionArtifactManifest(artifactRoot, nodeDefensePolicy);
  return artifactRoot;
}

test("Windows inspection policy mints one opaque capability and inspects every manifest traversal and read location", async () => {
  const artifactRoot = await createArtifactFixture("artifact-boundary-inspection-coverage");
  const calls = [];
  let constructions = 0;
  const capability = Object.freeze({});
  try {
    const policy = await __testOnly.createWindowsReparsePolicyForTest(async () => ({
      async createBuildWindowsReparseInspector() { constructions += 1; return capability; },
      async assertNoWindowsReparse(receivedCapability, path) {
        assert.strictEqual(receivedCapability, capability, "every inspection must receive the minted opaque capability");
        calls.push(path);
      },
    }));
    assert.equal(constructions, 1, "the adapter must mint exactly one capability per artifact operation");
    await verifyProductionArtifactManifest(artifactRoot, policy);
    const required = [
      artifactRoot,
      join(artifactRoot, ARTIFACT_MANIFEST_FILE),
      join(artifactRoot, "index.html"),
      join(artifactRoot, "assets"),
      join(artifactRoot, "assets", "index-abcdefgh.js"),
    ];
    for (const path of required) assert.ok(calls.includes(path), `missing inspection for ${path}`);
    assert.equal(constructions, 1, "traversal must not remint a capability");
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("Windows inspection policy fails closed when the shared adapter is unavailable or invalid", async () => {
  for (const adapter of [async () => { throw new Error("missing"); }, async () => ({})]) {
    await assert.rejects(__testOnly.createWindowsReparsePolicyForTest(adapter), /windows_reparse_inspection_unavailable/);
  }
  const artifactRoot = await createArtifactFixture("artifact-boundary-inspection-unavailable");
  try {
    const policy = await __testOnly.createWindowsReparsePolicyForTest(async () => ({
      createBuildWindowsReparseInspector: async () => Object.freeze({}),
      assertNoWindowsReparse: async () => { throw new Error("invalid helper protocol"); },
    }));
    await assert.rejects(verifyProductionArtifactManifest(artifactRoot, policy), /invalid helper protocol/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("artifact verifier rejects source maps and unlisted files", async () => {
  const artifactRoot = await createArtifactFixture("artifact-boundary-invalid");
  try {
    await writeFile(join(artifactRoot, "assets", "index-abcdefgh.js.map"), "{}", "utf8");
    await assert.rejects(verifyProductionArtifactManifest(artifactRoot, nodeDefensePolicy), /source maps/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("artifact verifier rejects preexisting symbolic-link files before manifest acceptance", async () => {
  const artifactRoot = await createArtifactFixture("artifact-boundary-symlink-file");
  const assetPath = join(artifactRoot, "assets", "index-abcdefgh.js");
  const linkedTarget = join(artifactRoot, "linked-target.js");
  try {
    await writeFile(linkedTarget, "console.log(1)", "utf8");
    try {
      await rm(assetPath);
      await symlink(linkedTarget, assetPath, "file");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "ENOTSUP") return;
      throw error;
    }
    await assert.rejects(verifyProductionArtifactManifest(artifactRoot), /symlink or reparse point/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("artifact verifier rejects a Windows junction or directory symbolic link before traversal", async (t) => {
  const artifactRoot = await createArtifactFixture("artifact-boundary-reparse-directory");
  const assetsPath = join(artifactRoot, "assets");
  const targetPath = join(artifactRoot, "linked-assets");
  try {
    await mkdir(targetPath);
    await writeFile(join(targetPath, "index-abcdefgh.js"), "console.log(1)", "utf8");
    await rm(assetsPath, { recursive: true });
    try {
      await symlink(targetPath, assetsPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "ENOTSUP") {
        t.skip(`directory reparse creation is unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(verifyProductionArtifactManifest(artifactRoot, nodeDefensePolicy), /symlink or reparse point/);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
