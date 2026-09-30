#!/usr/bin/env node
// Scene-affordance-kind projection audit for `observe_scene`.
//
// A scene kind is not usable just because the Mod enum has it. One kind has to
// survive a nine-hop projection owned by six different layers, and every hop is
// silent when it is missing:
//
//   1. C# enum            - navigation/scenecontracts.cs `SceneAffordanceKind`
//                           (the authority; every other hop derives from it)
//   2. IsDefined          - same file; rejects a kind the enum does not cover
//   3. ToWireValue        - same file; enum -> wire string
//   4. ToRefPrefix        - same file; enum -> opaque ref prefix
//   5. DefaultPriority    - same file; rank demotion for dense kinds
//   6. IsDensityCapped    - same file; per-kind ceiling membership
//   7. BridgeProtocol     - src/Core/Protocol/BridgeProtocol.cs outbound +
//                           inbound allowlists (a kind missing here fails
//                           serialization at runtime, not at build time)
//   8. Host protocol      - host/src/protocol.ts `SceneAffordance.kind` union
//                           and `OBSERVE_SCENE_KINDS` Set
//   9. Envelope schema    - protocol/bridge-v1.schema.json `observe_scene`
//                           affordance enum
//
// This is not hypothetical: `water_source` shipped in the Mod enum, the Host
// protocol and the scanner, but was missing from the BridgeProtocol allowlists,
// so real water observations failed during serialization (fixed in 34e9ee1).
// The Mod's own `ClassifyWorldObject` docstring also claimed "the seven allowed
// values" long after there were thirteen.
//
// Authority direction is one-way: the C# enum decides, every other layer must
// equal it. A layer that is a superset is a bug, not forward compatibility.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONTRACTS = "integrations/stardew/navigation/scenecontracts.cs";
// The ground wire helper, the exception ceiling and the truncation reason set all
// live here, not in scenecontracts.cs, so the ground chain needs both files.
const PROJECTION = "integrations/stardew/navigation/sceneobservationprojection.cs";
const BRIDGE_PROTOCOL = "integrations/stardew/src/Core/Protocol/BridgeProtocol.cs";
const HOST_PROTOCOL = "host/src/protocol.ts";
const SCHEMA = "protocol/bridge-v1.schema.json";

const DEFAULT_ROOT = ROOT;
const read = (relative, root = ROOT) => readFileSync(path.join(root, relative), "utf8");

/** PascalCase enum member -> lower snake wire value, applied to the C# wire rows. */
function enumMembers(contractsSource) {
  const block = contractsSource.match(/internal enum SceneAffordanceKind\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error("scene_kind_audit_enum_not_found");
  return block[1]
    .split(",")
    .map((row) => row.replace(/\/\/.*$/gm, "").trim())
    .filter((row) => /^[A-Za-z][A-Za-z0-9]*$/.test(row));
}

/** Parse `=> "wire"` rows from one `kind switch` helper, keyed by enum member. */
function switchMap(contractsSource, helperName) {
  const block = contractsSource.match(
    new RegExp(`internal static [A-Za-z<>?\\[\\] ]+ ${helperName}\\(\\s*SceneAffordanceKind kind\\)\\s*=>\\s*kind switch\\s*\\{([\\s\\S]*?)\\n\\s*\\};`),
  );
  if (!block) throw new Error(`scene_kind_audit_switch_not_found:${helperName}`);
  const map = {};
  for (const match of block[1].matchAll(/SceneAffordanceKind\.(\w+)\s*=>\s*"([^"]*)"/g)) {
    map[match[1]] = match[2];
  }
  return map;
}

/** Parse one `kind is A or B or C` membership predicate. */
function kindIsSet(contractsSource, helperName) {
  const block = contractsSource.match(
    new RegExp(`internal static bool ${helperName}\\(SceneAffordanceKind kind\\)\\s*=>\\s*kind is([\\s\\S]*?);`),
  );
  if (!block) throw new Error(`scene_kind_audit_predicate_not_found:${helperName}`);
  return new Set([...block[1].matchAll(/SceneAffordanceKind\.(\w+)/g)].map((m) => m[1]));
}

