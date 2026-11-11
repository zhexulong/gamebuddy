import {
  installationChain,
  deferredVoid,
  connectedSemanticGameLeaseFixture,
  sequencedInstallationInspector,
  createAdmissionBroker,
  signAttachmentValue,
  waitForAttachmentRequest,
  publishAttachmentAdmission,
  ownerRecord,
  availableCabins,
  prepareCabinCoordinator,
  confirmFirstCabin,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

installLifecycleTestHooks();

test("attached semantic Game STOP is generation-bound, idempotent, settled, and does not detach", async () => {
  const stopGate = deferredVoid();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: stopGate.promise });
  let gateReleased = false;
  try {
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });

    assert.throws(
      () =>
        fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
          apiVersion: 1,
          idempotencyKey: "wrong-generation-stop",
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_attachment_generation_conflict/,
    );
    assert.equal(fixture.gameStopCalls.length, 0);

    const command = { apiVersion: 1 as const, idempotencyKey: "game-stop-key", expectedAttachmentGeneration: 1 };
    const first = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), command);
    const replay = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), command);
    assert.equal(replay, first);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "stopping",
    });
    assert.equal(fixture.gameStopCalls.length, 1);
    assert.equal(fixture.gameStopCalls[0]!.stopId, command.idempotencyKey);
    assert.equal(fixture.gameStopCalls[0]!.reasonCode, "player_stop_all");
    assert.notEqual(fixture.gameStopCalls[0]!.sourceEventId, command.idempotencyKey);
    assert.match(fixture.gameStopCalls[0]!.sourceEventId, /^[0-9a-f-]{36}$/);
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
          ...command,
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_stop_idempotency_conflict/,
    );
    stopGate.resolve();
    gateReleased = true;
    await first;
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "stopped",
    });
    await fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
      apiVersion: 1,
      idempotencyKey: "game-stop-key-2",
      expectedAttachmentGeneration: 1,
    });
    assert.equal(fixture.gameStopCalls.length, 2);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "stopped",
    });
  } finally {
    if (!gateReleased) stopGate.resolve();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("failed semantic Game STOP is terminal for its attachment and replay remains exact", async () => {
  const failure = Promise.reject(new Error("controlled-stop-settlement-failure"));
  void failure.catch(() => undefined);
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: failure });
  try {
    await confirmFirstCabin(fixture);
    const command = { apiVersion: 1 as const, idempotencyKey: "failed-game-stop-key", expectedAttachmentGeneration: 1 };
    const first = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), command);
    const replay = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), command);
    assert.equal(replay, first);
    await assert.rejects(first, /controlled-stop-settlement-failure/);
    assert.equal(fixture.gameStopCalls.length, 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "failed",
    });
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
          apiVersion: 1,
          idempotencyKey: "fresh-after-failed-stop",
          expectedAttachmentGeneration: 1,
        }),
      /stardew_game_runtime_unavailable/,
    );
    assert.equal(fixture.gameStopCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reentrant close during initial ingress activation never publishes an attachment", async () => {
  let closePromise: Promise<void> | undefined;
  let fixtureForClose: Awaited<ReturnType<typeof prepareCabinCoordinator>> | undefined;
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    afterIngressActivation() {
      assert.ok(fixtureForClose);
      closePromise = fixtureForClose.coordinator.close();
    },
  });
  fixtureForClose = fixture;
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "reentrant-ingress-close-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.ok(closePromise);
    await closePromise;
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted Farmhand Bridge retries only pipe-not-ready before authenticated connection", async () => {
  let attempts = 0;
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      connectFarmhandGameRuntimeFacade: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("controlled_pipe_not_ready") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => connectedSemanticGameLeaseFixture(),
          recoverDeadOwner: async () => undefined,
          close: async () => undefined,
        });
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
      apiVersion: 1,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "bridge-transient-retry-key",
      confirmed: true,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await confirmation, { apiVersion: 1, status: "manifest_admitted" });
    assert.equal(attempts, 2);
    assert.equal(fixture.spawnCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted Farmhand Bridge attestation mismatch is permanently uncertain and quarantined", async () => {
  let attempts = 0;
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      connectFarmhandGameRuntimeFacade: async () => {
        attempts += 1;
        throw new Error("bridge_runtime_attestation_mismatch");
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "bridge-attestation-mismatch-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.equal(attempts, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(attempts, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted semantic Game enter failure is one-shot uncertain and closes its facade", async () => {
  let connectorCalls = 0;
  let enterCalls = 0;
  let closeCalls = 0;
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      connectFarmhandGameRuntimeFacade: async () => {
        connectorCalls += 1;
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => {
            enterCalls += 1;
            const error = new Error("controlled_semantic_game_enter_failure") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          },
          recoverDeadOwner: async () => undefined,
          close: async () => {
            closeCalls += 1;
          },
        });
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "semantic-enter-failure-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.equal(connectorCalls, 1);
    assert.equal(enterCalls, 1);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(connectorCalls, 1);
    assert.equal(enterCalls, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
  assert.equal(closeCalls, 1);
});

test("dynamic cabin confirmation rejects cross-session, expiry, stale revision, conflicts, and closes fail-closed", async () => {
  const fixture = await prepareCabinCoordinator();
  const foreignBroker = await createAdmissionBroker();
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const firstChoice = choices.choices[0]!;
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.confirmCabinChoice(foreignBroker.issue("cabin_confirm"), {
          apiVersion: 1,
          choiceHandle: firstChoice.choiceHandle,
          idempotencyKey: "foreign-key",
          confirmed: true,
        }),
      /stardew_cabin_browser_admission_invalid/,
    );

    const pendingCommand = {
      apiVersion: 1 as const,
      choiceHandle: firstChoice.choiceHandle,
      idempotencyKey: "single-confirmation-key",
      confirmed: true as const,
    };
    const pending = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      pendingCommand,
    );
    await waitForAttachmentRequest(fixture.runtimeRoot);
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
          ...pendingCommand,
          choiceHandle: choices.choices[1]!.choiceHandle,
        }),
      /stardew_cabin_idempotency_conflict/,
    );
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
          apiVersion: 1,
          choiceHandle: choices.choices[1]!.choiceHandle,
          idempotencyKey: "second-confirmation-key",
          confirmed: true,
        }),
      /stardew_cabin_confirmation_conflict/,
    );

    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    const directory = join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "session");
    await writeFile(
      join(directory, "stardew-attachment-response.json"),
      JSON.stringify(
        signAttachmentValue({
          schemaVersion: 1,
          requestId: request.requestId as string,
          state: "rejected",
          reasonCode: "binding_readback_mismatch",
          updatedAtUnixMs: Date.now(),
          signature: "",
        }),
      ),
    );
    await assert.rejects(pending, /stardew_cabin_publication_uncertain/);
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), pendingCommand),
      /stardew_cabin_publication_uncertain/,
    );

    await fixture.coordinator.close();
    await assert.rejects(
      fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read")),
      /stardew_cabin_handoff_unavailable|stardew_cabin_handoff_revision_changed/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
    await foreignBroker.close();
  }
});

