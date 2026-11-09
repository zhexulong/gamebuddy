// Falsifier suite for the open-ground census.
//
// The gate is the property, so what matters is not "it is red" but that it goes RED FOR THE RIGHT MEMBER and GREEN for a
// site whose walking answer comes from the collision test - directly, or through the one predicate. Both directions are
// driven on synthetic sources, plus the honesty check on the predicate itself and the zero-population rule, which must
// be blocked rather than green.
//
// THE PREDICATE DIRECTION IS PROVEN IN THREE PLACES, because corroboration-by-predicate is only worth what the
// predicate does: a member that calls `StardewBodyController.IsWalkableTile` is green; the same member is RED when
// `StardewBodyController.cs` arrives with `IsPlannerAdmissibleTile` gutted to `=> true`; and the tree this suite runs in
// answers every one of its call sites, so the census cannot go green by watching nothing.
//
// red-proof: inject  `IsPassableBuildableAtLocation`'s `StardewBodyController.IsWalkableTile(` removed ->
//            `engine_open_ground_lie:...BuildFarmBuilding...:374` and `blocked (1 lie(s), 2 corroborated)`.
// red-proof: inject  `StardewBodyController.IsPlannerAdmissibleTile` reduced to `=> true` ->
//            `engine_open_ground_predicate_lie:` naming `IsPlannerAdmissibleTile` and `blocked (0 lie(s), 3 corroborated)`.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BODY_ADMISSION,
  checkStardewOpenGroundClaims,
  declarationText,
  enclosingMember,
  runtimeSources,
} from "./audit-stardew-open-ground-claims.mjs";

const file = (source) => [{ path: "integrations/stardew/probe.cs", source }];

/** The predicate's own declaration, honest by default so a probe case isolates the member it is about. */
const HONEST_PREDICATE =
  "private static bool IsPlannerAdmissibleTile(GameLocation location, Farmer actor, Vector2 tile) =>\n" +
  "        !location.isCollidingPosition(\n" +
  "            new Microsoft.Xna.Framework.Rectangle((int)tile.X * 64 + 1, (int)tile.Y * 64 + 1, 62, 62),\n" +
  "            Game1.viewport,\n" +
  "            actor is Farmer,\n" +
  "            0,\n" +
  "            glider: false,\n" +
  "            actor,\n" +
  "            pathfinding: true,\n" +
  "            skipCollisionEffects: true);";

const authority = (declaration = HONEST_PREDICATE) => ({
  path: BODY_ADMISSION.file,
  source: `namespace GameBuddy.Stardew;\n\ninternal static class StardewBodyController\n{\n    ${declaration}\n}\n`,
});

/** One probe member, beside the predicate the census reads. */
const withAuthority = (memberSource) => [...file(memberSource), authority()];

test("the member that answers walking from the map alone is named", () => {
  const report = checkStardewOpenGroundClaims({
    sources: withAuthority(`
internal sealed class Probe
{
    private static bool IsSomewherePassable(GameLocation farm, Vector2 tile)
    {
        return farm.isTilePassable(tile);
    }
}
`),
  });
  assert.equal(report.examined, 1);
  assert.deepEqual(
    report.findings.map((finding) => `${finding.member}:${finding.line}`),
    ["IsSomewherePassable:6"],
  );
  assert.equal(report.verdict, "blocked");
});

test("a site beside the collision test is corroborated, not counted as a lie", () => {
  const report = checkStardewOpenGroundClaims({
    sources: withAuthority(`
internal sealed class Probe
{
    private static bool IsSomewherePassable(GameLocation farm, Vector2 tile)
    {
        return farm.isTilePassable(tile) && !farm.isCollidingPosition(box, viewport, true, 0, false, farmer, true);
    }
}
`),
  });
  assert.equal(report.examined, 1);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.corroborated.map((entry) => entry.member),
    ["IsSomewherePassable"],
  );
  assert.equal(report.verdict, "passed");
});

test("a site whose walking answer comes from the one predicate is corroborated, not a lie", () => {
  // The shape the sixteen sites were moved to: the map read stays where it is map geometry, and the body's answer is
  // the predicate. Under the previous revision this was reported as a lie for not spelling `isCollidingPosition`.
  const report = checkStardewOpenGroundClaims({
    sources: withAuthority(`
internal sealed class Probe
{
    private static bool IsLegalPlacement(GameLocation farm, Vector2 tile)
    {
        return farm.isTilePassable(tile) && StardewBodyController.IsStandableTile(farm, Game1.player, tile);
    }
}
`),
  });
  assert.equal(report.examined, 1);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    report.corroborated.map((entry) => entry.member),
    ["IsLegalPlacement"],
  );
  assert.equal(report.verdict, "passed");
  assert.equal(report.authority.ok, true);
});

