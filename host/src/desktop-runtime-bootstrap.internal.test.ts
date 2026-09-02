import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DESKTOP_RUNTIME_BOOTSTRAP_ENTRY } from "./desktop-runtime-bootstrap.internal.js";

test("Desktop bootstrap entry exports only the fixed internal descriptor", async () => {
  const entryModule = await import("./desktop-runtime-bootstrap.internal.js");

  assert.deepEqual(Object.keys(entryModule), ["DESKTOP_RUNTIME_BOOTSTRAP_ENTRY"]);
  assert.deepEqual(DESKTOP_RUNTIME_BOOTSTRAP_ENTRY, {
    schema: "gamebuddy-desktop-runtime-bootstrap-entry/v1",
    entry: "desktop-runtime-bootstrap.internal.js",
  });
  assert.equal(Object.isFrozen(DESKTOP_RUNTIME_BOOTSTRAP_ENTRY), true);
});

test("Desktop bootstrap entry has no public or runtime ingress", async () => {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = sourceDirectory.endsWith("src") ? sourceDirectory : resolve(sourceDirectory, "..", "src");
  const [source, artifactConfig] = await Promise.all([
    readFile(resolve(sourceRoot, "desktop-runtime-bootstrap.internal.ts"), "utf8"),
    readFile(resolve(sourceRoot, "..", "production-artifact.config.json"), "utf8"),
  ]);

  for (const forbidden of [
    "process.argv",
    "process.env",
    "node:fs",
    "node:path",
    "node:child_process",
    "spawn(",
    "runtime/node.exe",
    "Guardian",
    "broker",
    "token",
    "session",
    "root",
  ]) assert.equal(source.includes(forbidden), false, `forbidden bootstrap ingress: ${forbidden}`);

  const artifact = JSON.parse(artifactConfig) as { entryRoots: unknown };
  assert.equal(Array.isArray(artifact.entryRoots), true);
  const entryRoots = artifact.entryRoots as unknown[];
  assert.equal(entryRoots.includes("desktop-runtime-bootstrap.internal.js"), false);
});
