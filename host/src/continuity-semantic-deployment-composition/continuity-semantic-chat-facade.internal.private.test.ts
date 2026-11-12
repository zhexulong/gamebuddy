import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readSourceShape } from "../test-support/source-shape.test-support.js";
import { createFreshUnmountedChatSemanticFacade } from "./continuity-semantic-chat-facade.internal.js";

test("production Chat composition is internal and owns construction dependencies", async () => {
  const folder = resolve(dirname(fileURLToPath(import.meta.url)));
  const sourceFolder = join(folder, "../../src/continuity-semantic-deployment-composition");
  const publicDeployment = readSourceShape(join(sourceFolder, "continuity-semantic-deployment-composition.ts")).shape;
  const chatComposition = readSourceShape(join(sourceFolder, "continuity-semantic-chat-facade.internal.ts")).shape;
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
  const { shape: source } = readSourceShape(
    join(folder, "../../src/continuity-semantic-deployment-composition/continuity-semantic-chat-facade.internal.ts"),
  );
  assert.doesNotMatch(source, /manifestPath\s*:/);
  assert.doesNotMatch(source, /loadHostDeploymentManifest/);
  assert.match(
    source,
    /const authority = await createFreshSemanticChatRuntimeProductionAuthorityFromDeploymentManifest\(manifest, options\)/,
  );
  assert.doesNotMatch(source, /\{\s*\.\.\.manifest\s*\}/);
});
