/**
 * The ONE release of a cabin-press quarantine, behind its four assertions.
 *
 * The quarantine exists because a cabin press's signed manifest WAS admitted and the attach that follows it
 * refused (`stardew_cabin_publication_uncertain`): a second press would write a second manifest into the
 * same world. So the only thing that may free the held attempt is a proof that the first publication did
 * not take effect - and a proof is four facts:
 *
 *   (a) the record under the transaction is the quarantined attempt the evidence was taken under,
 *   (b) the installation registration still names that attempt,
 *   (c) the attempt's Guardian-owned objects are proven gone,
 *   (d) the answer is a fresh `not_bound` about this attempt's own world.
 *
 * Each of them is forced false here on a real seam, and each refusal is asserted by name - a release that
 * cannot say which fact it rested on is not allowed to write anything, and this file is the reading that
 * holds it to that.
 */
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../../../path-lock.js";
import {
  publishStardewInstallationRegistration,
  withStardewLifecycleInstallationRegistrationOwner,
} from "../../../stardew-installation-registration.internal.js";
import { createTestWindowsStaleLockReclaimer } from "../../../windows-stale-lock-reclaimer/index.test-support.js";
import { stardewCabinQuarantineRefusalOf } from "./stardew-private-bootstrap-composer.core.internal.js";
import {
  manifestForAttachment,
  ownerTestView,
  prepareManifestHandoffFixture,
  signedAttachmentSession,
  signedAttachmentValue,
  simulatedLockHelper,
  temporaryRoots,
  waitForPublishedAttachmentRequest,
} from "./stardew-private-bootstrap-composer.test-fixtures.js";

test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
test.after(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SAVE = "save-attachment-factory";
const WORLD = "world-attachment-factory";
const MANIFEST_FARMHAND = "12345";
/** The fixture's clock, so a document stamped here is fresh and one stamped minutes earlier is not. */
const NOW_MS = 1_000;

/**
 * The advertisement a world that does NOT hold her publishes: live, this save and this world, and no cabin
 * carrying either her or the farmhand the admitted manifest named.
 */
function notBoundSession(token: string, overrides: Readonly<{ saveId?: string; worldId?: string }> = {}) {
  return signedAttachmentValue(
    {
      ...signedAttachmentSession(token, "player-generation-1", []),
      saveId: overrides.saveId ?? SAVE,
      worldId: overrides.worldId ?? WORLD,
      hostPlayerId: overrides.worldId ?? WORLD,
      publishedAtUnixMs: NOW_MS,
      expiresAtUnixMs: NOW_MS + 5_000,
    },
    token,
  );
}

/** A Guardian whose two named objects the OS proves gone: the only verdict a release may act on. */
const deadGuardian = async () => ({ playerJob: "not_found" as const, lease: "not_found" as const });

/** One ready registration in the fixture's own root, with no attempt bound yet. */
async function publishReadyRegistration(root: string): Promise<void> {
  await publishStardewInstallationRegistration(root, null, {
    schema: "gamebuddy-stardew-installation-registration/v1",
    binding: { rootLayoutVersion: 1 },
    revision: 1,
    state: "ready",
    locator: "C:\\Games\\Stardew Valley",
    activeAttempt: null,
    instanceGeneration: 0,
  });
}

/**
 * Binds the fixture's attempt into its registration through the SAME seam the composer's prepare-and-bind uses.
 *
 * It happens before the quarantine, because the pointer is bound while the attempt is still `reserved` - which
 * is what the release then finds and re-checks.
 */
async function bindAttempt(root: string, bootstrapId: string, ownerRecordRevision: number): Promise<void> {
  await withStardewLifecycleInstallationRegistrationOwner(root, async (registration) => {
    const current = await registration.readRegistration();
    if (current === null) throw new Error("registration_missing");
    const marker = Object.freeze({
      schema: "gamebuddy-stardew-installation-owner-transaction/v1" as const,
      operation: "prepare_bind" as const,
      bootstrapCorrelation: bootstrapId,
      registrationRevision: current.revision + 1,
      ownerRecordRevision,
    });
    await registration.writeMarker(marker);
    await registration.bindPreparedPointer(current.revision, marker);
    await registration.clearMarker(marker);
  });
}

/**
 * One quarantined cabin attempt, with an admitted manifest and a live advertisement of its own world.
 *
 * The advertisement is written LAST, so every case below starts from the same evidence and differs only in
 * the assertion it forces false.
 */
async function quarantinedAttempt(options: Readonly<{ session?: (token: string) => unknown }> = {}) {
  const fixture = await prepareManifestHandoffFixture();
  const ownerView = ownerTestView(fixture.owner);
  await publishReadyRegistration(fixture.root);
  await bindAttempt(fixture.root, ownerView.record.bootstrapId, ownerView.record.ownerRecordRevision);
  const selection = await fixture.coordinator.select(fixture.owner, "cabin-attachment-factory");
  const pending = fixture.coordinator.confirmAndAdmit(selection, { confirmed: true });
  const request = await waitForPublishedAttachmentRequest(fixture.sessionDirectory);
  const requestId = request.requestId as string;
  await writeFile(
    join(fixture.sessionDirectory, "stardew-attachment-response.json"),
    JSON.stringify(
      signedAttachmentValue(
        {
          schemaVersion: 1,
          requestId,
          state: "ready",
          reasonCode: "manifest_issued",
          updatedAtUnixMs: NOW_MS + 100,
          manifestPath: "stardew-farmhand-manifest.json",
          signature: "",
        },
        fixture.token,
      ),
    ),
  );
  await writeFile(
    join(fixture.sessionDirectory, "stardew-farmhand-manifest.json"),
    JSON.stringify(
      manifestForAttachment({
        token: fixture.token,
        requestId,
        saveId: SAVE,
        worldId: WORLD,
        farmhandId: MANIFEST_FARMHAND,
        nonce: "nonce-attachment-factory",
      }),
    ),
  );
  const admission = await pending;
  await ownerTestView(fixture.owner).quarantine();
  const session = (options.session ?? notBoundSession)(fixture.token);
  await writeFile(join(fixture.sessionDirectory, "stardew-session.json"), JSON.stringify(session));
  return { fixture, admission, owner: fixture.owner, coordinator: fixture.coordinator };
}

/** The refusal a release answered with, or a failure that says it wrote when it should not have. */
async function refusalOf(run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    return stardewCabinQuarantineRefusalOf(error) ?? `unnamed:${String(error)}`;
  }
  return "released";
}

