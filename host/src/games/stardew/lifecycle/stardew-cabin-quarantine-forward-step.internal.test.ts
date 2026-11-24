import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StardewAttachmentFlow } from "../../../stardew-attachment.js";
import { decideStardewCabinQuarantineStep } from "./stardew-cabin-quarantine-forward-step.internal.js";

const token = "test-session-token-012345";
const nowMs = 2_000;
const expected = { saveId: "save_01", worldId: "world_01", farmhandId: "123456789" };

const session = {
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
};

function signed<T extends Record<string, unknown>>(value: T): T {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.signature;
  return {
    ...value,
    signature: createHmac("sha256", token).update(JSON.stringify(unsigned), "utf8").digest("base64url"),
  } as T;
}

/** The whole chain over a real document: the probe's answer, then the mapping the release will read. */
async function decideOver(document: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-stardew-forward-step-"));
  try {
    await writeFile(join(directory, "stardew-session.json"), JSON.stringify(document));
    const flow = new StardewAttachmentFlow({
      sessionDirectory: directory,
      sessionToken: token,
      companionId: "companion_01",
      nowMs: () => nowMs,
    });
    const reading = await flow.readCabinOccupancy(expected);
    return {
      occupancy: reading.occupancy,
      reading,
      step: decideStardewCabinQuarantineStep({
        occupancy: reading.occupancy,
        record: "publication_uncertain_quarantine",
      }),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("cabin quarantine: a live save that does not hold her releases the attempt and offers the cabin choice again", async () => {
  const { occupancy, step } = await decideOver(signed(session));
  assert.deepEqual(occupancy, { status: "not_bound" });
  assert.deepEqual(step, { step: "release_and_offer_cabin" });
});

/**
 * THE RED PROOF THIS LANE EXISTS FOR.
 *
 * A stale document is the one reading that would put a SECOND signed manifest into a world the first
 * one may already hold her in. The probe refuses to call a document older than its own publication
 * window fresh, and the decision refuses to release on an `unknown` - so the pair answers
 * `stay_quarantined_with_reason` and names the staleness, even though the document itself lists no
 * cabin for her.
 */
test("cabin quarantine: not_bound from a STALE document stays quarantined and names the staleness", async () => {
  const { occupancy, step } = await decideOver(
    signed({ ...session, publishedAtUnixMs: 1_000, expiresAtUnixMs: 1_400 }),
  );
  assert.deepEqual(occupancy, { status: "unknown", reason: "session_document_stale" });
  assert.deepEqual(step, { step: "stay_quarantined_with_reason", reason: "session_document_stale" });
  // The document really does list no cabin for her: the refusal is about freshness, not about content.
  assert.equal(
    (session.cabins as readonly { boundCompanionId: string }[]).some(
      (cabin) => cabin.boundCompanionId === "companion_01",
    ),
    false,
  );
});

test("cabin quarantine: a save that does hold her advances to moved_in and releases nothing", async () => {
  const { step } = await decideOver(
    signed({
      ...session,
      cabins: [{ cabinId: "cabin_03", ownerFarmhandId: "", boundCompanionId: "companion_01", isBusy: false }],
    }),
  );
  assert.deepEqual(step, { step: "advance_to_moved_in", cabinId: "cabin_03" });
});

test("cabin quarantine: an attempt that is not this publication quarantine is not moved by the probe", () => {
  assert.deepEqual(
    decideStardewCabinQuarantineStep({ occupancy: { status: "not_bound" }, record: "other_attempt_state" }),
    { step: "stay_quarantined_with_reason", reason: "record_is_not_a_publication_quarantine" },
  );
  // She being in the save is a fact about the player's world, not about a record: it decides the
  // surface wherever it is found, and the record keeps its quarantine either way.
  assert.deepEqual(
    decideStardewCabinQuarantineStep({
      occupancy: { status: "already_bound", cabinId: "cabin_03", boundBy: "companion" },
      record: "other_attempt_state",
    }),
    { step: "advance_to_moved_in", cabinId: "cabin_03" },
  );
});

test("cabin quarantine: every unknown the probe can answer stays quarantined with its own reason", () => {
  const reasons = [
    "session_document_missing",
    "session_document_unreadable",
    "session_document_unauthenticated",
    "session_document_stale",
    "session_document_clock_ahead",
    "session_document_other_world",
    "session_host_not_ready",
    "session_protocol_mismatch",
    "manifest_farmhand_unavailable",
  ] as const;
  for (const reason of reasons)
    assert.deepEqual(
      decideStardewCabinQuarantineStep({
        occupancy: { status: "unknown", reason },
        record: "publication_uncertain_quarantine",
      }),
      { step: "stay_quarantined_with_reason", reason },
      reason,
    );
});
