import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { DEFAULT_IDENTITY_PROFILE, identityProfileHash, writeIdentityProfile } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { writeWorldBook } from "../worldbook.js";
import { assembleGameRuntimeContext } from "./game-runtime-context-assembly.js";

// The identity-profile writer takes the Host-owned durable path lock, which
// requires the bound reclaimer exactly as production does.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const IDENTITY = Object.freeze({
  continuityId: "continuity_context_01",
  companionId: "companion_context_01",
  playerId: "player_context_01",
  saveId: "save_context_01",
  worldId: "world_context_01",
});

async function runtimeRootFor(name) {
  const root = await canonicalTestRoot(`game-runtime-context-${name}-`);
  await mkdir(root, { recursive: true });
  return root;
}

const PERSONA_PROFILE = Object.freeze({
  ...DEFAULT_IDENTITY_PROFILE,
  identity: Object.freeze({ name: "Kiko", role: "whale companion", continuity: "one shared journey" }),
  persona: Object.freeze({ core: "gentle and curious", interactionStyle: "warm", expressionStyle: "playful" }),
});

test("assembly reads the same canonical profile and world book the Chat surface consumes", async () => {
  const runtimeRoot = await runtimeRootFor("canonical");
  const paths = resolveRuntimePaths(IDENTITY, runtimeRoot);
  await mkdir(paths.runtimeCwd, { recursive: true });
  await writeIdentityProfile(paths.identityProfilePath, PERSONA_PROFILE);
  await writeWorldBook(join(paths.runtimeCwd, "worldbook.json"), {
    schemaVersion: 1,
    worldBookId: "gamebuddy.worldbook.kiko",
    revision: 3,
    alwaysOnPremise: "The companion is an ocean-dwelling spirit.",
    entries: [
      {
        entryId: "tide",
        title: "Tides",
        content: "Tides follow the moon.",
        scope: "setting",
        provenance: "authored",
        tokenBudget: "small",
      },
    ],
  });

  const context = await assembleGameRuntimeContext({ identity: IDENTITY, runtimeRoot });
  assert.equal(context.profile?.identity.name, "Kiko");
  assert.equal(context.profile?.persona?.core, "gentle and curious");
  assert.equal(context.worldBook?.metadata.worldBookId, "gamebuddy.worldbook.kiko");
  assert.equal(context.worldBook?.metadata.revision, 3);
  // The world book metadata hash is derived, never trusted from the file.
  assert.match(context.worldBook?.metadata.canonicalHash ?? "", /^[a-f0-9]{64}$/);
});

test("an absent profile or world book yields nothing so the runtime core keeps its own default", async () => {
  const runtimeRoot = await runtimeRootFor("absent");
  const context = await assembleGameRuntimeContext({ identity: IDENTITY, runtimeRoot });
  assert.deepEqual(context, {});
});

test("an explicitly supplied value always wins over the canonical file", async () => {
  const runtimeRoot = await runtimeRootFor("explicit");
  const paths = resolveRuntimePaths(IDENTITY, runtimeRoot);
  await mkdir(paths.runtimeCwd, { recursive: true });
  await writeIdentityProfile(paths.identityProfilePath, PERSONA_PROFILE);

  const explicitProfile = Object.freeze({
    ...DEFAULT_IDENTITY_PROFILE,
    identity: Object.freeze({ name: "Explicit", role: "test", continuity: "test" }),
  });
  const context = await assembleGameRuntimeContext({
    identity: IDENTITY,
    runtimeRoot,
    identityProfile: explicitProfile,
  });
  assert.equal(context.profile?.identity.name, "Explicit");
});

test("invalid canonical files fail closed to the runtime default instead of surfacing broken content", async () => {
  const runtimeRoot = await runtimeRootFor("invalid");
  const paths = resolveRuntimePaths(IDENTITY, runtimeRoot);
  await mkdir(paths.runtimeCwd, { recursive: true });
  // A profile whose stored hash does not match its content must be rejected.
  await writeFile(
    paths.identityProfilePath,
    JSON.stringify({ ...PERSONA_PROFILE, canonicalHash: identityProfileHash(DEFAULT_IDENTITY_PROFILE) }),
    "utf8",
  );
  await writeFile(join(paths.runtimeCwd, "worldbook.json"), "{ not json", "utf8");

  const context = await assembleGameRuntimeContext({ identity: IDENTITY, runtimeRoot });
  assert.deepEqual(context, {});
});

test("assembly never reads a scenario: tavern fiction must not reach the game world", async () => {
  const runtimeRoot = await runtimeRootFor("no-scenario");
  const paths = resolveRuntimePaths(IDENTITY, runtimeRoot);
  await mkdir(paths.runtimeCwd, { recursive: true });
  // A scenario artifact existing next to the profile must have no effect.
  await writeFile(join(paths.runtimeCwd, "scenario.json"), JSON.stringify({ scenario: "tavern fiction" }), "utf8");
  const context = await assembleGameRuntimeContext({ identity: IDENTITY, runtimeRoot });
  assert.equal("scenario" in context, false);
  assert.deepEqual(context, {});
});
