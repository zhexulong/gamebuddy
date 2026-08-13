import assert from "node:assert/strict";
import test from "node:test";
import { createTavernInterchangeService } from "./interchange-service.js";

const hash = "a".repeat(64);
const candidate = {
  schemaVersion: 1 as const,
  revision: 1,
  canonicalHash: hash,
  artifact: {
    schemaVersion: 1 as const,
    revision: 1,
    candidateId: "st-card-import",
    sourceFormat: "st-v3" as const,
    sourceVersion: "st-v3",
    sourceHash: hash,
    name: "Safe",
    reviewState: "pending" as const,
    fields: [],
  },
};
const report = {
  schemaVersion: 1 as const,
  revision: 1,
  canonicalHash: hash,
  artifact: {
    schemaVersion: 1 as const,
    revision: 1,
    importId: "import",
    source: "json" as const,
    sourceFormat: "st-v3" as const,
    sourceHash: hash,
    dispositions: [],
  },
};
test("safe interchange composes only pending canonical import artifacts", async () => {
  let imported = false;
  const service = createTavernInterchangeService({
    async import() {
      imported = true;
      return { candidate, report };
    },
    async export() {
      return { candidate, report };
    },
  });
  assert.deepEqual(await service.importStCard("import", "{}"), { candidate, report });
  assert.ok(imported);
  assert.deepEqual(await service.exportSafe("import"), { candidate, report });
});
