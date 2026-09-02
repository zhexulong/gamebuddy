import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readArtifactConfigFromText } from "./production-artifact.mjs";

const configPath = fileURLToPath(new URL("../production-artifact.config.json", import.meta.url));
const publisherPath = fileURLToPath(new URL("./production-artifact.mjs", import.meta.url));
const configText = await readFile(configPath, "utf8");
const config = JSON.parse(configText);
const fixedBundledRuntime = {
  kind: "verified_host_bundled_node_runtime",
  sourceUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip",
  archiveSha256: "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba",
  archiveRoot: "node-v24.20.0-win-x64",
  runtimePath: "runtime/node.exe",
  nodeSha256: "5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5",
  bootstrapPath: "desktop-runtime-bootstrap.internal.js",
  runtimeVersion: "v24.20.0",
  runtimePlatform: "win32",
  runtimeArch: "x64",
};

function configTextWithRuntime(bundledRuntime) {
  return JSON.stringify({ ...config, bundledRuntime });
}

test("bundled runtime descriptor is the exact fixed hash-only release-CI contract", async () => {
  const parsed = await readArtifactConfigFromText(configText);
  assert.deepEqual(parsed.bundledRuntime, fixedBundledRuntime);
});

test("artifact config rejects PGP/key/path/boolean claims and URL/hash overrides", async (t) => {
  const rejected = [
    ["required signer fingerprint", { requiredSignerFingerprint: "x" }],
    ["signer key path", { signerKeyPath: "publisher-trust/node-release-signer.asc" }],
    ["keyring path", { keyringPath: "publisher-trust" }],
    ["PGP boolean", { pgpVerified: true }],
    ["raw runtime path", { extractedRoot: "C:\\runtime" }],
    ["URL override", { sourceUrl: "https://example.invalid/node.zip" }],
    ["hash override", { archiveSha256: "0".repeat(64) }],
  ];
  for (const [name, override] of rejected) {
    await t.test(name, async () => {
      await assert.rejects(
        readArtifactConfigFromText(configTextWithRuntime({ ...fixedBundledRuntime, ...override })),
        /invalid_(?:production_artifact_config|bundled_runtime_descriptor)/,
      );
    });
  }
});

test("production runtime provenance has no PGP or keyring authority", async () => {
  const publisherSource = await readFile(publisherPath, "utf8");
  assert.doesNotMatch(publisherSource, /openpgp|PGP|keyring|requiredSignerFingerprint|signerFingerprint|pgpVerified/);
  assert.match(
    await readFile(fileURLToPath(new URL("../../design/tasks/active/host-bundled-runtime-bootstrap-contract.md", import.meta.url)), "utf8"),
    /Windows release CI validates only the committed SHA-256 before safe extraction/,
  );
});
