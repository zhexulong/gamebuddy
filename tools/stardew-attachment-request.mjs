import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { StardewAttachmentFlow } = await loadHostProductionModule("stardew-attachment.js");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const sessionDirectory = option("--session-directory");
const hostConfigPath = option("--host-config");
const expectedFarmhandId = option("--expected-farmhand-id");
const timeoutMs = Number(option("--timeout-ms"));
const hostConfig = JSON.parse((await readFile(hostConfigPath, "utf8")).replace(/^\uFEFF/, ""));
const hostProvisioning = hostConfig.HostFarmhandProvisioning;
if (!hostProvisioning?.SessionToken || !hostConfig.CompanionId) throw new Error("invalid_host_profile");

const deadline = Date.now() + timeoutMs;
let lastError = "attachment_not_started";
let requestId;
let manifest;
let flow;
while (Date.now() < deadline) {
  try {
    if (requestId === undefined) {
      const session = await readLiveSessionWithRetry();
      flow = new StardewAttachmentFlow({
        sessionDirectory,
        sessionToken: hostProvisioning.SessionToken,
        companionId: hostConfig.CompanionId,
        cabinId: findCabinId(session, expectedFarmhandId),
        expectedFarmhandId,
      });
      requestId = await flow.confirmAndRequest(session, { confirmed: true, expectedFarmhandId });
    }
    manifest = await flow.waitForManifest(requestId, Math.min(1_000, Math.max(1, deadline - Date.now())));
    break;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    // `awaiting_save` is consumed inside waitForResponse() as a bounded
    // intermediate state. Once waitForManifest() throws a signed
    // `stardew_attachment_rejected_*`, it is terminal regardless of its reason
    // code; never reinterpret a rejected response as save lifecycle progress.
    if (requestId !== undefined && /stardew_attachment_rejected_/.test(lastError)) throw error;
    if (
      !/stardew_session_(expired|host_not_ready|awaiting_save)|ENOENT|invalid_stardew_session|cabin_missing|target_cabin_not_unique|stardew_attachment_timeout/.test(
        lastError,
      )
    )
      throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!manifest) throw new Error(lastError);
console.log(
  JSON.stringify(
    {
      state: "ready",
      requestId,
      companionId: manifest.companionId,
      farmhandId: manifest.farmhandId,
      cabinId: manifest.cabinId,
      saveId: manifest.saveId,
      worldId: manifest.worldId,
      sessionNoncePresent: Boolean(manifest.sessionNonce),
      manifestExpiresAtUnixMs: manifest.expiresAtUnixMs,
    },
    null,
    2,
  ),
);

async function readLiveSessionWithRetry() {
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(`${sessionDirectory}/stardew-session.json`, "utf8");
      const candidate = JSON.parse(raw);
      const cabinId = findCabinId(candidate, expectedFarmhandId);
      const flow = new StardewAttachmentFlow({
        sessionDirectory,
        sessionToken: hostProvisioning.SessionToken,
        companionId: hostConfig.CompanionId,
        cabinId,
        expectedFarmhandId,
      });
      return await flow.readLiveSession();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (
        !/stardew_session_(expired|host_not_ready)|ENOENT|invalid_stardew_session|cabin_missing|target_cabin_not_unique/.test(
          lastError,
        )
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(lastError);
}

function findCabinId(session, farmhandId) {
  const matches = Array.isArray(session.cabins)
    ? session.cabins.filter((cabin) => cabin.ownerFarmhandId === farmhandId)
    : [];
  if (matches.length !== 1) throw new Error("target_cabin_not_unique");
  return matches[0].cabinId;
}
