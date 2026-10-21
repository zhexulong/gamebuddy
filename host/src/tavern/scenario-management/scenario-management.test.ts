import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../../path-lock.js";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../../windows-stale-lock-reclaimer/index.js";
import { macroTable } from "../macro-engine.js";
import { TavernArtifactStore } from "../artifact-store.js";
import { createScenarioManagementService, withScenarioSurfaceMacros } from "./scenario-management.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});
test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

test("scenario management durably creates, reads, and exactly revises a safe player projection", async () => {
  const root = await canonicalTestRoot("scenario-management-");
  try {
    const service = createScenarioManagementService(new TavernArtifactStore(root), root);
    const description = "A quiet evening at the Stardrop Saloon.";

    const created = await service.create({ name: "Saloon evening", description });
    assert.deepEqual(created, { revision: 1, name: "Saloon evening", description, preview: description });
    assert.deepEqual(await service.read(), created);

    const updated = await service.update({
      expectedRevision: 1,
      name: "Rainy evening",
      description: "Rain falls softly outside.",
    });
    assert.deepEqual(updated, {
      revision: 2,
      name: "Rainy evening",
      description: "Rain falls softly outside.",
      preview: "Rain falls softly outside.",
    });
    assert.deepEqual(await service.read(), updated);
    await assert.rejects(
      service.update({ expectedRevision: 1, name: "Stale", description: "This must not write." }),
      /scenario_revision_conflict/,
    );

    for (const field of ["scenarioId", "artifactId", "canonicalHash", "path", "text", "provenance", "owner"] as const)
      assert.equal(field in updated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scenario management fails closed for corrupt canonical revisions", async () => {
  const root = await canonicalTestRoot("scenario-management-");
  try {
    const store = new TavernArtifactStore(root);
    const service = createScenarioManagementService(store, root);
    await service.create({ name: "One", description: "First" });
    await service.update({ expectedRevision: 1, name: "Two", description: "Second" });
    await writeFile(
      join(
        resolve(root),
        "scenarios",
        `player-scenario-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 32)}`,
        "revisions",
        "2.json",
      ),
      "{ corrupt",
      "utf8",
    );
    await assert.rejects(service.read(), /invalid_scenario_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scenario management rejects nonnumeric revision-directory entries", async () => {
  const root = await canonicalTestRoot("scenario-management-");
  try {
    const service = createScenarioManagementService(new TavernArtifactStore(root), root);
    await service.create({ name: "One", description: "First" });
    const id = `player-scenario-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 32)}`;
    await writeFile(join(resolve(root), "scenarios", id, "revisions", "2.tmp"), "junk", "utf8");
    await assert.rejects(service.read(), /invalid_scenario_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scenario management ignores a legacy singleton when no canonical revision exists", async () => {
  const root = await canonicalTestRoot("scenario-management-");
  try {
    await (await import("node:fs/promises")).mkdir(join(resolve(root), "scenario-management"), { recursive: true });
    await writeFile(
      join(resolve(root), "scenario-management", "scenario.json"),
      JSON.stringify({ schemaVersion: 1, revision: 1, scenarioId: "legacy", text: "Must not load" }),
      "utf8",
    );
    assert.equal(await createScenarioManagementService(new TavernArtifactStore(root), root).read(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scenario management accepts only safe player name and description fields", async () => {
  const root = await canonicalTestRoot("scenario-management-");
  try {
    const service = createScenarioManagementService(new TavernArtifactStore(root), root);
    await assert.rejects(
      service.create({ name: "Saloon", description: "Safe", script: "run()" } as never),
      /invalid_scenario_request/,
    );
    await assert.rejects(service.create({ name: "Saloon\u0000", description: "Safe" }), /invalid_scenario_request/);
    await assert.rejects(
      service.create({ name: "Saloon", description: "Safe with C0 \u0000 control" }),
      /invalid_scenario_request/,
    );
    await assert.rejects(
      service.create({ name: "Saloon", description: "Safe with C1 \u0085 control" }),
      /invalid_scenario_request/,
    );
    const createdWithMarkers = await service.create({
      name: "Saloon with markers",
      description: "Welcome <User> to <<Scene>> with <Char>!",
    });
    assert.equal(createdWithMarkers.description, "Welcome <User> to <<Scene>> with <Char>!");
    await assert.rejects(service.create({ name: "Other", description: "Also safe" }), /scenario_already_exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("the browser scenario projection renders the run's macros while the durable record keeps them", async () => {
  const root = await canonicalTestRoot("scenario-management-macros-");
  try {
    const store = new TavernArtifactStore(root);
    const durable = createScenarioManagementService(store, root);
    const surface = withScenarioSurfaceMacros(durable, async () => macroTable({ char: "琥珀", locale: "zh-CN" }));

    const created = await surface.create({
      name: "{{char}}的清晨",
      description: "{{user}}与青梅竹马{{char}}一起收菜。",
    });
    assert.equal(created.name, "琥珀的清晨");
    assert.equal(created.description, "你与青梅竹马琥珀一起收菜。");
    assert.equal(created.description.includes("{{"), false);
    assert.equal(created.preview.includes("{{"), false);

    const updated = await surface.update({
      expectedRevision: 1,
      name: "黄昏",
      description: "{{char}}把{{user}}的锄头靠回木栏。",
    });
    assert.equal(updated.description, "琥珀把你的锄头靠回木栏。");

    const read = await surface.read();
    assert.ok(read !== null);
    assert.equal(read.description, "琥珀把你的锄头靠回木栏。");
    assert.doesNotMatch(read.preview, /\{\{/u);

    // A macro that straddles the preview bound must resolve whole: a naive
    // truncate-then-render leaves a stray `{{` in the preview the surface paints.
    const long = await surface.update({
      expectedRevision: 2,
      name: "长",
      description: `${"a".repeat(235)}{{user}}`,
    });
    assert.equal(long.preview.includes("{{"), false);
    // 235 filler chars plus the rendered one-character player reference 你.
    assert.equal(long.preview.length, 236);

    // The durable record keeps the card's own macros verbatim; the assertions
    // above pass only because the surface projection rendered them.
    const stored = await durable.read();
    assert.ok(stored !== null);
    assert.equal(stored.description, `${"a".repeat(235)}{{user}}`);
    assert.ok(stored.description.includes("{{user}}"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
