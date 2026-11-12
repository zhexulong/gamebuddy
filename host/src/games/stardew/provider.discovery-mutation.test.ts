import assert from "node:assert/strict";
import test from "node:test";
import type {
  StardewInstallationSelectionResult,
  StardewProductionLifecycleCoordinator,
} from "../../stardew-production-lifecycle-coordinator.internal.js";
import { createStardewGamePresentationProjection } from "./provider.js";

const csrfToken = "A".repeat(43);
const browserSessionExpiresAtMs = 1_900_000_000_000;
const candidateId = "Q".repeat(42) + "A";

/**
 * The projection answering exactly one registration.
 *
 * The other discovery seams refuse to answer: this file asks one question - what leaves the Host when the coordinator
 * reports what became of the companion Mod - and a fake that answered everything would leave the answer's origin
 * ambiguous.
 */
function registrationAnswering(selection: StardewInstallationSelectionResult) {
  const unused = async () => {
    throw new Error("unused_discovery_seam");
  };
  const activationOwner = Object.freeze({
    confirmInstallation: async () => selection,
    readInstallationDiscovery: unused,
    retryInstallationDiscovery: unused,
    cancelInstallationSelection: unused,
    openInstallationPicker: unused,
  });
  const coordinator = { activationOwner } as unknown as StardewProductionLifecycleCoordinator;
  const discovery = createStardewGamePresentationProjection(coordinator).lifecycleActivationBindingSink.gameDiscovery;
  assert.ok(discovery, "the projection must expose the installation discovery binding");
  return discovery;
}

function confirmOn(discovery: ReturnType<typeof registrationAnswering>) {
  const admission = { csrfToken, browserSessionExpiresAtMs } as Parameters<typeof discovery.confirm>[0];
  return discovery.confirm(admission, { apiVersion: 1, candidateId });
}

/**
 * A registration whose Mod deployment was refused is not a registration the player can play.
 *
 * The coordinator deploys the Mod as the last step of registering
 * (`stardew-production-lifecycle-coordinator.internal.ts:1761-1762`) and reports the outcome beside `registered`
 * precisely so a refusal names itself - "the folder is registered" and "the Mod is where the game will load it" are
 * two different facts. Measured 2026-11-13: the projection copied `status` alone, so a Host that wrote nothing into
 * `Mods/GameBuddy` answered exactly what a Host that deployed it answered, and the panel's
 * `data-companion-mod-outcome` sentence could never render.
 */
test("a registered folder carries what happened to the companion Mod when the deployment was refused", async () => {
  const discovery = registrationAnswering({
    status: "registered",
    companionMod: "companion-mod-mods-directory-not-writable",
  });

  assert.deepEqual(await confirmOn(discovery), {
    apiVersion: 1,
    status: "registered",
    companionMod: "companion-mod-mods-directory-not-writable",
  });
});

test("a registered folder carries a successful deployment too, so the two are distinguishable", async () => {
  const discovery = registrationAnswering({ status: "registered", companionMod: "companion-mod-installed" });

  assert.deepEqual(await confirmOn(discovery), {
    apiVersion: 1,
    status: "registered",
    companionMod: "companion-mod-installed",
  });
});

/**
 * The Mod outcome is a member of `registered` alone.
 *
 * A refusal names its own cause (`mod_loader_missing` and its siblings) and no deployment ever ran there, so this
 * outcome must not appear beside it - an absent key is the only honest reading, and the browser treats absent as
 * "not reported".
 */
test("a registration refusal carries no Mod outcome at all", async () => {
  const discovery = registrationAnswering({ status: "mod_loader_missing" });

  const answer = await confirmOn(discovery);

  assert.deepEqual(answer, { apiVersion: 1, status: "mod_loader_missing" });
  assert.equal(Object.hasOwn(answer, "companionMod"), false);
});
