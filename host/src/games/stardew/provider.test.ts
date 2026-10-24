import assert from "node:assert/strict";
import test from "node:test";
import { isComposedGameProfile } from "../../game-browser-contract/index.js";
import type {
  StardewGameSurfaceActionAuthorityReader,
  StardewGameSurfaceAttachmentReader,
  StardewGameSurfaceInstallationReader,
  StardewGameSurfaceLaunchReadinessReader,
  StardewProductionLifecycleCoordinator,
} from "../../stardew-production-lifecycle-coordinator.internal.js";
import type { StardewRoleLifecycleReader } from "../../stardew-role-lifecycle-facade.js";
import { createStardewGamePresentationProjection } from "./provider.js";

const csrfToken = "A".repeat(43);

function fakeCoordinator(
  confirmResult: Readonly<{ status: "registered" | "mod_loader_missing" }> = { status: "registered" },
) {
  const calls = { lifecycle: 0, attachment: 0, launchReadiness: 0, actionAuthority: 0, installation: 0 };
  const discoveryCalls: string[] = [];
  const discoveryReceivers: unknown[] = [];
  const rawCandidateId = "A".repeat(43);
  const redactedCandidateId = "Q".repeat(42) + "A";
  const lifecycleReader = {
    readRoleLifecycleView: async () => {
      calls.lifecycle += 1;
      return { playerHost: { state: "pending", ownership: "none" } };
    },
  } as unknown as StardewRoleLifecycleReader;
  const attachmentReader = {
    readAttachmentView: () => {
      calls.attachment += 1;
      return { status: "none", generation: 0, connectionStatus: "none" };
    },
  } as unknown as StardewGameSurfaceAttachmentReader;
  const launchReadinessReader = {
    readLaunchReadinessView: () => {
      calls.launchReadiness += 1;
      return { generation: 0, status: "none" };
    },
  } as unknown as StardewGameSurfaceLaunchReadinessReader;
  const installation = { registered: false };
  const installationReader = {
    readInstallationView: async () => {
      calls.installation += 1;
      return installation.registered ? ("registered" as const) : ("absent" as const);
    },
  } as unknown as StardewGameSurfaceInstallationReader;
  const actionAuthorityReader = {
    readActionAuthorityView: () => {
      calls.actionAuthority += 1;
      return { status: "unavailable" };
    },
  } as unknown as StardewGameSurfaceActionAuthorityReader;
  const activationOwner = Object.freeze({
    bindBrowserAdmissionIssuer: () => undefined,
    async readInstallationDiscovery(this: unknown) {
      discoveryReceivers.push(this);
      discoveryCalls.push("read");
      return {
        candidates: [
          {
            candidateId: rawCandidateId,
            source: "known-location" as const,
            label: "Stardew Valley",
            displayPath: "C:\\\\Games\\\\Stardew Valley",
            location: null,
            status: "candidate" as const,
          },
          {
            candidateId: redactedCandidateId,
            source: "steam-vdf" as const,
            label: "Stardew Valley",
            displayPath: "Detected installation (path hidden)",
            location: "C: · Steam",
            status: "admission_required" as const,
          },
        ],
        diagnostics: ["no-candidates" as const],
      };
    },
    async confirmInstallation(this: unknown, _admission: unknown, candidateId: string) {
      discoveryReceivers.push(this);
      discoveryCalls.push(`confirm:${candidateId}`);
      return confirmResult;
    },
    async retryInstallationDiscovery(this: unknown) {
      discoveryReceivers.push(this);
      discoveryCalls.push("retry");
      return { candidates: [], diagnostics: [] };
    },
    async cancelInstallationSelection(this: unknown) {
      discoveryReceivers.push(this);
      discoveryCalls.push("cancel");
      return { status: "cancelled" as const };
    },
    async openInstallationPicker(this: unknown) {
      discoveryReceivers.push(this);
      discoveryCalls.push("manual-picker");
      return { status: "cancelled" as const };
    },
  });
  return {
    calls,
    discoveryCalls,
    discoveryReceivers,
    activationOwner,
    installation,
    coordinator: {
      lifecycleReader,
      attachmentReader,
      launchReadinessReader,
      installationReader,
      actionAuthorityReader,
      activationOwner,
      close: async () => undefined,
    } as unknown as StardewProductionLifecycleCoordinator,
  };
}

test("stardew presentation projection declares the game preview surface and binds the coordinator's own activation owner", () => {
  const { activationOwner, coordinator } = fakeCoordinator();
  const projection = createStardewGamePresentationProjection(coordinator);

  // Producer: the game adapter's own surface declaration is branded and carries
  // the exact preview operations the composed browser profile mounts.
  assert.equal(isComposedGameProfile(projection.gameProfile), true);
  assert.equal(projection.gameProfile.profileId, "gamebuddy.game.preview");
  assert.equal(projection.gameProfile.releaseTier, "game_preview");
  assert.deepEqual(projection.gameProfile.navigationItemIds, ["game"]);
  assert.deepEqual(
    [...projection.gameProfile.operationIds],
    [
      "game.state.read",
      "game.prerequisites.setup",
      "game.launch",
      "game.stop",
      "game.resume",
      "game.resume.cancel",
      "game.reopen",
      "game.disconnect",
      "game.endgame",
      "game.create",
      "game.installation.discovery.read",
      "game.installation.discovery.confirm",
      "game.installation.discovery.retry",
      "game.installation.discovery.cancel",
      "game.installation.discovery.manual_picker",
      "game.stardew.cabins.read",
      "game.stardew.cabins.confirm",
      "game.stardew.settings.read",
      "game.stardew.settings.update",
    ],
  );
  // Consumer: the activation owner crosses the seam as the composed binding
  // sink itself, so the static shell binds the coordinator's exact owner.
  assert.notEqual(projection.lifecycleActivationBindingSink, activationOwner);
  assert.equal(typeof projection.lifecycleActivationBindingSink.gameDiscovery?.read, "function");
});

