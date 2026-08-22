import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPublishedStardewActionIds } from "./stardew-published-action-registry.mjs";

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
  await withRegistrations(
    registrations.replace("Registrations", "OtherRegistrations"),
    async (registrationsPath) => {
      await assert.rejects(
        readPublishedStardewActionIds({ registrationsPath }),
        /missing_mod_registrations/,
      );
    },
  );
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