test("a fresh not_bound about this world releases the quarantined attempt", async () => {
  const { fixture, admission, owner, coordinator } = await quarantinedAttempt();
  const evidence = await coordinator.readCabinOccupancy(owner, admission);
  assert.deepEqual(evidence.reading.occupancy, { status: "not_bound" });
  // The evidence names the record it was taken under, and that record is the quarantine.
  assert.equal(evidence.record.state, "quarantined");
  assert.equal(evidence.record.cleanupDisposition, "retry_required");
  assert.equal(evidence.record.bootstrapId, ownerTestView(owner).record.bootstrapId);

  await coordinator.releaseQuarantinedCabinPublication(owner, admission, evidence, deadGuardian);

  // The attempt itself is NOT rewritten: the release is the pointer's bookkeeping, and the record keeps the
  // terminal it reached. What moved is the registration, which is what a new attempt needs.
  assert.equal(ownerTestView(owner).record.state, "quarantined");
  assert.equal(ownerTestView(owner).record.ownerRecordRevision, evidence.record.ownerRecordRevision);
  assert.equal(fixture.root.length > 0, true);
});

test("(a) evidence about another revision of the record releases nothing and says so", async () => {
  const { admission, owner, coordinator } = await quarantinedAttempt();
  const evidence = await coordinator.readCabinOccupancy(owner, admission);
  const stale = {
    ...evidence,
    record: { ...evidence.record, ownerRecordRevision: evidence.record.ownerRecordRevision + 1 },
  };
  assert.equal(
    await refusalOf(() => coordinator.releaseQuarantinedCabinPublication(owner, admission, stale, deadGuardian)),
    "record_is_not_the_quarantined_attempt",
  );
  assert.equal(ownerTestView(owner).record.state, "quarantined", "a refused release leaves the record held");
});

