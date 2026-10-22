import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { canonicalHash } from "../artifact-store.js";
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

test("managed World Info update carries the entry facts the authoring surface never names", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    // A player's own SillyTavern card: "Festival" is always on and gated by its secondary words.
    const importLorebook = repository.import;
    assert.ok(importLorebook, "the managed library exposes its one lorebook importer");
    await importLorebook.call(repository, {
      name: "Festival Lore",
      description: "Selection rules for the valley.",
      entries: [
        {
          comment: "Festival",
          content: "The town holds a festival every summer.",
          key: ["festival"],
          keysecondary: ["summer"],
          selectiveLogic: 1,
          constant: true,
        },
        { comment: "Harbor", content: "Boats moor at the harbor.", key: ["harbor"] },
      ],
    });
    const imported = (await repository.detail("Festival Lore"))!;
    assert.deepEqual(imported.entries, [
      {
        scope: "setting",
        publicTitle: "Festival",
        summary: "The town holds a festival every summer.",
        keys: ["festival"],
        constant: true,
        secondaryKeys: ["summer"],
        selectiveLogic: 1,
      },
      { scope: "setting", publicTitle: "Harbor", summary: "Boats moor at the harbor.", keys: ["harbor"] },
    ]);

    // What the editor submits: the four fields it has a control for, and nothing else.
    const authored = imported.entries.map((entry) => ({
      scope: entry.scope,
      publicTitle: entry.publicTitle,
      summary: entry.summary,
      ...(entry.keys === undefined ? {} : { keys: entry.keys }),
    }));
    const saved = await repository.update("Festival Lore", {
      expectedRevision: imported.revision,
      publicTitle: "Festival Lore",
      summary: "Selection rules for the valley.",
      entries: authored,
    });
    assert.deepEqual(saved.entries[0], {
      scope: "setting",
      publicTitle: "Festival",
      summary: "The town holds a festival every summer.",
      keys: ["festival"],
      constant: true,
      secondaryKeys: ["summer"],
      selectiveLogic: 1,
    });

    // A value the caller does state is its own answer, so the carry can never mean "ignore the request".
    const stated = await repository.update("Festival Lore", {
      expectedRevision: saved.revision,
      publicTitle: "Festival Lore",
      summary: "Selection rules for the valley.",
      entries: [{ ...authored[0]!, constant: false, secondaryKeys: ["autumn"], selectiveLogic: 2 }, authored[1]!],
    });
    assert.deepEqual(
      [stated.entries[0]!.constant, stated.entries[0]!.secondaryKeys, stated.entries[0]!.selectiveLogic],
      [false, ["autumn"], 2],
    );

    // Dropping a row is not an invitation to hand its facts to its neighbour: the remaining
    // entry is matched by its own title, so it keeps exactly the facts it never had.
    const trimmed = await repository.update("Festival Lore", {
      expectedRevision: stated.revision,
      publicTitle: "Festival Lore",
      summary: "Selection rules for the valley.",
      entries: [authored[1]!],
    });
    assert.deepEqual(trimmed.entries, [
      { scope: "setting", publicTitle: "Harbor", summary: "Boats moor at the harbor.", keys: ["harbor"] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed World Info delete removes the item from the library and keeps its immutable revision on disk", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    await repository.create(request);
    await repository.create({ ...request, publicTitle: "Cindersap Forest" });
    const catalog = JSON.parse(await readFile(join(root, "world-info-management", "catalog.json"), "utf8")) as {
      artifacts: readonly { handle: string; publicTitle: string }[];
    };
    const item = catalog.artifacts.find((artifact) => artifact.publicTitle === "Pelican Town")!;
    const revisionPath = join(root, "world-info-management", "revisions", item.handle, "1.json");
    const envelope = JSON.parse(await readFile(revisionPath, "utf8")) as {
      schemaVersion: number;
      revision: number;
      canonicalHash: string;
      artifact: unknown;
    };

    await repository.delete("Pelican Town");

    // Only that item leaves the library; deleting a name the catalog no longer
    // holds is an explicit refusal rather than a silent success.
    assert.deepEqual(
      (await repository.list()).map((projection) => projection.publicTitle),
      ["Cindersap Forest"],
    );
    assert.equal(await repository.detail("Pelican Town"), null);
    assert.deepEqual(await repository.history("Pelican Town"), []);
    await assert.rejects(() => repository.delete("Pelican Town"), /world_info_not_found/);
    const rewritten = JSON.parse(await readFile(join(root, "world-info-management", "catalog.json"), "utf8")) as {
      artifacts: readonly { publicTitle: string }[];
    };
    assert.deepEqual(
      rewritten.artifacts.map((artifact) => artifact.publicTitle),
      ["Cindersap Forest"],
    );

    // The immutable revision file is retained exactly as written and still
    // verifies against its own canonical hash: a Chat bound to this exact
    // revision keeps reading the artifact the library no longer lists.
    const retained = JSON.parse(await readFile(revisionPath, "utf8")) as typeof envelope;
    assert.deepEqual(retained, envelope);
    assert.equal(canonicalHash(retained.artifact), retained.canonicalHash);
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
      {
        ...request,
        entries: [{ scope: "setting", publicTitle: "title\nbreak", summary: "Title cannot have newline" }],
      },
      { ...request, entries: [{ scope: "setting", publicTitle: "No", summary: "null\u0000byte" }] },
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

test("managed World Info accepts multiline paragraphs and formatted text in summaries", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    const multiline = {
      publicTitle: "Wangshu Inn",
      summary: "An inn in Bishui Plain.\n\nBuilt upon a massive stone pillar, it serves as a vantage point.",
      entries: [
        {
          scope: "setting" as const,
          publicTitle: "Observation Deck",
          summary: "Top floor of the inn.\nOverlooks Dihua Marsh and Bishui River <south of Stone Gate>.",
        },
      ],
    };
    const created = await repository.create(multiline);
    assert.equal(created.publicTitle, "Wangshu Inn");
    assert.equal(created.summary, multiline.summary);
    assert.equal(created.entries[0]?.summary, multiline.entries[0]?.summary);
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

test("managed World Info supports secondaryKeys and selectiveLogic and rejects invalid variants", async () => {
  const { root, repository } = await temporaryRepository();
  try {
    const validEntry = {
      publicTitle: "Reaction Guide",
      summary: "Elemental interactions.",
      entries: [
        {
          scope: "setting" as const,
          publicTitle: "Vaporize",
          summary: "Pyro on Hydro.",
          keys: ["vaporize"],
          secondaryKeys: ["pyro", "hydro"],
          selectiveLogic: 3 as const,
        },
      ],
    };
    const created = await repository.create(validEntry);
    assert.deepEqual(created.entries[0]?.secondaryKeys, ["pyro", "hydro"]);
    assert.equal(created.entries[0]?.selectiveLogic, 3);

    const detailed = await repository.detail("Reaction Guide");
    assert.deepEqual(detailed?.entries[0]?.secondaryKeys, ["pyro", "hydro"]);
    assert.equal(detailed?.entries[0]?.selectiveLogic, 3);

    // Invalid selectiveLogic
    assert.throws(
      () =>
        repository.validateCreateRequest({
          ...validEntry,
          entries: [{ ...validEntry.entries[0], selectiveLogic: 4 as any }],
        }),
      /invalid_world_info_request/,
    );
    assert.throws(
      () =>
        repository.validateCreateRequest({
          ...validEntry,
          entries: [{ ...validEntry.entries[0], selectiveLogic: "0" as any }],
        }),
      /invalid_world_info_request/,
    );

    // Invalid secondaryKeys
    assert.throws(
      () =>
        repository.validateCreateRequest({
          ...validEntry,
          entries: [{ ...validEntry.entries[0], secondaryKeys: [] }],
        }),
      /invalid_world_info_request/,
    );
    assert.throws(
      () =>
        repository.validateCreateRequest({
          ...validEntry,
          entries: [{ ...validEntry.entries[0], secondaryKeys: [""] }],
        }),
      /invalid_world_info_request/,
    );

    // C1 control characters rejection in title, summary, keys, secondaryKeys
    assert.throws(
      () =>
        repository.validateCreateRequest({
          ...validEntry,
          publicTitle: "Bad\u0080Title",
        }),
      /invalid_world_info_request/,
    );
    assert.throws(
      () =>
        repository.validateCreateRequest({
          ...validEntry,
          summary: "Bad\u009fSummary",
        }),
      /invalid_world_info_request/,
    );
    assert.throws(
      () =>
        repository.validateCreateRequest({
          ...validEntry,
          entries: [{ ...validEntry.entries[0], keys: ["bad\u0085key"] }],
        }),
      /invalid_world_info_request/,
    );
    assert.throws(
      () =>
        repository.validateCreateRequest({
          ...validEntry,
          entries: [{ ...validEntry.entries[0], secondaryKeys: ["bad\u0085secondary"] }],
        }),
      /invalid_world_info_request/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
