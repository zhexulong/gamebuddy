import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `ride_bus` must never gain an approach declaration, and no other action may silently gain or lose one.
 *
 * WHY `ride_bus` DECLARES NOTHING. Its family is `transport_warps` and its postcondition is `bus_arrived` - the
 * arrival the native cutscene and warp produce - so it is the same shape as `ride_minecart` and `enter_exit`: a
 * cross-map transition where the walk to the bus stop is the caller's own `move_to_tile` step. Its handler refuses
 * `bus_ticket_machine_out_of_reach` (pinned in the C# `ApproachClassificationTests`). A declaration here would say
 * "you must already stand beside this" and promise a walk that is not the action's to make.
 *
 * SCOPE OF THIS FILE, stated plainly because it is easy to over-read. These assertions read the Mod's generated
 * `action-surface.v1.json` - the artifact the surface projection emits - not the `hello_ack` wire. The wire carries the
 * same fact through `FarmhandActionDescriptorWire.Approach` and the Host's `approach` descriptor key, which
 * `approach-requirement-pipeline.test.ts` pins end to end from the Mod's own serializer into `plan_shape`. This file
 * guards the LAYER WHERE THE FACT IS DECLARED, so a wrong or missing declaration fails here by name instead of
 * surfacing only as a strange `plan_shape` answer.
 *
 * The guard is bidirectional because both directions are the same mistake: an action that silently GAINS a
 * declaration publishes a precondition it does not have, and one that silently LOSES one takes away the only
 * statement that let the companion stand in the right place first.
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);

type SurfaceAction = Readonly<{
  actionId: string;
  identityVersion: number;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
  postcondition?: Readonly<{ name: string }>;
  approach?: Readonly<{ relation: string; withinTiles?: number }>;
}>;

const SURFACE = (
  JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { schema: unknown; actions: readonly SurfaceAction[] }
).actions;

function surfaceAction(actionId: string): SurfaceAction {
  const action = SURFACE.find((candidate) => candidate.actionId === actionId);
  assert.ok(action, `${actionId} is on the published surface`);
  return action;
}

test("ride_bus declares no approach requirement, and its shape is the cross-map one", () => {
  const bus = surfaceAction("ride_bus");

  // ABSENT, not null-valued: the projector omits the member when null, so an action that declares nothing must not
  // arrive looking like one that declared "anywhere".
  assert.equal("approach" in bus, false, "ride_bus must declare no standing precondition");

  // Its shape is pinned beside the absence, so the absence cannot drift into "bus_arrived is no longer a
  // transition and the action happens to have no declaration yet".
  assert.equal(bus.lifecycle, "live_verified");
  assert.equal(bus.kind, "execution");
  assert.deepEqual(bus.postcondition, { name: "bus_arrived" });
});

test("pickup_forage declares exactly (adjacent, 1) - it is not the walk, and it says so", () => {
  // The declared half of the classification. `pickup_forage`'s handler measures the native Chebyshev-1 radius and
  // REFUSES outside it (`forage_target_out_of_range`), so the declaration is a true statement: stand
  // adjacent first, in your own step, and the action will work. Exactly a relation and a distance - a third field
  // invented beside them would be a precondition nobody enforces.
  assert.deepEqual(surfaceAction("pickup_forage").approach, { relation: "adjacent", withinTiles: 1 });
});

test("the set of actions declaring a precondition is exactly the set a reader of the artifact expects", () => {
  // Derived from the artifact rather than from a hand-maintained list, so a declaration added to - or removed from -
  // any action fails here by name, including the two `eea94e3f` removed once their handlers began walking in.
  //
  // The four below are the ones whose handlers refuse from a distance and never walk: `enter_exit` and
  // `ride_minecart` (cross-map / a warp resolved from the source tile), `use_obelisk` (the obelisk's own warp), and
  // `pickup_forage` (the report's `observation_binding_target_out_of_range`).
  const declaring = SURFACE.filter((action) => action.approach !== undefined)
    .map((action) => action.actionId)
    .sort();
  assert.deepEqual(declaring, ["enter_exit", "pickup_forage", "ride_minecart", "use_obelisk"]);
});

test("every declaration is the same bounded shape, so a reader never parses a second vocabulary", () => {
  for (const action of SURFACE.filter((candidate) => candidate.approach !== undefined)) {
    assert.deepEqual(
      action.approach,
      { relation: "adjacent", withinTiles: 1 },
      `${action.actionId} declares the one relation this surface uses`,
    );
  }
});