/**
 * Parse `SceneGroundKind` members from the C# enum.
 *
 * Ground is a second projection axis, not a scene kind: affordances say what a
 * tile can DO, ground says what it IS. It travels its own chain and can go stale
 * on its own, which is exactly what a kind-only audit cannot see.
 */
function groundEnumMembers(contractsSource) {
  const block = contractsSource.match(/internal enum SceneGroundKind\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error("scene_ground_audit_enum_not_found");
  return block[1]
    .split(",")
    .map((row) => row.replace(/\/\/.*$/gm, "").trim())
    .filter((row) => /^[A-Za-z][A-Za-z0-9]*$/.test(row));
}

/** Parse `SceneGroundKind.X => "wire"` rows from the ground wire helper. */
function groundWireMap(contractsSource) {
  const block = contractsSource.match(
    /internal static string ToWireValue\(SceneGroundKind kind\)\s*=>\s*kind switch\s*\{([\s\S]*?)\n\s*\};/,
  );
  if (!block) throw new Error("scene_ground_audit_wire_switch_not_found");
  const map = {};
  for (const match of block[1].matchAll(/SceneGroundKind\.(\w+)\s*=>\s*"([^"]*)"/g)) map[match[1]] = match[2];
  return map;
}

/** Parse the `"Grass" => SceneGroundKind.Grass` table that maps the engine's own Back-layer Type. */
function groundFromBackTypeMap(contractsSource) {
  const block = contractsSource.match(
    /internal static SceneGroundKind FromBackType\(string\? backType\)\s*=>\s*backType switch\s*\{([\s\S]*?)\n\s*\};/,
  );
  if (!block) throw new Error("scene_ground_audit_from_back_type_not_found");
  const map = {};
  for (const match of block[1].matchAll(/"([^"]+)"\s*=>\s*SceneGroundKind\.(\w+)/g)) map[match[1]] = match[2];
  return map;
}

/** Parse `SceneGroundKind is A or B or C` membership for the ground helper. */
function groundKindIsSet(contractsSource, helperName) {
  const block = contractsSource.match(
    new RegExp(`internal static bool ${helperName}\\(SceneGroundKind kind\\)\\s*=>\\s*kind is([\\s\\S]*?);`),
  );
  if (!block) throw new Error(`scene_ground_audit_predicate_not_found:${helperName}`);
  return new Set([...block[1].matchAll(/SceneGroundKind\.(\w+)/g)].map((m) => m[1]));
}

/** Parse the integer bodies of an `int` return switch (dense-kind priority). */
function intSwitchMap(contractsSource, helperName) {
  const block = contractsSource.match(
    new RegExp(`internal static int ${helperName}\\(SceneAffordanceKind kind\\)\\s*=>\\s*kind switch\\s*\\{([\\s\\S]*?)\\n\\s*\\};`),
  );
  if (!block) throw new Error(`scene_kind_audit_int_switch_not_found:${helperName}`);
  const map = {};
  for (const match of block[1].matchAll(/SceneAffordanceKind\.(\w+)\s*=>\s*(-?\d+)/g)) {
    map[match[1]] = Number.parseInt(match[2], 10);
  }
  return map;
}

/** Extract the quoted strings of a C# `or`-joined string pattern. */
function csharpStringPattern(source, marker) {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`scene_kind_audit_marker_not_found:${marker}`);
  const tail = source.slice(index, index + 4000);
  const line = tail.split("\n").find((row) => row.includes("is ")) ?? tail;
  return new Set([...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

export function auditSceneKindProjection({ root = DEFAULT_ROOT } = {}) {
  const contracts = read(CONTRACTS, root);
  const members = enumMembers(contracts);

  const wireByMember = switchMap(contracts, "ToWireValue");
  const refPrefixByMember = switchMap(contracts, "ToRefPrefix");
  const priorityByMember = intSwitchMap(contracts, "DefaultPriority");
  const isDefinedMembers = kindIsSet(contracts, "IsDefined");
  const densityCappedMembers = kindIsSet(contracts, "IsDensityCapped");

  const findings = [];
  const perKind = [];

  const declaredWire = new Set();
  for (const member of members) {
    const wire = wireByMember[member];
    if (wire === undefined) findings.push({ kind: member, hop: "ToWireValue", detail: "enum member has no wire value" });
    else if (declaredWire.has(wire)) findings.push({ kind: member, hop: "ToWireValue", detail: `duplicate wire value ${wire}` });
    else declaredWire.add(wire);

    if (!isDefinedMembers.has(member)) findings.push({ kind: member, hop: "IsDefined", detail: "enum member is not accepted by IsDefined" });
    if (refPrefixByMember[member] === undefined) findings.push({ kind: member, hop: "ToRefPrefix", detail: "enum member has no ref prefix" });
    if (priorityByMember[member] === undefined && (densityCappedMembers.has(member) || priorityByMember[member] !== 0)) {
      // Dense kinds must carry an explicit demotion; sparse kinds default to 0.
    }
    if (densityCappedMembers.has(member) && priorityByMember[member] === undefined) {
      findings.push({ kind: member, hop: "DefaultPriority", detail: "density-capped kind has no explicit priority" });
    }
    if (!densityCappedMembers.has(member) && priorityByMember[member] !== undefined) {
      findings.push({ kind: member, hop: "IsDensityCapped", detail: "demoted kind is not density-capped" });
    }

    perKind.push({
      member,
      wire: wire ?? null,
      refPrefix: refPrefixByMember[member] ?? null,
      priority: priorityByMember[member] ?? 0,
      densityCapped: densityCappedMembers.has(member),
    });
  }

  // A duplicate ref prefix makes two kinds share an opaque id namespace.
  const seenPrefixes = new Map();
  for (const row of perKind) {
    if (row.refPrefix === null) continue;
    if (seenPrefixes.has(row.refPrefix)) {
      findings.push({ kind: row.member, hop: "ToRefPrefix", detail: `ref prefix ${row.refPrefix} already used by ${seenPrefixes.get(row.refPrefix)}` });
    } else {
      seenPrefixes.set(row.refPrefix, row.member);
    }
  }

  const bridge = read(BRIDGE_PROTOCOL, root);
  // Take only the `kind` comparison row. A greedy window would also swallow the
  // following `direction` row and report its values as unknown kinds.
  const csharpKindComparisons = (source, marker) => {
    const index = source.indexOf(marker);
    if (index < 0) throw new Error(`scene_kind_audit_marker_not_found:${marker}`);
    // Everything after the pattern intro, so the `"kind"` property name in the
    // same expression is not mistaken for an admitted kind.
    const tail = source.slice(index + marker.length).split("\n")[0];
    return new Set([...tail.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  };
  const outbound = csharpKindComparisons(bridge, 'value.GetProperty("kind").GetString() is not');
  const inbound = csharpKindComparisons(bridge, "&& affordance.Kind is ");

  const host = read(HOST_PROTOCOL, root);
  // Anchor on the ObserveSceneAffordance declaration: other `kind:` unions in
  // this file (destination "label"|"ref", body event kinds) are unrelated, and
  // the affordance union wraps across lines in current formatting.
  const affordanceDecl = host.match(/export type ObserveSceneAffordance = Readonly<\{([\s\S]*?)\}>;/);
  const hostUnion = new Set(
    affordanceDecl ? [...affordanceDecl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((v) => v !== "North" && v !== "South" && v !== "East" && v !== "West" && v !== "CurrentTile") : [],
  );
  const hostSetMatch = host.match(/const OBSERVE_SCENE_KINDS = new Set\(\[([^\]]*)\]\)/);
  const hostSet = new Set(hostSetMatch ? [...hostSetMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);

  const schema = JSON.parse(read(SCHEMA, root));
  const schemaEnum = new Set(schema?.$defs?.observeSceneAffordance?.properties?.kind?.enum ?? []);

  const layers = [
    ["BridgeProtocol outbound", outbound],
    ["BridgeProtocol inbound", inbound],
    ["host protocol union", hostUnion],
    ["host protocol Set", hostSet],
    ["envelope schema enum", schemaEnum],
  ];

  for (const [layerName, layerValues] of layers) {
    for (const wire of declaredWire) {
      if (!layerValues.has(wire)) findings.push({ kind: wire, hop: layerName, detail: "kind missing from this layer" });
    }
    for (const value of layerValues) {
      if (!declaredWire.has(value)) findings.push({ kind: value, hop: layerName, detail: "layer admits a kind the Mod enum does not declare" });
    }
  }

  const ground = auditGroundProjection({ contracts, projection: read(PROJECTION, root), bridge, host, schema });
  findings.push(...ground.findings);

  return {
    kindCount: members.length,
    perKind: perKind.sort((a, b) => a.member.localeCompare(b.member)),
    groundKinds: ground.perKind,
    findings: findings.sort((a, b) => `${a.kind}${a.hop}`.localeCompare(`${b.kind}${b.hop}`)),
  };
}

// Audit the ground projection chain, a second axis parallel to the scene kinds.
//
// Ground travels its own hops and each one is silent when wrong: the C# enum, its
// wire helper, the engine Back-layer Type table, the BridgeProtocol outbound path,
// the Host union and the envelope schema. A kind-only audit reports "ok" while any
// of these disagree, and the failure then appears only when a real observation is
// serialized -- the same shape as the water_source defect this file documents.
function auditGroundProjection({ contracts, projection, bridge, host, schema }) {
  const findings = [];
  const perKind = [];

  const members = groundEnumMembers(contracts);
  const wireByMember = groundWireMap(contracts);
  const fromBackType = groundFromBackTypeMap(contracts);
  const isDefined = groundKindIsSet(contracts, "IsDefined");

  const declaredWire = new Set();
  for (const member of members) {
    const wire = wireByMember[member];
    if (wire === undefined) findings.push({ kind: member, hop: "ground ToWireValue", detail: "ground kind has no wire value" });
    else if (declaredWire.has(wire)) findings.push({ kind: member, hop: "ground ToWireValue", detail: `duplicate ground wire value ${wire}` });
    else declaredWire.add(wire);
    if (!isDefined.has(member)) findings.push({ kind: member, hop: "ground IsDefined", detail: "ground kind is not accepted by IsDefined" });
    perKind.push({ member, wire: wire ?? null });
  }

  // The engine's own Back-layer Type strings are the input side; Other is the
  // default arm and so is not expected as a named key.
  for (const [backType, member] of Object.entries(fromBackType)) {
    if (!members.includes(member))
      findings.push({ kind: backType, hop: "ground FromBackType", detail: `maps to SceneGroundKind.${member}, which the enum does not declare` });
  }

  // The outbound path must derive its wire value from the enum, not from a literal.
  if (!/SceneGroundKindWire\.ToWireValue/.test(projection))
    findings.push({ kind: "ground", hop: "BridgeProtocol", detail: "outbound path does not go through SceneGroundKindWire.ToWireValue" });

  // truncatedReason is a closed three-value set wherever it is declared.
  const REASONS = ["maximum_affordances", "payload_limit", "ground_limit"];
  const csharpReasons = new Set([...projection.matchAll(/"(maximum_affordances|payload_limit|ground_limit)"/g)].map((m) => m[1]));
  for (const reason of REASONS) {
    if (!csharpReasons.has(reason)) findings.push({ kind: "ground", hop: "truncatedReason", detail: `C# does not accept ${reason}` });
  }
  if (!/ground_limit/.test(bridge))
    findings.push({ kind: "ground", hop: "BridgeProtocol truncatedReason", detail: "bridge validator does not accept ground_limit" });

  // The Host declares the value set once as the SceneGroundKind alias and reuses
  // it, so the literals live there rather than in the ground object itself.
  const hostKindAlias = host.match(/export type SceneGroundKind =([^;]+);/);
  const hostGroundUnion = new Set(hostKindAlias ? [...hostKindAlias[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);
  const hostGroundDecl = host.match(/export type ObserveSceneGround = Readonly<\{([\s\S]*?)\}>;/);
  if (!hostGroundDecl)
    findings.push({ kind: "ground", hop: "host protocol ground declaration", detail: "ObserveSceneGround type not found" });
  else if (!/dominantKind:\s*SceneGroundKind/.test(hostGroundDecl[1]))
    findings.push({ kind: "ground", hop: "host protocol ground declaration", detail: "ObserveSceneGround.dominantKind does not reference SceneGroundKind" });
  const hostReason = host.match(/truncatedReason:\s*([^;]+);/);
  const hostReasons = new Set(hostReason ? [...hostReason[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);

  const schemaGroundSet = new Set(schema?.$defs?.observeSceneGround?.properties?.dominantKind?.enum ?? []);
  const schemaReasons = new Set(
    (schema?.$defs?.observeSceneResult?.properties?.truncatedReason?.anyOf ?? []).flatMap((branch) => branch?.enum ?? []),
  );

  // Reasons also appear in a conditional branch narrowing by `partial`, and that is
  // where a producer value goes missing: `ground_limit` was absent from the
  // partial=true branch, so a mixed-ground observation was unschema-valid even
  // though the Mod, the bridge validator and the Host runtime set all accepted it.
  for (const [index, branch] of (schema?.$defs?.observeSceneResult?.allOf ?? []).entries()) {
    const narrowed = branch?.then?.properties?.truncatedReason;
    if (narrowed === undefined || narrowed.type === "null") continue;
    for (const reason of narrowed.enum ?? []) {
      if (!REASONS.includes(reason))
        findings.push({ kind: "ground", hop: `envelope schema allOf[${index}]`, detail: `branch admits ${reason}, which the producer never emits` });
    }
    for (const reason of REASONS) {
      if (!(narrowed.enum ?? []).includes(reason))
        findings.push({ kind: "ground", hop: `envelope schema allOf[${index}]`, detail: `branch omits ${reason}, which the producer can emit with partial=true` });
    }
  }

  for (const [layerName, layerValues] of [
    ["host protocol ground union", hostGroundUnion],
    ["envelope schema ground enum", schemaGroundSet],
  ]) {
    for (const wire of declaredWire) {
      if (!layerValues.has(wire)) findings.push({ kind: wire, hop: layerName, detail: "ground kind missing from this layer" });
    }
    for (const value of layerValues) {
      if (!declaredWire.has(value)) findings.push({ kind: value, hop: layerName, detail: "layer admits a ground kind the Mod enum does not declare" });
    }
  }

  if (!hostReasons.has("ground_limit"))
    findings.push({ kind: "ground", hop: "host protocol truncatedReason", detail: "host union does not accept ground_limit" });
  for (const reason of REASONS) {
    if (!schemaReasons.has(reason))
      findings.push({ kind: "ground", hop: "envelope schema truncatedReason", detail: `schema does not accept ${reason}` });
  }

  return { perKind: perKind.sort((a, b) => a.member.localeCompare(b.member)), findings };
}

function main() {
  const report = auditSceneKindProjection();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.findings.length === 0 ? 0 : 1;
  }

  console.log(`scene affordance kinds: ${report.kindCount}`);
  for (const row of report.perKind) {
    const flags = [row.densityCapped ? "dense" : "sparse", `priority=${row.priority}`].join(" ");
    console.log(`  ${row.member.padEnd(14)} wire=${String(row.wire).padEnd(14)} ref=${String(row.refPrefix).padEnd(4)} ${flags}`);
  }
  if (report.findings.length === 0) {
    console.log("projection: ok (all nine hops agree with the Mod enum)");
    return 0;
  }
  console.log(`projection: ${report.findings.length} finding(s)`);
  for (const finding of report.findings) console.log(`  [${finding.hop}] ${finding.kind}: ${finding.detail}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
