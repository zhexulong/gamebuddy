import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StardewAttachmentFlow } from "./stardew-attachment.js";
import {
  createStardewIssuedJoinManifestSource,
  createStardewWorldCreationBindingSeam,
  STARDEW_GAME_WORLD_CREATION_INTEGRATION_CONFLICT,
  STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE,
  STARDEW_GAME_WORLD_CREATION_SLOT_INVALID,
  STARDEW_GAME_WORLD_CREATION_SLOT_MISSING,
  STARDEW_WORLD_CREATION_MANIFEST_ABSENT,
  type StardewIssuedJoinManifestSource,
} from "./stardew-owned-farmhand-game-world-creation-seam.internal.js";

const SESSION_TOKEN = "world-creation-seam-token-012345";
const REQUEST_ID = "request_world_creation_01";
const OBSERVED_SLOT = "GameBuddyFarm_445094166";
const CREATE_INPUT = Object.freeze({
  gameSessionId: "session_world_creation",
  integrationId: "stardew",
  worldRequest: Object.freeze({}),
});

function signed<T extends { signature: string }>(value: T): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", SESSION_TOKEN).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
  };
}

function worldSession() {
  return {
    schemaVersion: 1,
    integrationId: "stardew",
    integrationVersion: "0.1.0",
    gameVersion: "1.6.15",
    gameBuildNumber: 24356,
    smapiVersion: "4.5.2",
    multiplayerProtocol: "1.6.15",
    endpoint: "127.0.0.1:24642",
    saveId: "save_world_creation",
    worldId: "world_world_creation",
    hostPlayerId: "world_world_creation",
    runtimeRole: "player_host",
    launchGeneration: "player-generation-1",
    publishedAtUnixMs: 1_000,
    expiresAtUnixMs: 60_000,
    nonce: "nonce_world_creation",
    state: "ready",
    cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    signature: "",
  };
}

/** A manifest exactly as the Mod writes it: `observedSaveSlot` between `worldId` and `companionId`. */
function joinManifest(observedSaveSlot?: string) {
  return signed({
    schemaVersion: 1,
    requestId: REQUEST_ID,
    integrationId: "stardew",
    integrationVersion: "0.1.0",
    gameVersion: "1.6.15",
    gameBuildNumber: 24356,
    smapiVersion: "4.5.2",
    multiplayerProtocol: "1.6.15",
    endpoint: "127.0.0.1:24642",
    saveId: "save_world_creation",
    worldId: "world_world_creation",
    ...(observedSaveSlot === undefined ? {} : { observedSaveSlot }),
    companionId: "companion_01",
    farmhandId: "123456789",
    cabinId: "cabin_01",
    sessionNonce: "nonce_world_creation",
    issuedAtUnixMs: 2_000,
    expiresAtUnixMs: 59_000,
    signature: "",
  });
}

/**
 * Real-time clock anchored inside the fixture's signed validity windows, so the
 * session/manifest fixtures stay deterministic while the seam's create deadline
 * still expires in real time.
 */
