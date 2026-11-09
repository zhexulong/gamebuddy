// Falsifier suite for the open-ground census.
//
// The gate is red at the commit it lands, so the proof that matters is not "it is red" but "it goes RED FOR THE RIGHT
// MEMBER and green for a site that asks the collision test". Both directions are driven here on synthetic sources, plus
// the zero-population rule, which must be blocked rather than green.
//
// The census was also driven once on the real tree: a member added to the Mod's own `ModEntry.cs` whose only walking
// answer was `isTilePassable` was named by file and member, and reverting it took the count back to 16.
//
// red-proof: inject  a member added to integrations/stardew/ModEntry.cs whose only walking answer is
//            `farm.isTilePassable(tile)` -> `examined 17` and an
//            `engine_open_ground_lie:integrations/stardew/ModEntry.cs:848 in IsOpenGroundForProbe` line.
import assert from "node:assert/strict";
import test from "node:test";

import { checkStardewOpenGroundClaims, enclosingMember, runtimeSources } from "./audit-stardew-open-ground-claims.mjs";

const file = (source) => [{ path: "integrations/stardew/probe.cs", source }];

test("the member that answers walking from the map alone is named", () => {
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
  assert.equal(report.examined, 1);
  assert.deepEqual(
    report.findings.map((finding) => `${finding.member}:${finding.line}`),
    ["IsSomewherePassable:6"],
  );
  assert.equal(report.verdict, "blocked");
});

test("a site beside the collision test is corroborated, not counted as a lie", () => {
  const report = checkStardewOpenGroundClaims({
    sources: file(`
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

test("a Building's own footprint is a different API and stays out of the population", () => {
  const report = checkStardewOpenGroundClaims({
    sources: file(`
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
