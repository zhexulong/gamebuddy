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
import {
  createStardewInstallationDiscoveryProvider,
  type StardewGogInstallRootSource,
  type StardewInstallationDiscoveryProvider,
} from "./windows-stardew-installation-discovery/index.js";
import { probeStardewGameRoot } from "./stardew-game-install/discovery.js";

installLifecycleTestHooks();

test("installation discovery reports unavailable sources and no candidates without invoking registration", async () => {
  await withWindowsPlatform(async () => {
    const provider = createStardewInstallationDiscoveryProvider({
      probe: async () => ({ readable: true, smapi: false }),
    });
    const fixture = await createFixture({ overrides: { installationDiscoveryOverlay: provider } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const result = await fixture.coordinator.activationOwner.readInstallationDiscovery(
        fixture.broker.issue("discovery_read"),
      );
      assert.deepEqual(result, { candidates: [], diagnostics: ["source-unavailable", "no-candidates"] });
      assert.equal(fixture.playerSpawnCalls.length, 0);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("installation discovery routes admit each coordinator operation without operation mismatch", async () => {
  await withWindowsPlatform(async () => {
    const events: string[] = [];
    const provider: StardewInstallationDiscoveryProvider = Object.freeze({
      discover: async () => {
        events.push("discover");
        return {
          candidates: [
            {
              candidateId: "candidate-01",
              source: "known-location" as const,
              label: "Stardew Valley",
              displayPath: "Detected installation (path hidden)",
              location: "C: · Steam",
              status: "admission_required" as const,
              modLoader: "missing" as const,
            },
          ],
          diagnostics: [],
        };
      },
      confirm: (candidateId: string) => {
        assert.equal(candidateId, "candidate-01");
        events.push("confirm");
        return gameDirectoryCandidate;
      },
      reset: () => {
        events.push("reset");
      },
    });
    const fixture = await createFixture({
      overrides: {
        installationDiscoveryOverlay: provider,
        selectStardewFolder: async () => ({ status: "cancelled" as const }),
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const initial = await fixture.coordinator.activationOwner.readInstallationDiscovery(
        fixture.broker.issue("discovery_read"),
      );
      assert.equal(initial.candidates.length, 1);
      assert.deepEqual(
        await fixture.coordinator.activationOwner.confirmInstallation(
          fixture.broker.issue("discovery_confirm"),
          "candidate-01",
        ),
        // The folder is registered AND the Mod outcome is reported. These fixtures mount no generation root, so
        // the Mod deployment has nothing to deploy and says so - which is the fact, not a placeholder.
        { status: "registered", companionMod: "companion-mod-unavailable" },
      );
      const retried = await fixture.coordinator.activationOwner.retryInstallationDiscovery(
        fixture.broker.issue("discovery_retry"),
      );
      assert.equal(retried.candidates.length, 1);
      assert.deepEqual(
        await fixture.coordinator.activationOwner.cancelInstallationSelection(fixture.broker.issue("discovery_cancel")),
        { status: "cancelled" },
      );
      assert.deepEqual(
        await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")),
        { status: "cancelled" },
      );
      assert.deepEqual(events, ["discover", "confirm", "reset", "discover", "reset"]);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("installation discovery retry resets the provider before rediscovery and cancellation", async () => {
  await withWindowsPlatform(async () => {
    const events: string[] = [];
    const provider: StardewInstallationDiscoveryProvider = Object.freeze({
      discover: async () => {
        events.push("discover");
        return { candidates: [], diagnostics: ["no-candidates"] as const };
      },
      confirm: () => {
        throw new Error("confirm_not_expected");
      },
      reset: () => {
        events.push("reset");
      },
    });
    const fixture = await createFixture({ overrides: { installationDiscoveryOverlay: provider } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.readInstallationDiscovery(fixture.broker.issue("discovery_read"));
      await fixture.coordinator.activationOwner.retryInstallationDiscovery(fixture.broker.issue("discovery_retry"));
      assert.deepEqual(
        await fixture.coordinator.activationOwner.cancelInstallationSelection(fixture.broker.issue("discovery_cancel")),
        { status: "cancelled" },
      );
      assert.deepEqual(events, ["discover", "reset", "discover", "reset"]);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("an installation holding the game but no mod loader is named, not reported as a failed search", async () => {
  await withWindowsPlatform(async () => {
    // The machine the report came from: Stardew Valley is installed and SMAPI is not.
    // The folder's own contents are the fact the launch-time requirement reads, so
    // this fixture is a real directory holding only the game executable.
    const installParent = await canonicalTemporaryRoot("gamebuddy-vanilla-install-");
    temporaryRoots.push(installParent);
    const vanillaRoot = join(installParent, "Stardew Valley");
    await mkdir(vanillaRoot, { recursive: true });
    await writeFile(join(vanillaRoot, "Stardew Valley.exe"), "", "utf8");
    const provider: StardewInstallationDiscoveryProvider = Object.freeze({
      discover: async () => ({
        candidates: [
          {
            candidateId: "candidate-01",
            source: "known-location" as const,
            label: "Stardew Valley",
            displayPath: "Detected installation (path hidden)",
            location: "C: · Steam",
            status: "admission_required" as const,
            modLoader: "missing" as const,
          },
        ],
        diagnostics: [] as const,
      }),
      confirm: (candidateId: string) => {
        assert.equal(candidateId, "candidate-01");
        return vanillaRoot;
      },
      reset: () => undefined,
    });
    const fixture = await createFixture({
      overrides: {
        installationDiscoveryOverlay: provider,
        selectStardewFolder: async () => ({ status: "selected" as const, path: vanillaRoot }),
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const registrationBefore = await readStardewInstallationRegistration(fixture.runtimeRoot);
      // Both routes to the same admission - the candidate the scan found and the
      // folder the player picked - name the same fact rather than folding it into
      // `unavailable`, which the panel reads as a search that failed.
      assert.deepEqual(
        await fixture.coordinator.activationOwner.confirmInstallation(
          fixture.broker.issue("discovery_confirm"),
          "candidate-01",
        ),
        { status: "mod_loader_missing" },
      );
      assert.deepEqual(
        await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")),
        { status: "mod_loader_missing" },
      );
      // The refusal comes before admission: nothing was inspected and the player's
      // registration is exactly what it was.
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), registrationBefore);
      assert.equal(fixture.freshRegistrationAdmissionCount(), 0);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

/**
 * The other selection refusal a player can cause: they picked a folder that holds no
 * game. It is not a failed search and not an unavailable registration - the search was
 * fine and the folder was simply wrong - so both routes into registration name it, and
 * the registration itself is untouched.
 *
 * The boundary is part of the same test: a folder this process cannot read is NOT this
 * fact, and a lifecycle that is closing names no cause about the folder at all. Both keep
 * the unnamed `unavailable` outcome rather than telling a player to pick a different
 * folder when the disk was what failed.
 */
test("a folder holding no game is refused by its own name, and every other refusal unchanged", async () => {
  await withWindowsPlatform(async () => {
    const installParent = await canonicalTemporaryRoot("gamebuddy-wrong-folder-");
    temporaryRoots.push(installParent);
    const wrongRoot = join(installParent, "My Pictures");
    await mkdir(wrongRoot, { recursive: true });
    const provider: StardewInstallationDiscoveryProvider = Object.freeze({
      discover: async () => ({
        candidates: [
          {
            candidateId: "candidate-01",
            source: "known-location" as const,
            label: "Stardew Valley",
            displayPath: "Detected installation (path hidden)",
            location: "C: · Steam",
            status: "admission_required" as const,
            modLoader: "missing" as const,
          },
        ],
        diagnostics: [] as const,
      }),
      confirm: (candidateId: string) => {
        assert.equal(candidateId, "candidate-01");
        return wrongRoot;
      },
      reset: () => undefined,
    });
    const fixture = await createFixture({
      overrides: {
        installationDiscoveryOverlay: provider,
        selectStardewFolder: async () => ({ status: "selected" as const, path: wrongRoot }),
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const registrationBefore = await readStardewInstallationRegistration(fixture.runtimeRoot);
      assert.deepEqual(
        await fixture.coordinator.activationOwner.confirmInstallation(
          fixture.broker.issue("discovery_confirm"),
          "candidate-01",
        ),
        { status: "not_stardew_installation" },
      );
      assert.deepEqual(
        await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")),
        { status: "not_stardew_installation" },
      );
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), registrationBefore);
      assert.equal(fixture.freshRegistrationAdmissionCount(), 0);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

/**
 * The third refusal a player can cause, and the one that used to be invisible.
 *
 * A folder reached through a shortcut, a junction or an MO2 virtual folder holds the game and
 * the mod loader - so neither of the two older refusals can be what refuses it - and the
 * identity chain is the only check that sees the link. It reached the player as `unavailable`,
 * the sentence that claims no cause, so nothing told them the path was the problem. The
 * boundary is asserted in the same run: the very next pick holds no game at all and keeps
 * `not_stardew_installation`, so the two refusals did not collapse into one.
 */
test("a folder reached through a link is refused by its own name, and a folder with no game keeps its own", async () => {
  await withWindowsPlatform(async () => {
    const installParent = await canonicalTemporaryRoot("gamebuddy-reparse-folder-");
    temporaryRoots.push(installParent);
    const linkedRoot = join(installParent, "Stardew Valley");
    await mkdir(linkedRoot, { recursive: true });
    // Both executables, so neither the no-game nor the no-mod-loader refusal can be what
    // refuses this folder: only the path itself is wrong.
    await writeFile(join(linkedRoot, "Stardew Valley.exe"), "", "utf8");
    await writeFile(join(linkedRoot, "StardewModdingAPI.exe"), "", "utf8");
    const noGameRoot = join(installParent, "My Pictures");
    await mkdir(noGameRoot, { recursive: true });
    // The chain the inspector reports for the linked folder: one of its components is a
    // reparse point, which is exactly what a junction, a shortcut target or an MO2 instance is.
    const reparseChain = identityChainFor(linkedRoot).map((entry, index) =>
      index === 1 ? Object.freeze({ ...entry, isReparsePoint: true }) : entry,
    );
    const picks = [linkedRoot, noGameRoot];
    let pickCount = 0;
    const fixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => ({ status: "selected" as const, path: picks[pickCount++]! }),
        createInstallationInspector: async () => installationInspector([reparseChain]),
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const registrationBefore = await readStardewInstallationRegistration(fixture.runtimeRoot);
      assert.deepEqual(
        await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")),
        { status: "reparse_point" },
      );
      assert.deepEqual(
        await fixture.coordinator.activationOwner.openInstallationPicker(fixture.broker.issue("discovery_picker")),
        { status: "not_stardew_installation" },
      );
      // Neither refusal registered anything: the durable record is exactly what it was.
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), registrationBefore);
      assert.equal(pickCount, 2);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

/**
 * The end-to-end half of the GOG wiring: a candidate a NON-Steam source produced reaches the
 * exact same admission a Steam candidate does.
 *
 * The panel's provider mounted Steam alone, so a player whose Stardew Valley came from GOG
 * Galaxy saw an empty scan on a machine where the game is installed. What matters after the
 * wiring is not that a row appears but that confirming it is admitted by the same three
 * checks - `requireStardewGameInstalled`, `requireStardewModLoaderInstalled` and
 * `admitStardewInstallation` - on the folder GOG named. The fixture mounts the production
 * provider with only the two metadata readers replaced and the real probe, and counts the
 * fresh inspector admissions, which only `registerInstallationLocator` mints.
 */
test("a candidate a non-Steam source produced reaches the same registration admission", async () => {
  await withWindowsPlatform(async () => {
    const installParent = await canonicalTemporaryRoot("gamebuddy-gog-install-");
    temporaryRoots.push(installParent);
    const installRoot = join(installParent, "Stardew Valley");
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, "Stardew Valley.exe"), "", "utf8");
    await writeFile(join(installRoot, "StardewModdingAPI.exe"), "", "utf8");

    // The production composition, with only the two metadata readers replaced: the GOG source
    // names the folder above, and no Steam library holds the game at all.
    const provider = createStardewInstallationDiscoveryProvider({
      probe: async () => ({ readable: true, smapi: false }),
      source: Object.freeze({
        read: async () => Object.freeze({ roots: Object.freeze([]), diagnostics: Object.freeze([]) }),
      }),
      gog: Object.freeze({
        read: async () => Object.freeze({ roots: Object.freeze([installRoot]), diagnostics: Object.freeze([]) }),
        probe: probeStardewGameRoot,
      }) satisfies StardewGogInstallRootSource,
    });
    const fixture = await createFixture({
      overrides: {
        installationDiscoveryOverlay: provider,
        createInstallationInspector: async () => installationInspector([identityChainFor(installRoot)]),
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const scan = await fixture.coordinator.activationOwner.readInstallationDiscovery(
        fixture.broker.issue("discovery_read"),
      );
      assert.deepEqual(
        scan.candidates.map((candidate) => candidate.source),
        ["gog"],
      );
      assert.deepEqual(scan.diagnostics, []);
      assert.deepEqual(
        await fixture.coordinator.activationOwner.confirmInstallation(
          fixture.broker.issue("discovery_confirm"),
          scan.candidates[0]!.candidateId,
        ),
        // The folder is registered AND the Mod outcome is reported. These fixtures mount no generation root, so
        // the Mod deployment has nothing to deploy and says so - which is the fact, not a placeholder.
        { status: "registered", companionMod: "companion-mod-unavailable" },
      );
      // The candidate was admitted, not trusted: one fresh admission ran, and the durable
      // record now names the very folder the GOG source proposed. The pointer stays bound to
      // the activation's own attempt, which is exactly what a Steam candidate leaves behind.
      assert.equal(fixture.freshRegistrationAdmissionCount(), 1);
      const registered = await readStardewInstallationRegistration(fixture.runtimeRoot);
      assert.equal(registered?.state, "ready");
      assert.equal(registered?.locator, installRoot);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

/**
 * And the same admission still refuses what it always refused, whatever source proposed it: a
 * GOG folder holding the game and no mod loader is the mod-loader refusal, not a registration.
 */
test("a non-Steam candidate without the mod loader is refused by the shared admission", async () => {
  await withWindowsPlatform(async () => {
    const installParent = await canonicalTemporaryRoot("gamebuddy-gog-vanilla-");
    temporaryRoots.push(installParent);
    const installRoot = join(installParent, "Stardew Valley");
    await mkdir(installRoot, { recursive: true });
    await writeFile(join(installRoot, "Stardew Valley.exe"), "", "utf8");
    const provider = createStardewInstallationDiscoveryProvider({
      probe: async () => ({ readable: true, smapi: false }),
      gog: Object.freeze({
        read: async () => Object.freeze({ roots: Object.freeze([installRoot]), diagnostics: Object.freeze([]) }),
        probe: probeStardewGameRoot,
      }),
    });
    const fixture = await createFixture({
      overrides: { installationDiscoveryOverlay: provider },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const scan = await fixture.coordinator.activationOwner.readInstallationDiscovery(
        fixture.broker.issue("discovery_read"),
      );
      assert.deepEqual(
        scan.candidates.map((candidate) => candidate.source),
        ["gog"],
      );
      assert.deepEqual(
        await fixture.coordinator.activationOwner.confirmInstallation(
          fixture.broker.issue("discovery_confirm"),
          scan.candidates[0]!.candidateId,
        ),
        { status: "mod_loader_missing" },
      );
      // The refusal comes before admission: nothing was inspected and nothing was registered.
      assert.equal(fixture.freshRegistrationAdmissionCount(), 0);
      assert.equal((await readStardewInstallationRegistration(fixture.runtimeRoot))?.locator, gameDirectoryCandidate);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("an unreadable or closing installation selection keeps the unnamed unavailable outcome", async () => {
  await withWindowsPlatform(async () => {
    // A path this process cannot look at: the read never completes, so no cause about the
    // folder can be named.
    const unreadable = "C:\\gamebuddy\u0000unreadable";
    const unreadableFixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => ({ status: "selected" as const, path: unreadable }),
      },
    });
    try {
      assert.deepEqual(
        await unreadableFixture.coordinator.activationOwner.openInstallationPicker(
          unreadableFixture.broker.issue("discovery_picker"),
        ),
        { status: "unavailable" },
      );
    } finally {
      await unreadableFixture.coordinator.close();
      await unreadableFixture.broker.close();
    }

    const closingFixture = await createFixture({
      overrides: {
        selectStardewFolder: async () => ({ status: "cancelled" as const }),
      },
    });
    await closingFixture.coordinator.activationOwner.activate(closingFixture.broker.issue());
    await closingFixture.coordinator.close();
    try {
      assert.deepEqual(
        await closingFixture.coordinator.activationOwner.openInstallationPicker(
          closingFixture.broker.issue("discovery_picker"),
        ),
        { status: "unavailable" },
      );
    } finally {
      await closingFixture.broker.close();
    }
  });
});
