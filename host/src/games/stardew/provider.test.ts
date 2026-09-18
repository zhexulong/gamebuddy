import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isComposedGameProfile } from "../../game-browser-contract/index.js";
import type {
  StardewGameSurfaceActionAuthorityReader,
  StardewGameSurfaceAttachmentReader,
  StardewGameSurfaceLaunchReadinessReader,
  StardewProductionLifecycleCoordinator,
} from "../../stardew-production-lifecycle-coordinator.internal.js";
import type { StardewRoleLifecycleReader } from "../../stardew-role-lifecycle-facade.js";
import { createStardewGamePresentationProjection } from "./provider.js";

const csrfToken = "A".repeat(43);

function fakeCoordinator() {
  const calls = { lifecycle: 0, attachment: 0, launchReadiness: 0, actionAuthority: 0 };
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
  const actionAuthorityReader = {
    readActionAuthorityView: () => {
      calls.actionAuthority += 1;
      return { status: "unavailable" };
    },
  } as unknown as StardewGameSurfaceActionAuthorityReader;
  const activationOwner = Object.freeze({ bindBrowserAdmissionIssuer: () => undefined });
  return {
    calls,
    activationOwner,
    coordinator: {
      lifecycleReader,
      attachmentReader,
      launchReadinessReader,
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
      "game.create",
      "game.stardew.cabins.read",
      "game.stardew.cabins.confirm",
    ],
  );
  // Consumer: the activation owner crosses the seam as the composed binding
  // sink itself, so the static shell binds the coordinator's exact owner.
  assert.equal(projection.lifecycleActivationBindingSink, activationOwner);
});

test("stardew presentation projection reads game state through the coordinator's own readers", async () => {
  const { calls, coordinator } = fakeCoordinator();
  const projection = createStardewGamePresentationProjection(coordinator);

  const state = await projection.readGame({ csrfToken, browserSessionExpiresAtMs: 1_000 });

  // Verifier: the projection delegates to every coordinator reader and projects
  // the declared game profile identity, never a browser- or entry-supplied one.
  assert.deepEqual(calls, { lifecycle: 1, attachment: 1, launchReadiness: 1, actionAuthority: 1 });
  assert.equal(state.apiVersion, 1);
  assert.equal(state.build.browserContract, "game_browser_api/v1");
  assert.equal(state.build.profileId, "gamebuddy.game.preview");
  assert.equal(state.csrfToken, csrfToken);
  assert.equal(state.browserSession.expiresAtMs, 1_000);
  assert.equal(state.game.instance.status, "launching");
  assert.equal(state.game.connectionStatus, "none");
  assert.equal(state.game.actionAuthority, "unavailable");
});

test("stardew provider returns the presentation projection with its lifecycle capability", async () => {
  // The production provider closure is not constructible without a deployment
  // manifest, an authenticated Guardian session, and the published native
  // helpers, so this seam is pinned at source: the capability carries the same
  // owner's projection and never a second lifecycle owner.
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "games", "stardew", "provider.ts"),
    "utf8",
  );
  assert.match(source, /return Object\.freeze\(\{\s*close: \(\) => coordinator\.close\(\),\s*presentation: createStardewGamePresentationProjection\(coordinator\),\s*\}\);/s);
  assert.match(source, /presentation: createStardewGamePresentationProjection\(coordinator\)/);
});