test("a gutted predicate corroborates nobody, and the finding names it", () => {
  const report = checkStardewOpenGroundClaims({
    sources: [
      ...file(`
internal sealed class Probe
{
    private static bool IsLegalPlacement(GameLocation farm, Vector2 tile)
    {
        return farm.isTilePassable(tile) && StardewBodyController.IsStandableTile(farm, Game1.player, tile);
    }
}
`),
      authority(
        "private static bool IsPlannerAdmissibleTile(GameLocation location, Farmer actor, Vector2 tile) => actor is Farmer;",
      ),
    ],
  });
  assert.equal(report.examined, 1);
  assert.deepEqual(report.findings, [], "the member still asks the predicate, which is why the predicate must be read");
  assert.equal(report.authority.ok, false);
  assert.match(report.authority.reason, /IsPlannerAdmissibleTile/u);
  assert.match(report.authority.reason, /empty helper/u);
  assert.equal(report.verdict, "blocked", "a member can never be corroborated by an empty helper");
});

test("a predicate that is not declared at all is a blocked reading, not an assumption", () => {
  const report = checkStardewOpenGroundClaims({
    sources: file(`
internal sealed class Probe
{
    private static bool IsSomewherePassable(GameLocation farm, Vector2 tile)
    {
        return farm.isTilePassable(tile);
    }
}
`),
  });
  assert.equal(report.authority.ok, false);
  assert.match(report.authority.reason, /StardewBodyController\.cs/u);
  assert.equal(report.verdict, "blocked");
});

test("a Building's own footprint is a different API and stays out of the population", () => {
  const report = checkStardewOpenGroundClaims({
    sources: withAuthority(`
internal sealed class Probe
{
    private static bool Anything(Building building, Vector2 tile) => building.isTilePassable(tile);
}
`),
  });
  assert.equal(report.examined, 0, "the excluded receiver must not be counted as examined either");
  assert.equal(report.verdict, "blocked", "a population of zero is blocked, never green");
});

test("the walked population is the Mod's runtime sources, and it is not empty on this tree", () => {
  const sources = runtimeSources();
  assert.ok(sources.length > 50, `expected the Mod's sources, found ${sources.length}`);
  assert.ok(
    sources.every((entry) => !entry.path.includes("/tests/") && !/ModEntry\.Fixtures/u.test(entry.path)),
    "tests and fixture setup are outside the population, and the reason is in the gate header",
  );
});

test("no member of this tree answers walking from the map alone", () => {
  // The tree the suite runs in, so a new member that takes the map's answer is named by file, line and member rather
  // than being found by a live run. This is also what keeps the gate a gate: it is called from the corpus, not only
  // from a shell.
  const report = checkStardewOpenGroundClaims();
  assert.deepEqual(
    report.findings.map((finding) => `${finding.file}:${finding.line} in ${finding.member}`),
    [],
  );
  assert.equal(report.authority.ok, true, report.authority.reason);
  assert.ok(report.examined > 0, "a census that examined nothing agrees with itself");
  assert.equal(report.corroborated.length, report.examined, "every remaining site must be corroborated");
});

test("a member is found through a multi-line signature and an inner block", () => {
  const source = `
internal sealed class Probe
{
    private static bool Method(
        GameLocation farm,
        Vector2 tile)
    {
        if (farm is null)
        {
            return false;
        }
        return farm.isTilePassable(tile);
    }
}
`;
  const offset = source.indexOf("farm.isTilePassable");
  assert.equal(enclosingMember(source, offset)?.name, "Method");
});

test("a declaration is read whole and a call site of the same name is not mistaken for it", () => {
  const source = `
internal static class Probe
{
    private static bool IsPlannerAdmissibleTile(GameLocation location, Farmer actor, Vector2 tile) =>
        !location.isCollidingPosition(box, Game1.viewport, actor is Farmer, 0, glider: false, actor, pathfinding: true);

    private static bool IsTileAdmittedForBody(GameLocation location, Farmer actor, Vector2 tile) =>
        location.isTileOnMap(tile) && (actor.Tile == tile || IsPlannerAdmissibleTile(location, actor, tile));
}
`;
  const declaration = declarationText(source, "IsPlannerAdmissibleTile");
  assert.ok(declaration?.includes("isCollidingPosition("), "the declaration carries its own expression body");
  assert.ok(!declaration?.includes("IsTileAdmittedForBody"), "and stops before the next declaration");
});
