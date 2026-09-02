import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { assertProtectedWindowsReleaseCiEnvironment, withSyntheticVerifiedReleaseBundledRuntimeForTest } from "./node-runtime-release-acquisition.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bootstrapPairCaptures = new AsyncLocalStorage();
const fsPromises = createRequire(import.meta.url)("node:fs/promises");
const nativeMkdtemp = fsPromises.mkdtemp;
fsPromises.mkdtemp = async (...args) => {
  const root = await nativeMkdtemp(...args);
  const capture = bootstrapPairCaptures.getStore();
  if (capture !== undefined && typeof args[0] === "string" && resolve(args[0]) === capture.prefix)
    capture.pairRoots.push(resolve(root));
  return root;
};
syncBuiltinESMExports();
test.after(() => {
  fsPromises.mkdtemp = nativeMkdtemp;
  syncBuiltinESMExports();
});
function captureFreshBootstrapPair(pairParent, operation) {
  const capture = { prefix: resolve(pairParent, "pair-"), pairRoots: [] };
  return Object.freeze({
    operation: bootstrapPairCaptures.run(capture, operation),
    pairRoot() {
      assert.equal(capture.pairRoots.length, 1, "this scratch operation must create exactly one bootstrap pair");
      return capture.pairRoots[0];
    },
  });
}
const protectedReleaseEnvironment = {
  GITHUB_ACTIONS: "true", RUNNER_OS: "Windows", RUNNER_ARCH: "X64",
  GITHUB_WORKFLOW: "GameBuddy Protected Windows Release", GAMEBUDDY_RELEASE_ENVIRONMENT: "gamebuddy-production-release",
  GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3", GITHUB_RUN_ID: "123456", GITHUB_RUN_ATTEMPT: "1",
};