test("dynamic cabin handles distinguish expired and revision-stale failures", async () => {
  const expiring = await prepareCabinCoordinator(Date.now() + 1_500);
  try {
    const choices = await expiring.coordinator.activationOwner.readCabinChoices(expiring.broker.issue("cabin_read"));
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_600));
    assert.throws(
      () =>
        expiring.coordinator.activationOwner.confirmCabinChoice(expiring.broker.issue("cabin_confirm"), {
          apiVersion: 1,
          choiceHandle: choices.choices[0]!.choiceHandle,
          idempotencyKey: "expired-key",
          confirmed: true,
        }),
      /stardew_cabin_choice_expired/,
    );
  } finally {
    await expiring.coordinator.close();
    await expiring.broker.close();
  }

  const stale = await prepareCabinCoordinator();
  try {
    const choices = await stale.coordinator.activationOwner.readCabinChoices(stale.broker.issue("cabin_read"));
    const confirmationAdmission = stale.broker.issue("cabin_confirm");
    await stale.coordinator.close();
    assert.throws(
      () =>
        stale.coordinator.activationOwner.confirmCabinChoice(confirmationAdmission, {
          apiVersion: 1,
          choiceHandle: choices.choices[0]!.choiceHandle,
          idempotencyKey: "stale-key",
          confirmed: true,
        }),
      /stardew_cabin_choice_revision_stale/,
    );
  } finally {
    await stale.coordinator.close();
    await stale.broker.close();
  }
});

