import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { visibleActionsFromModCatalog, type ActionPolicy } from "./action-registry.js";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";

test("Mod catalog pullback preserves restrictive intersection laws", () => {
  const candidateActions = TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId);
  const candidateFamilies = Array.from(new Set(TEST_MOD_REGISTRATIONS.map((entry) => entry.familyId)));

  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...candidateActions), { minLength: 0, maxLength: 6 }),
      fc.array(fc.constantFrom(...candidateActions), { minLength: 0, maxLength: 6 }),
      fc.array(fc.constantFrom(...candidateFamilies), { minLength: 0, maxLength: 3 }),
      (liveCapabilities, deniedActions, deniedFamilies) => {
        const policy: ActionPolicy = {
          policyVersion: 1,
          deniedActions: Array.from(new Set(deniedActions)),
          deniedFamilies: Array.from(new Set(deniedFamilies)),
        };
        const result = visibleActionsFromModCatalog(
          TEST_MOD_REGISTRATIONS,
          Array.from(new Set(liveCapabilities)),
          policy,
        );
        const resultIds = new Set(result.map((entry) => entry.actionId));
        for (const registration of TEST_MOD_REGISTRATIONS) {
          const expected =
            liveCapabilities.includes(registration.actionId) &&
            !policy.deniedActions.includes(registration.actionId) &&
            !policy.deniedFamilies.includes(registration.familyId);
          assert.equal(resultIds.has(registration.actionId), expected);
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("unregistered local adapters never materialize", () => {
  const result = visibleActionsFromModCatalog(
    [
      {
        actionId: "unknown_mod_action",
        familyId: "unknown_family",
        identityVersion: 1,
        lifecycle: "published", kind: "execution" as const,
      },
    ],
    ["unknown_mod_action"],
  );
  assert.deepEqual(result, []);
});