async function withSessionDirectory<T>(
  body: (input: Readonly<{ directory: string; clock: () => number }>) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-world-creation-seam-"));
  const startedAtMs = Date.now();
  const clock = () => 2_000 + (Date.now() - startedAtMs);
  try {
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(signed(worldSession())));
    return await body(Object.freeze({ directory, clock }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function seamOver(directory: string, clock: () => number, deadlineMs: number, requestId = REQUEST_ID) {
  const attachmentFlow = new StardewAttachmentFlow({
    sessionDirectory: directory,
    sessionToken: SESSION_TOKEN,
    companionId: "companion_01",
    cabinId: "cabin_01",
    nowMs: clock,
  });
  return createStardewWorldCreationBindingSeam({
    manifestSource: createStardewIssuedJoinManifestSource({ attachmentFlow, requestId }),
    deadlineMs,
    nowMs: clock,
    pollIntervalMs: 5,
  });
}

function rejectsWith(code: string) {
  return (error: unknown): boolean => {
    assert.equal((error as Error).message, code);
    return true;
  };
}

test("(a) returns exactly the observed slot the launched Player Host published and never reads worldRequest", async () => {
  await withSessionDirectory(async ({ directory, clock }) => {
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(joinManifest(OBSERVED_SLOT)));
    const seam = seamOver(directory, clock, clock() + 5_000);
    const result = await seam.createWorldBinding({
      ...CREATE_INPUT,
      // Owner ruling: worldRequest stays a verbatim passthrough. A caller that
      // smuggles owner/session identity into it must not influence the ref.
      worldRequest: Object.freeze({ bindingRef: "fabricated-from-world-request", gameSessionId: "forged" }),
    });
    assert.deepEqual(result, { bindingRef: OBSERVED_SLOT });
    assert.equal(Object.isFrozen(result), true);
  });
});

test("(a) waits for the manifest the Player Host has not published yet, then returns it", async () => {
  await withSessionDirectory(async ({ directory, clock }) => {
    const seam = seamOver(directory, clock, clock() + 5_000);
    const pending = seam.createWorldBinding(CREATE_INPUT);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(joinManifest(OBSERVED_SLOT)));
    assert.deepEqual(await pending, { bindingRef: OBSERVED_SLOT });
  });
});

test("(b) fails closed and produces no ref when the manifest is never issued", async () => {
  await withSessionDirectory(async ({ directory, clock }) => {
    const seam = seamOver(directory, clock, clock() + 40);
    await assert.rejects(
      () => seam.createWorldBinding(CREATE_INPUT),
      rejectsWith(STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE),
    );
  });
});

test("(b) keeps polling the issued manifest until the create deadline instead of failing on the first absence", async () => {
  let attempts = 0;
  const source: StardewIssuedJoinManifestSource = Object.freeze({
    readIssuedJoinManifest: async (): Promise<unknown> => {
      attempts += 1;
      throw new Error(STARDEW_WORLD_CREATION_MANIFEST_ABSENT);
    },
  });
  const seam = createStardewWorldCreationBindingSeam({
    manifestSource: source,
    deadlineMs: Date.now() + 30,
    nowMs: Date.now,
    pollIntervalMs: 1,
  });
  await assert.rejects(
    () => seam.createWorldBinding(CREATE_INPUT),
    rejectsWith(STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE),
  );
  assert.ok(attempts >= 2, `expected repeated waits for the issued manifest, saw ${attempts} attempts`);
});

test("(c) fails closed when the published slot is not a redacted basename", async () => {
  // Through the owner-bound flow the Host reader rejects the manifest itself.
  for (const slot of ["C:/Users/player/Saves/GameBuddyFarm_1", "GameBuddy Farm_1", "GameBuddyFarm", ""]) {
    await withSessionDirectory(async ({ directory, clock }) => {
      await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(joinManifest(slot)));
      const seam = seamOver(directory, clock, clock() + 50);
      await assert.rejects(
        () => seam.createWorldBinding(CREATE_INPUT),
        rejectsWith(STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE),
        `slot ${JSON.stringify(slot)} must not become a binding ref`,
      );
    });
  }
  // And the seam's own slot contract rejects a malformed slot on the manifest it
  // was handed, without ever falling back to another field.
  for (const slot of ["GameBuddy Farm_1", "", "GameBuddyFarm", "GameBuddyFarm_445094166.json", 42, null]) {
    const seam = seamWithRawManifest({ observedSaveSlot: slot });
    await assert.rejects(
      () => seam.createWorldBinding(CREATE_INPUT),
      rejectsWith(STARDEW_GAME_WORLD_CREATION_SLOT_INVALID),
      `slot ${JSON.stringify(slot)} must be rejected`,
    );
  }
});