test("release workflow supplies only bounded identity facts and keeps acquisition out of ordinary CI", async () => {
  const workflow = await readFile(fileURLToPath(new URL("../../.github/workflows/release-windows.yml", import.meta.url)), "utf8");
  const ordinaryCi = await readFile(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");
  assert.match(workflow, /^name: GameBuddy Protected Windows Release$/m);
  assert.match(workflow, /environment: gamebuddy-production-release/);
  assert.match(workflow, /GAMEBUDDY_RELEASE_ENVIRONMENT: gamebuddy-production-release/);
  assert.match(workflow, /GAMEBUDDY_RELEASE_REF: \$\{\{ github\.ref \}\}/);
  assert.match(workflow, /pnpm --dir host build:release/);
  assert.doesNotMatch(workflow, /(?:runtime-url|runtime-path|archiveSha256|sourceUrl|sign(?:tool|ing)|upload-artifact)/i);
  assert.doesNotMatch(ordinaryCi, /build:release|node-runtime-release-acquisition|gamebuddy-production-release/i);
  assert.doesNotMatch(ordinaryCi, /^\s*- run: pnpm build\s*$/m);
  assert.match(ordinaryCi, /pnpm --filter @gamebuddy\/dialogue-web build/);
});

test("release acquisition requires the exact protected Windows release CI identity before fetch", () => {
  assert.doesNotThrow(() => assertProtectedWindowsReleaseCiEnvironment({ env: protectedReleaseEnvironment, platform: "win32" }));
  for (const [label, value] of [
    ["local", { ...protectedReleaseEnvironment, GITHUB_ACTIONS: undefined }],
    ["non-Windows", protectedReleaseEnvironment],
    ["runner OS", { ...protectedReleaseEnvironment, RUNNER_OS: "Linux" }],
    ["runner architecture", { ...protectedReleaseEnvironment, RUNNER_ARCH: "ARM64" }],
    ["workflow", { ...protectedReleaseEnvironment, GITHUB_WORKFLOW: "CI" }],
    ["environment", { ...protectedReleaseEnvironment, GAMEBUDDY_RELEASE_ENVIRONMENT: "unprotected" }],
    ["event", { ...protectedReleaseEnvironment, GITHUB_EVENT_NAME: "pull_request" }],
    ["branch ref", { ...protectedReleaseEnvironment, GITHUB_REF: "refs/heads/main" }],
    ["invalid tag", { ...protectedReleaseEnvironment, GITHUB_REF: "refs/tags/vnext" }],
    ["missing run identity", { ...protectedReleaseEnvironment, GITHUB_RUN_ID: undefined }],
    ["invalid run attempt", { ...protectedReleaseEnvironment, GITHUB_RUN_ATTEMPT: "0" }],
  ]) assert.throws(() => assertProtectedWindowsReleaseCiEnvironment({ env: value, platform: label === "non-Windows" ? "linux" : "win32" }), /protected_windows_release_ci_required/, label);
});

test("direct imports cannot supply release runtime state to the fixed publisher", async () => {
  const acquisition = await import("./node-runtime-release-acquisition.mjs");
  assert.equal(Object.hasOwn(acquisition, "consumeAcquiredReleaseRuntimeForFixedReleaseBuild"), false);
  assert.equal(Object.hasOwn(acquisition, "consumeFixedReleaseRuntimeForInternalPublisher"), false);
  assert.equal(Object.hasOwn(acquisition, "withFixedReleaseRuntimeForInternalBuild"), false);
  assert.equal(Object.hasOwn(acquisition, "createWindowsReleaseBootstrapScratch"), false);
  assert.equal(Object.hasOwn(acquisition, "withAcquiredReleaseRuntime"), false);
  assert.throws(() => acquisition.takeComposedFixedReleaseRuntimeForPublisher({ extractedRoot: "forged" }), /verified_bundled_runtime_input_required/);
  const source = await readFile(fileURLToPath(new URL("./node-runtime-release-acquisition.mjs", import.meta.url)), "utf8");
  assert.match(source, /createWindowsReleaseBootstrapScratch/);
  assert.doesNotMatch(source, /withFixedReleaseRuntimeForInternalBuild|release-runtime-handoff/);
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+\w+\s*\(\s*(?:runtime|source|provider|extractedRoot|callback)/);
  const publisherSource = await readFile(fileURLToPath(new URL("./production-artifact.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(publisherSource, /export\s+(?:async\s+)?function\s+publishFixedReleaseArtifactFromVerifiedRuntime\s*\([^)]*\w/);
  await assert.rejects(import("./release-runtime-handoff.internal.mjs"), /ERR_MODULE_NOT_FOUND/);
  assert.doesNotMatch(source, /runtime_acquisition_windows_reparse_inspector_unavailable/);
});
const crc32 = (value) => { let crc = ~0; for (const byte of value) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (~crc) >>> 0; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const { name, content = Buffer.from("x"), method = 0, encrypted = false, attrs = 0, declaredSize } of entries) {
    const file = Buffer.from(content); const nameBytes = Buffer.from(name); const crc = crc32(file); const flags = encrypted ? 1 : 0; const size = declaredSize ?? file.length;
    const local = Buffer.concat([Buffer.from("504b0304", "hex"), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes, file]);
    locals.push(local);
    central.push(Buffer.concat([Buffer.from("504b0102", "hex"), u16(0x0314), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(attrs), u32(offset), nameBytes])); offset += local.length;
  }
  const body = Buffer.concat([...locals, ...central]);
  return Buffer.concat([body, Buffer.from("504b0506", "hex"), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(Buffer.concat(central).length), u32(Buffer.concat(locals).length), u16(0)]);
}
function descriptor(bytes, node = Buffer.from("node")) { return { sourceUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip", archiveSha256: hash(bytes), archiveRoot: "node-v24.20.0-win-x64", nodeSha256: hash(node) }; }
async function withRoot(run) { const root = await mkdtemp(join(tmpdir(), "runtime-acquisition-test-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function acquire(root, bytes, d = descriptor(bytes), options = {}) {
  return withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor: d, zipBytes: bytes, temporaryRoot: root, ...options }, async (runtime) => runtime);
}

for (const name of ["../outside", "/rooted", "C:/drive", "\\\\unc", "node-v24.20.0-win-x64\\backslash", "node-v24.20.0-win-x64/CON", "node-v24.20.0-win-x64/a:ads"]) {
  test(`rejects unsafe ZIP name ${JSON.stringify(name)}`, async () => withRoot(async (root) => {
    const bytes = zip([{ name }, { name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node") }]);
    await assert.rejects(acquire(root, bytes), /runtime_zip_(?:entry_forbidden|root_invalid)/);
  }));
}
test("rejects duplicate paths, links, encryption, unsupported compression metadata, and missing node", async () => withRoot(async (root) => {
  for (const entries of [
    [{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node") }, { name: "node-v24.20.0-win-x64/NODE.EXE" }],
    [{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node"), attrs: 0o120777 << 16 }],
    [{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node"), encrypted: true }],
    [{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node"), method: 12 }],
    [{ name: "node-v24.20.0-win-x64/LICENSE" }],
  ]) { const bytes = zip(entries); await assert.rejects(acquire(root, bytes), /runtime_zip_(?:duplicate_destination|entry_forbidden|node_missing)/); }
}));
test("enforces entry-count and per-entry/expanded byte limits before extraction", async () => withRoot(async (root) => {
  const rootName = "node-v24.20.0-win-x64";
  const count = zip([{ name: `${rootName}/node.exe`, content: Buffer.from("node") }, ...Array.from({ length: 2_000 }, (_, index) => ({ name: `${rootName}/f${index}` }))]);
  await assert.rejects(acquire(root, count), /runtime_zip_entry_count_limit/);
  const perEntry = zip([{ name: `${rootName}/node.exe`, content: Buffer.from("node"), declaredSize: 32 * 1024 * 1024 + 1 }]);
  await assert.rejects(acquire(root, perEntry), /runtime_zip_entry_size_limit/);
  const expanded = zip([{ name: `${rootName}/node.exe`, content: Buffer.from("node"), declaredSize: 32 * 1024 * 1024 }, ...Array.from({ length: 8 }, (_, index) => ({ name: `${rootName}/f${index}`, declaredSize: 32 * 1024 * 1024 }))]);
  await assert.rejects(acquire(root, expanded), /runtime_zip_expanded_size_limit/);
}));
test("synthetic acquisition exposes only callback-scoped test state", async () => withRoot(async () => {
  const node = Buffer.from("node"); const bytes = zip([{ name: "node-v24.20.0-win-x64/node.exe", content: node }, { name: "node-v24.20.0-win-x64/LICENSE", content: Buffer.from("license") }]); const d = descriptor(bytes, node);
  let captured;
  await withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor: d, zipBytes: bytes }, async (runtime) => {
    captured = runtime;
    assert.deepEqual(runtime.files.map((entry) => entry.sourcePath), ["LICENSE", "node.exe"]);
  });
  assert.equal(typeof captured.extractedRoot, "string");
}));
test("production boundary modules expose no generic publisher/provider test APIs or ambient runtime fallback", async () => {
  for (const file of ["production-artifact.mjs", "node-runtime-release-acquisition.mjs", "build-production-artifact.mjs"]) {
    const source = await readFile(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /publishProductionArtifactFromAcquiredReleaseRuntime|buildReleaseProductionArtifactWithAcquiredProvider|withAcquiredReleaseRuntimeForProduction|withSyntheticReleaseRuntimePublisherForTest/);
  }
  const acquisitionSource = await readFile(fileURLToPath(new URL("./node-runtime-release-acquisition.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(acquisitionSource, /process\.execPath|test-support|fixture/);
  const production = await import("./production-artifact.mjs");
  assert.equal(Object.hasOwn(production, "publishProductionArtifactFromAcquiredReleaseRuntime"), false);
  assert.equal(Object.hasOwn(await import("./node-runtime-release-acquisition.mjs"), "consumeAcquiredReleaseRuntimeForFixedReleaseBuild"), false);
  assert.equal(Object.hasOwn(await import("./node-runtime-release-acquisition.mjs"), "consumeFixedReleaseRuntimeForInternalPublisher"), false);
  assert.equal(Object.hasOwn(await import("./node-runtime-release-acquisition.mjs"), "withFixedReleaseRuntimeForInternalBuild"), false);
});
test("non-Windows synthetic acquisition retains isolated test scratch behavior", { skip: process.platform === "win32" }, async () => {
  const bytes = zip([{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node") }]);
  await assert.doesNotReject(withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor: descriptor(bytes), zipBytes: bytes }, async () => undefined));
});
test("acquired runtime lifecycle disposes once after admission or publisher callback settlement", async () => {
  const bytes = zip([{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node") }]);
  for (const phase of ["success", "after-acquisition", "publisher-callback"]) {
    let root; let scratchDisposals = 0; let cleanupCalls = 0; let callbackCalls = 0;
    const scratchRootForTest = async () => {
      root = await mkdtemp(join(tmpdir(), "runtime-acquisition-lifecycle-"));
      return Object.freeze({
        root,
        async dispose() { scratchDisposals++; await rm(root, { recursive: true, force: false }); },
      });
    };
    const operation = withSyntheticVerifiedReleaseBundledRuntimeForTest({
      descriptor: descriptor(bytes),
      zipBytes: bytes,
      scratchRootForTest,
      cleanupForTest: async (path) => { cleanupCalls++; assert.equal(path, root); await rm(path, { recursive: true, force: true }); },
      afterAcquisitionForTest: async ({ extractedRoot }) => {
        assert.equal(extractedRoot, join(root, "extracted"));
        if (phase === "after-acquisition") throw new Error("admission_failed");
      },
    }, async () => {
      callbackCalls++;
      if (phase === "publisher-callback") throw new Error("publisher_failed");
      return "published";
    });
    if (phase === "success") assert.equal(await operation, "published");
    else await assert.rejects(operation, phase === "after-acquisition" ? /admission_failed/ : /publisher_failed/);
    assert.equal(callbackCalls, phase === "after-acquisition" ? 0 : 1, phase);
    assert.equal(scratchDisposals, 1, phase);
    assert.equal(cleanupCalls, 1, phase);
    await assert.rejects(lstat(root), { code: "ENOENT" }, phase);
  }
});
test("cleanup failure terminally rejects after an admitted callback failure without retrying disposal", async () => {
  const bytes = zip([{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node") }]);
  let cleanupCalls = 0;
  await assert.rejects(withSyntheticVerifiedReleaseBundledRuntimeForTest({
    descriptor: descriptor(bytes),
    zipBytes: bytes,
    cleanupForTest: async () => { cleanupCalls++; throw new Error("cleanup"); },
    afterAcquisitionForTest: async () => { throw new Error("admission_failed"); },
  }, async () => assert.fail("publisher callback must not run after admission failure")), /runtime_acquisition_cleanup_failed/);
  assert.equal(cleanupCalls, 1);
});
test("Windows release bootstrap scratch admits a fresh exact helper pair and removes both roots on close", { skip: process.platform !== "win32" }, async (t) => {
  const [{ createWindowsReleaseBootstrapScratch }, { projectRoot, helperFileName, manifestFileName }] = await Promise.all([
    import("./windows-release-bootstrap-scratch.internal.mjs"),
    import("./build-windows-reparse-inspector.mjs"),
  ]);
  const pairParent = join(projectRoot, ".release-bootstrap-inspector");
  let scratch;
  let pairRoot;
  try {
    const creation = captureFreshBootstrapPair(pairParent, () => createWindowsReleaseBootstrapScratch({ env: protectedReleaseEnvironment }));
    scratch = await creation.operation;
    pairRoot = creation.pairRoot();
  } catch (error) {
    const blocked = new Set([
      "windows_reparse_dotnet_missing",
      "windows_reparse_dotnet_sdk_lock_invalid",
      "windows_reparse_dotnet_sdk_drift",
      "windows_reparse_dotnet_spawn_failed",
      "windows_reparse_dotnet_timeout",
      "windows_reparse_dotnet_output_overflow",
      "windows_reparse_dotnet_failed",
      "windows_reparse_helper_missing",
      "windows_reparse_helper_pair_invalid",
      "runtime_acquisition_windows_reparse_inspection_unavailable",
    ]);
    if (error instanceof Error && blocked.has(error.message)) {
      t.skip("BLOCKED: exact release bootstrap helper cannot build or admit on this runner");
      return;
    }
    throw error;
  }
  try {
    assert.equal(resolve(pairRoot, ".."), resolve(pairParent));
    assert.match(basename(pairRoot), /^pair-/);
    assert.equal((await lstat(scratch.root)).isDirectory(), true);
    await scratch.close();
    await assert.rejects(lstat(scratch.root), { code: "ENOENT" });
  } finally {
    if (scratch !== undefined) await rm(scratch.root, { recursive: true, force: true }).catch(() => {});
    if (pairRoot !== undefined) await rm(pairRoot, { recursive: true, force: true }).catch(() => {});
  }
});
test("Windows release scratch admission removes its fresh exact helper pair and scratch root after publisher callback failure", { skip: process.platform !== "win32" }, async (t) => {
  const [{ createWindowsReleaseBootstrapScratch }, { projectRoot, helperFileName, manifestFileName }] = await Promise.all([
    import("./windows-release-bootstrap-scratch.internal.mjs"),
    import("./build-windows-reparse-inspector.mjs"),
  ]);
  const pairParent = join(projectRoot, ".release-bootstrap-inspector");
  const bytes = zip([{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node") }]);
  let scratchRoot;
  let pairRoot;
  let failure;
  const acquisition = captureFreshBootstrapPair(pairParent, () => withSyntheticVerifiedReleaseBundledRuntimeForTest({
      descriptor: descriptor(bytes),
      zipBytes: bytes,
      scratchRootForTest: async () => {
        const scratch = await createWindowsReleaseBootstrapScratch();
        return Object.freeze({ root: scratch.root, dispose: scratch.close });
      },
      afterAcquisitionForTest: async ({ extractedRoot }) => {
        scratchRoot = join(extractedRoot, "..");
        pairRoot = acquisition.pairRoot();
        assert.equal(resolve(pairRoot, ".."), resolve(pairParent));
        assert.match(basename(pairRoot), /^pair-/);
        assert.equal((await lstat(scratchRoot)).isDirectory(), true);
        throw new Error("post_admission_publisher_failed");
      },
    }, async () => assert.fail("publisher callback must not run after post-admission failure")));
  try {
    await acquisition.operation;
  } catch (error) {
    failure = error;
  }
  if (scratchRoot === undefined) {
    const blocked = new Set([
      "windows_reparse_dotnet_missing",
      "windows_reparse_dotnet_sdk_lock_invalid",
      "windows_reparse_dotnet_sdk_drift",
      "windows_reparse_dotnet_spawn_failed",
      "windows_reparse_dotnet_timeout",
      "windows_reparse_dotnet_output_overflow",
      "windows_reparse_dotnet_failed",
      "windows_reparse_helper_missing",
      "windows_reparse_helper_pair_invalid",
      "runtime_acquisition_windows_reparse_inspection_unavailable",
    ]);
    if (failure instanceof Error && blocked.has(failure.message)) {
      t.skip("BLOCKED: exact release bootstrap helper cannot build or admit on this runner");
      return;
    }
    throw failure;
  }
  assert.match(failure?.message ?? "", /post_admission_publisher_failed/);
  await assert.rejects(lstat(scratchRoot), { code: "ENOENT" });
  // The helper pair is private to the native-inspector callback and is removed
  // before the acquired root is exposed to the publisher callback.
});
test("fixed archive digest mismatch rejects before extraction", async () => withRoot(async (root) => {
  const bytes = zip([{ name: "node-v24.20.0-win-x64/node.exe", content: Buffer.from("node") }]);
  await assert.rejects(acquire(root, bytes, { ...descriptor(bytes), archiveSha256: "0".repeat(64) }), /pinned_runtime_digest_mismatch/);
}));
