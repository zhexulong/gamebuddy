import assert from "node:assert/strict";
import { access, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { identityKey } from "../runtime.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import {
  createNewCompanionService,
  provisionDirectNewCompanion,
  provisionNewCompanion,
} from "./new-companion-service.js";

const hash = "a".repeat(64);

async function cleanupTestRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await assert.rejects(access(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
}

const candidate = {
  schemaVersion: 1 as const,
  revision: 1,
  candidateId: "candidate",
  sourceFormat: "st-v3" as const,
  sourceVersion: "st-v3",
  sourceHash: hash,
  name: "Candidate",
  reviewState: "reviewed" as const,
  fields: [
    { field: "persona_core", text: "calm", eligibility: "profile_eligible_after_explicit_review" as const },
    { field: "name", text: "Candidate", eligibility: "candidate_only" as const },
  ],
};
test("New Companion requires explicit eligible-field review and creates only supplied new metadata", async () => {
  const writes: unknown[] = [];
  const service = createNewCompanionService({
    async create(input) {
      writes.push(input);
      return { schemaVersion: 1 as const, revision: 1, ...input };
    },
  });
  const review = service.review(candidate, { reviewedFields: ["persona_core"], approvedAtMs: 1 });
  const created = await service.create(review, candidate, {
    companionId: "new-companion",
    continuityId: "new-continuity",
    name: "New Buddy",
    profileId: "profile",
    profileRevision: 1,
    profileHash: hash,
  });
  assert.equal(created.companionId, "new-companion");
  assert.equal(writes.length, 1);
  assert.throws(
    () => service.review(candidate, { reviewedFields: ["name"], approvedAtMs: 1 }),
    /invalid_new_companion_review/,
  );
  await assert.rejects(
    service.create({ ...review, sourceHash: "b".repeat(64) }, candidate, {
      companionId: "new-companion",
      continuityId: "new-continuity",
      name: "New Buddy",
      profileId: "profile",
      profileRevision: 1,
      profileHash: hash,
    }),
    /review_required/,
  );
});

test("direct New Companion provisions a fresh opaque identity, continuity, and Host-owned profile without a candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-direct-new-companion-"));
  try {
    const created = await provisionDirectNewCompanion(root, "player", "Direct Buddy");
    assert.match(created.identity.companionId, /^companion-/);
    assert.match(created.identity.continuityId!, /^continuity-/);
    assert.equal(created.profile.identity.name, "Direct Buddy");
    const runtimeRoot = join(root, "contexts", identityKey(created.identity));
    assert.match(await readFile(join(runtimeRoot, "identity-profile.json"), "utf8"), /Direct Buddy/);
    assert.match(
      await readFile(join(runtimeRoot, "identity-profile-binding.json"), "utf8"),
      new RegExp(identityKey(created.identity)),
    );
    await assert.rejects(provisionDirectNewCompanion(root, "player", "\u0000"), /invalid_new_companion_name/);
  } finally {
    await cleanupTestRoot(root);
  }
});

test("New Companion fails closed when runtime namespace is replaced by a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tavern-new-companion-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "tavern-new-companion-outside-"));
  const contextsPath = join(root, "contexts");
  const outsideSentinel = join(outside, "sentinel.txt");
  try {
    await writeFile(outsideSentinel, "outside-sentinel", "utf8");
    try {
      await symlink(outside, contextsPath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))
      ) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(provisionDirectNewCompanion(root, "player", "Blocked Buddy"), /unsafe_path_boundary/);
    assert.equal(await readFile(outsideSentinel, "utf8"), "outside-sentinel");
    await assert.rejects(lstat(join(outside, "identity-profile.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("New Companion provisions a fresh opaque identity and Host-owned profile binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "tavern-new-companion-"));
  try {
    const pending = { ...candidate, reviewState: "pending" as const };
    const review = createNewCompanionService({
      async create() {
        throw new Error("not_used");
      },
    }).review(pending, { reviewedFields: ["persona_core"], approvedAtMs: 9 });
    const created = await provisionNewCompanion(
      root,
      "player",
      pending,
      review,
      createChatThreadStore(root, "b".repeat(64)),
    );
    assert.notEqual(created.identity.companionId, "companion");
    assert.notEqual(created.identity.continuityId, "continuity");
    assert.equal(created.profile.persona?.core, "calm");
    const runtimeRoot = join(root, "contexts", identityKey(created.identity));
    assert.match(
      await readFile(join(runtimeRoot, "identity-profile.json"), "utf8"),
      new RegExp(created.profile.profileId),
    );
    assert.match(
      await readFile(join(runtimeRoot, "identity-profile-binding.json"), "utf8"),
      new RegExp(identityKey(created.identity)),
    );
  } finally {
    await cleanupTestRoot(root);
  }
});
