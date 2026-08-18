import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { TavernArtifactStore } from "../artifact-store.js";
import { validateTavernArtifact } from "../types.js";
import { createGreetingManagementService } from "./greeting-management.js";

test("GreetingSet labels are backward-compatible and strictly inert text", () => {
  assert.deepEqual(
    validateTavernArtifact({
      schemaVersion: 1,
      revision: 1,
      greetingSetId: "legacy",
      variants: [{ variantId: "first", text: "Hello." }],
    }),
    { schemaVersion: 1, revision: 1, greetingSetId: "legacy", variants: [{ variantId: "first", text: "Hello." }] },
  );
  assert.deepEqual(
    validateTavernArtifact({
      schemaVersion: 1,
      revision: 1,
      greetingSetId: "labeled",
      label: "Welcome",
      variants: [{ variantId: "first", label: "First message", text: "Hello." }],
    }),
    {
      schemaVersion: 1,
      revision: 1,
      greetingSetId: "labeled",
      label: "Welcome",
      variants: [{ variantId: "first", label: "First message", text: "Hello." }],
    },
  );
  assert.throws(
    () =>
      validateTavernArtifact({
        schemaVersion: 1,
        revision: 1,
        greetingSetId: "unsafe",
        label: "Welcome\n",
        variants: [{ variantId: "first", text: "Hello." }],
      }),
    /invalid_tavern_artifact/,
  );
  assert.throws(
    () =>
      validateTavernArtifact({
        schemaVersion: 1,
        revision: 1,
        greetingSetId: "unsafe",
        variants: [{ variantId: "first", label: "First", text: "Hello.", script: "run()" }],
      }),
    /invalid_tavern_artifact/,
  );
});

test("greeting management creates an exact authored opening set and reads back its revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "greeting-management-"));
  try {
    const service = createGreetingManagementService(new TavernArtifactStore(root), root);
    const request = {
      label: "Campfire welcome",
      variants: [
        { label: "First message", text: "Welcome to the campfire, traveler." },
        { label: "Rainy evening", text: "Come in out of the rain." },
      ],
    };

    const created = await service.create(request);
    assert.deepEqual(created, { revision: 1, ...request });
    assert.deepEqual(await service.read(), created);
    assert.equal("greetingSetId" in created, false);
    assert.equal("variantId" in created.variants[0]!, false);
    assert.equal("canonicalHash" in created, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("greeting management fails closed for corrupt canonical revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "greeting-management-"));
  try {
    const store = new TavernArtifactStore(root);
    const service = createGreetingManagementService(store, root);
    await service.create({ label: "One", variants: [{ label: "First", text: "Hello" }] });
    await service.update({ expectedRevision: 1, label: "Two", variants: [{ label: "Second", text: "Welcome" }] });
    const id = `greeting-set-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 32)}`;
    await writeFile(join(resolve(root), "greetings", id, "revisions", "2.json"), "{ corrupt", "utf8");
    await assert.rejects(service.read(), /invalid_greeting_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("greeting management rejects nonnumeric revision-directory entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "greeting-management-"));
  try {
    const service = createGreetingManagementService(new TavernArtifactStore(root), root);
    await service.create({ label: "One", variants: [{ label: "First", text: "Hello" }] });
    const id = `greeting-set-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 32)}`;
    await writeFile(join(resolve(root), "greetings", id, "revisions", ".DS_Store"), "junk", "utf8");
    await assert.rejects(service.read(), /invalid_greeting_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("greeting management ignores a legacy singleton when no canonical revision exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "greeting-management-"));
  try {
    await (await import("node:fs/promises")).mkdir(join(resolve(root), "greeting-management"), { recursive: true });
    await writeFile(
      join(resolve(root), "greeting-management", "greetings.json"),
      JSON.stringify({ schemaVersion: 1, revision: 1, greetingSetId: "legacy", variants: [] }),
      "utf8",
    );
    assert.equal(await createGreetingManagementService(new TavernArtifactStore(root), root).read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("greeting management rejects unsafe or extensible input and duplicate creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "greeting-management-"));
  try {
    const service = createGreetingManagementService(new TavernArtifactStore(root), root);
    await assert.rejects(
      service.create({ label: "Welcome", variants: [{ label: "First", text: "Hello", script: "run()" }] } as never),
      /invalid_greeting_request/,
    );
    await assert.rejects(
      service.create({ label: "Welcome\n", variants: [{ label: "First", text: "Hello" }] }),
      /invalid_greeting_request/,
    );
    await assert.rejects(
      service.create({ label: "Welcome", variants: [{ label: "First", text: "Hello\u0000" }] }),
      /invalid_greeting_request/,
    );
    await service.create({ label: "Welcome", variants: [{ label: "First", text: "Hello" }] });
    await assert.rejects(
      service.create({ label: "Other", variants: [{ label: "First", text: "Hi" }] }),
      /greeting_already_exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
