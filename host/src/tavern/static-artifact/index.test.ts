import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStaticTavernArtifactServer, verifyTavernStaticArtifact } from "./index.js";
import { createTestWindowsReparseInspector } from "../../windows-reparse-inspector/index.test-support.js";

const identity = Object.freeze({ browserContract: "tavern_browser_api/v1" as const, profileId: "chat-core" });
const script = Buffer.from("console.log('synthetic artifact');\n", "utf8");
const assetPath = "assets/app-abcdef12.js";
function regularInspector() {
  return createTestWindowsReparseInspector(() => syntheticHelper([]));
}

async function fixture(change?: (root: string) => Promise<void>): Promise<{ root: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-static-artifact-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Tavern</title>", "utf8");
  await writeFile(join(root, assetPath), script);
  await writeFile(
    join(root, "tavern-browser-artifact-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      browserContract: identity.browserContract,
      profileId: identity.profileId,
      entryHtml: "index.html",
      assets: [
        {
          path: assetPath,
          sha256: createHash("sha256").update(script).digest("hex"),
          bytes: script.length,
          mime: "text/javascript",
        },
      ],
    }),
    "utf8",
  );
  await change?.(root);
  return { root, dispose: async () => await rm(root, { recursive: true, force: true }) };
}
async function request(
  port: number,
  path: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return await new Promise((resolveRequest, reject) => {
    get({ host: "127.0.0.1", port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolveRequest({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
      );
    }).on("error", reject);
  });
}

test("verified static artifact serves only slash and exact assets with strict headers", async () => {
  const item = await fixture();
  const artifact = await createStaticTavernArtifactServer(item.root, identity, regularInspector());
  try {
    await new Promise<void>((resolveListen) => artifact.server.listen(0, "127.0.0.1", resolveListen));
    const address = artifact.server.address();
    assert.ok(address && typeof address !== "string");
    const html = await request(address.port, "/");
    assert.equal(html.status, 200);
    assert.equal(html.body.toString("utf8"), "<!doctype html><title>Tavern</title>");
    assert.equal(html.headers["cache-control"], "no-store");
    assert.equal(html.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(html.headers["x-content-type-options"], "nosniff");
    assert.match(String(html.headers["content-security-policy"]), /default-src 'self'/);
    const asset = await request(address.port, `/${assetPath}`);
    assert.equal(asset.status, 200);
    assert.deepEqual(asset.body, script);
    assert.equal(asset.headers["content-type"], "text/javascript");
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
    for (const path of [
      "/missing",
      "/assets/unknown-abcdef12.js",
      "/assets/app-abcdef12.js.map",
      "/tavern-browser-artifact-manifest.json",
      "/assets/",
      "/.hidden",
      "/%2e%2e/index.html",
      "/assets%2fapp-abcdef12.js",
      `/${assetPath}?x=1`,
    ]) {
      const result = await request(address.port, path);
      assert.equal(result.status, 404, path);
      assert.equal(result.headers["cache-control"], "no-store", path);
    }
  } finally {
    await artifact.close();
    await item.dispose();
  }
});

test("server retains verified HTML bytes when the on-disk shell is replaced after construction", async () => {
  const item = await fixture();
  const artifact = await createStaticTavernArtifactServer(item.root, identity, regularInspector());
  try {
    await new Promise<void>((resolveListen) => artifact.server.listen(0, "127.0.0.1", resolveListen));
    await writeFile(join(item.root, "replacement.html"), "<script>substituted shell</script>", "utf8");
    await rename(join(item.root, "replacement.html"), join(item.root, "index.html"));
    const address = artifact.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await request(address.port, "/");
    assert.equal(response.status, 200);
    assert.equal(response.body.toString("utf8"), "<!doctype html><title>Tavern</title>");
    assert.notEqual(response.body.toString("utf8"), "<script>substituted shell</script>");
  } finally {
    await artifact.close();
    await item.dispose();
  }
});

test("verifier fails closed for missing, extra, stale, malformed, and mismatched identities", async () => {
  const cases: Array<
    [string, (root: string) => Promise<void>, { browserContract: "tavern_browser_api/v1"; profileId: string }]
  > = [
    ["missing manifest", async (root) => await rm(join(root, "tavern-browser-artifact-manifest.json")), identity],
    ["extra asset", async (root) => await writeFile(join(root, "assets", "stale-abcdef12.js"), "stale"), identity],
    ["stale hash", async (root) => await writeFile(join(root, assetPath), "tampered"), identity],
    ["source map", async (root) => await writeFile(join(root, "assets", "app-abcdef12.js.map"), "{}"), identity],
    [
      "malformed manifest",
      async (root) => await writeFile(join(root, "tavern-browser-artifact-manifest.json"), "{}"),
      identity,
    ],
    ["wrong expected profile", async () => {}, { ...identity, profileId: "other-profile" }],
  ];
  for (const [name, change, expected] of cases) {
    const item = await fixture(change);
    try {
      await assert.rejects(
        () => verifyTavernStaticArtifact(item.root, expected, regularInspector()),
        /invalid_tavern_static_artifact|ENOENT/,
        name,
      );
    } finally {
      await item.dispose();
    }
  }
});

test("static verifier invokes the inspector for every traversal and read path", async () => {
  const inspected: string[] = [];
  const capability = createTestWindowsReparseInspector(() => syntheticHelper(inspected));
  const item = await fixture();
  try {
    await verifyTavernStaticArtifact(item.root, identity, capability);
    for (const relativePath of ["", "tavern-browser-artifact-manifest.json", "assets", assetPath, "index.html"]) {
      assert.ok(inspected.some((path) => path === join(item.root, relativePath)), relativePath || "root");
    }
  } finally {
    await item.dispose();
  }
});

test("Windows directory junctions fail verification before static server construction", { skip: process.platform !== "win32" }, async () => {
  const item = await fixture();
  const target = await mkdtemp(join(tmpdir(), "gamebuddy-static-artifact-junction-target-"));
  try {
    await rm(join(item.root, "assets"), { recursive: true });
    await symlink(target, join(item.root, "assets"), "junction");
    await assert.rejects(() => verifyTavernStaticArtifact(item.root, identity, regularInspector()), /invalid_tavern_static_artifact/);
    await assert.rejects(() => createStaticTavernArtifactServer(item.root, identity, regularInspector()), /invalid_tavern_static_artifact/);
  } finally {
    await item.dispose();
    await rm(target, { recursive: true, force: true });
  }
});

test("verifier rejects duplicate entries, unsafe reparse entries, size mismatch, and non-asset paths", async () => {
  const cases: Array<[string, (root: string) => Promise<void>]> = [
    [
      "duplicate",
      async (root) =>
        await writeFile(
          join(root, "tavern-browser-artifact-manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            browserContract: identity.browserContract,
            profileId: identity.profileId,
            entryHtml: "index.html",
            assets: [asset(), asset()],
          }),
        ),
    ],
    [
      "size",
      async (root) =>
        await writeFile(
          join(root, "tavern-browser-artifact-manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            browserContract: identity.browserContract,
            profileId: identity.profileId,
            entryHtml: "index.html",
            assets: [{ ...asset(), bytes: 1 }],
          }),
        ),
    ],
    ["reparse-shaped unsupported entry", async (root) => await mkdir(join(root, "assets", "nested"))],
    [
      "bad path",
      async (root) =>
        await writeFile(
          join(root, "tavern-browser-artifact-manifest.json"),
          JSON.stringify({
            schemaVersion: 1,
            browserContract: identity.browserContract,
            profileId: identity.profileId,
            entryHtml: "index.html",
            assets: [{ ...asset(), path: "app-abcdef12.js" }],
          }),
        ),
    ],
  ];
  for (const [name, change] of cases) {
    const item = await fixture(change);
    try {
      await assert.rejects(
        () => verifyTavernStaticArtifact(item.root, identity, regularInspector()),
        /invalid_tavern_static_artifact/,
        name,
      );
    } finally {
      await item.dispose();
    }
  }
});
function syntheticHelper(inspected: string[]) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  });
  child.stdin.on("data", (input: Buffer) => {
    inspected.push(JSON.parse(input.toString("utf8")).path);
    child.stdout.end('{"schemaVersion":1,"result":"regular"}\n');
    child.stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  });
  return child as unknown as ChildProcess;
}
function asset() {
  return {
    path: assetPath,
    sha256: createHash("sha256").update(script).digest("hex"),
    bytes: script.length,
    mime: "text/javascript" as const,
  };
}