test("manifest-admitted AI materialization failure is permanently uncertain and never republishes attachment", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { failPackageReadAt: 3 });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "materialization-failure-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(fixture.packageReadCount(), 3);
    assert.deepEqual(fixture.spawnCalls, []);
    const repeatedRequest = await readFile(
      join(
        fixture.runtimeRoot,
        "stardew-private-bootstrap",
        "bootstrap-coordinator-1",
        "session",
        "stardew-attachment-request.json",
      ),
      "utf8",
    );
    assert.equal(JSON.parse(repeatedRequest).requestId, request.requestId);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted private Bridge config replacement is permanently uncertain and quarantines without AI spawn", async () => {
  let runtimeRoot = "";
  let tampered = false;
  const inspector = sequencedInstallationInspector(
    [
      [installationChain, installationChain],
      [installationChain, installationChain, installationChain],
      [installationChain, installationChain, installationChain],
    ],
    async (sequenceIndex, readIndex) => {
      if (sequenceIndex !== 3 || readIndex !== 3 || tampered) return;
      tampered = true;
      await writeFile(
        join(
          runtimeRoot,
          "stardew-private-bootstrap",
          "bootstrap-coordinator-1",
          "ai-client",
          "Mods",
          "GameBuddy",
          "config.json",
        ),
        JSON.stringify({ EnableLocalBridge: false }),
      );
    },
  );
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: { createInstallationInspector: async () => inspector },
  });
  runtimeRoot = fixture.runtimeRoot;
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "ai-bridge-config-replacement-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(tampered, true);
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("every admission point acquires its own fresh request-scoped installation capability", async () => {
  // Gate 5: the phases must admit independently rather than share one admission.
  // The coordinator's exchange point is the inspector FACTORY, re-invoked once
  // per admission; the fresh identity reread behind each call is what the phase
  // actually trusts. Counting factory invocations therefore shows the phases did
  // not share an admission.
  //
  // A full setup -> Stage C -> Stage D flow has THREE admission points, not two:
  //   1. picker-time registration (registerInstallationLocator) -- admits the
  //      selected locator before it is ever durable;
  //   2. Stage C (runPlayerHostLaunch) -- immediately before spawning the
  //      Player Host;
  //   3. Stage D (confirmCabinChoice) -- immediately before the AI-client launch.
  // Asserting the exact count is the point: a shared or skipped admission would
  // move this number, and the picker-time one is the easiest to lose because it
  // is the only admission that runs before any durable registration exists.
  let inspectorAcquisitions = 0;
  const inspector = sequencedInstallationInspector([
    [installationChain, installationChain],
    [installationChain, installationChain],
    [installationChain, installationChain, installationChain],
  ]);
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      createInstallationInspector: async () => {
        inspectorAcquisitions += 1;
        return inspector;
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "fresh-capability-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await confirmation, { apiVersion: 1, status: "manifest_admitted" });

    assert.equal(inspectorAcquisitions, 3, "picker-time, Stage C and Stage D each admit anew");
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("manifest-admitted AI installation replacement is permanently uncertain and quarantines without AI spawn", async () => {
  const changed = installationChain.map((entry, index) =>
    index === 2 ? Object.freeze({ ...entry, fileId: "ffffffffffffffffffffffffffffffff" }) : entry,
  );
  const inspector = sequencedInstallationInspector([
    [installationChain, installationChain],
    [installationChain, installationChain, installationChain],
    [installationChain, installationChain, changed],
  ]);
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: { createInstallationInspector: async () => inspector },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "ai-installation-replacement-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

for (const failure of ["spawn", "probe"] as const) {
  test(`manifest-admitted AI ${failure} failure is permanently uncertain and consumes launch authority`, async () => {
    const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
      aiSpawnFailure: failure === "spawn",
      aiProbeFailure: failure === "probe",
    });
    try {
      const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
      const command = {
        apiVersion: 1 as const,
        choiceHandle: choices.choices[0]!.choiceHandle,
        idempotencyKey: `ai-${failure}-failure-key`,
        confirmed: true as const,
      };
      const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
        fixture.broker.issue("cabin_confirm"),
        command,
      );
      const request = await waitForAttachmentRequest(fixture.runtimeRoot);
      await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
      await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
      assert.throws(
        () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
        /stardew_cabin_publication_uncertain/,
      );
      assert.equal(fixture.spawnCalls.length, 1);
      assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
}

test("close drains manifest-admitted AI materialization before quarantine and process teardown", async () => {
  let releasePackageRead!: () => void;
  const packageReadGate = new Promise<void>((resolve) => {
    releasePackageRead = resolve;
  });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    packageReadGateAt: { count: 3, promise: packageReadGate },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
      apiVersion: 1,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "close-during-materialization-key",
      confirmed: true,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    while (fixture.packageReadCount() < 3) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    let closeSettled = false;
    const close = fixture.coordinator.close().finally(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(closeSettled, false);
    assert.deepEqual(fixture.playerKillCalls, []);
    releasePackageRead();
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    await close;
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "closed");
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
  } finally {
    releasePackageRead();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("Game disconnect joins same-generation STOP, closes only the semantic facade, and rereads none", async () => {
  const stopGate = deferredVoid();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: stopGate.promise });
  try {
    await confirmFirstCabin(fixture);
    const stop = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
      apiVersion: 1,
      idempotencyKey: "disconnect-joined-stop",
      expectedAttachmentGeneration: 1,
    });
    const command = {
      apiVersion: 1 as const,
      idempotencyKey: "disconnect-key-00000001",
      expectedAttachmentGeneration: 1,
    };
    const disconnect = fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      command,
    );
    const replay = fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), command);
    assert.equal(replay, disconnect);
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
          apiVersion: 1,
          idempotencyKey: "disconnect-second-key-01",
          expectedAttachmentGeneration: 1,
        }),
      /stardew_game_disconnect_in_progress/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "stopping",
    });
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 1);
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
          apiVersion: 1,
          idempotencyKey: "stop-after-disconnect",
          expectedAttachmentGeneration: 1,
        }),
      /stardew_game_runtime_unavailable/,
    );
    assert.equal(fixture.gameStopCalls.length, 1);
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.aiKillCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
    stopGate.resolve();
    await Promise.all([stop, disconnect]);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.deepEqual(fixture.aiKillCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
          ...command,
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_disconnect_idempotency_conflict/,
    );
  } finally {
    stopGate.resolve();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("Game disconnect and outer close share one pending attachment teardown", async () => {
  const stopGate = deferredVoid();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: stopGate.promise });
  try {
    await confirmFirstCabin(fixture);
    const stop = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
      apiVersion: 1,
      idempotencyKey: "disconnect-close-stop",
      expectedAttachmentGeneration: 1,
    });
    const disconnect = fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "disconnect-close-shared",
      expectedAttachmentGeneration: 1,
    });
    const close = fixture.coordinator.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.aiKillCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
    stopGate.resolve();
    await Promise.all([stop, disconnect, close]);
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    assert.deepEqual(fixture.playerKillCalls, []);
  } finally {
    stopGate.resolve();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("Game disconnect waits for a rejected STOP settlement before containing the attachment", async () => {
  let rejectStop!: (error: Error) => void;
  const stopSettled = new Promise<void>((_resolve, reject) => {
    rejectStop = reject;
  });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, { gameStopSettled: stopSettled });
  try {
    await confirmFirstCabin(fixture);
    const stop = fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
      apiVersion: 1,
      idempotencyKey: "disconnect-stop-rejected",
      expectedAttachmentGeneration: 1,
    });
    const disconnect = fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "disconnect-after-stop-failure",
      expectedAttachmentGeneration: 1,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    rejectStop(new Error("controlled-stop-settlement-failure"));
    await assert.rejects(stop, /controlled-stop-settlement-failure/);
    await disconnect;
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
  } finally {
    rejectStop(new Error("cleanup-stop-settlement"));
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("synchronous Game task cancellation failure is shared, replayable, and retryable", async () => {
  const cancelError = new Error("controlled-game-task-cancel-failure");
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    gameRuntimeTaskCancelError: cancelError,
  });
  try {
    await confirmFirstCabin(fixture);
    const command = {
      apiVersion: 1 as const,
      idempotencyKey: "disconnect-cancel-failed",
      expectedAttachmentGeneration: 1,
    };
    const failed = fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), command);
    await assert.rejects(failed, /controlled-game-task-cancel-failure/);
    assert.equal(
      fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), command),
      failed,
    );
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "failed",
    });
    await assert.rejects(
      fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
        apiVersion: 1,
        idempotencyKey: "disconnect-cancel-retry",
        expectedAttachmentGeneration: 1,
      }),
      /controlled-game-task-cancel-failure/,
    );
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 2);
    assert.deepEqual(fixture.bridgeCloseCalls, []);
  } finally {
    await fixture.coordinator.close().catch(() => undefined);
    await fixture.broker.close();
  }
});

test("failed Game disconnect retains generation and permits only a fresh-key retry", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    gameRuntimeBindingCloseResults: [false, true],
  });
  try {
    await confirmFirstCabin(fixture);
    const failedCommand = {
      apiVersion: 1 as const,
      idempotencyKey: "disconnect-failed-key-01",
      expectedAttachmentGeneration: 1,
    };
    const failed = fixture.coordinator.activationOwner.disconnectGame(
      fixture.broker.issue("game_disconnect"),
      failedCommand,
    );
    await assert.rejects(failed, /controlled_game_runtime_binding_close_failure/);
    assert.equal(
      fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), failedCommand),
      failed,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "failed",
    });
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "disconnect-retry-key-002",
      expectedAttachmentGeneration: 1,
    });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
