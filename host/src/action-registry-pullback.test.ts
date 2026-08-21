import test from "node:test";
import assert from "node:assert/strict";
import { fc } from "./test-support/fast-check.js";
import {
  STARDEW_ACTION_REGISTRY,
  visiblePublishedActions,
  resolveCapabilityPullback,
  type ActionPolicy,
} from "./action-registry.js";

test("Pullback Universal Property: ActiveActions == Published ∩ LiveCapabilities ∩ ActionNotDenied ∩ FamilyNotDenied", () => {
  const candidateActions = STARDEW_ACTION_REGISTRY.map((a) => a.actionId);
  const candidateFamilies = Array.from(new Set(STARDEW_ACTION_REGISTRY.map((a) => a.familyId)));

  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...candidateActions), { minLength: 0, maxLength: 6 }),
      fc.array(fc.constantFrom(...candidateActions), { minLength: 0, maxLength: 6 }),
      fc.array(fc.constantFrom(...candidateFamilies), { minLength: 0, maxLength: 3 }),
      (liveCapsList, deniedActionsList, deniedFamiliesList) => {
        const liveCaps = Array.from(new Set(liveCapsList));
        const deniedActions = Array.from(new Set(deniedActionsList));
        const deniedFamilies = Array.from(new Set(deniedFamiliesList));
        const policy: ActionPolicy = { policyVersion: 1, deniedActions, deniedFamilies };

        const result = resolveCapabilityPullback(STARDEW_ACTION_REGISTRY, liveCaps, policy);
        const resultSet = new Set(result.map((a) => a.actionId));

        for (const action of STARDEW_ACTION_REGISTRY) {
          const isPublished = action.lifecycle === "published" && action.actionClass === "primitive";
          const isLive = liveCaps.includes(action.requiredCapability);
          const isNotDeniedAction = !deniedActions.includes(action.actionId);
          const isNotDeniedFamily = !deniedFamilies.includes(action.familyId);

          const shouldBeIncluded = isPublished && isLive && isNotDeniedAction && isNotDeniedFamily;
          assert.equal(resultSet.has(action.actionId), shouldBeIncluded);
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("visiblePublishedActions delegates directly to resolveCapabilityPullback", () => {
  const caps = ["till_soil", "equip_tool"];
  const policy: ActionPolicy = { policyVersion: 1, deniedActions: ["equip_tool"], deniedFamilies: [] };

  const fromPullback = resolveCapabilityPullback(STARDEW_ACTION_REGISTRY, caps, policy);
  const fromVisible = visiblePublishedActions(caps, policy);

  assert.deepEqual(fromVisible, fromPullback);
});