test("(b) a registration that names another attempt releases nothing and says so", async () => {
  const { admission, owner, coordinator } = await quarantinedAttempt();
  const evidence = await coordinator.readCabinOccupancy(owner, admission);
  await coordinator.releaseQuarantinedCabinPublication(owner, admission, evidence, deadGuardian);
  // The pointer is free now, so the SAME evidence names no attempt: the second release is the case a
  // registration that moved under the caller produces, and the record is still the quarantine it was.
  assert.equal(
    await refusalOf(() => coordinator.releaseQuarantinedCabinPublication(owner, admission, evidence, deadGuardian)),
    "registration_names_another_attempt",
  );
  assert.equal(ownerTestView(owner).record.state, "quarantined", "the attempt is untouched by the refusal");
});

test("(c) a Guardian whose objects are still open releases nothing and says so", async () => {
  const { admission, owner, coordinator } = await quarantinedAttempt();
  const evidence = await coordinator.readCabinOccupancy(owner, admission);
  const presentGuardian = async () => ({ playerJob: "opened" as const, lease: "not_found" as const });
  assert.equal(
    await refusalOf(() => coordinator.releaseQuarantinedCabinPublication(owner, admission, evidence, presentGuardian)),
    "guardian_objects_not_proven_dead",
  );
  assert.equal(ownerTestView(owner).record.state, "quarantined");
});

test("(d) an answer that is not a fresh not_bound about this world releases nothing and says so", async () => {
  const { admission, owner, coordinator } = await quarantinedAttempt({
    // The player loaded another save into the same game: the same session directory now advertises a world
    // this attempt never published into, and its answer proves nothing about this one.
    session: (token) => notBoundSession(token, { saveId: "save_other", worldId: "world_other" }),
  });
  const otherWorld = await coordinator.readCabinOccupancy(owner, admission);
  assert.deepEqual(otherWorld.reading.occupancy, { status: "unknown", reason: "session_document_other_world" });
  assert.equal(
    await refusalOf(() => coordinator.releaseQuarantinedCabinPublication(owner, admission, otherWorld, deadGuardian)),
    "evidence_not_fresh_for_this_world",
  );
  assert.equal(ownerTestView(owner).record.state, "quarantined");
});

test("(d) an answer read minutes ago is not evidence about the world now, and says so", async () => {
  const { admission, owner, coordinator } = await quarantinedAttempt();
  const evidence = await coordinator.readCabinOccupancy(owner, admission);
  // A `not_bound` that was true minutes ago is exactly what a stale publisher leaves behind: the Mod may
  // have bound her in the beat after the stamp, so the release refuses rather than trusting the memory.
  const aged = {
    ...evidence,
    reading: { ...evidence.reading, observedAtUnixMs: evidence.reading.observedAtUnixMs - 60_000 },
  };
  assert.equal(
    await refusalOf(() => coordinator.releaseQuarantinedCabinPublication(owner, admission, aged, deadGuardian)),
    "evidence_not_fresh_for_this_world",
  );
  assert.equal(ownerTestView(owner).record.state, "quarantined");
});

test("a stale document answers unknown over the same seam the release reads, so nothing is released", async () => {
  const { fixture, admission, owner, coordinator } = await quarantinedAttempt();
  // The publisher stopped an hour ago on this Host's clock: the document still claims life, and the answer is
  // still `unknown` - the reading that never releases an attempt into a second manifest.
  fixture.harness.setNow(NOW_MS + 3_600_000);
  const evidence = await coordinator.readCabinOccupancy(owner, admission);
  assert.deepEqual(evidence.reading.occupancy, { status: "unknown", reason: "session_document_stale" });
  assert.equal(
    await refusalOf(() => coordinator.releaseQuarantinedCabinPublication(owner, admission, evidence, deadGuardian)),
    "evidence_not_fresh_for_this_world",
  );

  // The attempt is forgotten here, and the token goes with it: the probe must then REFUSE rather than answer from a
  // material this Host no longer holds. That is the whole cost of keeping the secret through the quarantine, and
  // this is the reading that says the cost is paid at the one moment it should be.
  assert.equal(ownerTestView(owner).hasPrivateMaterial(), true, "the quarantine keeps the read authority");
  fixture.testCore.forgetOwnedPlayerHostMaterial(owner);
  assert.equal(ownerTestView(owner).hasPrivateMaterial(), false, "forgetting the attempt drops its material");
  await assert.rejects(
    () => coordinator.readCabinOccupancy(owner, admission),
    /stardew_cabin_occupancy_unavailable/,
    "a forgotten attempt must not answer from a material nobody holds",
  );
});
