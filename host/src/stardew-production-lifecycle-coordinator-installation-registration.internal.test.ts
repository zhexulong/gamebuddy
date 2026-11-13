import {
  gameDirectoryCandidate,
  temporaryRoots,
  identityChainFor,
  installationInspector,
  withWindowsPlatform,
  canonicalTemporaryRoot,
  createFixture,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readStardewInstallationRegistration } from "./stardew-installation-registration.internal.js";

installLifecycleTestHooks();

test("a fresh Host registers the folder the player picked as revision one, and a second pick replaces it", async () => {
  await withWindowsPlatform(async () => {
    // The player the defect was reported by: a Host whose runtime root holds no registration
    // record at all, picking a folder before any lifecycle activation. No staged attempt exists
    // here and none can - an attempt is only reserved against an existing ready record - so the
    // write is authorized by the admission above it: the authenticated picker callback plus the
    // folder checks on exactly this locator.
    const installParent = await canonicalTemporaryRoot("gamebuddy-fresh-registration-");
    temporaryRoots.push(installParent);
    const picks = [join(installParent, "Stardew Valley"), join(installParent, "Stardew Valley Copy")];
    for (const root of picks) {
      await mkdir(root, { recursive: true });
      // Both executables, so neither refusal names a missing game or a missing mod loader.
      await writeFile(join(root, "Stardew Valley.exe"), "", "utf8");
      await writeFile(join(root, "StardewModdingAPI.exe"), "", "utf8");
    }
    let pickCount = 0;
    const fixture = await createFixture({
      withoutSeededRegistration: true,
      overrides: {
        selectStardewFolder: async () => ({ status: "selected" as const, path: picks[pickCount++]! }),
        // One inspector per registration, sized to the chain the pick being admitted walks.
        createInstallationInspector: async () => {
          const chain = identityChainFor(picks[pickCount - 1]!);
          return installationInspector([chain, chain]);
        },
      },
    });
    try {
      assert.equal(await readStardewInstallationRegistration(fixture.runtimeRoot), null);
      assert.deepEqual(
        await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")),
        // The folder is registered AND the Mod outcome is reported. These fixtures mount no generation root, so
        // the Mod deployment has nothing to deploy and says so - which is the fact, not a placeholder.
        { status: "registered", companionMod: "companion-mod-unavailable" },
      );
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), {
        schema: "gamebuddy-stardew-installation-registration/v1",
        binding: { rootLayoutVersion: 1 },
        revision: 1,
        state: "ready",
        locator: picks[0],
        activeAttempt: null,
      });
      // The product-visible half: the Host now reports an installation, which is the fact the
      // Game surface reads instead of asking the player to choose a folder again.
      assert.equal(await fixture.coordinator.installationReader.readInstallationView(), "registered");

      assert.deepEqual(
        await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")),
        // The folder is registered AND the Mod outcome is reported. These fixtures mount no generation root, so
        // the Mod deployment has nothing to deploy and says so - which is the fact, not a placeholder.
        { status: "registered", companionMod: "companion-mod-unavailable" },
      );
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), {
        schema: "gamebuddy-stardew-installation-registration/v1",
        binding: { rootLayoutVersion: 1 },
        revision: 2,
        state: "ready",
        locator: picks[1],
        activeAttempt: null,
      });
      assert.equal(pickCount, 2);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

/**
 * The boundary of the fresh-root publish: a record that a live attempt already occupies is
 * NOT a record any caller may overwrite. Without the owner the locator under that pointer is
 * refused, and the record is left exactly as it was - the publish CAS must never be reached.
 */
test("a registration with a live attempt pointer and no owner is refused instead of replacing the record", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture({
      overrides: { selectStardewFolder: async () => ({ status: "selected" as const, path: gameDirectoryCandidate }) },
    });
    try {
      // The shape only a live attempt can produce: a ready record whose pointer is bound. It is
      // written as the exact bytes the owner transaction publishes, because only that transaction
      // may bind a pointer and it always advances an existing ready record by one revision.
      const occupied = {
        schema: "gamebuddy-stardew-installation-registration/v1" as const,
        binding: { rootLayoutVersion: 1 } as const,
        revision: 2,
        state: "ready" as const,
        locator: gameDirectoryCandidate,
        activeAttempt: { bootstrapCorrelation: "bootstrap-other-attempt" },
      };
      await writeFile(
        join(fixture.runtimeRoot, "stardew-installation-registration", "registration.json"),
        JSON.stringify(occupied),
        "utf8",
      );
      // No activation ran in this fixture, so there is no exact owner to key the replace by.
      assert.deepEqual(
        await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")),
        { status: "unavailable" },
      );
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), occupied);
      assert.equal(fixture.freshRegistrationAdmissionCount(), 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("manual installation picker cancellation and failure preserve registration without creating an active attempt", async () => {
  await withWindowsPlatform(async () => {
    for (const pickerResult of [{ status: "cancelled" as const }, new Error("picker_failure")]) {
      const fixture = await createFixture({
        overrides: {
          selectStardewFolder: async () => {
            if (pickerResult instanceof Error) throw pickerResult;
            return pickerResult;
          },
        },
      });
      try {
        const registrationBefore = await readStardewInstallationRegistration(fixture.runtimeRoot);
        const activationBefore = fixture.coordinator.activationOwner.readPrivateActivationSnapshot();
        const readinessBefore = fixture.coordinator.launchReadinessReader.readLaunchReadinessView();
        const result = await fixture.coordinator.activationOwner.openInstallationPicker(
          fixture.broker.issue("discovery_picker"),
        );
        assert.deepEqual(result, { status: pickerResult instanceof Error ? "unavailable" : "cancelled" });
        const registrationAfter = await readStardewInstallationRegistration(fixture.runtimeRoot);
        assert.deepEqual(registrationAfter, registrationBefore);
        assert.equal(registrationAfter?.locator, registrationBefore?.locator);
        assert.equal(registrationAfter?.revision, registrationBefore?.revision);
        assert.equal(registrationAfter?.state, registrationBefore?.state);
        assert.equal(registrationBefore?.activeAttempt, null);
        assert.equal(registrationAfter?.activeAttempt, null);
        assert.deepEqual(fixture.coordinator.activationOwner.readPrivateActivationSnapshot(), activationBefore);
        assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), readinessBefore);
        assert.deepEqual(fixture.playerSpawnCalls, []);
      } finally {
        await fixture.coordinator.close();
        await fixture.broker.close();
      }
    }
  });
});

