import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `ride_bus` must never gain an approach declaration, and each relation must keep the shape its handler justifies.
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
 * The classification is pinned in both directions because both are the same mistake: an action that silently GAINS a
 * declaration publishes a precondition it does not have, and one that silently LOSES one takes away the only
 * statement that let the companion stand in the right place first. The POPULATION question - that every action whose
 * handler walks declares `self_walked`, and that nothing declares it without the leg - is
 * `ApproachDeclarationCoverageTests` in the Mod's own suite, because that gate can read the handler sources and this
 * one can only read the artifact.
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
  // REFUSES outside it (`observation_binding_target_out_of_range`), so the declaration is a true statement: stand
  // adjacent first, in your own step, and the action will work. Exactly a relation and a distance - a third field
  // invented beside them would be a precondition nobody enforces.
  assert.deepEqual(surfaceAction("pickup_forage").approach, { relation: "adjacent", withinTiles: 1 });
});

test("the artifact declares the two relations, and each states exactly what its handler does", () => {
  // Derived from the artifact rather than from a hand-maintained list, so a declaration added to - or removed from -
  // any action fails here by name. The two relations answer the same question from opposite sides, and the set below
  // is split by WHICH answer the handler gives:
  //
  //   `adjacent`    - the handler refuses from a distance and never walks: `enter_exit` and `ride_minecart` (cross-map /
  //                   a warp resolved from the source tile), `use_obelisk` (the obelisk's own warp), and `pickup_forage`
  //                   (the report's `observation_binding_target_out_of_range`).
  //   `self_walked` - the handler closes the distance itself, so there is nothing to stand beside first.
  //
  // The coverage half - that every action whose handler walks declares it, and that nothing declares it without the leg
  // - is `ApproachDeclarationCoverageTests` in the Mod's own suite, which can read the handler sources. This file can
  // only read the artifact, so it pins the SHAPE and the classification, not the population.
  const declaring = SURFACE.filter((action) => action.approach !== undefined);
  const adjacent = declaring
    .filter((action) => action.approach?.relation === "adjacent")
    .map((action) => action.actionId)
    .sort();
  assert.deepEqual(adjacent, ["enter_exit", "pickup_forage", "ride_minecart", "use_obelisk"]);

  const selfWalked = declaring.filter((action) => action.approach?.relation === "self_walked");
  assert.ok(selfWalked.length > 0, "the handlers that walk the actor in must declare it");
  for (const action of selfWalked) {
    assert.deepEqual(
      action.approach,
      { relation: "self_walked" },
      `${action.actionId} closes the distance itself, so it states no distance`,
    );
  }

  // No third vocabulary: a relation word the Host passes through verbatim but nobody defined would read to the model as
  // a relationship that does not exist.
  assert.deepEqual(
    declaring
      .map((action) => action.approach?.relation)
      .filter((relation) => relation !== "adjacent" && relation !== "self_walked"),
    [],
  );
});

test("cut_weeds declares self_walked - the answer the live run was missing", () => {
  // Measured 2026-11-06: thirteen `plan_shape` answers for `cut_weeds` read
  // `"approachRequirement":{"declared":false,"reasonCode":"approach_requirement_undeclared"}`. Its handler walks the
  // actor in (`TryBeginToolApproach`), so the surface's silence was the one thing that could not be told apart from "no
  // constraint".
  assert.deepEqual(surfaceAction("cut_weeds").approach, { relation: "self_walked" });
});

test("every adjacent declaration is the same bounded shape, so a reader never parses a second vocabulary", () => {
  for (const action of SURFACE.filter((candidate) => candidate.approach?.relation === "adjacent")) {
    assert.deepEqual(
      action.approach,
      { relation: "adjacent", withinTiles: 1 },
      `${action.actionId} declares the one bounded distance this relation uses`,
    );
  }
});
