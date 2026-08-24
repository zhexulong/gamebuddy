import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(
  await readFile(resolve(root, "design/references/tavern/st-semantic-references-v1.json"), "utf8"),
);
const expected = "8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8";
if (registry.sourceCommit !== expected) throw new Error("tavern_reference_commit_drift");
for (const entry of registry.references) {
  const path = resolve(root, "ref/external/SillyTavern", entry.path);
  const text = await readFile(path, "utf8");
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  if (hash !== entry.blobSha256) throw new Error(`tavern_reference_blob_drift:${entry.referenceId}`);
  if (!text.includes(entry.symbolOrStableAnchor))
    throw new Error(`tavern_reference_anchor_missing:${entry.referenceId}`);
}
const fixtures = JSON.parse(await readFile(resolve(root, "fixtures/tavern/sillytavern/manifest.v1.json"), "utf8"));
if (fixtures.sourceCommit !== expected) throw new Error("tavern_fixture_commit_drift");
for (const fixture of fixtures.fixtures) {
  const bytes = await readFile(resolve(root, "fixtures/tavern/sillytavern", fixture.path));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== fixture.sha256) throw new Error(`tavern_fixture_hash_drift:${fixture.id}`);
}
console.log(
  `verified ${registry.references.length} Tavern semantic references and ${fixtures.fixtures.length} fixtures at ${expected}`,
);