test("Game setup cancellation is redacted, replayable, and never launches Player Host", async () => {
  await withWindowsPlatform(async () => {
    let pickerCalls = 0;
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          pickerCalls += 1;
          return { status: "cancelled" };
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const command = { apiVersion: 1 as const, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" };
      const first = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), command);
      const replay = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), command);
      assert.equal(replay, first);
      await first;
      assert.equal(pickerCalls, 1);
      assert.deepEqual(fixture.playerSpawnCalls, []);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.equal(
        JSON.stringify(fixture.coordinator.activationOwner.readPrivateActivationSnapshot()).includes(
          gameDirectoryCandidate,
        ),
        false,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

/**
 * The defect this exists for: a dismissed folder dialog resolved `setupPlayerHost` successfully and that
 * success stayed cached under the command's idempotency key, so the player's next click on the same key
 * replayed a setup that never registered anything and the installation stayed absent.
 *
 * The assertion is deliberately the RETRY, not the first click alone: a cancellation that resolves is
 * harmless as long as the key it resolved under is not kept. Cancelling and then retrying with the same
 * key must reach the picker again and register the folder it returns.
 */
test("a cancelled Game setup does not cache its own success under the idempotency key", async () => {
  await withWindowsPlatform(async () => {
    let pickerCalls = 0;
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          pickerCalls += 1;
          // The player dismisses the dialog, then picks the folder on the second click.
          return pickerCalls === 1
            ? { status: "cancelled" as const }
            : { status: "selected" as const, path: gameDirectoryCandidate };
        },
        createInstallationInspector: async () => {
          const chain = identityChainFor(gameDirectoryCandidate);
          return installationInspector([chain, chain]);
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const command = { apiVersion: 1 as const, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" };
      const registrationBefore = await readStardewInstallationRegistration(fixture.runtimeRoot);
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), command);
      assert.equal(pickerCalls, 1);
      // Nothing was registered by the cancelled dialog: the record is byte-identical.
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), registrationBefore);
      // The same key, after the cancellation settled: a fresh attempt, not the cached outcome. The
      // registration the retry writes is the record it found, advanced by exactly one revision.
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), command);
      assert.equal(pickerCalls, 2);
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), {
        ...registrationBefore!,
        revision: registrationBefore!.revision + 1,
      });
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup admits only one pending idempotency lineage", async () => {
  await withWindowsPlatform(async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          await gate;
          return { status: "cancelled" };
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const pending = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
        }),
        /stardew_game_setup_in_progress/,
      );
      assert.deepEqual(fixture.playerSpawnCalls, []);
      release();
      await pending;
    } finally {
      release();
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup picker failure replays exactly and permits a fresh-key retry", async () => {
  await withWindowsPlatform(async () => {
    let pickerCalls = 0;
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          pickerCalls += 1;
          if (pickerCalls === 1) throw new Error("controlled_picker_failure");
          return { status: "selected", path: gameDirectoryCandidate };
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const first = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      await assert.rejects(first, /stardew_game_setup_failed/);
      const replay = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      assert.equal(replay, first);
      await assert.rejects(replay, /stardew_game_setup_failed/);
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
      });
      assert.equal(pickerCalls, 2);
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("close drains a pending Game setup picker and prevents a later launch", async () => {
  await withWindowsPlatform(async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => {
          await gate;
          return { status: "selected", path: gameDirectoryCandidate };
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const setup = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      const close = fixture.coordinator.close();
      let closeSettled = false;
      void close.finally(() => {
        closeSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closeSettled, false);
      release();
      await assert.rejects(setup, /stardew_lifecycle_closing/);
      await close;
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      release();
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

/**
 * One-click mod-loader install.
 *
 * The defect this exists for: a player whose game folder holds Stardew Valley and no SMAPI
 * was told so by name and then had nowhere to go. The panel could only say "install SMAPI,
 * then find again" - a sentence that ends outside the product. These tests pin the action
 * that ends inside it, and the boundaries that make the button safe to press: it acts only
 * on the bound folder, it never overwrites a loader the player already has, it reports
 * `current` rather than claiming a write it did not make, and a generation that carries no
 * verifiable payload refuses instead of installing half a loader.
 */
