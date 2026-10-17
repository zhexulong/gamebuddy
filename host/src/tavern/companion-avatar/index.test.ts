import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "../../path-lock.js";
import { canonicalTestRoot } from "../../test-support/canonical-test-root.test-support.js";
import { pngCardFile, pngPictureFile } from "../../test-support/png-card.test-support.js";
import {
  COMPANION_AVATAR_FILE_NAME,
  MAX_COMPANION_AVATAR_BYTES,
  companionAvatarPath,
  createCompanionAvatarService,
  isCompletePngFile,
  writeAvatarFile,
} from "./index.js";

test.before(async () => {
  const { createBuildWindowsStaleLockReclaimer } = await import("../../windows-stale-lock-reclaimer/index.js");
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const identity = Object.freeze({
  playerId: "player-avatar",
  companionId: "companion-avatar",
  continuityId: "continuity-avatar",
});

const handle = `${"B".repeat(42)}A`;

function serviceFor(root: string, known: Readonly<Record<string, string | undefined>>) {
  return createCompanionAvatarService({
    runtimeRoot: root,
    playerId: identity.playerId,
    async resolveCompanion(candidate) {
      const companionId = known[candidate];
      return companionId === undefined
        ? null
        : Object.freeze({ companionId, continuityId: `${companionId}-continuity` });
    },
  });
}

test("the avatar lives at the companion root the roster's own identity derives", () => {
  const path = companionAvatarPath("/runtime/root", identity.playerId, identity);
  assert.equal(basename(path), COMPANION_AVATAR_FILE_NAME);
  // Two different companions never share a directory: the path is derived from
  // the identity, so an avatar can only ever be read back where its own
  // companion's artifacts live, and the raw durable ids never appear in it.
  const other = companionAvatarPath("/runtime/root", identity.playerId, {
    companionId: "companion-other",
    continuityId: identity.continuityId,
  });
  assert.notEqual(dirname(path), dirname(other));
  assert.equal(path.includes(identity.playerId), false);
  assert.equal(path.includes(identity.companionId), false);
});

test("isCompletePngFile accepts a real PNG container and refuses everything else", () => {
  assert.equal(isCompletePngFile(pngPictureFile()), true);
  assert.equal(isCompletePngFile(pngCardFile(JSON.stringify({ data: { name: "Rin" } }))), true);
  assert.equal(isCompletePngFile(new Uint8Array(0)), false);
  // A JSON card renamed `.png`: the bytes are the card, not a picture.
  assert.equal(isCompletePngFile(Buffer.from('{"data":{"name":"Rin"}}', "utf8")), false);
  // Signature only, and a truncated chain, are both refused.
  assert.equal(isCompletePngFile(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), false);
  const whole = pngPictureFile();
  assert.equal(isCompletePngFile(whole.subarray(0, whole.length - 4)), false);
  // A chunk whose declared length runs past the end of the file is refused
  // rather than read.
  const overlong = Buffer.from(whole);
  overlong.writeUInt32BE(0xffff, 8);
  assert.equal(isCompletePngFile(overlong), false);
});

test("a written avatar reads back byte for byte, and an absent one is absent", async () => {
  const root = await canonicalTestRoot("tavern-avatar-service-");
  try {
    const service = serviceFor(root, { [handle]: identity.companionId });
    assert.deepEqual(await service.read(handle), { state: "absent" });
    // A handle the roster never projected is a different answer from absent.
    assert.equal(await service.read(`${"C".repeat(42)}A`), null);
    const picture = pngCardFile(JSON.stringify({ spec: "chara_card_v3", data: { name: "Rin" } }));
    const path = companionAvatarPath(root, identity.playerId, identity);
    await writeAvatarFile(path, picture, root);
    const read = await service.read(handle);
    assert.equal(read?.state, "present");
    assert.deepEqual(await readFile(path), Buffer.from(picture));
    assert.deepEqual(read?.state === "present" ? read.bytes : undefined, Buffer.from(picture));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that exists but cannot be used is never reported as absent", async () => {
  const root = await canonicalTestRoot("tavern-avatar-unreadable-");
  try {
    const service = serviceFor(root, { [handle]: identity.companionId });
    const path = companionAvatarPath(root, identity.playerId, identity);
    await mkdir(dirname(path), { recursive: true });
    // Not a PNG at all.
    await writeFile(path, "this is not a picture", "utf8");
    await assert.rejects(service.read(handle), /companion_avatar_malformed/);
    // A structurally complete PNG that is over the card decoder's own ceiling.
    await writeFile(path, pngPictureFile());
    await truncate(path, MAX_COMPANION_AVATAR_BYTES + 1);
    await assert.rejects(service.read(handle), /companion_avatar_too_large/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked avatar or a linked companion root cannot name a file outside it", async (t) => {
  const root = await canonicalTestRoot("tavern-avatar-boundary-");
  const outside = await canonicalTestRoot("tavern-avatar-outside-");
  try {
    const service = serviceFor(root, { [handle]: identity.companionId });
    const path = companionAvatarPath(root, identity.playerId, identity);
    await mkdir(dirname(path), { recursive: true });
    const outsideFile = join(outside, "sentinel.png");
    await writeFile(outsideFile, pngPictureFile());
    try {
      await symlink(outsideFile, path, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip("symlink fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(service.read(handle), /companion_avatar_unreadable/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test(
  "a directory junction cannot replace the companion root the avatar is read from",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await canonicalTestRoot("tavern-avatar-junction-");
    const outside = await canonicalTestRoot("tavern-avatar-junction-outside-");
    try {
      const service = serviceFor(root, { [handle]: identity.companionId });
      const path = companionAvatarPath(root, identity.playerId, identity);
      await writeFile(join(outside, COMPANION_AVATAR_FILE_NAME), pngPictureFile());
      await mkdir(dirname(dirname(path)), { recursive: true });
      await symlink(outside, dirname(path), "junction");
      await assert.rejects(service.read(handle), /companion_avatar_unreadable/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  },
);
