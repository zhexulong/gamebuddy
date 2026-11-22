import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONSTRUCTION_PATH,
  checkSnapshotFamilyBounds,
  ENGINE_PUBLISHED_FAMILIES,
  evaluateIntegerBound,
  FAMILIES_WITHOUT_A_HOST_CAP,
  hostFamilyCaps,
  MODELS_PATH,
  modConstants,
  PRODUCER_BOUND_FORMS,
  producerBound,
  snapshotFamilyParameters,
  snapshotRecordParameters,
} from "./check-stardew-snapshot-family-bounds.mjs";

test("every shipped snapshot family's producer ceiling is readable and within the Host's cap", () => {
  const report = checkSnapshotFamilyBounds();
  assert.deepEqual(report.findings, [], "the committed tree must not carry a cross-language bound drift");
  assert.equal(report.ok, true);
  assert.ok(report.familyCount > 70, "the population must come from the wire record, not a short list");
});

test("both populations are derived, so a family added to one side alone is a finding", () => {
  const parameters = snapshotRecordParameters(
    "public sealed record BridgeSnapshot(\n  long Revision,\n  IReadOnlyList<BridgeWarp>? Warps,\n  IReadOnlyList<BridgeSoilTile>? SoilTiles\n);",
  );
  assert.deepEqual(
    snapshotFamilyParameters(parameters).map((parameter) => parameter.name),
    ["Warps", "SoilTiles"],
  );
  assert.deepEqual(
    [
      ...hostFamilyCaps(
        'export const SNAPSHOT_FAMILY_RULES = Object.freeze([\n  { field: "warps", maxItems: 512 },\n]);',
      ),
    ],
    [["warps", 512]],
  );
  assert.ok(Object.hasOwn(FAMILIES_WITHOUT_A_HOST_CAP, "capabilities"));
});

test("a family added to one side alone is named, which is how the reported drifts began", () => {
  const models = readFileSync(MODELS_PATH, "utf8");
  const construction = readFileSync(CONSTRUCTION_PATH, "utf8");
  const recordAnchor = "IReadOnlyList<BridgeSoilTile>? SoilTiles,";
  const argumentAnchor =
    'advertisedCapabilities.Contains("till_soil", StringComparer.Ordinal) ? DiscoverSoilTiles(player) : null,';

  // Declared on the wire and constructed, but absent from the Host's cap table.
  const declared = checkSnapshotFamilyBounds({
    models: models.replace(recordAnchor, `${recordAnchor}\n    IReadOnlyList<BridgeSoilTile>? NewFamilyTargets,`),
    construction: construction.replace(
      argumentAnchor,
      `${argumentAnchor}\n            advertisedCapabilities.Contains("till_soil", StringComparer.Ordinal) ? DiscoverSoilTiles(player) : null,`,
    ),
  });
  assert.ok(
    declared.findings.some((finding) => finding.field === "newFamilyTargets" && finding.kind === "missing_host_cap"),
    "a family the Host never caps must fail by name",
  );

  // Declared on the wire with no construction-site argument, so the two lists no longer zip.
  const unconstructed = checkSnapshotFamilyBounds({
    models: models.replace(recordAnchor, `${recordAnchor}\n    IReadOnlyList<BridgeSoilTile>? NewFamilyTargets,`),
  });
  assert.ok(
    unconstructed.findings.some((finding) => finding.kind === "construction_arity_mismatch"),
    "a family declared but never produced must fail instead of silently shifting every later field",
  );
});

test("a Host cap the Mod never publishes is named", () => {
  const report = checkSnapshotFamilyBounds({
    models: "public sealed record BridgeSnapshot(\n  IReadOnlyList<BridgeWarp>? Warps\n);",
    construction: "new BridgeSnapshot(\n  Warps: null\n)",
    protocol:
      'export const SNAPSHOT_FAMILY_RULES = Object.freeze([\n  { field: "warps", maxItems: 512 },\n  { field: "obeliskTargets", maxItems: 32 },\n]);',
    schema: { $defs: { snapshot: { properties: {} } } },
    sources: [],
  });
  assert.ok(
    report.findings.some((finding) => finding.field === "obeliskTargets" && finding.kind === "missing_mod_family"),
    "a cap for a family the wire record does not declare must fail by name",
  );
});

test("a Mod family the Host never caps is named", () => {
  const report = checkSnapshotFamilyBounds({
    models: "public sealed record BridgeSnapshot(\n  IReadOnlyList<BridgeWarp>? Warps\n);",
    construction: "new BridgeSnapshot(\n  Warps: null\n)",
    protocol: 'export const SNAPSHOT_FAMILY_RULES = Object.freeze([\n  { field: "soilTiles", maxItems: 64 },\n]);',
    schema: { $defs: { snapshot: { properties: {} } } },
    sources: [],
  });
  assert.ok(
    report.findings.some((finding) => finding.field === "warps" && finding.kind === "missing_host_cap"),
    "a published family with no Host cap must fail by name",
  );
});

