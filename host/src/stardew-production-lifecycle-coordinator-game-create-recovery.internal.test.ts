import {
  waitForAttachmentRequest,
  publishAttachmentAdmission,
  attachmentRequestId,
  availableCabins,
  prepareCabinCoordinator,
  fakeGameSessionCreationAuthority,
  scriptedRecoveryTeardown,
  writeAttemptRecord,
  seedWorldSlotRow,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { GameBrowserValidatorsV1 } from "./game-browser-contract/index.js";
import { STARDEW_GAME_WORLD_CREATION_SLOT_MISSING } from "./stardew-owned-farmhand-game-world-creation-seam.internal.js";

installLifecycleTestHooks();

// ─── Loop 4 path B': the mounted create seam and the unified failure closure ──

test("game.create runs the owner-bound world-creation seam only after its own manifest handoff admission", async () => {
  const fake = fakeGameSessionCreationAuthority();
  let pathFixture!: Awaited<ReturnType<typeof prepareCabinCoordinator>>;
  const seamObservations: Array<Readonly<{ joinedRequestId: string | null; admittedManifest: boolean }>> = [];
  pathFixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      // The production seam reports the observed slot from the join manifest and
      // fails closed with bounded codes; this stand-in fails with the seam's own
      // absent-slot code, so what is proven here is the wiring: the seam runs
      // after this create's admission, and its failure settles durably.
      createWorldBinding: async () => {
        const joinedRequestId = await attachmentRequestId(pathFixture.runtimeRoot);
        const manifest = JSON.parse(
          await readFile(
            join(
              pathFixture.runtimeRoot,
              "stardew-private-bootstrap",
              "bootstrap-coordinator-1",
              "session",
              "stardew-farmhand-manifest.json",
            ),
            "utf8",
          ),
        ) as { requestId?: unknown };
        seamObservations.push(
          Object.freeze({
            joinedRequestId,
            admittedManifest: joinedRequestId !== null && manifest.requestId === joinedRequestId,
          }),
        );
        throw new Error(STARDEW_GAME_WORLD_CREATION_SLOT_MISSING);
      },
    },
  });
  try {
    const creating = pathFixture.coordinator.activationOwner.createGameSession(
      pathFixture.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    const request = await waitForAttachmentRequest(pathFixture.runtimeRoot);
    await publishAttachmentAdmission(pathFixture.runtimeRoot, request, availableCabins[0]!);
    const result = await creating;
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    // The seam saw this create's OWN admitted manifest: the request identity on
    // disk is the one the issued manifest is signed for. A seam that ran before
    // the admission would have seen no manifest for that request at all.
    assert.equal(seamObservations.length, 1);
    assert.equal(seamObservations[0]!.admittedManifest, true);
    // A bounded seam failure never fabricates a binding: pending intent settled
    // as failed with no binding row and nothing resumable.
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0], {
      gameSessionId: sessions[0]!.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 2,
    });
    assert.equal(fake.readBinding(sessions[0]!.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    assert.deepEqual(fake.inputs(), ["create", "fail"]);
    assert.deepEqual(pathFixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
  } finally {
    await pathFixture.coordinator.close();
    await pathFixture.broker.close();
  }
});

