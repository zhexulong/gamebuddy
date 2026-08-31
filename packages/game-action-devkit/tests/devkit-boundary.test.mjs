import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceFiles = [
  "src/cli.mjs",
  "src/index.mjs",
  "src/project-runner.mjs",
  "src/process-supervisor.mjs",
  "bin/game-action.mjs",
];
const schemaFiles = [
  "schemas/game-action-project.v1.schema.json",
  "schemas/game-action-profile-envelope.v1.schema.json",
  "schemas/game-action-scenario-result.v1.schema.json",
];

function importSpecifiers(source) {
  return [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)].map((match) => match[1]);
}

test("devkit implementation has no Stardew or repository-root import boundary", async () => {
  for (const relativeFile of sourceFiles) {
    const file = path.join(packageRoot, relativeFile);
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /stardew/iu, relativeFile);
    for (const specifier of importSpecifiers(source)) {
      assert.doesNotMatch(specifier, /stardew/iu, `${relativeFile}: ${specifier}`);
      if (relativeFile.startsWith("src/")) {
        assert.ok(specifier.startsWith("node:") || specifier.startsWith("./"), `${relativeFile}: ${specifier}`);
      } else {
        assert.ok(specifier === "../src/cli.mjs", `${relativeFile}: ${specifier}`);
      }
    }
  }
});

test("generic project, profile, and scenario schemas are bounded package artifacts", async () => {
  const schemas = await Promise.all(schemaFiles.map(async (relativeFile) => {
    const value = JSON.parse(await readFile(path.join(packageRoot, relativeFile), "utf8"));
    return [relativeFile, value];
  }));
  for (const [relativeFile, schema] of schemas) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", relativeFile);
    assert.match(schema.$id, /game-action-devkit\/schemas\//u, relativeFile);
    assert.equal(schema.type, "object", relativeFile);
    assert.equal(schema.additionalProperties, false, relativeFile);
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0, relativeFile);
    assert.doesNotMatch(JSON.stringify(schema), /stardew|farm|tile|npc|player/iu, relativeFile);
  }
  assert.deepEqual(schemas[0][1].required, ["schema", "gameId", "projectVersion", "adapter", "portfolio", "toolInventory", "evidenceRoot", "defaultProfileExample"]);
  assert.deepEqual(schemas[1][1].required, ["schema", "gameId", "profileId", "revision", "payload"]);
  assert.deepEqual(schemas[2][1].required, ["schema", "gameId", "status"]);
});
