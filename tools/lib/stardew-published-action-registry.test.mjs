import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPublishedStardewActionIds, readStardewActionWatchdogs } from "./stardew-published-action-registry.mjs";

const registrations = `
public static readonly IReadOnlyList<FarmhandActionRegistration> Registrations = Array.AsReadOnly(new[]
{
    Registration("move_to_tile", "movement_navigation", 1, FarmhandActionHandlerGroup.Movement),
    Registration("not_published", "future", 1, FarmhandActionHandlerGroup.Movement, FarmhandActionLifecycle.Experimental),
    Registration("till_soil", "farming_crops", 1, FarmhandActionHandlerGroup.Farming),
});
`;

async function withRegistrations(source, run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-action-registrations-"));
  const path = join(root, "FarmhandActionDefinitions.cs");
  try {
    await writeFile(path, source, "utf8");
    return await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("published action extraction is Mod-owned and excludes experimental registrations", async () => {
  await withRegistrations(registrations, async (registrationsPath) => {
    assert.deepEqual(await readPublishedStardewActionIds({ registrationsPath }), ["move_to_tile", "till_soil"]);
  });
});

test("published action extraction fails closed without the Mod registration declaration", async () => {
  await withRegistrations(registrations.replace("Registrations", "OtherRegistrations"), async (registrationsPath) => {
    await assert.rejects(readPublishedStardewActionIds({ registrationsPath }), /missing_mod_registrations/);
  });
});

test("published action extraction rejects duplicate Mod-owned published identifiers", async () => {
  await withRegistrations(
    registrations.replace(
      'Registration("till_soil", "farming_crops", 1, FarmhandActionHandlerGroup.Farming)',
      'Registration("move_to_tile", "farming_crops", 1, FarmhandActionHandlerGroup.Farming)',
    ),
    async (registrationsPath) => {
      await assert.rejects(readPublishedStardewActionIds({ registrationsPath }), /invalid_published_set/);
    },
  );
});

/**
 * A catalog with the three things the derivation must tell apart: a row that takes the declared default, a row that
 * names a constant of its own, a row whose descriptor comes from a factory that declares the window in a `with` block,
 * and a read-only row that must publish nothing at all.
 */
const catalogWithWindows = `
public const long DefaultWatchdogMs = 60_000;
public const long NavigationWatchdogMs = 600_000;
public const long LifecycleWatchdogMs = 600_000;

private static FarmhandActionDescriptor Lifecycle() => new FarmhandActionDescriptor(
    Array.Empty<FarmhandActionArgument>()) with
{
    WatchdogMs = FarmhandActionCatalog.LifecycleWatchdogMs,
};

public static readonly IReadOnlyList<FarmhandActionRegistration> Registrations = Array.AsReadOnly(new[]
{
    E("till_soil", "farming_crops", FarmhandActionHandlerGroup.Farming, A(null, null, "native_action_postcondition")),
    E("navigate_to_destination", "world_navigation", FarmhandActionHandlerGroup.Movement, new FarmhandActionDescriptor(
        new[] { new FarmhandActionArgument("destination", "destination_selector") },
        WatchdogMs: NavigationWatchdogMs)),
    E("sleep", "world_lifecycle", FarmhandActionHandlerGroup.WorldLifecycle, Lifecycle(), FarmhandActionLifecycle.LiveVerified),
    R("observe_scene", "world_perception"),
});
`;

test("the watchdog is each registration's own declared window, never one constant", async () => {
  await withRegistrations(catalogWithWindows, async (registrationsPath) => {
    const watchdogOf = readStardewActionWatchdogs({ definitionsPath: registrationsPath });
    assert.equal(watchdogOf.get("till_soil"), 60_000, "an ordinary row takes the declared default");
    assert.equal(
      watchdogOf.get("navigate_to_destination"),
      600_000,
      "a row naming its own constant publishes that constant",
    );
    assert.equal(
      watchdogOf.get("sleep"),
      600_000,
      "a row whose descriptor is a factory publishes what the factory declares",
    );
    assert.equal(
      watchdogOf.has("observe_scene"),
      false,
      "a read-only row is not dispatchable, so it publishes no window rather than the default",
    );
  });
});

test("the real catalog publishes the window the live defect was measured against", () => {
  const watchdogOf = readStardewActionWatchdogs();
  assert.equal(
    watchdogOf.get("fish_here"),
    60_000,
    "fish_here publishes one minute, which is what its runner exceeded",
  );
  assert.equal(watchdogOf.get("navigate_to_destination"), 600_000, "the navigation row declares ten minutes");
  assert.equal(watchdogOf.get("sleep"), 600_000, "the lifecycle row declares ten minutes through its factory");
  assert.ok(watchdogOf.size > 90, `the derivation must reach the whole catalog, got ${String(watchdogOf.size)}`);
});

test("a catalog with no default watchdog is refused instead of reading as an empty map", async () => {
  await withRegistrations(
    catalogWithWindows.replace("DefaultWatchdogMs", "SomeOtherCeiling"),
    async (registrationsPath) => {
      assert.throws(() => readStardewActionWatchdogs({ definitionsPath: registrationsPath }), /no_default_watchdog/);
    },
  );
});

test("one action declaring two different windows is refused rather than last-wins", async () => {
  await withRegistrations(
    catalogWithWindows
      .replace('E("sleep", "world_lifecycle"', 'E("till_soil", "world_lifecycle"')
      .replace(
        "Lifecycle(), FarmhandActionLifecycle.LiveVerified",
        "Lifecycle(), FarmhandActionLifecycle.LiveVerified",
      ),
    async (registrationsPath) => {
      assert.throws(
        () => readStardewActionWatchdogs({ definitionsPath: registrationsPath }),
        /action_declares_two_watchdogs:till_soil:60000:600000/,
      );
    },
  );
});