test("(c) fails closed when the manifest belongs to another attachment request", async () => {
  await withSessionDirectory(async ({ directory, clock }) => {
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(joinManifest(OBSERVED_SLOT)));
    // The seam was bound to this create's own request identity; a manifest the
    // Player Host issued for a different request must never bind this world.
    const seam = seamOver(directory, clock, clock() + 50, "request_world_creation_02");
    await assert.rejects(
      () => seam.createWorldBinding(CREATE_INPUT),
      rejectsWith(STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE),
    );
  });
});

test("(d) never fabricates a slot from the manifest's other identity fields", async () => {
  for (const manifest of [
    { saveId: "save_world_creation", worldId: "world_world_creation", farmhandId: "123456789", cabinId: "cabin_01" },
    // Even a slot-shaped value in another field is not the observed slot.
    { saveId: OBSERVED_SLOT, worldId: "445094166", requestId: OBSERVED_SLOT, sessionNonce: "nonce_world_creation" },
    { observedSaveSlot: undefined, saveId: OBSERVED_SLOT },
  ]) {
    const seam = seamWithRawManifest(manifest);
    await assert.rejects(
      () => seam.createWorldBinding(CREATE_INPUT),
      rejectsWith(STARDEW_GAME_WORLD_CREATION_SLOT_MISSING),
      `manifest ${JSON.stringify(manifest)} must not yield a binding ref`,
    );
  }
});

test("a terminal manifest read failure fails closed without retrying", async () => {
  let attempts = 0;
  const terminal = new Error("stardew_manifest_authentication_failed");
  const seam = createStardewWorldCreationBindingSeam({
    manifestSource: Object.freeze({
      readIssuedJoinManifest: async (): Promise<unknown> => {
        attempts += 1;
        throw terminal;
      },
    }),
    deadlineMs: Date.now() + 60_000,
    pollIntervalMs: 1,
  });
  await assert.rejects(
    () => seam.createWorldBinding(CREATE_INPUT),
    rejectsWith(STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE),
  );
  assert.equal(attempts, 1);
});

test("the seam rejects a foreign integration before it ever reads a manifest", async () => {
  let attempts = 0;
  const seam = createStardewWorldCreationBindingSeam({
    manifestSource: Object.freeze({
      readIssuedJoinManifest: async (): Promise<unknown> => {
        attempts += 1;
        throw new Error(STARDEW_WORLD_CREATION_MANIFEST_ABSENT);
      },
    }),
    deadlineMs: Date.now() + 60_000,
    pollIntervalMs: 1,
  });
  await assert.rejects(
    () => seam.createWorldBinding({ ...CREATE_INPUT, integrationId: "other-integration" }),
    rejectsWith(STARDEW_GAME_WORLD_CREATION_INTEGRATION_CONFLICT),
  );
  await assert.rejects(
    () => seam.createWorldBinding({ ...CREATE_INPUT, gameSessionId: "has space" }),
    rejectsWith(STARDEW_GAME_WORLD_CREATION_INTEGRATION_CONFLICT),
  );
  assert.equal(attempts, 0);
});

test("construction rejects a missing manifest source and a non-opaque request identity", () => {
  assert.throws(
    () => createStardewWorldCreationBindingSeam({ deadlineMs: Date.now() + 1_000 } as never),
    /invalid_stardew_world_creation_manifest_source/,
  );
  assert.throws(
    () =>
      createStardewIssuedJoinManifestSource({
        attachmentFlow: { readIssuedManifest: async () => ({}) } as never,
        requestId: "has space",
      }),
    /invalid_stardew_world_creation_manifest_source/,
  );
});

function seamWithRawManifest(manifest: unknown) {
  return createStardewWorldCreationBindingSeam({
    manifestSource: Object.freeze({ readIssuedJoinManifest: async (): Promise<unknown> => manifest }),
    deadlineMs: Date.now() + 60_000,
  });
}
