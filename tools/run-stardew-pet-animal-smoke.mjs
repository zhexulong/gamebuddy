import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0))
  throw new Error("invalid_client_config");
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const startedAt = Date.now();
try {
  if (!client.state.capabilities.includes("pet_animal")) throw new Error("pet_animal_capability_missing");
  let snapshot = await client.observe();
  const readyDeadline = Date.now() + 10_000;
  while (!snapshot.actionable && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await client.observe();
  }
  if (!snapshot.capabilities.includes("pet_animal")) throw new Error("snapshot_pet_animal_capability_missing");
  const target = Array.isArray(snapshot.petTargets)
    ? (snapshot.petTargets.find(
        (entry) =>
          entry.pettedToday === false &&
          typeof entry.targetId === "string" &&
          Number.isInteger(entry.x) &&
          Number.isInteger(entry.y),
      ) ?? null)
    : null;
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_unpetted_pet_target",
        snapshot: summarize(snapshot),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `pet_animal_${Date.now()}`,
      idempotencyKey: `pet_animal_idem_${Date.now()}`,
      action: "pet_animal",
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const afterTarget = after.petTargets?.find((entry) => entry.targetId === target.targetId) ?? null;
    const evidence = typeof receipt.evidence?.detail === "string" ? parseEvidence(receipt.evidence.detail) : {};
    const passed =
      receipt.state === "succeeded" &&
      receipt.reasonCode === "pet_completed" &&
      afterTarget === null &&
      evidence.day_recorded === "true" &&
      evidence.friendship_callback === "true";
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "pet_completed" : receipt.reasonCode,
        target: summarizeTarget(target),
        receipt: summarizeReceipt(receipt),
        after: summarize(after),
        durationMs: Date.now() - startedAt,
      }),
    );
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: client.state.latestReceipt,
    }),
  );
  process.exitCode = 2;
} finally {
  client.close();
}

function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    petTargets: snapshot.petTargets?.length ?? 0,
  };
}
function summarizeTarget(target) {
  return {
    targetId: target.targetId,
    x: target.x,
    y: target.y,
    petType: target.petType,
    friendship: target.friendship,
    pettedToday: target.pettedToday,
  };
}
function summarizeReceipt(receipt) {
  return {
    executionId: receipt.executionId,
    requestId: receipt.requestId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence ?? null,
  };
}
function parseEvidence(detail) {
  return Object.fromEntries(
    detail.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      return separator < 1 ? [] : [[part.slice(0, separator), part.slice(separator + 1)]];
    }),
  );
}
