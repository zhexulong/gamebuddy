import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { createWorldInfoManagementRepository } from "./world-info-management.js";

const request = Object.freeze({
  publicTitle: "Pelican Town",
  summary: "A small valley town.",
  entries: Object.freeze([
    Object.freeze({ scope: "setting" as const, publicTitle: "Town square", summary: "The center of town." }),
    Object.freeze({
      scope: "companion" as const,
      publicTitle: "Shared history",
      summary: "The companion knows the player enjoys fishing.",
    }),
  ]),
});

async function temporaryRepository() {
  const root = await canonicalTestRoot("world-info-management-");
  return { root, repository: createWorldInfoManagementRepository(root) };
}

test("managed World Info creates, lists, details, updates, and preserves immutable public revision history", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    const created = await repository.create(request);
    assert.deepEqual(created, { revision: 1, ...request });
    assert.deepEqual(await repository.list(), [created]);
    assert.deepEqual(await repository.detail("Pelican Town"), created);
    assert.equal(await repository.detail("Missing"), null);

    const updated = await repository.update("Pelican Town", {
      expectedRevision: 1,
      publicTitle: "Pelican Valley",
      summary: "A small valley town with a busy harbor.",
      entries: [
        {
          scope: "companion",
          publicTitle: "Shared history",
          summary: "The companion knows the player enjoys fishing.",
        },
      ],
    });
    assert.deepEqual(updated, {
      revision: 2,
      publicTitle: "Pelican Valley",
      summary: "A small valley town with a busy harbor.",
      entries: [
        {
          scope: "companion",
          publicTitle: "Shared history",
          summary: "The companion knows the player enjoys fishing.",
        },
      ],
    });
    assert.deepEqual(await repository.history("Pelican Valley"), [created, updated]);
    assert.deepEqual(await repository.list(), [updated]);
    assert.equal(await repository.detail("Pelican Town"), null);
    await assert.rejects(
      () =>
        repository.update("Pelican Valley", {
          expectedRevision: 1,
          publicTitle: updated.publicTitle,
          summary: updated.summary,
          entries: updated.entries,
        }),
      /world_info_revision_conflict/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed World Info rejects unknown, executable, scoped, and control-bearing input", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    for (const invalid of [
      { ...request, alwaysOnPremise: "not allowed" },
      { ...request, entries: [{ scope: "world", publicTitle: "No", summary: "No" }] },
      { ...request, entries: [{ scope: "setting", publicTitle: "No", summary: "<script>alert(1)</script>" }] },
      { ...request, entries: [{ scope: "setting", publicTitle: "No", summary: "line\nbreak" }] },
      { ...request, entries: [{ scope: "setting", publicTitle: "No", summary: "Safe", regex: ".*" }] },
    ])
      assert.throws(() => repository.validateCreateRequest(invalid), /invalid_world_info_request/);

    await repository.create(request);
    await assert.rejects(() => repository.create(request), /world_info_already_exists/);
    await assert.rejects(
      () => repository.update("Pelican Town", { ...request, expectedRevision: 0 }),
      /invalid_world_info_request/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed World Info refuses revision junctions and leaves an external sentinel untouched", async (t) => {
  const { root, repository } = await temporaryRepository();
  const outside = await canonicalTestRoot("world-info-management-external-");
  const sentinel = join(outside, "sentinel.json");
  try {
    await writeFile(sentinel, "sentinel", "utf8");
    const management = join(root, "world-info-management");
    await mkdir(management, { recursive: true });
    try {
      await symlink(outside, join(management, "revisions"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(() => repository.create(request), /unsafe_path_boundary/);
    assert.equal(await readFile(sentinel, "utf8"), "sentinel");
    assert.deepEqual(await readdir(outside), ["sentinel.json"]);
    assert.equal(await readFile(join(management, "revisions", "sentinel.json"), "utf8"), "sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("managed World Info cleans up only its temporary file after a successful atomic write", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    await repository.create(request);
    const management = join(root, "world-info-management");
    const files = await readdir(management);
    assert.deepEqual(
      files.filter((file) => file.endsWith(".tmp")),
      [],
      "successful writes must not leave temporary artifacts behind",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed World Info persists opaque UUID handles without exposing them", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    await repository.create(request);
    await repository.create({ ...request, publicTitle: "Cindersap Forest" });
    const catalog = JSON.parse(await readFile(join(root, "world-info-management", "catalog.json"), "utf8")) as {
      artifacts: readonly { handle: string }[];
    };
    assert.equal(catalog.artifacts.length, 2);
    assert.equal(new Set(catalog.artifacts.map((artifact) => artifact.handle)).size, 2);
    for (const artifact of catalog.artifacts)
      assert.match(artifact.handle, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed World Info verifies revision snapshots on readback and never projects opaque storage handles", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    const created = await repository.create(request);
    assert.equal("worldInfoHandle" in created, false);
    assert.equal(JSON.stringify(created).includes("canonicalHash"), false);

    const catalog = JSON.parse(await readFile(join(root, "world-info-management", "catalog.json"), "utf8")) as {
      artifacts: readonly { handle: string }[];
    };
    const revisionPath = join(root, "world-info-management", "revisions", catalog.artifacts[0]!.handle, "1.json");
    const tampered = JSON.parse(await readFile(revisionPath, "utf8")) as { artifact: { summary: string } };
    tampered.artifact.summary = "Tampered";
    await writeFile(revisionPath, JSON.stringify(tampered), "utf8");
    await assert.rejects(() => repository.detail("Pelican Town"), /invalid_world_info_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