test("stardew discovery mount delegates every nested callback to the same activation owner", async () => {
  const { activationOwner, coordinator, discoveryCalls, discoveryReceivers } = fakeCoordinator();
  const projection = createStardewGamePresentationProjection(coordinator);
  const discovery = projection.lifecycleActivationBindingSink.gameDiscovery!;
  const admission = {} as Parameters<typeof discovery.read>[0];

  assert.deepEqual(await discovery.read(admission), {
    apiVersion: 1,
    candidates: [
      {
        candidateId: "A".repeat(43),
        source: "known-location",
        label: "Stardew Valley",
        hint: null,
        location: null,
        status: "candidate",
      },
      {
        candidateId: "Q".repeat(42) + "A",
        source: "steam-vdf",
        label: "Stardew Valley",
        hint: "Detected installation (path hidden)",
        location: "C: · Steam",
        status: "admission_required",
      },
    ],
    diagnostics: ["no-candidates"],
  });
  await discovery.confirm(admission, { apiVersion: 1, candidateId: "Q".repeat(42) + "A" });
  await discovery.retry(admission);
  await discovery.cancel(admission);
  await discovery.manualPicker(admission);

  assert.deepEqual(discoveryCalls, ["read", `confirm:${"Q".repeat(42)}A`, "retry", "cancel", "manual-picker"]);
  assert.deepEqual(discoveryReceivers, [
    activationOwner,
    activationOwner,
    activationOwner,
    activationOwner,
    activationOwner,
  ]);
  assert.equal(
    projection.lifecycleActivationBindingSink.bindBrowserAdmissionIssuer,
    activationOwner.bindBrowserAdmissionIssuer,
  );
});

test("the mod-loader refusal crosses the seam as its own outcome, not as an unavailable one", async () => {
  const { coordinator } = fakeCoordinator({ status: "mod_loader_missing" });
  const projection = createStardewGamePresentationProjection(coordinator);
  const discovery = projection.lifecycleActivationBindingSink.gameDiscovery!;
  const admission = {} as Parameters<typeof discovery.confirm>[0];

  // Producer: the coordinator refused the candidate because the folder has no mod
  // loader. Verifier: the projection keeps that outcome instead of folding it into
  // `unavailable`, which the panel renders as a search outcome.
  assert.deepEqual(await discovery.confirm(admission, { apiVersion: 1, candidateId: "Q".repeat(42) + "A" }), {
    apiVersion: 1,
    status: "mod_loader_missing",
  });
});

test("stardew presentation projection reads game state through the coordinator's own readers", async () => {
  const { calls, coordinator } = fakeCoordinator();
  const projection = createStardewGamePresentationProjection(coordinator);

  const state = await projection.readGame({ csrfToken, browserSessionExpiresAtMs: 1_000 });

  // Verifier: the projection delegates to every coordinator reader and projects
  // the declared game profile identity, never a browser- or entry-supplied one.
  assert.deepEqual(calls, { lifecycle: 1, attachment: 1, launchReadiness: 1, actionAuthority: 1, installation: 1 });
  assert.equal(state.apiVersion, 1);
  assert.equal(state.build.browserContract, "game_browser_api/v1");
  assert.equal(state.build.profileId, "gamebuddy.game.preview");
  assert.equal(state.csrfToken, csrfToken);
  assert.equal(state.browserSession.expiresAtMs, 1_000);
  assert.equal(state.game.instance.status, "launching");
  assert.equal(state.game.connectionStatus, "none");
  assert.equal(state.game.actionAuthority, "unavailable");
});

/**
 * Defect 3. The Game surface said "no Stardew Valley installation was found"
 * while the Host held a `ready` registration for that same directory, because
 * the surface derived "is the game installed" from launch readiness alone - a
 * fact that only exists AFTER a launch was staged. The registration read is the
 * authoritative one (the launch path gates on the same call), so both directions
 * are pinned here: registered+ready => the surface does not claim it was not
 * found, and genuinely unregistered => it does.
 */
test("the game surface's install state follows the Host registration in both directions", async () => {
  const { coordinator, installation, calls } = fakeCoordinator();
  const projection = createStardewGamePresentationProjection(coordinator);
  const context = { csrfToken, browserSessionExpiresAtMs: 1_900_000_000_000 };

  const unregistered = await projection.readGame(context);
  assert.equal(unregistered.game.prerequisites.status, "unknown");
  assert.equal(unregistered.game.prerequisites.detectedGame, null);

  installation.registered = true;
  const registered = await projection.readGame(context);
  assert.equal(registered.game.prerequisites.status, "met");
  assert.equal(registered.game.prerequisites.detectedGame, "Stardew Valley");
  assert.equal(calls.installation, 2);
});
