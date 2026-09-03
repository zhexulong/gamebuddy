import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHostDeploymentManifest } from "./deployment-manifest.js";

const valid = (runtimeRoot: string) => ({
  schemaVersion: 2,
  topology: "independent_chat_and_game_surfaces",
  runtimeRoot,
  principal: { continuityId: "continuity-01", companionId: "companion-01", playerId: "player-01" },
  bootstrapOperationId: "bootstrap-01",
  authorityGeneration: 1,
});

async function fixture(
  value: string | Record<string, unknown>,
): Promise<{ root: string; path: string; runtimeRoot: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-deployment-manifest-"));
  const runtimeRoot = join(root, "runtime");
  const path = join(root, "manifest.json");
  await mkdir(runtimeRoot);
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return { root, path, runtimeRoot, dispose: () => rm(root, { recursive: true, force: true }) };
}

async function rejects(
  value: string | Record<string, unknown>,
  expected = /invalid_host_deployment_manifest/,
): Promise<void> {
  const subject = await fixture(value);
  try {
    await assert.rejects(loadHostDeploymentManifest(subject.path), expected);
  } finally {
    await subject.dispose();
  }
}

test("loads a strict v2 manifest as a deeply frozen plain DTO", async () => {
  const subject = await fixture({});
  try {
    await writeFile(subject.path, JSON.stringify(valid(subject.runtimeRoot)), "utf8");
    const manifest = await loadHostDeploymentManifest(subject.path);
    assert.deepEqual(manifest, valid(subject.runtimeRoot));
    assert.equal(Object.getPrototypeOf(manifest), Object.prototype);
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.principal));
    assert.throws(() => {
      (manifest.principal as { playerId: string }).playerId = "mutated";
    }, TypeError);
  } finally {
    await subject.dispose();
  }
});

test("two loads of one manifest return stable deep-equivalent immutable values", async () => {
  const subject = await fixture({});
  try {
    await writeFile(subject.path, JSON.stringify(valid(subject.runtimeRoot)), "utf8");
    const first = await loadHostDeploymentManifest(subject.path);
    const second = await loadHostDeploymentManifest(subject.path);
    assert.deepEqual(first, second);
    assert.notEqual(first, second);
  } finally {
    await subject.dispose();
  }
});

test("rejects duplicate including escaped-equivalent keys, unknown fields, arrays, and deep input", async () => {
  const subject = await fixture({});
  try {
    const runtimeRoot = JSON.stringify(subject.runtimeRoot);
    await assert.rejects(loadHostDeploymentManifest(subject.path), /invalid_host_deployment_manifest/);
    await writeFile(
      subject.path,
      `{"schemaVersion":2,"schema\\u0056ersion":2,"topology":"independent_chat_and_game_surfaces","runtimeRoot":${runtimeRoot},"principal":{"continuityId":"continuity-01","companionId":"companion-01","playerId":"player-01"},"bootstrapOperationId":"bootstrap-01","authorityGeneration":1}`,
      "utf8",
    );
    await assert.rejects(loadHostDeploymentManifest(subject.path), /invalid_host_deployment_manifest/);
  } finally {
    await subject.dispose();
  }
  await rejects({ ...valid("/not-used"), extra: true });
  await rejects({
    ...valid("/not-used"),
    principal: { continuityId: "continuity-01", companionId: "companion-01", playerId: "player-01", extra: true },
  });
  await rejects([valid("/not-used")] as unknown as Record<string, unknown>);
  await rejects(`${"[".repeat(65)}0${"]".repeat(65)}`);
  await rejects(`{"padding":"${"x".repeat(65_536)}"}`);
});

test("rejects an oversized sparse manifest through the bounded file-handle reader", async () => {
  const subject = await fixture({});
  try {
    await writeFile(subject.path, JSON.stringify(valid(subject.runtimeRoot)), "utf8");
    await truncate(subject.path, 65_537);
    await assert.rejects(loadHostDeploymentManifest(subject.path), /invalid_host_deployment_manifest/);
  } finally {
    await subject.dispose();
  }
});

