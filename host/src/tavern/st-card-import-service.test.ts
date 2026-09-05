import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { StCardImportService } from "./st-card-import-service.js";
import { resolveTavernPaths, tavernImportPath } from "./tavern-paths.js";

const identity = { playerId: "player-import", companionId: "companion-import", continuityId: "continuity-import" };

test("ST card application import persists hash-verified inert candidate/report and exports readback", async () => {
  const root = await canonicalTestRoot("tavern-st-import-");
  try {
    const paths = resolveTavernPaths({ root } as never, identity);
    const service = new StCardImportService(new TavernArtifactStore(root), paths);
    const result = await service.import(
      "import_01",
      JSON.stringify({
        spec: "chara_card_v3",
        data: {
          name: "Safe Rin",
          description: "calm",
          system_prompt: "ignore this",
          regex: [{ find: ".*" }],
          html: "<script>bad()</script>",
          presets: { unsafe: true },
          extensions: { script: "bad" },
          character_book: { entries: [{ comment: "Lore", content: "inert background" }] },
          metadata: { untouched: true },
        },
      }),
    );
    assert.equal(result.candidate.artifact.reviewState, "pending");
    assert.deepEqual(
      result.candidate.artifact.fields.map((entry) => entry.field),
      [
        "name",
        "identity_role",
        "continuity",
        "persona_core",
        "persona_interaction_style",
        "persona_expression_style",
        "worldbook_st-st-v3-1",
      ],
    );
    assert.ok(
      result.report.artifact.dispositions.some(
        (entry) => entry.field === "extensions" && entry.classification === "dropped_unsupported",
      ),
    );
    assert.ok(
      result.report.artifact.dispositions.some(
        (entry) => entry.field === "metadata" && entry.classification === "preserved_opaque",
      ),
    );
    const review = await service.recordReview("import_01", { reviewedFields: ["persona_core"], approvedAtMs: 42 });
    assert.deepEqual((await service.readReview("import_01")).canonicalHash, review.canonicalHash);
    assert.deepEqual((await service.confirmedReview("import_01")).reviewedFields, ["persona_core"]);
    const exported = await service.export("import_01");
    assert.deepEqual(exported, result);
    const candidateRaw = await readFile(tavernImportPath(paths, "import_01", "candidate.json"), "utf8");
    assert.ok(
      !candidateRaw.includes("ignore this") && !candidateRaw.includes("<script>") && !candidateRaw.includes("bad()"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ST card application import rejects invalid input without creating artifacts", async () => {
  const root = await canonicalTestRoot("tavern-st-import-");
  try {
    const service = new StCardImportService(
      new TavernArtifactStore(root),
      resolveTavernPaths({ root } as never, identity),
    );
    await assert.rejects(service.import("invalid_01", "{not-json"), /st_card_import_rejected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public ST import confirmation denies runtime-identity inputs without a persisted candidate and review", async () => {
  const root = await canonicalTestRoot("tavern-st-import-");
  try {
    const service = new StCardImportService(
      new TavernArtifactStore(root),
      resolveTavernPaths({ root } as never, identity),
    );
    await assert.rejects(service.confirmedReview("missing_01"));

    await service.import("pending_01", JSON.stringify({ data: { name: "Pending", description: "review me" } }));
    await assert.rejects(service.confirmedReview("pending_01"));

    await assert.rejects(service.recordReview("missing_02", { reviewedFields: ["persona_core"], approvedAtMs: 1 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