test("game.create drives the ONE durable failure closure when registration fails after an admitted manifest", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: Object.freeze({
        ...fake.authority,
        registerGameSessionWorldBinding: async () => {
          throw new Error("controlled-registration-failure");
        },
      }),
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await creating;
    // The world was observed and admitted, but registration never landed: the
    // closure fails the pending intent and leaves no binding row, never a
    // resumable half-record and never a bare accepted.
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0], {
      gameSessionId: sessions[0]!.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 2,
    });
    assert.equal(fake.readBinding(sessions[0]!.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    assert.deepEqual(fake.inputs(), ["create", "fail"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create whose completion step fails after registration settles terminally through the ONE durable closure", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: Object.freeze({
        ...fake.authority,
        completeGameSessionBinding: async () => {
          throw new Error("controlled-completion-failure");
        },
      }),
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // The world was created and its binding registered (rev1), but completion
    // never landed, so the session is still `pending` revision 1. That is one of
    // the two live shapes `markGameSessionWorldBindingTerminal` settles, and it
    // settles onto the same canonical terminal pair as a completed session that
    // failed later: terminal binding rev2 + failed metadata rev3 in the store's
    // own single transaction. `failGameSessionCreation` cannot settle it - it
    // refuses a session that already has a binding row - so this create drives
    // the terminal path, and only that path.
    const result = await creating;
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0]!.gameSessionId;
    assert.deepEqual(fake.readBinding(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      status: "terminal",
      revision: 2,
    });
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 3,
    });
    // Nothing resumable: the settled session can never be resumed, and the
    // registration-without-completion row pair is gone rather than left visible.
    assert.deepEqual(fake.listResumable(), []);
    // Exact durable steps: the closure took the terminal path, never `fail`.
    assert.deepEqual(fake.inputs(), ["create", "register", "terminal"]);
    // The failure preceded the first activation, so nothing was ever attached.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.spawnCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create reports the terminal create failure when its durable settle cannot be applied", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: Object.freeze({
        ...fake.authority,
        completeGameSessionBinding: async () => {
          throw new Error("controlled-completion-failure");
        },
        // The store itself refuses to apply the settle (quarantine, a lost row,
        // or any other unavailable durable surface).
        markGameSessionWorldBindingTerminal: async () => {
          throw new Error("controlled-store-failure");
        },
      }),
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // Design card 114: a create whose durable failure closure cannot be applied
    // is never reported as a clean `unavailable` - the wire reports the terminal
    // `stardew_game_create_failed` - and the unsettled rows stay visible (binding
    // registered rev1 with pending rev1 metadata) instead of being faked.
    await assert.rejects(creating, /stardew_game_create_failed/);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0]!.gameSessionId;
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "pending",
      revision: 1,
    });
    assert.equal(fake.readBinding(sessionId)?.status, "registered");
    assert.deepEqual(fake.listResumable(), []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * A crashed create's leftover world slot is the PLAYER'S to keep.
 *
 * The trigger still opens the leftover attempt and drives its one recovery - so
 * the crashed attempt's own registration pointer is released and its transaction
 * consumed - and then REFUSES this create under its own bounded code, because the
 * world slot is the player's and a second create on that world is not the product
 * answer: the next stop after a crash is `resumeGameSession`. The store's slot
 * release is deliberately not called here any more, so the leftover row stays
 * registered exactly as the crashed process left it.
 *
 * The leftover attempt's record has no recorded recovery actor, so the trigger
 * mints one - that is the fallback branch, and the actor is asserted as a fresh
 * opaque guid rather than as a value this test supplied.
 */
test("game.create over a leftover world slot finalizes the crashed recovery and refuses itself with the resume-instead code", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const crashedBootstrapId = "bootstrap-crashed-attempt-1";
  const scripted = scriptedRecoveryTeardown("recovered");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    await writeAttemptRecord(fixture.runtimeRoot, crashedBootstrapId);
    const recordBefore = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"),
      "utf8",
    );
    const leftover = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477",
      holderHandle: crashedBootstrapId,
      settle: false,
    });
    assert.equal(fake.readBinding(leftover.gameSessionId)?.status, "registered");
    assert.equal(fake.readMetadata(leftover.gameSessionId)?.status, "pending");

    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);

    // The create refused itself under its OWN bounded code: the world slot is
    // still the previous session's, so this is a known product state ("resume the
    // session instead of creating one") rather than an arbitrary internal failure.
    await assert.rejects(
      creating,
      (error: unknown) =>
        error instanceof Error && error.message === "stardew_game_create_world_held_by_player_resume_required",
    );
    // The world slot was NOT released: the leftover holder's own registered row
    // and its pending metadata are exactly what the crashed process left, so the
    // session's world is intact and waiting for its resume.
    assert.deepEqual(fake.readBinding(leftover.gameSessionId), {
      gameSessionId: leftover.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      status: "registered",
      revision: 1,
    });
    assert.deepEqual(fake.readMetadata(leftover.gameSessionId), leftover);
    assert.deepEqual(fake.slotReleases(), []);
    // The drive ran once, recovered and then finalized, and never reached a
    // role-containment or a settlement path.
    assert.deepEqual(scripted.events, ["recover", "finalizeRecovered"]);
    // ONE request for both halves, so the actor the durable CASes recorded and
    // the actor the finalization must match cannot drift apart.
    assert.equal(scripted.requests.length, 2);
    assert.equal(scripted.requests[0], scripted.requests[1]);
    // The request carried the opened attempt's own projection - the seven fields
    // of the CURRENT durable record, asserted against the bytes on disk so
    // neither side can drift into agreeing on a wrong record.
    const persisted = JSON.parse(
      await readFile(join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8"),
    ) as Record<string, unknown>;
    const guardian = persisted.guardian as Record<string, unknown>;
    assert.deepEqual(scripted.recoveryBindings, [
      {
        bindingRevision: guardian.bindingRevision,
        ownerRecordRevision: persisted.ownerRecordRevision,
        leaseName: guardian.leaseName,
        playerJobName: guardian.playerJobName,
        aiJobName: guardian.aiJobName,
        playerHostState: persisted.playerHostState,
        aiClientState: persisted.aiClientState,
      },
    ]);
    assert.deepEqual(Object.keys(scripted.recoveryBindings[0] as object).sort(), [
      "aiClientState",
      "aiJobName",
      "bindingRevision",
      "leaseName",
      "ownerRecordRevision",
      "playerHostState",
      "playerJobName",
    ]);
    // The crashed attempt's own record was not touched by this refuse: nothing
    // was fabricated into it.
    assert.equal(
      await readFile(join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8"),
      recordBefore,
    );
    // The slot was read once, for this create's own world ref.
    assert.deepEqual(fake.slotReads(), [{ integrationId: "stardew", bindingRef: "Farm_389124477" }]);
    // Durable steps: the seeding pair, then this create's own create and its own
    // single failure settle. The leftover session's rows were not touched at all.
    assert.deepEqual(fake.inputs(), ["create", "register", "create", "fail"]);
    // This create's own attempt settled through the SAME single durable closure:
    // the pre-registration shape (pending rev1 -> failed rev2, no binding row),
    // never a resumable half-record.
    const sessions = fake.sessions();
    assert.equal(sessions.length, 2);
    const own = sessions.find((row) => row.gameSessionId !== leftover.gameSessionId)!;
    assert.deepEqual(own, {
      gameSessionId: own.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 2,
    });
    assert.equal(fake.readBinding(own.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    // Never attached and never ready: no AI client was launched and the wire
    // reports no session handle.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * The leftover record's own recorded recovery actor is adopted, never replaced,
 * and the world slot is never released on this path either.
 *
 * An interrupted recovery must resume its exact recorded actor: the actor the
 * durable CASes wrote is the one the finalization has to match, so this trigger's
 * own fallback cannot substitute an actor of its own. And because the world slot
 * is the player's to keep, the holder's own handle is read but never presented
 * for a release.
 */
test("game.create's leftover trigger adopts the record's recorded recovery actor and never releases the world slot", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const crashedBootstrapId = "bootstrap-crashed-attempt-2";
  const recordedActor = "5c8e1f2b-0a4d-4e7c-9b31-6d2f8a3c7e50";
  const scripted = scriptedRecoveryTeardown("recovered");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // An interrupted recovery: the durable `recovering` CAS already ran and wrote
    // its actor, and one role is already classified contained.
    await writeAttemptRecord(fixture.runtimeRoot, crashedBootstrapId, {
      state: "recovering",
      guardianState: "recovering",
      recoveryInstanceId: recordedActor,
      playerHostState: "contained",
      aiClientState: "active",
    });
    const recordBefore = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"),
      "utf8",
    );
    const leftover = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477",
      holderHandle: crashedBootstrapId,
      settle: false,
    });

    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(
      creating,
      (error: unknown) =>
        error instanceof Error && error.message === "stardew_game_create_world_held_by_player_resume_required",
    );

    // The record's own actor was adopted, not replaced.
    assert.equal(scripted.requests[0]!.recoveryInstanceId, recordedActor);
    // The world slot was never released, so its holder's own handle was never
    // presented for one; the leftover session still holds the slot with the shape
    // the crashed process left.
    assert.deepEqual(fake.slotReleases(), []);
    assert.deepEqual(fake.readBinding(leftover.gameSessionId), {
      gameSessionId: leftover.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      status: "registered",
      revision: 1,
    });
    assert.deepEqual(fake.readMetadata(leftover.gameSessionId), leftover);
    // The interrupted recovery's own record was left exactly as it was found: its
    // adopted actor and its `recovering` position are intact.
    assert.equal(
      await readFile(join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8"),
      recordBefore,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * The AI-side terminal on the create path: the broker settled and cleaned up the
 * AI side and deliberately preserved the player's world, and this create refuses
 * itself under its OWN bounded code, whose meaning is that the world is still the
 * player's and the session must be RESUMED rather than created again.
 *
 * The attempt is closed out on the same step, through that terminal's own seam
 * member: the drive closes the attempt out FIRST and only then reports the
 * terminal, so an attempt is never reported as closed while it still occupies its
 * registration. What the durable closure itself does - the record's own terminal,
 * the registration pointer release and the consumed transaction - is asserted in
 * the composer test and in the cross-layer recovery integration test, where a real
 * owner binding exists; this level scripts the seam, so here it is the ORDER that
 * is pinned together with everything the trigger must never do: no world-slot
 * release, no fabricated record, no invented role containment.
 *
 * The residual this test used to record is closed: the registration pointer is no
 * longer left bound to the crashed attempt, so the resume this refusal points at
 * is no longer refused with `stardew_bootstrap_registration_unavailable`. The
 * cross-layer lane asserts that end to end.
 */
test("game.create over a slot whose recovery settled the AI side refuses itself and leaves the player's world to resume", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const crashedBootstrapId = "bootstrap-crashed-attempt-3";
  const recordedActor = "6d2a9f4b-1c37-4e80-9b52-7f0e4a8d3c61";
  const scripted = scriptedRecoveryTeardown("ai_settled_player_preserved");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // The shape the deliberate terminal leaves the attempt in: the durable
    // `recovering` CAS ran (the gate opened and a recorded actor exists), NO role
    // was recorded contained, and nothing claims a pending cleanup retry.
    await writeAttemptRecord(fixture.runtimeRoot, crashedBootstrapId, {
      state: "recovering",
      guardianState: "recovering",
      recoveryInstanceId: recordedActor,
      playerHostState: "reserved",
      aiClientState: "reserved",
    });
    const recordBefore = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"),
      "utf8",
    );
    const leftover = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477",
      holderHandle: crashedBootstrapId,
      settle: false,
    });

    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // The refusal is this create's own resume-instead code, never the held-gate
    // verdict: a held gate would claim the holder was not proven gone, which is
    // not what happened - the gate opened and the AI side was settled.
    await assert.rejects(
      creating,
      (error: unknown) =>
        error instanceof Error && error.message === "stardew_game_create_world_held_by_player_resume_required",
    );

    // The drive ran its recover step exactly once and then closed the attempt out
    // through that terminal's OWN seam member - never through the containment one,
    // which would close it out as a containment the recovery never observed. The
    // closure itself is the composer's real one in production (asserted in the
    // composer and cross-layer tests); the scripted seam here records the order.
    assert.deepEqual(scripted.events, ["recover", "finalizeRecoveredAiSettled"]);
    // The world slot is still held by the crashed session, with its own handle,
    // and its row is untouched. This is the evidence for the ruling's third goal:
    // the player's world is preserved, waiting for its resume.
    assert.deepEqual(fake.readBinding(leftover.gameSessionId), {
      gameSessionId: leftover.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      status: "registered",
      revision: 1,
    });
    assert.deepEqual(fake.readMetadata(leftover.gameSessionId), leftover);
    assert.deepEqual(fake.slotReleases(), []);
    // The slot-addressed read still names the crashed attempt as the holder, so a
    // later lifecycle can still open that exact attempt.
    assert.deepEqual(
      await fake.authority.readGameSessionWorldBindingSlotHolder({
        integrationId: "stardew",
        bindingRef: "Farm_389124477",
      }),
      {
        gameSessionId: leftover.gameSessionId,
        integrationId: "stardew",
        bindingRef: "Farm_389124477",
        status: "registered",
        revision: 1,
        holderHandle: crashedBootstrapId,
      },
    );
    // Nothing was fabricated into the attempt record: what this create's drive did
    // to it is exactly what the closure this level scripted did - nothing. It is
    // still the record the deliberate terminal left, read back field by field, so a
    // silent rewrite into a terminal or quarantined shape cannot pass as "unchanged
    // bytes". The durable closure's own effect on that record (its terminal
    // successor, the released pointer, the consumed transaction) is asserted where
    // a real owner binding exists: the composer test and the cross-layer test.
    assert.equal(
      await readFile(join(fixture.runtimeRoot, "stardew-private-bootstrap", crashedBootstrapId, "owner.json"), "utf8"),
      recordBefore,
    );
    const persisted = JSON.parse(recordBefore) as Record<string, unknown>;
    assert.equal(persisted.state, "recovering");
    assert.equal(persisted.recoveryInstanceId, recordedActor);
    assert.notEqual(persisted.playerHostState, "contained");
    assert.notEqual(persisted.aiClientState, "contained");
    assert.equal(persisted.cleanupDisposition, "pending");
    // This create's own attempt still settles through the SAME single durable
    // closure, and its own durable steps are unchanged.
    assert.deepEqual(fake.inputs(), ["create", "register", "create", "fail"]);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 2);
    const own = sessions.find((row) => row.gameSessionId !== leftover.gameSessionId)!;
    assert.deepEqual(own, {
      gameSessionId: own.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 2,
    });
    assert.equal(fake.readBinding(own.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * No leftover holder is the untouched path: the create consults the slot, finds
 * nothing to recover, drives no recovery at all, and takes exactly the durable
 * steps it took before the trigger existed.
 */
test("game.create over a slot with no leftover holder drives no recovery and keeps its previous durable steps", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const scripted = scriptedRecoveryTeardown("never");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await creating;
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    assert.equal(result.status, "attached");
    // The slot was consulted - the read is never skipped - and nothing was
    // driven or released off it.
    assert.deepEqual(fake.slotReads(), [{ integrationId: "stardew", bindingRef: "Farm_389124477" }]);
    assert.deepEqual(fake.slotReleases(), []);
    assert.deepEqual(scripted.events, []);
    // Exactly the pre-trigger durable steps, in the same order.
    assert.deepEqual(fake.inputs(), ["create", "register", "complete"]);
    assert.equal(fake.readBinding(result.gameSessionId!)?.status, "registered");
    assert.equal(fake.readMetadata(result.gameSessionId!)?.status, "resumable");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * A SETTLED row on the slot is not an occupant. The readback deliberately
 * returns such a row when nothing is registered - so a release against it is
 * refused as `holderTerminal` instead of being mistaken for an unknown slot -
 * and reading it as an occupant here would refuse every later create on a slot
 * that has ever been settled.
 *
 * That is not a theoretical shape: the binding ref is the physical save slot the
 * Player Host observed, whose basename is derived from the farm name, so a create
 * that failed once leaves a terminal row under exactly the ref the next create
 * observes. The record below is a real terminal one, so a judge that decided on
 * the record instead of on the row would hit the opener's terminal refusal here
 * and the create would fail closed.
 */
test("game.create is not blocked by a settled row on the slot, only by a registered holder", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const settledBootstrapId = "bootstrap-settled-attempt-1";
  const scripted = scriptedRecoveryTeardown("never");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // The attempt behind the settled row terminated: both roles drained, no
    // recorded actor, nothing left to recover.
    await writeAttemptRecord(fixture.runtimeRoot, settledBootstrapId, {
      state: "contained",
      guardianState: "contained",
      recoveryInstanceId: null,
      playerHostState: "contained",
      aiClientState: "contained",
    });
    const settled = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477",
      holderHandle: settledBootstrapId,
      settle: true,
    });
    assert.equal(fake.readBinding(settled.gameSessionId)?.status, "terminal");

    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await creating;
    assert.equal(result.status, "attached");
    assert.deepEqual(fake.slotReads(), [{ integrationId: "stardew", bindingRef: "Farm_389124477" }]);
    assert.deepEqual(scripted.events, []);
    assert.deepEqual(fake.slotReleases(), []);
    // The settled row is untouched, and this create's own world is registered on
    // the same slot.
    assert.deepEqual(fake.readBinding(settled.gameSessionId), {
      gameSessionId: settled.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      status: "terminal",
      revision: 2,
    });
    assert.deepEqual(fake.inputs(), ["create", "register", "terminal", "create", "register", "complete"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * A slot whose holder is a LIVE attempt is refused at the slot judge, not at the
 * store's duplicate rule.
 *
 * This test used to pin the store's own `game_session_world_binding_duplicate`
 * refusal as reached from the create path: the create registered, the store
 * rejected the second live session on the world slot, and the create settled
 * through the one durable closure. The judge now decides that case first - a
 * `registered` holder is driven through the existing recovery seam, and a held
 * native gate means the holder was NOT proven gone - so the store's duplicate
 * rule is never reached from here at all. What the scenario must still prove is
 * unchanged: a live holder is refused, nothing is stolen from it, nothing is
 * released or finalized, and the create settles through the SAME single durable
 * closure. The store's duplicate rule keeps its own test in the store suite.
 */
test("game.create is refused at the slot judge when another live holder still owns the world slot", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const foreignBootstrapId = "bootstrap-live-holder-1";
  const scripted = scriptedRecoveryTeardown("gate_held");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      containedRuntimeTeardown: scripted.teardown,
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // Another session (pending metadata + registered binding) already holds the
    // world slot this create's own world-creation seam observes, and the attempt
    // behind its handle is still non-terminal - so its native gate is held.
    await writeAttemptRecord(fixture.runtimeRoot, foreignBootstrapId);
    const foreign = await seedWorldSlotRow(fake, {
      bindingRef: "Farm_389124477",
      holderHandle: foreignBootstrapId,
      settle: false,
    });
    const foreignRecordBefore = await readFile(
      join(fixture.runtimeRoot, "stardew-private-bootstrap", foreignBootstrapId, "owner.json"),
      "utf8",
    );

    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // The refusal carries the judge's OWN bounded code: a held gate is the lease
    // verdict - the holder was not proven gone, since the handle at that lease
    // name may be a gate this Host itself opened - and it is reported as itself
    // rather than folded into the generic unavailable outcome.
    await assert.rejects(
      creating,
      (error: unknown) => error instanceof Error && error.message === "stardew_game_create_slot_holder_not_proven_gone",
    );
    // The refusal happened at the judge: this create never asked the store to
    // register, so the store's own duplicate rule is not the thing refusing here.
    assert.deepEqual(fake.inputs(), ["create", "register", "create", "fail"]);
    // Nothing was released and nothing was finalized; the drive ran its recover
    // step exactly once and stopped there.
    assert.deepEqual(scripted.events, ["recover"]);
    assert.deepEqual(fake.slotReleases(), []);
    // The live holder's slot and its durable record are exactly what they were:
    // it keeps the one registered row on that world, and its attempt was neither
    // recovered nor rewritten.
    assert.deepEqual(fake.readBinding(foreign.gameSessionId), {
      gameSessionId: foreign.gameSessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      status: "registered",
      revision: 1,
    });
    assert.deepEqual(fake.readMetadata(foreign.gameSessionId), foreign);
    assert.equal(
      await readFile(join(fixture.runtimeRoot, "stardew-private-bootstrap", foreignBootstrapId, "owner.json"), "utf8"),
      foreignRecordBefore,
    );
    // This create's own attempt still settles through the SAME single closure:
    // the pre-registration shape (pending rev1 -> failed rev2, no binding row),
    // never a resumable half-record.
    const sessions = fake.sessions();
    assert.equal(sessions.length, 2);
    const own = sessions.find((row) => row.gameSessionId !== foreign.gameSessionId)!;
    assert.deepEqual(own, {
      gameSessionId: own.gameSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 2,
    });
    assert.equal(fake.readBinding(own.gameSessionId), null);
    assert.deepEqual(fake.listResumable(), []);
    // Never attached and never ready: no world of this session's own exists, no
    // AI client was launched and the wire reports no session handle.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