test("an unbounded producer is a finding, not a silent pass", () => {
  // The exact obelisk defect: a `foreach` over an engine collection with nothing truncating it.
  const shape =
    "List<BridgeObeliskTarget> targets = new();\nforeach (Building b in location.buildings) { targets.Add(one); }\nreturn targets;";
  const report = checkSnapshotFamilyBounds({
    models: "public sealed record BridgeSnapshot(\n  IReadOnlyList<BridgeObeliskTarget>? ObeliskTargets\n);",
    construction: "new BridgeSnapshot(\n  ObeliskTargets: DiscoverObeliskTargets(player)\n)",
    protocol: 'export const SNAPSHOT_FAMILY_RULES = Object.freeze([\n  { field: "obeliskTargets", maxItems: 32 },\n]);',
    schema: { $defs: { snapshot: { properties: { obeliskTargets: { type: "array", maxItems: 64 } } } } },
    sources: [
      {
        file: "integrations/stardew/farmhandexecutioncontroller.obeliskactions.cs",
        text: `private IReadOnlyList<BridgeObeliskTarget> DiscoverObeliskTargets(Farmer player) { ${shape} }`,
      },
    ],
  });
  const finding = report.findings.find((entry) => entry.field === "obeliskTargets");
  assert.equal(finding?.kind, "unreadable_bound");
  assert.ok(
    finding.detail.includes("Readable forms:"),
    "the finding must say which forms it reads, so the next author knows what would satisfy it",
  );
});

test("a producer above the Host cap is refused with the closing reason named", () => {
  const report = checkSnapshotFamilyBounds({
    models: "public sealed record BridgeSnapshot(\n  IReadOnlyList<BridgeWarp>? Warps\n);",
    construction: "new BridgeSnapshot(\n  Warps: DiscoverWarps(player)\n)",
    protocol: 'export const SNAPSHOT_FAMILY_RULES = Object.freeze([\n  { field: "warps", maxItems: 8 },\n]);',
    schema: { $defs: { snapshot: { properties: { warps: { type: "array", maxItems: 512 } } } } },
    sources: [
      {
        file: "integrations/stardew/farmhandexecutioncontroller.cs",
        text: "private static IReadOnlyList<BridgeWarp> DiscoverWarps(Farmer player) { List<BridgeWarp> result = new(); return result.Take(16).ToArray(); }",
      },
    ],
  });
  const finding = report.findings.find((entry) => entry.field === "warps");
  assert.equal(finding?.kind, "producer_exceeds_cap");
  assert.ok(finding.detail.includes("invalid_snapshot:warps:count=9"), "the finding names what ends the bridge");
});

test("the ceiling is the minimum over truncations, never their sum", () => {
  const constants = new Map([
    ["items", 36],
    ["MaximumInventorySlot", 36],
  ]);
  const arrays = new Map();
  // A nested window under a `Take`: the Take caps the list whatever the window's size.
  const nested = producerBound(
    "List<X> result = new(); for (int x = 0; x <= 169; x++) { } return result.Take(32).ToArray();",
    constants,
    arrays,
  );
  assert.equal(nested.bound, 32);
  // A backpack scan publishes at most one row per slot, which is the Mod's own slot ceiling.
  const backpack = producerBound(
    "List<X> result = new(); for (int slot = 0; slot < player.Items.Count; slot++) { result.Add(x); } return result;",
    constants,
    arrays,
  );
  assert.equal(backpack.bound, 36);
  // Two independent budgets in one method really do add: each caps a different kind of row.
  const twoBudgets = producerBound(
    "List<X> result = new(); int sites = 0; int built = 0; for (;;) { if (sites >= 8) break; if (built >= 8) break; } return result;",
    constants,
    arrays,
  );
  assert.equal(twoBudgets.bound, 16);
});

test("integer expressions resolve only where a ceiling is genuinely stated", () => {
  const constants = new Map([
    ["HighestSelectableMineFloor", 120],
    ["TargetDiscoveryRadius", 6],
  ]);
  assert.equal(evaluateIntegerBound("120", constants), 120);
  assert.equal(evaluateIntegerBound("HighestSelectableMineFloor", constants), 120);
  assert.equal(evaluateIntegerBound("Math.Min(lowestLevelReached, HighestSelectableMineFloor)", constants), 120);
  assert.equal(evaluateIntegerBound("Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius)", constants), null);
  assert.equal(evaluateIntegerBound("player.Items.Count", constants), null);
});

test("the Mod's own backpack fact is read from the Mod, not typed here", () => {
  const constants = modConstants([
    {
      file: "integrations/stardew/src/Core/Policy/FarmhandExecutionAcceptance.cs",
      text: "public sealed record FarmhandExecutionAcceptanceFacts(\n  int MaximumInventorySlot = 36,\n  int Other = 1);",
    },
  ]);
  assert.equal(constants.get("MaximumInventorySlot"), 36);
});

test("an engine-projection exemption cannot outlive its reason", () => {
  const report = checkSnapshotFamilyBounds({
    models: "public sealed record BridgeSnapshot(\n  IReadOnlyList<BridgeWarp>? Warps\n);",
    construction: "new BridgeSnapshot(\n  Warps: DiscoverWarps(player)\n)",
    protocol: 'export const SNAPSHOT_FAMILY_RULES = Object.freeze([\n  { field: "warps", maxItems: 512 },\n]);',
    schema: { $defs: { snapshot: { properties: { warps: { type: "array", maxItems: 512 } } } } },
    sources: [
      {
        file: "integrations/stardew/farmhandexecutioncontroller.cs",
        text: "private static IReadOnlyList<BridgeWarp> DiscoverWarps(Farmer player) { List<BridgeWarp> result = new(); return result.Take(64).ToArray(); }",
      },
    ],
  });
  assert.ok(Object.hasOwn(ENGINE_PUBLISHED_FAMILIES, "warps"), "the exemption is declared for warps");
  assert.ok(
    report.findings.some((finding) => finding.field === "warps" && finding.kind === "stale_engine_exemption"),
    "a family that gained a readable ceiling must fail as a stale exemption",
  );
});

test("the readable forms are named, so widening the reader is a visible act", () => {
  assert.ok(PRODUCER_BOUND_FORMS.length >= 5);
  for (const form of PRODUCER_BOUND_FORMS) assert.ok(form.length > 10);
});
