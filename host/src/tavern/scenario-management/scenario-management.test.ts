import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { TavernArtifactStore } from "../artifact-store.js";
import { validateTavernArtifact } from "../types.js";
import { createScenarioManagementService } from "./scenario-management.js";

test("scenario management durably creates, reads, and exactly revises a safe player projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenario-management-"));
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

test("scenario management uses legacy only when canonical is absent and fails closed for corrupt canonical revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenario-management-"));
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
    assert.deepEqual(await service.read(), { revision: 1, name: "One", description: "First", preview: "First" });
    await writeFile(
      join(
        resolve(root),
        "scenarios",
        `player-scenario-${createHash("sha256").update(resolve(root), "utf8").digest("hex").slice(0, 32)}`,
        "revisions",
        "1.json",
      ),
      "{ corrupt",
      "utf8",
    );
    await assert.rejects(service.read(), /invalid_scenario_artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scenario management reads legacy text-only artifacts and bounds previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenario-management-"));
  try {
    const store = new TavernArtifactStore(root);
    const description = "a".repeat(241);
    const legacy = {
      schemaVersion: 1 as const,
      revision: 1,
      scenarioId: "legacy-scenario",
      text: description,
      provenance: "imported" as const,
      owner: "imported_candidate" as const,
    };
    await store.write(
      join(resolve(root), "scenario-management", "scenario.json"),
      legacy,
      (value) => validateTavernArtifact(value) as typeof legacy,
    );

    assert.deepEqual(await createScenarioManagementService(store, root).read(), {
      revision: 1,
      name: "Scenario",
      description,
      preview: "a".repeat(240),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scenario management accepts only safe player name and description fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "scenario-management-"));
  try {
    const service = createScenarioManagementService(new TavernArtifactStore(root), root);
    await assert.rejects(
      service.create({ name: "Saloon", description: "Safe", script: "run()" } as never),
      /invalid_scenario_request/,
    );
    await assert.rejects(service.create({ name: "Saloon\n", description: "Safe" }), /invalid_scenario_request/);
    await assert.rejects(
      service.create({ name: "Saloon", description: "<script>alert(1)</script>" }),
      /invalid_scenario_request/,
    );
    await service.create({ name: "Saloon", description: "Safe" });
    await assert.rejects(service.create({ name: "Other", description: "Also safe" }), /scenario_already_exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
