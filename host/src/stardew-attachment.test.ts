import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StardewAttachmentFlow } from "./stardew-attachment.js";

const token = "test-session-token-012345";
const baseSession = {
  schemaVersion: 1,
  integrationId: "stardew",
  integrationVersion: "0.1.0",
  gameVersion: "1.6.15",
  gameBuildNumber: 24356,
  smapiVersion: "4.5.2",
  multiplayerProtocol: "1.6.15",
  endpoint: "127.0.0.1:24642",
  saveId: "save_01",
  worldId: "world_01",
  hostPlayerId: "world_01",
  runtimeRole: "player_host",
  launchGeneration: "generation_01",
  publishedAtUnixMs: 1_000,
  expiresAtUnixMs: 20_000,
  nonce: "nonce_01",
  state: "ready",
  cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "", boundCompanionId: "", isBusy: false }],
  signature: "",
};

function signed<T extends { signature: string }>(value: T): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", token).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
  };
}

test("Stardew attachment flow requires explicit confirmation and emits only a bounded request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(signed(baseSession)));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    const session = await flow.readLiveSession();
    await assert.rejects(() => flow.confirmAndRequest(session), /user_confirmation_required/);
    const requestId = await flow.confirmAndRequest(session, { confirmed: true });
    const request = JSON.parse(await readFile(join(directory, "stardew-attachment-request.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(request.requestId, requestId);
    assert.equal(request.endpoint, undefined);
    assert.equal(request.expectedFarmhandId, "");
    assert.equal(typeof request.signature, "string");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow rejects stale or unauthenticated advertisements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    await writeFile(
      join(directory, "stardew-session.json"),
      JSON.stringify({ ...baseSession, signature: "tampered-session-signature" }),
    );
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    await assert.rejects(() => flow.readLiveSession(), /authentication_failed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow waits for the answer to its own request, and a manifest for another request never lands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed(baseSession);
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    const otherRequest = signed({
      schemaVersion: 1,
      requestId: "request_other",
      state: "rejected",
      reasonCode: "request_replayed",
      updatedAtUnixMs: 2_001,
      signature: "",
    });
    await writeFile(join(directory, "stardew-attachment-response.json"), JSON.stringify(otherRequest));
    const requestFile = join(directory, "stardew-attachment-response.json");
    const pending = flow.waitForResponse("request_01", 2_000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    const finalResponse = signed({
      schemaVersion: 1,
      requestId: "request_01",
      state: "rejected",
      reasonCode: "binding_readback_mismatch",
      updatedAtUnixMs: 2_100,
      signature: "",
    });
    await writeFile(requestFile, JSON.stringify(finalResponse));
    const result = await pending;
    assert.equal(result.state, "rejected");
    assert.equal(result.reasonCode, "binding_readback_mismatch");

    const mismatch = signed({
      schemaVersion: 1,
      requestId: "request_02",
      state: "ready",
      reasonCode: "manifest_issued",
      updatedAtUnixMs: 2_200,
      manifestPath: "stardew-farmhand-manifest.json",
      signature: "",
    });
    await writeFile(requestFile, JSON.stringify(mismatch));
    await assert.rejects(
      () => flow.waitForManifest("request_01", 200),
      /stardew_attachment_rejected_binding_readback_mismatch|stardew_attachment_timeout/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a response state this Mod no longer answers is refused at once, not waited out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(signed(baseSession)));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    const stale = signed({
      schemaVersion: 1,
      requestId: "request_01",
      state: "awaiting_save",
      reasonCode: "binding_persist_pending",
      updatedAtUnixMs: 2_001,
      signature: "",
    });
    await writeFile(join(directory, "stardew-attachment-response.json"), JSON.stringify(stale));
    const startedAtMs = Date.now();
    await assert.rejects(() => flow.waitForResponse("request_01", 5_000), /invalid_stardew_response/);
    assert.ok(Date.now() - startedAtMs < 1_500);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an attachment the Mod calls uncertain is read by its reason, not refused as an invalid response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(signed(baseSession)));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    const uncertain = signed({
      schemaVersion: 1,
      requestId: "request_01",
      state: "uncertain",
      reasonCode: "manifest_publication_failed",
      updatedAtUnixMs: 2_001,
      signature: "",
    });
    await writeFile(join(directory, "stardew-attachment-response.json"), JSON.stringify(uncertain));
    await assert.rejects(
      () => flow.waitForManifest("request_01", 500),
      /stardew_attachment_rejected_manifest_publication_failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow retries only a transient advertisement publication hand-off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const readySession = signed({
      ...baseSession,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    const transientSession = signed({ ...readySession, state: "host_not_ready" });
    const manifest = signed({
      schemaVersion: 1,
      requestId: "request_01",
      integrationId: "stardew",
      integrationVersion: "0.1.0",
      gameVersion: "1.6.15",
      gameBuildNumber: 24356,
      smapiVersion: "4.5.2",
      multiplayerProtocol: "1.6.15",
      endpoint: "127.0.0.1:24642",
      saveId: readySession.saveId,
      worldId: readySession.worldId,
      companionId: "companion_01",
      farmhandId: "123456789",
      cabinId: "cabin_01",
      sessionNonce: readySession.nonce,
      issuedAtUnixMs: 2_000,
      expiresAtUnixMs: 19_000,
      signature: "",
    });
    const response = signed({
      schemaVersion: 1,
      requestId: "request_01",
      state: "ready",
      reasonCode: "manifest_issued",
      updatedAtUnixMs: 2_000,
      manifestPath: "stardew-farmhand-manifest.json",
      signature: "",
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(transientSession));
    await writeFile(join(directory, "stardew-attachment-response.json"), JSON.stringify(response));
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(manifest));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    const pending = flow.waitForManifest("request_01", 2_000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(readySession));
    assert.equal((await pending).requestId, "request_01");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a first binding reaches the Host on the advertisement beat after the manifest, not before it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    // THE LIVE SHAPE OF A FIRST ATTACHMENT (run r19, 2026-11-21). A Cabin the press binds is empty,
    // its Farmhand is drawn inside the request the Mod accepts, and the advertisement is
    // republished on the Mod's own one-second beat. The beat the Host reads at the press therefore
    // still reports the Cabin it published - no owner, no binding - and only the next beat carries
    // what the manifest names. Waiting for that beat is the difference between a hand-off and a lie.
    const beforeTheBinding = signed({
      ...baseSession,
      publishedAtUnixMs: 1_000,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "", boundCompanionId: "", isBusy: false }],
    });
    const carryingTheBinding = signed({
      ...baseSession,
      publishedAtUnixMs: 2_000,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(beforeTheBinding));
    await writeFile(
      join(directory, "stardew-attachment-response.json"),
      JSON.stringify(
        signed({
          schemaVersion: 1,
          requestId: "request_01",
          state: "ready",
          reasonCode: "manifest_issued",
          updatedAtUnixMs: 1_500,
          manifestPath: "stardew-farmhand-manifest.json",
          signature: "",
        }),
      ),
    );
    await writeFile(
      join(directory, "stardew-farmhand-manifest.json"),
      JSON.stringify(
        signed({
          schemaVersion: 1,
          requestId: "request_01",
          integrationId: "stardew",
          integrationVersion: "0.1.0",
          gameVersion: "1.6.15",
          gameBuildNumber: 24356,
          smapiVersion: "4.5.2",
          multiplayerProtocol: "1.6.15",
          endpoint: "127.0.0.1:24642",
          saveId: baseSession.saveId,
          worldId: baseSession.worldId,
          companionId: "companion_01",
          farmhandId: "123456789",
          cabinId: "cabin_01",
          sessionNonce: baseSession.nonce,
          issuedAtUnixMs: 1_500,
          expiresAtUnixMs: 12_000,
          signature: "",
        }),
      ),
    );
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    const pending = flow.waitForManifest("request_01", 2_000);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(carryingTheBinding));
    assert.equal((await pending).farmhandId, "123456789");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a binding the world never publishes after the manifest is refused, not waited out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    // The same empty Cabin on the beat published AFTER the manifest: the world had its beat to
    // publish the binding the manifest names and did not, which is the mismatch this check exists for.
    await writeFile(
      join(directory, "stardew-session.json"),
      JSON.stringify(
        signed({
          ...baseSession,
          publishedAtUnixMs: 2_000,
          cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "", boundCompanionId: "", isBusy: false }],
        }),
      ),
    );
    await writeFile(
      join(directory, "stardew-farmhand-manifest.json"),
      JSON.stringify(
        signed({
          schemaVersion: 1,
          requestId: "request_01",
          integrationId: "stardew",
          integrationVersion: "0.1.0",
          gameVersion: "1.6.15",
          gameBuildNumber: 24356,
          smapiVersion: "4.5.2",
          multiplayerProtocol: "1.6.15",
          endpoint: "127.0.0.1:24642",
          saveId: baseSession.saveId,
          worldId: baseSession.worldId,
          companionId: "companion_01",
          farmhandId: "123456789",
          cabinId: "cabin_01",
          sessionNonce: baseSession.nonce,
          issuedAtUnixMs: 1_500,
          expiresAtUnixMs: 12_000,
          signature: "",
        }),
      ),
    );
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    await assert.rejects(
      () => flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01"),
      /stardew_manifest_cabin_binding_mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow accepts signed 64-bit negative native IDs in unrelated cabins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed({
      ...baseSession,
      cabins: [
        { cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false },
        { cabinId: "cabin_02", ownerFarmhandId: "-1928590176183130079", boundCompanionId: "", isBusy: false },
      ],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      expectedFarmhandId: "123456789",
      nowMs: () => 2_000,
    });
    const requestId = await flow.confirmAndRequest(await flow.readLiveSession(), { confirmed: true });
    assert.match(requestId, /^[a-f0-9]{32}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow rejects signed manifests with a different save/world scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed({
      ...baseSession,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    const manifest = signed({
      schemaVersion: 1,
      requestId: "request_01",
      integrationId: "stardew",
      integrationVersion: "0.1.0",
      gameVersion: "1.6.15",
      gameBuildNumber: 24356,
      smapiVersion: "4.5.2",
      multiplayerProtocol: "1.6.15",
      endpoint: "127.0.0.1:24642",
      saveId: "other_save",
      worldId: session.worldId,
      companionId: "companion_01",
      farmhandId: "123456789",
      cabinId: "cabin_01",
      sessionNonce: session.nonce,
      issuedAtUnixMs: 2_000,
      expiresAtUnixMs: 19_000,
      signature: "",
    });
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(manifest));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    await assert.rejects(
      () => flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01"),
      /stardew_manifest_session_mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow rejects a tampered manifest before it can be consumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed({
      ...baseSession,
      // The beat that answers this manifest is published AFTER it: the world had its own
      // one-second chance to report the Cabin's owner and reported someone else.
      publishedAtUnixMs: 2_500,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    const manifest = signed({
      schemaVersion: 1,
      requestId: "request_01",
      integrationId: "stardew",
      integrationVersion: "0.1.0",
      gameVersion: "1.6.15",
      gameBuildNumber: 24356,
      smapiVersion: "4.5.2",
      multiplayerProtocol: "1.6.15",
      endpoint: "127.0.0.1:24642",
      saveId: session.saveId,
      worldId: session.worldId,
      companionId: "companion_01",
      farmhandId: "123456789",
      cabinId: "cabin_01",
      sessionNonce: session.nonce,
      issuedAtUnixMs: 2_000,
      expiresAtUnixMs: 19_000,
      signature: "",
    });
    await writeFile(
      join(directory, "stardew-farmhand-manifest.json"),
      JSON.stringify({ ...manifest, farmhandId: "987654321" }),
    );
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    await assert.rejects(
      () => flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01"),
      /stardew_manifest_cabin_binding_mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow rejects a manifest with a tampered signature", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed({
      ...baseSession,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    const manifest = signed({
      schemaVersion: 1,
      requestId: "request_01",
      integrationId: "stardew",
      integrationVersion: "0.1.0",
      gameVersion: "1.6.15",
      gameBuildNumber: 24356,
      smapiVersion: "4.5.2",
      multiplayerProtocol: "1.6.15",
      endpoint: "127.0.0.1:24642",
      saveId: session.saveId,
      worldId: session.worldId,
      companionId: "companion_01",
      farmhandId: "123456789",
      cabinId: "cabin_01",
      sessionNonce: session.nonce,
      issuedAtUnixMs: 2_000,
      expiresAtUnixMs: 19_000,
      signature: "",
    });
    await writeFile(
      join(directory, "stardew-farmhand-manifest.json"),
      JSON.stringify({ ...manifest, signature: "tampered-manifest-signature" }),
    );
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    await assert.rejects(
      () => flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01"),
      /stardew_manifest_authentication_failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow accepts the Host fixed manifest filename only after session binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed({
      ...baseSession,
      // Published after this manifest's issuance, so the Cabin's owner below is the world's answer
      // rather than a beat that predates the binding.
      publishedAtUnixMs: 2_500,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    const manifest = signed({
      schemaVersion: 1,
      requestId: "request_01",
      integrationId: "stardew",
      integrationVersion: "0.1.0",
      gameVersion: "1.6.15",
      gameBuildNumber: 24356,
      smapiVersion: "4.5.2",
      multiplayerProtocol: "1.6.15",
      endpoint: "127.0.0.1:24642",
      saveId: session.saveId,
      worldId: session.worldId,
      companionId: "companion_01",
      farmhandId: "123456789",
      cabinId: "cabin_01",
      sessionNonce: session.nonce,
      issuedAtUnixMs: 2_000,
      expiresAtUnixMs: 19_000,
      signature: "",
    });
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(manifest));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    const result = await flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01");
    assert.equal(result.farmhandId, "123456789");
    await assert.rejects(
      () => flow.readIssuedManifest(join(directory, "other.json"), "request_01"),
      /invalid_manifest_path/,
    );

    const wrongCabinBinding = signed({ ...manifest, farmhandId: "987654321", signature: "" });
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(wrongCabinBinding));
    await assert.rejects(
      () => flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01"),
      /stardew_manifest_cabin_binding_mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A manifest exactly as the Mod writes it: camelCase keys in the C# record's
// declaration order, with `observedSaveSlot` between `worldId` and `companionId`.
// The signature is over this exact serialized object, so the slot is inside the
// signed bytes on both sides.
function modShapedManifest(
  input: Readonly<{
    session: Readonly<{ saveId: string; worldId: string; nonce: string }>;
    observedSaveSlot?: string;
  }>,
) {
  return signed({
    schemaVersion: 1,
    requestId: "request_01",
    integrationId: "stardew",
    integrationVersion: "0.1.0",
    gameVersion: "1.6.15",
    gameBuildNumber: 24356,
    smapiVersion: "4.5.2",
    multiplayerProtocol: "1.6.15",
    endpoint: "127.0.0.1:24642",
    saveId: input.session.saveId,
    worldId: input.session.worldId,
    observedSaveSlot: input.observedSaveSlot,
    companionId: "companion_01",
    farmhandId: "123456789",
    cabinId: "cabin_01",
    sessionNonce: input.session.nonce,
    issuedAtUnixMs: 2_000,
    expiresAtUnixMs: 19_000,
    signature: "",
  });
}

test("Stardew attachment flow exposes the observed save slot from inside the signed manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed({
      ...baseSession,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    const manifest = modShapedManifest({ session, observedSaveSlot: "GameBuddyFarm_445094166" });
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(manifest));

    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });

    const result = await flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01");
    assert.equal(result.observedSaveSlot, "GameBuddyFarm_445094166");

    // The slot is part of the signed bytes: changing it without re-signing the
    // manifest must fail authentication, not silently change the binding ref.
    await writeFile(
      join(directory, "stardew-farmhand-manifest.json"),
      JSON.stringify({ ...manifest, observedSaveSlot: "OtherFarm_445094166" }),
    );
    await assert.rejects(
      () => flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01"),
      /stardew_manifest_authentication_failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow rejects an observed save slot that is not a redacted basename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed({
      ...baseSession,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });

    for (const slot of [
      "C:/Users/player/AppData/Roaming/StardewValley/Saves/GameBuddyFarm_1",
      "GameBuddy Farm_1",
      "GameBuddyFarm",
      "GameBuddyFarm_445094166.json",
      "",
    ]) {
      await writeFile(
        join(directory, "stardew-farmhand-manifest.json"),
        JSON.stringify(modShapedManifest({ session, observedSaveSlot: slot })),
      );
      await assert.rejects(
        () => flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01"),
        /invalid_stardew_manifest/,
        `slot ${JSON.stringify(slot)} must not be accepted`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment flow still accepts a manifest published without the observed save slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    const session = signed({
      ...baseSession,
      cabins: [{ cabinId: "cabin_01", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
    });
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(session));
    // `JSON.stringify` drops the undefined key, so the Mod-less fixture and its
    // signature cover the same bytes: a manifest without the field is valid.
    const withoutSlot = modShapedManifest({ session });
    await writeFile(join(directory, "stardew-farmhand-manifest.json"), JSON.stringify(withoutSlot));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });

    const result = await flow.readIssuedManifest("stardew-farmhand-manifest.json", "request_01");
    assert.equal(result.observedSaveSlot, undefined);
    assert.equal(result.farmhandId, "123456789");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stardew attachment sole verifier requires exact player-host runtime role and generation", async () => {
  const validDirectory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    await writeFile(join(validDirectory, "stardew-session.json"), JSON.stringify(signed(baseSession)));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: validDirectory,
      sessionToken: token,
      companionId: "companion_01",
      cabinId: "cabin_01",
      nowMs: () => 2_000,
    });
    const session = await flow.readLiveSession();
    assert.equal(session.runtimeRole, "player_host");
    assert.equal(session.launchGeneration, "generation_01");
  } finally {
    await rm(validDirectory, { recursive: true, force: true });
  }

  const invalidVariants: Array<Readonly<{ label: string; value: Record<string, unknown> }>> = [];
  const wrongRole = { ...baseSession, runtimeRole: "farmhand_client", signature: "" } as Record<string, unknown>;
  invalidVariants.push({ label: "wrong runtime role", value: wrongRole });
  const missingRole = { ...baseSession, signature: "" } as Record<string, unknown>;
  delete missingRole.runtimeRole;
  invalidVariants.push({ label: "missing runtime role", value: missingRole });
  const missingGeneration = { ...baseSession, signature: "" } as Record<string, unknown>;
  delete missingGeneration.launchGeneration;
  invalidVariants.push({ label: "missing launch generation", value: missingGeneration });
  const tamperedRole = { ...signed(baseSession), runtimeRole: "farmhand_client" } as Record<string, unknown>;
  invalidVariants.push({ label: "tampered runtime role", value: tamperedRole });
  const tamperedGeneration = { ...signed(baseSession), launchGeneration: "generation_02" } as Record<string, unknown>;
  invalidVariants.push({ label: "tampered launch generation", value: tamperedGeneration });

  for (const variant of invalidVariants) {
    const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
    try {
      const unsigned = { ...variant.value };
      const signature = unsigned.signature;
      delete unsigned.signature;
      const signedValue =
        typeof signature === "string" && signature.length > 0
          ? variant.value
          : {
              ...variant.value,
              signature: createHmac("sha256", token).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
            };
      await writeFile(join(directory, "stardew-session.json"), JSON.stringify(signedValue));
      const flow = new StardewAttachmentFlow({
        sessionDirectory: directory,
        sessionToken: token,
        companionId: "companion_01",
        cabinId: "cabin_01",
        nowMs: () => 2_000,
      });
      await assert.rejects(
        () => flow.readLiveSession(),
        /invalid_stardew_session|stardew_session_authentication_failed/,
        variant.label,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

/**
 * The cabin-occupancy probe, one case per answer, each over a real `stardew-session.json` written by
 * the same signer the Mod's own beats are written with.
 *
 * The expectation is the attempt's own: this save, this world, and the farmhand the admitted manifest
 * named. `now` is held at 2_000 ms, so the document's own expiry and this module's publication-age
 * bound are the only things that decide freshness.
 */
const OCCUPANCY_EXPECTED = { saveId: "save_01", worldId: "world_01", farmhandId: "123456789" };

function occupancyFlow(directory: string, nowMs = 2_000): StardewAttachmentFlow {
  return new StardewAttachmentFlow({
    sessionDirectory: directory,
    sessionToken: token,
    companionId: "companion_01",
    cabinId: "cabin_01",
    nowMs: () => nowMs,
  });
}

async function withSessionDocument(document: unknown, run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-"));
  try {
    if (document !== null) await writeFile(join(directory, "stardew-session.json"), String(document));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("cabin occupancy: a live advertisement that holds neither her nor the manifest's farmhand answers not_bound", async () => {
  await withSessionDocument(JSON.stringify(signed(baseSession)), async (directory) => {
    assert.deepEqual(await occupancyFlow(directory).readCabinOccupancy(OCCUPANCY_EXPECTED), { status: "not_bound" });
  });
});

test("cabin occupancy: a live advertisement whose cabin holds her answers already_bound with that cabin", async () => {
  const session = signed({
    ...baseSession,
    cabins: [{ cabinId: "cabin_07", ownerFarmhandId: "123456789", boundCompanionId: "companion_01", isBusy: false }],
  });
  await withSessionDocument(JSON.stringify(session), async (directory) => {
    assert.deepEqual(await occupancyFlow(directory).readCabinOccupancy(OCCUPANCY_EXPECTED), {
      status: "already_bound",
      cabinId: "cabin_07",
      boundBy: "companion",
    });
  });
});

/**
 * The shape the live run actually published one beat before the formal attachment: the Mod binds the
 * farmhand the manifest named into the chosen cabin when it accepts the request
 * (`SMAPI-latest.txt` 04:34:50, `wrote 1 Farmhand binding(s) into the engine's save cycle`), and
 * `boundCompanionId` only catches up on a later beat (04:35:01). A probe that looked at the companion
 * column alone would answer `not_bound` here and release the quarantine into a second manifest.
 */
test("cabin occupancy: a cabin holding the manifest's farmhand is already_bound, never not_bound", async () => {
  const session = signed({
    ...baseSession,
    cabins: [
      { cabinId: "cabin_01", ownerFarmhandId: "987654321", boundCompanionId: "", isBusy: false },
      { cabinId: "cabin_02", ownerFarmhandId: "123456789", boundCompanionId: "", isBusy: false },
    ],
  });
  await withSessionDocument(JSON.stringify(session), async (directory) => {
    assert.deepEqual(await occupancyFlow(directory).readCabinOccupancy(OCCUPANCY_EXPECTED), {
      status: "already_bound",
      cabinId: "cabin_02",
      boundBy: "manifest_farmhand",
    });
  });
});

test("cabin occupancy: an advertisement past its own expiry answers unknown, never not_bound", async () => {
  const session = signed({ ...baseSession, publishedAtUnixMs: 1_000, expiresAtUnixMs: 1_900 });
  await withSessionDocument(JSON.stringify(session), async (directory) => {
    assert.deepEqual(await occupancyFlow(directory).readCabinOccupancy(OCCUPANCY_EXPECTED), {
      status: "unknown",
      reason: "session_document_stale",
    });
  });
});

test("cabin occupancy: an advertisement whose publisher stopped answers unknown even while its own expiry claims life", async () => {
  // Seven beats after the stamp, with an hour of claimed life left: the publisher is gone, so the
  // document describes a world this Host has no way to know is still the one it describes.
  const session = signed({ ...baseSession, publishedAtUnixMs: 1_000, expiresAtUnixMs: 3_600_000 });
  await withSessionDocument(JSON.stringify(session), async (directory) => {
    assert.deepEqual(await occupancyFlow(directory, 8_000).readCabinOccupancy(OCCUPANCY_EXPECTED), {
      status: "unknown",
      reason: "session_document_stale",
    });
  });
});

test("cabin occupancy: an unreadable, missing or forged advertisement answers unknown", async () => {
  const cases = [
    {
      label: "truncated document",
      document: '{"schemaVersion":1,"integrationId":"stardew"',
      reason: "session_document_unreadable",
    },
    { label: "missing document", document: null, reason: "session_document_missing" },
    {
      label: "forged signature",
      document: JSON.stringify({ ...baseSession, signature: "tampered-session-signature" }),
      reason: "session_document_unauthenticated",
    },
    {
      label: "published ahead of this Host's clock",
      document: JSON.stringify(signed({ ...baseSession, publishedAtUnixMs: 40_000, expiresAtUnixMs: 60_000 })),
      reason: "session_document_clock_ahead",
    },
  ] as const;
  for (const item of cases) {
    await withSessionDocument(item.document, async (directory) => {
      assert.deepEqual(
        await occupancyFlow(directory).readCabinOccupancy(OCCUPANCY_EXPECTED),
        { status: "unknown", reason: item.reason },
        item.label,
      );
    });
  }
});

test("cabin occupancy: an advertisement of another save proves nothing about this attempt's save", async () => {
  // The player loaded a different save in the same game: the same per-attempt session directory now
  // carries a world this attempt never published into.
  const session = signed({ ...baseSession, saveId: "save_02", worldId: "world_02" });
  await withSessionDocument(JSON.stringify(session), async (directory) => {
    assert.deepEqual(await occupancyFlow(directory).readCabinOccupancy(OCCUPANCY_EXPECTED), {
      status: "unknown",
      reason: "session_document_other_world",
    });
  });
});

test("cabin occupancy: a host that is not ready, or speaks another protocol, answers unknown", async () => {
  const cases = [
    { state: "host_not_ready", reason: "session_host_not_ready" },
    { state: "protocol_mismatch", reason: "session_protocol_mismatch" },
  ] as const;
  for (const item of cases) {
    await withSessionDocument(JSON.stringify(signed({ ...baseSession, state: item.state })), async (directory) => {
      assert.deepEqual(
        await occupancyFlow(directory).readCabinOccupancy(OCCUPANCY_EXPECTED),
        { status: "unknown", reason: item.reason },
        item.state,
      );
    });
  }
});

test("cabin occupancy: without the manifest's farmhand, absence cannot be proven", async () => {
  // No admitted manifest in hand (a Host that restarted): the companion column alone cannot tell a
  // world the publication never reached from one where the Mod bound the farmhand a beat ago.
  await withSessionDocument(JSON.stringify(signed(baseSession)), async (directory) => {
    assert.deepEqual(await occupancyFlow(directory).readCabinOccupancy({ ...OCCUPANCY_EXPECTED, farmhandId: null }), {
      status: "unknown",
      reason: "manifest_farmhand_unavailable",
    });
  });
});

test("cabin occupancy: the probe reads the document and writes nothing", async () => {
  const session = signed(baseSession);
  await withSessionDocument(JSON.stringify(session), async (directory) => {
    const before = await readdir(directory);
    await occupancyFlow(directory).readCabinOccupancy(OCCUPANCY_EXPECTED);
    assert.deepEqual(await readdir(directory), before, "a probe that wrote would be a second writer of the attempt");
    assert.equal(await readFile(join(directory, "stardew-session.json"), "utf8"), JSON.stringify(session));
  });
});

test("cabin occupancy: a malformed expectation refuses instead of answering", async () => {
  await withSessionDocument(JSON.stringify(signed(baseSession)), async (directory) => {
    const flow = occupancyFlow(directory);
    await assert.rejects(
      () => flow.readCabinOccupancy({ ...OCCUPANCY_EXPECTED, saveId: "../escape" }),
      /invalid_cabin_occupancy_expectation/,
    );
    await assert.rejects(
      () => flow.readCabinOccupancy({ ...OCCUPANCY_EXPECTED, farmhandId: "not-a-native-id" }),
      /invalid_cabin_occupancy_expectation/,
    );
  });
});