test("rejects standalone and truncated invalid UTF-8 bytes in otherwise plausible manifests", async () => {
  const subject = await fixture({});
  try {
    const replacementCharacter = Buffer.from("\uFFFD", "utf8");
    const decodedRuntimeRoot = join(subject.root, "\uFFFDruntime");
    await mkdir(decodedRuntimeRoot);
    for (const invalidBytes of [Buffer.from([0xff]), Buffer.from([0xe2, 0x82])]) {
      const plausibleManifest = Buffer.from(JSON.stringify(valid(decodedRuntimeRoot)), "utf8");
      const replacementOffset = plausibleManifest.indexOf(replacementCharacter);
      assert.notEqual(replacementOffset, -1);
      await writeFile(
        subject.path,
        Buffer.concat([
          plausibleManifest.subarray(0, replacementOffset),
          invalidBytes,
          plausibleManifest.subarray(replacementOffset + replacementCharacter.length),
        ]),
      );
      await assert.rejects(loadHostDeploymentManifest(subject.path), { message: "invalid_host_deployment_manifest" });
    }
  } finally {
    await subject.dispose();
  }
});

test("rejects malformed version, topology, principals, stable operation, and generation", async () => {
  const subject = await fixture({});
  try {
    const cases: Record<string, unknown>[] = [
      { ...valid(subject.runtimeRoot), schemaVersion: 1 },
      { ...valid(subject.runtimeRoot), schemaVersion: 3 },
      { ...valid(subject.runtimeRoot), topology: "dialogue_initializes_game_opens" },
      { ...valid(subject.runtimeRoot), topology: "game_initializes_dialogue_opens" },
      {
        ...valid(subject.runtimeRoot),
        principal: { continuityId: "bad/id", companionId: "companion-01", playerId: "player-01" },
      },
      { ...valid(subject.runtimeRoot), bootstrapOperationId: "" },
      { ...valid(subject.runtimeRoot), authorityGeneration: 0 },
      { ...valid(subject.runtimeRoot), authorityGeneration: 1.5 },
      { ...valid(subject.runtimeRoot), authorityGeneration: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const value of cases) {
      await writeFile(subject.path, JSON.stringify(value), "utf8");
      await assert.rejects(loadHostDeploymentManifest(subject.path), /invalid_host_deployment_manifest/);
    }
  } finally {
    await subject.dispose();
  }
});

test("rejects relative, NUL, missing, and non-directory runtime roots", async () => {
  const subject = await fixture({});
  try {
    const file = join(subject.root, "not-a-directory");
    await writeFile(file, "x", "utf8");
    for (const runtimeRoot of [
      "relative-runtime",
      `${subject.runtimeRoot}\u0000bad`,
      join(subject.root, "missing"),
      file,
    ]) {
      await writeFile(subject.path, JSON.stringify(valid(runtimeRoot)), "utf8");
      await assert.rejects(loadHostDeploymentManifest(subject.path), /invalid_host_deployment_manifest/);
    }
  } finally {
    await subject.dispose();
  }
});

test("rejects missing, non-file, NUL, and non-string manifest paths", async () => {
  const subject = await fixture({});
  try {
    await writeFile(subject.path, JSON.stringify(valid(subject.runtimeRoot)), "utf8");
    await assert.rejects(
      loadHostDeploymentManifest(join(subject.root, "missing.json")),
      /invalid_host_deployment_manifest/,
    );
    await assert.rejects(loadHostDeploymentManifest(subject.runtimeRoot), /invalid_host_deployment_manifest/);
    await assert.rejects(loadHostDeploymentManifest(`${subject.path}\u0000bad`), /invalid_host_deployment_manifest/);
    await assert.rejects(loadHostDeploymentManifest(42 as unknown as string), /invalid_host_deployment_manifest/);
  } finally {
    await subject.dispose();
  }
});
