// The single policy-isolation proof for the Stardew Agent surface.
//
// This replaces what 39 native-local runners used to assert individually with
// `assertExactCapabilities`. That per-runner assertion was only ever true while
// a legacy `EnabledActions` allowlist hard-narrowed the surface; under the
// derived deny-by-exception policy the published base surface is legitimately
// advertised, so "exactly these N actions" was testing the retired config, not
// the product. It also broke every time an action changed lifecycle.
//
// What actually needs proving is stated once here:
//   1. an action the catalog still calls experimental never appears unless this
//      profile explicitly opted into it,
//   2. a denied action never appears,
//   3. a denied family's members never appear,
//   4. the policy shape the fixture writes is the derived one, and the retired
//      fields are gone.
//
// The Mod-side computation is mirrored from ActionPolicyEngine.ComputeEnabledActions
// and is checked against the real catalog so the two definitions cannot drift
// silently: the catalog is read from the C# source, never hand-copied.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFINITIONS = "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs";

/** Read the Mod catalog: id, family and lifecycle per registration. */
function readCatalog() {
  const source = readFileSync(resolve(ROOT, DEFINITIONS), "utf8");
  const body = /Registrations\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\)\;/.exec(source)?.[1];
  assert.ok(body, "the Mod registration block must be readable");
  const rows = [];
  for (const entry of body.split(/(?=\bE\()/)) {
    const m = /E\("([a-z_]+)",\s*"([a-z_]+)"/.exec(entry);
    if (!m) continue;
    const lifecycle = entry.includes("FarmhandActionLifecycle.Experimental")
      ? "experimental"
      : entry.includes("FarmhandActionLifecycle.LiveVerified")
        ? "live_verified"
        : "published";
    rows.push({ actionId: m[1], familyId: m[2], lifecycle });
  }
  return rows;
}

/** Mirror of ActionPolicyEngine.ComputeEnabledActions (deny-by-exception). */
function computeEnabledActions(rows, { deniedActions = [], deniedActionFamilies = [], experimentalActions = [] } = {}) {
  const denied = new Set(deniedActions);
  const deniedFamilies = new Set(deniedActionFamilies);
  const enabled = new Set(
    rows
      .filter((r) => (r.lifecycle === "published" || r.lifecycle === "live_verified")
        && !denied.has(r.actionId) && !deniedFamilies.has(r.familyId))
      .map((r) => r.actionId),
  );
  for (const action of experimentalActions) {
    const row = rows.find((r) => r.actionId === action && r.lifecycle === "experimental");
    if (row && !denied.has(row.actionId) && !deniedFamilies.has(row.familyId)) enabled.add(row.actionId);
  }
  return enabled;
}

const catalog = readCatalog();

test("the catalog is readable and its lifecycles are the expected three", () => {
  assert.ok(catalog.length > 40, `expected the full catalog, got ${catalog.length}`);
  const lifecycles = new Set(catalog.map((r) => r.lifecycle));
  for (const value of lifecycles) assert.ok(["published", "live_verified", "experimental"].includes(value), value);
});

test("default consent exposes the live rungs and leaks no unopted experimental action", () => {
  const enabled = computeEnabledActions(catalog);
  const expected = catalog.filter((r) => r.lifecycle !== "experimental").map((r) => r.actionId).sort();
  // Exact equality in both directions: nothing missing, and -- the point of this
  // test -- no experimental action smuggled in.
  assert.deepEqual([...enabled].sort(), expected);
  const leaked = catalog.filter((r) => r.lifecycle === "experimental" && enabled.has(r.actionId));
  assert.deepEqual(leaked, [], "experimental actions leaked into the default surface");
});

test("an experimental action appears only when this profile opted into it", () => {
  const experimental = catalog.filter((r) => r.lifecycle === "experimental");
  for (const row of experimental) {
    assert.equal(computeEnabledActions(catalog).has(row.actionId), false, `${row.actionId} leaked`);
    assert.equal(
      computeEnabledActions(catalog, { experimentalActions: [row.actionId] }).has(row.actionId),
      true,
      `${row.actionId} must be reachable through the explicit opt-in`,
    );
  }
});

test("a denied action is absent even when its lifecycle would admit it", () => {
  for (const row of catalog.filter((r) => r.lifecycle !== "experimental")) {
    const enabled = computeEnabledActions(catalog, { deniedActions: [row.actionId] });
    assert.equal(enabled.has(row.actionId), false, `${row.actionId} survived its own denial`);
  }
});

test("a denied family removes every one of its members", () => {
  const families = [...new Set(catalog.map((r) => r.familyId))];
  for (const familyId of families) {
    const enabled = computeEnabledActions(catalog, { deniedActionFamilies: [familyId] });
    const survivors = catalog
      .filter((r) => r.familyId === familyId && r.lifecycle !== "experimental" && enabled.has(r.actionId))
      .map((r) => r.actionId);
    assert.deepEqual(survivors, [], `family ${familyId} left members enabled`);
  }
});

test("denying an experimental action also closes its opt-in path", () => {
  for (const row of catalog.filter((r) => r.lifecycle === "experimental")) {
    const enabled = computeEnabledActions(catalog, {
      deniedActions: [row.actionId],
      experimentalActions: [row.actionId],
    });
    assert.equal(enabled.has(row.actionId), false, `${row.actionId} bypassed the deny through the opt-in`);
  }
});

test("the fixtures write the derived policy shape and none of the retired fields", () => {
  // The retired fields are what the runners used to assert. Keeping them out of
  // the fixtures is what makes the whole suite stop breaking on a lifecycle move.
  const fixture = readFileSync(resolve(ROOT, "tools/lib/stardew-native-local-player-fixture.mjs"), "utf8");
  assert.match(fixture, /result\.DeniedActions = \[\];/);
  assert.match(fixture, /result\.DeniedActionFamilies = \[\];/);
  assert.match(fixture, /result\.ExperimentalActions = actions\.filter/);
  assert.doesNotMatch(fixture, /result\.EnabledActions/);
  assert.doesNotMatch(fixture, /result\.ActionPolicyVersion/);

  // The experimental opt-in must come from the catalog, never a hand-typed list.
  assert.match(fixture, /readExperimentalStardewActionIds/);
});

test("the shared validator refuses a config that denies an action the run requires", async () => {
  const { validateNativeLocalFixturePolicy } = await import("./lib/stardew-native-smoke-harness-v1.mjs");
  const shape = { DeniedActions: [], DeniedActionFamilies: [], ExperimentalActions: [] };
  assert.doesNotThrow(() => validateNativeLocalFixturePolicy(shape, { requiredActions: ["move_to_tile"] }));
  assert.throws(
    () => validateNativeLocalFixturePolicy({ ...shape, DeniedActions: ["move_to_tile"] }, { requiredActions: ["move_to_tile"] }),
    /native_fixture_policy_denies_required/,
  );
  assert.throws(
    () => validateNativeLocalFixturePolicy({ ...shape, ExperimentalActions: ["pet_animal"] }, { experimentalActions: [] }),
    /native_fixture_policy_illegal_opt_in/,
  );
});