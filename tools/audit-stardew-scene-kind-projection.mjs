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
const BRIDGE_PROTOCOL = "integrations/stardew/src/Core/Protocol/BridgeProtocol.cs";
const HOST_PROTOCOL = "host/src/protocol.ts";
const SCHEMA = "protocol/bridge-v1.schema.json";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

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

export function auditSceneKindProjection() {
  const contracts = read(CONTRACTS);
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

  const bridge = read(BRIDGE_PROTOCOL);
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

  const host = read(HOST_PROTOCOL);
  // Anchor on the ObserveSceneAffordance declaration: other `kind:` unions in
  // this file (destination "label"|"ref", body event kinds) are unrelated, and
  // the affordance union wraps across lines in current formatting.
  const affordanceDecl = host.match(/export type ObserveSceneAffordance = Readonly<\{([\s\S]*?)\}>;/);
  const hostUnion = new Set(
    affordanceDecl ? [...affordanceDecl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((v) => v !== "North" && v !== "South" && v !== "East" && v !== "West" && v !== "CurrentTile") : [],
  );
  const hostSetMatch = host.match(/const OBSERVE_SCENE_KINDS = new Set\(\[([^\]]*)\]\)/);
  const hostSet = new Set(hostSetMatch ? [...hostSetMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);

  const schema = JSON.parse(read(SCHEMA));
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

  return {
    kindCount: members.length,
    perKind: perKind.sort((a, b) => a.member.localeCompare(b.member)),
    findings: findings.sort((a, b) => `${a.kind}${a.hop}`.localeCompare(`${b.kind}${b.hop}`)),
  };
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
