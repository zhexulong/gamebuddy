import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  type IdentityProfile,
  readIdentityProfile,
  writeIdentityProfile,
} from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveRuntimePaths, type CompanionIdentity } from "../runtime-identity.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { DEFAULT_COMPANION_PRESET } from "./default-companion-preset.js";
import { seedDefaultCompanionIntoFreshRuntimeRoot } from "./default-companion-seed.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { resolveTavernPaths } from "./tavern-paths.js";

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_default_companion",
  companionId: "companion_default_companion",
  playerId: "player_default_companion",
});

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function release(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("a fresh runtime root presents as 琥珀 with the preset's opening and world book", async () => {
  const root = await canonicalTestRoot("default-companion-seed-");
  try {
    const outcome = await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    assert.equal(outcome.seeded, true);
    assert.equal(outcome.reason, "seeded");
    assert.equal(outcome.identityName, "琥珀");
    assert.equal(outcome.profileId, DEFAULT_COMPANION_PRESET.profile.profileId);
    assert.equal(outcome.greetingVariants, DEFAULT_COMPANION_PRESET.greetings.length);

    const paths = resolveRuntimePaths(identity, root);
    const profile = await readIdentityProfile(paths.identityProfilePath);
    assert.equal(profile.identity.name, "琥珀");
    assert.notEqual(profile.identity.name, "GameBuddy Companion");
    assert.ok(profile.persona !== undefined && profile.persona.core.length > 0);

    const book = JSON.parse(await readFile(join(paths.runtimeCwd, "worldbook.json"), "utf8")) as {
      worldBookId: string;
    };
    assert.equal(book.worldBookId, DEFAULT_COMPANION_PRESET.worldBook.worldBookId);

    const record = await createGreetingManagementService(
      new TavernArtifactStore(paths.root),
      resolveTavernPaths(paths, identity).companionRoot,
    ).readExact();
    assert.ok(record !== null);
    assert.equal(record.variants[0]?.text, DEFAULT_COMPANION_PRESET.greetings[0]?.text);
  } finally {
    await release(root);
  }
});

test("a restart after a fresh seed never overwrites the player's edits", async () => {
  const root = await canonicalTestRoot("default-companion-reseed-");
  try {
    await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    const paths = resolveRuntimePaths(identity, root);
    const edited: IdentityProfile = Object.freeze({
      ...DEFAULT_COMPANION_PRESET.profile,
      identity: Object.freeze({ ...DEFAULT_COMPANION_PRESET.profile.identity, name: "我的搭档" }),
    });
    await writeIdentityProfile(paths.identityProfilePath, edited);

    const again = await seedDefaultCompanionIntoFreshRuntimeRoot(identity, root);
    assert.equal(again.seeded, false);
    assert.equal(again.reason, "already_present");
    assert.equal((await readIdentityProfile(paths.identityProfilePath)).identity.name, "我的搭档");
  } finally {
    await release(root);
  }
});
