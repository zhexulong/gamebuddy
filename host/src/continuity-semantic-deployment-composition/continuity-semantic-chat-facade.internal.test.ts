import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFreshUnmountedChatSemanticFacade } from "./continuity-semantic-chat-facade.internal.js";

test("production Chat composition is internal and owns construction dependencies", async () => {
  const folder = resolve(dirname(fileURLToPath(import.meta.url)));
  const sourceFolder = join(folder, "../../src/continuity-semantic-deployment-composition");
  const publicDeployment = await readFile(join(sourceFolder, "continuity-semantic-deployment-composition.ts"), "utf8");
  const chatComposition = await readFile(join(sourceFolder, "continuity-semantic-chat-facade.internal.ts"), "utf8");
  assert.equal(publicDeployment.includes("createFreshUnmountedChatSemanticFacade"), false);
  assert.equal(chatComposition.includes("materializer:"), false);
  assert.equal(chatComposition.includes("binding:"), false);
  assert.equal(chatComposition.includes("store:"), false);
  assert.equal(chatComposition.includes("factory:"), false);
  assert.equal(chatComposition.includes("loadHostDeploymentManifest"), false);
  assert.match(chatComposition, /createFreshUnmountedChatSemanticFacade\(\s*manifest: HostDeploymentManifest,/);
  assert.match(
    chatComposition,
    /createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest\(manifest, options\)/,
  );
  assert.equal(typeof createFreshUnmountedChatSemanticFacade, "function");
});

test("Chat facade preserves the exact manifest object and rejects adversarial manifest-path re-load after composition begins", async () => {
  const folder = resolve(dirname(fileURLToPath(import.meta.url)));
  const source = await readFile(
    join(folder, "../../src/continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /manifestPath\s*:/);
  assert.doesNotMatch(source, /loadHostDeploymentManifest/);
  assert.match(
    source,
    /const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest\(manifest, options\)/,
  );
  assert.doesNotMatch(source, /\{\s*\.\.\.manifest\s*\}/);
});
