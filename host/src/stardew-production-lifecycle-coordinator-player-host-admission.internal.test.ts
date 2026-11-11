import {
  installationChain,
  sequencedInstallationInspector,
  withWindowsPlatform,
  createFixture,
  publishSignedPlayerHostSession,
  ownerRecord,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";

installLifecycleTestHooks();

test("signed Player Host advertisement is consumed privately with exact generation correlation", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await publishSignedPlayerHostSession(fixture.runtimeRoot);
      await fixture.coordinator.activationOwner
        .setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        })
        .then(() =>
          fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
            expectedInstanceGeneration: 1,
          }),
        );
      const result = fixture.coordinator.activationOwner.readPrivateActivationSnapshot();
      assert.equal(result.state, "awaiting_player_host_attestation");
      assert.deepEqual(Object.keys(result).sort(), [
        "authorityGeneration",
        "requestId",
        "revision",
        "schemaVersion",
        "state",
      ]);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
      });
      const serialized = JSON.stringify(result);
      for (const forbidden of ["player-generation-1", "session", "advertisement", "pid", "owner"])
        assert.equal(serialized.includes(forbidden), false, forbidden);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("missing Player Host advertisement remains privately retryable before owner deadline", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner
        .setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        })
        .then(() =>
          fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
            expectedInstanceGeneration: 1,
          }),
        );
      const result = fixture.coordinator.activationOwner.readPrivateActivationSnapshot();
      assert.equal(result.state, "awaiting_player_host_attestation");
      await publishSignedPlayerHostSession(fixture.runtimeRoot);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
      });
      assert.equal(
        fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state,
        "awaiting_player_host_attestation",
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("missing Player Host advertisement becomes terminal after the retained owner deadline", async () => {
  await withWindowsPlatform(async () => {
    let now = Date.now() + 1_000;
    const fixture = await createFixture({
      nowMs: () => now,
      afterPlayerSpawn: () => {
        now += 11 * 60_000;
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await assert.rejects(
        fixture.coordinator.activationOwner
          .setupPlayerHost(fixture.broker.issue("game_setup"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          })
          .then(() =>
            fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
              apiVersion: 1,
              idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
              expectedInstanceGeneration: 1,
            }),
          ),
        /stardew_player_host_launch_failed/,
      );
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "failed");
      assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Player Host advertisement generation mismatch fails closed and quarantines", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await publishSignedPlayerHostSession(fixture.runtimeRoot, "wrong-player-generation");
      await assert.rejects(
        fixture.coordinator.activationOwner
          .setupPlayerHost(fixture.broker.issue("game_setup"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          })
          .then(() =>
            fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
              apiVersion: 1,
              idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
              expectedInstanceGeneration: 1,
            }),
          ),
        /stardew_player_host_launch_failed/,
      );
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "failed");
      assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
        }),
        /stardew_player_host_launch_not_staged/,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("staged Player Host admission failure restores staged and permits a later valid retry", async () => {
  await withWindowsPlatform(async () => {
    const changed = installationChain.map((entry, index) =>
      index === 2 ? Object.freeze({ ...entry, fileId: "ffffffffffffffffffffffffffffffff" }) : entry,
    );
    const inspector = sequencedInstallationInspector([
      [installationChain, changed],
      [installationChain, installationChain, installationChain],
    ]);
    const fixture = await createFixture({ overrides: { createInstallationInspector: async () => inspector } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await assert.rejects(
        fixture.coordinator.activationOwner
          .setupPlayerHost(fixture.broker.issue("game_setup"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          })
          .then(() =>
            fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
              apiVersion: 1,
              idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
              expectedInstanceGeneration: 1,
            }),
          ),
        /stardew_game_setup_failed/,
      );
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.deepEqual(fixture.playerSpawnCalls, []);
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
      });
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "CDEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      });
      assert.equal(fixture.playerSpawnCalls.length, 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("staged Player Host reparse admission failure is pre-launch, restores staged, and permits retry", async () => {
  await withWindowsPlatform(async () => {
    const reparse = installationChain.map((entry, index) =>
      index === 1 ? Object.freeze({ ...entry, isReparsePoint: true }) : entry,
    );
    const inspector = sequencedInstallationInspector([
      [reparse, reparse],
      [installationChain, installationChain, installationChain],
    ]);
    const fixture = await createFixture({ overrides: { createInstallationInspector: async () => inspector } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await assert.rejects(
        fixture.coordinator.activationOwner
          .setupPlayerHost(fixture.broker.issue("game_setup"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          })
          .then(() =>
            fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
              apiVersion: 1,
              idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
              expectedInstanceGeneration: 1,
            }),
          ),
        /stardew_game_setup_failed/,
      );
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.deepEqual(fixture.playerSpawnCalls, []);
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
      });
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "CDEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      });
      assert.equal(fixture.playerSpawnCalls.length, 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

for (const failure of ["spawn", "probe"] as const) {
  test(`staged Player Host ${failure} failure quarantines and permanently rejects retry`, async () => {
    await withWindowsPlatform(async () => {
      const fixture = await createFixture({
        playerSpawnFailure: failure === "spawn",
        playerProbeFailure: failure === "probe",
      });
      try {
        await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
        await assert.rejects(
          fixture.coordinator.activationOwner
            .setupPlayerHost(fixture.broker.issue("game_setup"), {
              apiVersion: 1,
              idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
            })
            .then(() =>
              fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
                apiVersion: 1,
                idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
                expectedInstanceGeneration: 1,
              }),
            ),
          /stardew_player_host_launch_failed/,
        );
        assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
        await assert.rejects(
          fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
            apiVersion: 1,
            idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          }),
          /stardew_player_host_launch_not_staged/,
        );
        assert.equal(fixture.playerSpawnCalls.length, 1);
      } finally {
        await fixture.coordinator.close();
        await fixture.broker.close();
      }
    });
  });
}

test("close during staged Player Host admission drains and prevents a later spawn", async () => {
  await withWindowsPlatform(async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createFixture({ inspectorGate: gate });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const launch = fixture.coordinator.activationOwner
        .setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        })
        .then(() =>
          fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
            expectedInstanceGeneration: 1,
          }),
        );
      const close = fixture.coordinator.close();
      release();
      await assert.rejects(launch, /stardew_lifecycle_closing/);
      await close;
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      release();
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});
