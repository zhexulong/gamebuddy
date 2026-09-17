import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import {
  CHAT_LIVE_ADMISSION_FILE,
  CHAT_LIVE_IDENTITY,
  CHAT_LIVE_MANIFEST_FILE,
  CHAT_LIVE_MARKER_FILE,
  CHAT_LIVE_SCHEMA,
  assertChatLiveArtifactAdmission,
  assertChatLiveArtifactInventory,
  assertChatLiveArtifactManifest,
  assertChatLiveArtifactMarker,
  assertChatLiveArtifactRoot,
  chatLiveDependencyClosureDigest,
  createChatLiveArtifactInventory,
  createChatLiveArtifactManifest,
  resolveChatLiveArtifactDependencyClosure,
  writeChatLiveArtifactAdmission,
  writeChatLiveArtifactInventory,
  writeChatLiveArtifactManifest,
  writeChatLiveArtifactMarker,
} from "../host/scripts/chat-live-artifact-support.mjs";

const disposableRoot = resolve("D:\\GameBuddy-chat-live-tmp");
const ARTIFACT_ID = "0123456789abcdef0123456789abcdef";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

async function withDisposableDirectory(prefix, run) {
  await mkdir(disposableRoot, { recursive: true });
  const root = await mkdtemp(join(disposableRoot, prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function smallClosure({ sourceRoot = "/checkout/node_modules/fixture-package", hostRoot = "/checkout/host", version = "1.0.0" } = {}) {
  return {
    schema: "gamebuddy-chat-live-dependency-closure/v1",
    hostRoot,
    rootPackages: ["fixture-package"],
    packages: [{
      name: "fixture-package",
      version,
      sourceRoot,
      destination: "node_modules/fixture-package",
      manifest: { name: "fixture-package", version },
      dependencies: [],
    }],
    omittedOptionalDependencies: [],
  };
}

function makeManifest(artifactRoot, overrides = {}) {
  return createChatLiveArtifactManifest({
    artifactId: ARTIFACT_ID,
    build: {
      tsconfig: "tsconfig.chat-live.json",
      tsconfigSha256: SHA_A,
      typescriptVersion: "5.8.3",
      node: "v22.14.0",
    },
    browserArtifactManifestSha256: SHA_B,
    dependencyClosureDigest: chatLiveDependencyClosureDigest(smallClosure()),
    disposableRoot: artifactRoot,
    ...overrides,
  });
}

async function createValidArtifact(run) {
  return withDisposableDirectory("chat-live-valid-", async (artifactRoot) => {
    const entryPath = join(artifactRoot, "dialogue-web-main.js");
    await writeFile(entryPath, "export const chatLiveFixture = true;\n");
    await writeChatLiveArtifactMarker({ artifactRoot });
    const manifest = makeManifest(artifactRoot);
    await writeChatLiveArtifactManifest({ artifactRoot, manifest });
    const inventoryResult = await writeChatLiveArtifactInventory({ artifactRoot, artifactId: ARTIFACT_ID });
    const admissionResult = await writeChatLiveArtifactAdmission({ artifactRoot });
    return run({
      artifactRoot,
      entryPath,
      manifest,
      inventory: inventoryResult.inventory,
      admission: admissionResult.admission,
    });
  });
}

test("marker and manifest use exact schemas and the Chat Live identity", async () => {
  await withDisposableDirectory("chat-live-schema-", async (artifactRoot) => {
    const markerResult = await writeChatLiveArtifactMarker({ artifactRoot });
    assert.deepEqual(Object.keys(markerResult.marker), ["schema", "identity"]);
    assert.deepEqual(markerResult.marker, {
      schema: CHAT_LIVE_SCHEMA.marker,
      identity: CHAT_LIVE_IDENTITY,
    });
    assert.deepEqual(
      assertChatLiveArtifactMarker(JSON.parse(await readFile(join(artifactRoot, CHAT_LIVE_MARKER_FILE), "utf8"))),
      markerResult.marker,
    );
    assert.throws(
      () => assertChatLiveArtifactMarker({ ...markerResult.marker, extra: true }),
      /chat_live_marker_invalid/,
    );
    assert.throws(
      () => assertChatLiveArtifactMarker({ ...markerResult.marker, identity: "gamebuddy.production.v1" }),
      /chat_live_marker_invalid/,
    );

    const manifest = makeManifest(artifactRoot);
    const manifestResult = await writeChatLiveArtifactManifest({ artifactRoot, manifest });
    assert.deepEqual(Object.keys(manifestResult.manifest), [
      "schema",
      "identity",
      "artifactId",
      "entry",
      "build",
      "browserArtifactManifestSha256",
      "dependencyClosureDigest",
      "disposableRoot",
    ]);
    assert.deepEqual(Object.keys(manifestResult.manifest.build), [
      "tsconfig",
      "tsconfigSha256",
      "typescriptVersion",
      "node",
    ]);
    assert.equal(manifestResult.manifest.schema, CHAT_LIVE_SCHEMA.manifest);
    assert.equal(manifestResult.manifest.identity, CHAT_LIVE_IDENTITY);
    assert.deepEqual(
      assertChatLiveArtifactManifest(JSON.parse(await readFile(join(artifactRoot, CHAT_LIVE_MANIFEST_FILE), "utf8"))),
      manifestResult.manifest,
    );
    assert.throws(
      () => assertChatLiveArtifactManifest({ ...manifestResult.manifest, extra: true }),
      /chat_live_manifest_invalid/,
    );
    assert.throws(
      () => assertChatLiveArtifactManifest({ ...manifestResult.manifest, schema: "gamebuddy-production-manifest/v1" }),
      /chat_live_manifest_invalid/,
    );
    assert.throws(
      () => assertChatLiveArtifactManifest({ ...manifestResult.manifest, identity: "gamebuddy.production.v1" }),
      /chat_live_manifest_invalid/,
    );
  });
});

test("dependency closure digest binds package identity and layout, not checkout paths", () => {
  const closure = smallClosure();
  const digest = chatLiveDependencyClosureDigest(closure);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(
    chatLiveDependencyClosureDigest(smallClosure({ sourceRoot: "/another/checkout/node_modules/fixture-package", hostRoot: "/another/checkout/host" })),
    digest,
  );
  assert.notEqual(chatLiveDependencyClosureDigest(smallClosure({ version: "1.0.1" })), digest);
  assert.notEqual(
    chatLiveDependencyClosureDigest({
      ...closure,
      packages: [
        { ...closure.packages[0], dependencies: ["node_modules/fixture-package/node_modules/dependency"] },
        {
          name: "dependency",
          version: "1.0.0",
          sourceRoot: "/checkout/node_modules/dependency",
          destination: "node_modules/fixture-package/node_modules/dependency",
          manifest: { name: "dependency", version: "1.0.0" },
          dependencies: [],
        },
      ],
    }),
    digest,
  );
});

test("inventory hashes every regular file and rejects symlinks", async (t) => {
  await withDisposableDirectory("chat-live-inventory-", async (artifactRoot) => {
    const nestedRoot = join(artifactRoot, "nested");
    await mkdir(nestedRoot);
    const firstPath = join(artifactRoot, "alpha.txt");
    const secondPath = join(nestedRoot, "beta.js");
    const first = Buffer.from("alpha\n");
    const second = Buffer.from("export const beta = 2;\n");
    await writeFile(firstPath, first);
    await writeFile(secondPath, second);

    const inventory = await createChatLiveArtifactInventory({ artifactRoot, artifactId: ARTIFACT_ID });
    assert.deepEqual(inventory.entries, [
      { path: "alpha.txt", sha256: sha256(first), bytes: first.length },
      { path: "nested/beta.js", sha256: sha256(second), bytes: second.length },
    ]);
    assert.equal(inventory.identity, CHAT_LIVE_IDENTITY);
    assert.equal(inventory.schema, CHAT_LIVE_SCHEMA.inventory);
    assert.deepEqual(assertChatLiveArtifactInventory(inventory), inventory);

    const linkPath = join(artifactRoot, "linked.txt");
    try {
      await symlink(firstPath, linkPath, "file");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
        t.skip(`symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      createChatLiveArtifactInventory({ artifactRoot, artifactId: ARTIFACT_ID }),
      /chat_live_artifact_nonregular_entry/,
    );
  });
});

test("admission atomically binds marker, manifest, inventory, and closure digests", async () => {
  await createValidArtifact(async ({ artifactRoot, manifest, inventory, admission }) => {
    assert.deepEqual(Object.keys(admission), [
      "schema",
      "identity",
      "artifactId",
      "entry",
      "manifestSha256",
      "inventoryDigest",
      "dependencyClosureDigest",
    ]);
    assert.equal(admission.schema, CHAT_LIVE_SCHEMA.admission);
    assert.equal(admission.identity, CHAT_LIVE_IDENTITY);
    assert.equal(admission.artifactId, manifest.artifactId);
    assert.equal(admission.entry, manifest.entry);
    assert.equal(admission.manifestSha256, sha256(await readFile(join(artifactRoot, CHAT_LIVE_MANIFEST_FILE))));
    assert.equal(admission.inventoryDigest, inventory.digest);
    assert.equal(admission.dependencyClosureDigest, manifest.dependencyClosureDigest);
    assert.deepEqual(assertChatLiveArtifactAdmission(admission), admission);
    assert.deepEqual(await assertChatLiveArtifactRoot({ artifactRoot }), {
      artifactRoot,
      marker: { schema: CHAT_LIVE_SCHEMA.marker, identity: CHAT_LIVE_IDENTITY },
      manifest,
      inventory,
      admission,
    });

    const admissionBytes = await readFile(join(artifactRoot, CHAT_LIVE_ADMISSION_FILE));
    const mismatchedManifest = makeManifest(artifactRoot, { artifactId: "fedcba9876543210fedcba9876543210" });
    await writeFile(join(artifactRoot, CHAT_LIVE_MANIFEST_FILE), `${JSON.stringify(mismatchedManifest, null, 2)}\n`);
    await assert.rejects(
      writeChatLiveArtifactAdmission({ artifactRoot }),
      /chat_live_artifact_identity_mismatch/,
    );
    assert.deepEqual(await readFile(join(artifactRoot, CHAT_LIVE_ADMISSION_FILE)), admissionBytes);
  });
});

test("root verification detects payload, manifest, and admission tampering", async () => {
  await createValidArtifact(async ({ artifactRoot, entryPath, manifest }) => {
    const originalEntry = await readFile(entryPath);
    const manifestPath = join(artifactRoot, CHAT_LIVE_MANIFEST_FILE);
    const originalManifest = await readFile(manifestPath);
    const admissionPath = join(artifactRoot, CHAT_LIVE_ADMISSION_FILE);
    const originalAdmission = JSON.parse(await readFile(admissionPath, "utf8"));

    await writeFile(entryPath, "export const chatLiveFixture = false;\n");
    await assert.rejects(
      assertChatLiveArtifactRoot({ artifactRoot }),
      /chat_live_inventory_mismatch_or_orphan/,
    );
    await writeFile(entryPath, originalEntry);

    const tamperedManifest = { ...manifest, browserArtifactManifestSha256: SHA_C };
    await writeFile(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    await assert.rejects(
      assertChatLiveArtifactRoot({ artifactRoot }),
      /chat_live_admission_manifest_binding_mismatch/,
    );
    await writeFile(manifestPath, originalManifest);

    await writeFile(admissionPath, `${JSON.stringify({ ...originalAdmission, inventoryDigest: SHA_C }, null, 2)}\n`);
    await assert.rejects(
      assertChatLiveArtifactRoot({ artifactRoot }),
      /chat_live_admission_inventory_binding_mismatch/,
    );
  });
});

test("does not use production current.json or a user Pi installation as fallback", async () => {
  await withDisposableDirectory("chat-live-current-fallback-", async (artifactRoot) => {
    await writeFile(join(artifactRoot, "current.json"), JSON.stringify({ generation: "user-controlled" }));
    await assert.rejects(
      assertChatLiveArtifactRoot({ artifactRoot }),
      /chat_live_marker_missing/,
    );
  });

  await withDisposableDirectory("chat-live-user-fallback-", async (fixtureRoot) => {
    const fakeUserPackage = join(fixtureRoot, "user-pi", "node_modules", "@earendil-works", "pi-coding-agent");
    await mkdir(fakeUserPackage, { recursive: true });
    await writeFile(join(fakeUserPackage, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.84.4",
      type: "module",
    }));

    const previousNodePath = process.env.NODE_PATH;
    const previousUserProfile = process.env.USERPROFILE;
    const previousHome = process.env.HOME;
    process.env.NODE_PATH = join(fixtureRoot, "user-pi", "node_modules");
    process.env.USERPROFILE = fixtureRoot;
    process.env.HOME = fixtureRoot;
    try {
      const emptyHostRoot = join(fixtureRoot, "empty-host");
      await mkdir(join(emptyHostRoot, "node_modules"), { recursive: true });
      await writeFile(join(emptyHostRoot, "package.json"), JSON.stringify({
        name: "empty-chat-live-host",
        dependencies: { "@earendil-works/pi-coding-agent": "0.84.4" },
      }));
      await assert.rejects(
        resolveChatLiveArtifactDependencyClosure({
          hostRoot: emptyHostRoot,
          rootPackages: ["@earendil-works/pi-coding-agent"],
          maxPackages: 8,
          maxDepth: 4,
        }),
        /(?:chat_live_root_package_missing:@earendil-works\/pi-coding-agent|ENOENT: no such file or directory)/,
      );
    } finally {
      if (previousNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = previousNodePath;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});
