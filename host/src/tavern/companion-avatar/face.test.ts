import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";

import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { pngCardFile } from "../../test-support/png-card.test-support.js";
import { companionAvatarPath, createCompanionAvatarService, type CompanionAvatarService } from "./index.js";
import { createCompanionAvatarRequestHandler, ownsCompanionAvatarRequest } from "./face.js";

const identity = Object.freeze({
  playerId: "player-avatar-face",
  companionId: "companion-avatar-face",
  continuityId: "continuity-avatar-face",
});
const handle = `${"B".repeat(42)}A`;
const unknownHandle = `${"C".repeat(42)}A`;

type Response = Readonly<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>;

async function request(port: number, path: string, method = "GET"): Promise<Response> {
  return await new Promise<Response>((resolveRequest, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolveRequest({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

async function withServer(service: CompanionAvatarService, run: (port: number) => Promise<void>): Promise<void> {
  const handler = createCompanionAvatarRequestHandler(service);
  const server = createServer((request, response) => handler.handle(request, response));
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((closed, failed) => server.close((error) => (error ? failed(error) : closed())));
  }
}

function serviceFor(root: string, known: readonly string[]) {
  return createCompanionAvatarService({
    runtimeRoot: root,
    playerId: identity.playerId,
    async resolveCompanion(candidate) {
      return known.includes(candidate)
        ? Object.freeze({ companionId: identity.companionId, continuityId: identity.continuityId })
        : null;
    },
  });
}

test("ownsCompanionAvatarRequest claims exactly the one avatar path space", () => {
  assert.equal(ownsCompanionAvatarRequest(`/assets/companions/${handle}/avatar.png`), true);
  assert.equal(ownsCompanionAvatarRequest("/assets/companions/"), true);
  assert.equal(ownsCompanionAvatarRequest(undefined), false);
  assert.equal(ownsCompanionAvatarRequest("/"), false);
  assert.equal(ownsCompanionAvatarRequest(`/assets/${handle}/avatar.png`), false);
  assert.equal(ownsCompanionAvatarRequest("/api/tavern/v1/state"), false);
});

test("the avatar face serves one companion's picture and refuses everything else", async () => {
  const root = await canonicalTestRoot("tavern-avatar-face-");
  try {
    const picture = pngCardFile(JSON.stringify({ spec: "chara_card_v3", data: { name: "Rin" } }));
    const path = companionAvatarPath(root, identity.playerId, identity);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, picture);
    const avatar = `/assets/companions/${handle}/avatar.png`;

    await withServer(serviceFor(root, [handle]), async (port) => {
      const served = await request(port, avatar);
      assert.equal(served.status, 200);
      assert.equal(served.headers["content-type"], "image/png");
      assert.equal(served.headers["cache-control"], "public, max-age=31536000, immutable");
      assert.equal(served.headers["content-length"], String(picture.length));
      assert.equal(served.headers["x-content-type-options"], "nosniff");
      assert.equal(served.headers["cross-origin-resource-policy"], "same-origin");
      assert.match(String(served.headers["content-security-policy"]), /default-src 'self'/);
      assert.deepEqual(served.body, Buffer.from(picture));

      // Every one of these is the same face answering for a path it does not
      // have, and none of them may resolve outside the companion root.
      for (const candidate of [
        `/assets/companions/${unknownHandle}/avatar.png`,
        `/assets/companions/${handle}/avatar.jpg`,
        `/assets/companions/${handle}/avatar.png/`,
        "/assets/companions/",
        "/assets/companions",
        `/assets/${handle}/avatar.png`,
        "/assets/app-abcdef12.js",
        "/index.html",
        `${avatar}?cache=1`,
        `${avatar}#fragment`,
        `/assets/companions/%2e%2e/avatar.png`,
        "/assets/companions/../avatar.png",
        `/assets/companions/${handle}/%2e%2e/avatar.png`,
        "/assets/companions/%2fetc%2fpasswd/avatar.png",
      ]) {
        const refused = await request(port, candidate);
        assert.equal(refused.status, 404, candidate);
        assert.equal(refused.headers["cache-control"], "no-store", candidate);
        assert.equal(refused.body.length, 0, candidate);
      }

      const posted = await request(port, avatar, "POST");
      assert.equal(posted.status, 405);
      assert.equal(posted.headers.allow, "GET");
      const headed = await request(port, avatar, "HEAD");
      assert.equal(headed.status, 405);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no picture is an ordinary 404; an unreadable picture is a distinct 500 with a named log line", async () => {
  const root = await canonicalTestRoot("tavern-avatar-face-states-");
  const written: string[] = [];
  const original = process.stderr.write;
  try {
    const service = serviceFor(root, [handle]);
    await withServer(service, async (port) => {
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const absent = await request(port, `/assets/companions/${handle}/avatar.png`);
        assert.equal(absent.status, 404);
        assert.deepEqual(written, []);
      } finally {
        process.stderr.write = original;
      }
    });
    const path = companionAvatarPath(root, identity.playerId, identity);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not a picture at all", "utf8");
    await withServer(service, async (port) => {
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const unreadable = await request(port, `/assets/companions/${handle}/avatar.png`);
        // Not a silent 404: a companion whose picture is on disk and unreadable
        // must not read as "she has no picture".
        assert.equal(unreadable.status, 500);
        assert.equal(unreadable.headers["cache-control"], "no-store");
        assert.ok(
          written.some((line) => line.startsWith("[companion-avatar] unreadable")),
          `expected a named log line; got ${JSON.stringify(written)}`,
        );
      } finally {
        process.stderr.write = original;
      }
    });
  } finally {
    process.stderr.write = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked avatar is never served, whatever it points at", async (t) => {
  const root = await canonicalTestRoot("tavern-avatar-face-symlink-");
  const outside = await canonicalTestRoot("tavern-avatar-face-outside-");
  try {
    const outsideFile = join(outside, "sentinel.png");
    await writeFile(outsideFile, pngCardFile(JSON.stringify({ data: { name: "Not Her" } })));
    const path = companionAvatarPath(root, identity.playerId, identity);
    await mkdir(dirname(path), { recursive: true });
    try {
      await symlink(outsideFile, path, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip("symlink fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await withServer(serviceFor(root, [handle]), async (port) => {
      const served = await request(port, `/assets/companions/${handle}/avatar.png`);
      assert.notEqual(served.status, 200);
      assert.equal(served.body.length, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
