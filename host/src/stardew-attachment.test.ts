import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("Stardew attachment flow waits through awaiting_save and rejects a manifest for another request", async () => {
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
    const response = signed({
      schemaVersion: 1,
      requestId: "request_01",
      state: "awaiting_save",
      reasonCode: "binding_persist_pending",
      updatedAtUnixMs: 2_001,
      signature: "",
    });
    await writeFile(join(directory, "stardew-attachment-response.json"), JSON.stringify(response));
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
      const signedValue = typeof signature === "string" && signature.length > 0
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
