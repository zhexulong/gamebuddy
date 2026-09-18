import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lane E3 absence guard: the temporary dialogue-web entry and its chat-live
 * one-off machine are deleted, and production roots must never resurrect them
 * (handoff "zero production references"; boundary card D6). The three product
 * surfaces themselves stay live inside the single Desktop composition owner.
 */
test("dialogue-web entry and launch-mode sources no longer exist", async () => {
  for (const source of ["src/dialogue-web-main.ts", "src/dialogue-launch-mode.ts"]) {
    await assert.rejects(readFile(resolve(hostRoot, source), "utf8"), { code: "ENOENT" });
  }
});

test("production roots never reference the removed entry or the chat-live machine", async () => {
  const config = JSON.parse(await readFile(resolve(hostRoot, "production-artifact.config.json"), "utf8"));
  assert.ok(!config.entryRoots.includes("dialogue-web-main.js"));
  // verificationRoots keep the E1 migration API/static-shell layers.
  assert.ok(config.verificationRoots.includes("tavern-management-dialogue-web.js"));
  assert.ok(config.verificationRoots.includes("reference-pipeline-dialogue-web.js"));

  const productionTsconfig = JSON.parse(await readFile(resolve(hostRoot, "tsconfig.production.json"), "utf8"));
  assert.ok(!productionTsconfig.files.includes("src/dialogue-web-main.ts"));
  assert.ok(!productionTsconfig.files.includes("src/dialogue-launch-mode.ts"));
  // The composition variant sources remain the production assembly.
  assert.ok(productionTsconfig.files.includes("src/tavern-management-dialogue-web.ts"));

  const testTsconfig = JSON.parse(await readFile(resolve(hostRoot, "tsconfig.test.json"), "utf8"));
  assert.ok(!testTsconfig.exclude.includes("src/dialogue-web-main.ts"));
  assert.ok(!testTsconfig.exclude.includes("src/dialogue-web-main.test.ts"));

  const packageScripts = JSON.parse(await readFile(resolve(hostRoot, "package.json"), "utf8")).scripts ?? {};
  assert.ok(!("start:dialogue" in packageScripts));
  assert.ok(!JSON.stringify(packageScripts).includes("dialogue-web-main.js"));

  for (const machineFile of ["tsconfig.chat-live.json", "scripts/build-chat-live-artifact.mjs", "scripts/start-chat-live-artifact.mjs", "scripts/chat-live-artifact-support.mjs"]) {
    await assert.rejects(readFile(resolve(hostRoot, machineFile), "utf8"), { code: "ENOENT" });
  }
});