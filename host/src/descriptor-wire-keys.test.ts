// The Mod's descriptor records are the producer; this list is the consumer's gate. `hasOnlyKeys` refuses the WHOLE
// hello_ack when one key is unknown, so a missing entry here is a live run that dies at hello with
// `invalid_hello_ack` - measured 2026-11-06, four runs. The population comes from the Mod's own records, so a member
// added there fails here instead of after a game launch.
//
// The second question this file answers is the one the Mod's two records raise against EACH OTHER: they are two
// projections of one Core record for two different readers, so they do not carry the same fields - and a field on one
// side only reads exactly like a field someone forgot on the other. `SINGLE_SIDED_MEMBERS` below is where that
// difference is stated instead of rediscovered.
//
// red-proof: inject  a member added to `FarmhandActionDescriptorWire` only (`string? InjectionProbe = null`) ->
//                    `the wire declares member(s) the artifact does not: arguments, injectionProbe, sceneTarget`
// red-proof: inject  `bool? Synthetic = null` added to the wire record -> `stale_single_sided_member: synthetic`,
//                    while the key-list test above stays GREEN: `KNOWN_ACTION_DESCRIPTOR_KEYS` already names that key,
//                    so this pair's difference cannot refuse hello_ack today

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ROOT, splitTopLevel } from "./wire-declaration.test-support.js";

// Absolute, from the repository root the shared support module finds by walking up from its own location: the Host
// suite runs every compiled file with `cwd` set to the Host package, so a repository-relative path here resolved to
// `host/host/src/protocol.ts` and `host/integrations/...` and both reads threw ENOENT rather than asserting anything.
const WIRE_MODELS = join(ROOT, "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs");
const SURFACE_PUBLICATION = join(ROOT, "integrations/stardew/src/Core/Policy/farmhandactionsurfacepublication.cs");
const PROTOCOL = join(ROOT, "host/src/protocol.ts");

/**
 * Keys of the surface projection that belong to the REGISTRATION envelope, not to the descriptor.
 *
 * `FarmhandActionDescriptorProjection` carries the action's identity on the same level as its descriptor members
 * (the artifact is a per-action row), while the hello_ack splits them into `FarmhandActionRegistrationWire` +
 * `FarmhandActionDescriptorWire`. Only the descriptor half is what `hasOnlyKeys` gates, so only that half is
 * measured here.
 */
const SURFACE_REGISTRATION_KEYS = ["actionId", "identityVersion", "lifecycle", "kind"];

/**
 * Members exactly ONE of the two declarations carries, and who reads the side that lacks it.
 *
 * `FarmhandActionDescriptor` owns every field; `FarmhandActionDescriptorWire` is the hello_ack projection and
 * `FarmhandActionDescriptorProjection` the artifact projection. A claim a static consumer needs and a live dispatch
 * does not belongs on one side only, so the two records are not meant to be the same document - but the difference is
 * invisible in either declaration alone: "which field is lost" and "is the loss a defect" are two questions, and only
 * the second one is about a reader.
 *
 * `arguments`/`argumentSchema` are the same fact in the two shapes each consumer reads; `synthetic` is a claim only the
 * artifact states; `sceneTarget` is the one member with NO reader at all. The assertion below is exact in both
 * directions, so a member added to one projection fails until it is named here, and an entry whose member reaches both
 * projections fails as stale.
 */
const SINGLE_SIDED_MEMBERS: Readonly<Record<string, Readonly<{ carriedBy: "wire" | "surface"; reason: string }>>> = {
  arguments: {
    carriedBy: "wire",
    reason:
      "the hello_ack spelling of an action's arguments, read by the Host (`action-registry.ts` `publishedArguments`, `game-tools.ts` `descriptor.arguments`); the artifact states the same list as `argumentSchema` because a static consumer looks an argument up by name",
  },
  argumentSchema: {
    carriedBy: "surface",
    reason:
      "the artifact spelling of that same list (`ProjectAction` builds it from `descriptor.Arguments`), read by the artifact's own gateway (`packages/game-action-program/src/descriptors.mjs`) and, as the other legal descriptor shape, by the Host (`action-registry.ts` `publishedArguments`); no wire descriptor carries it",
  },
  sceneTarget: {
    carriedBy: "wire",
    reason:
      "the observation binding an action declares (`pickup_forage` names one). It READ nowhere until this unit: the Host's `ActionRegistrationDescriptor` had no such member and `isValidActionDescriptor` only tolerated the key, so the projection omitting it lost nothing. It is read now - `lookaheadIneligibility` (`body-program-script.ts`) refuses to compose a scene-bound action into a plan that runs behind a programme still in flight - and the artifact still omits it, so the one reader sees only the live `hello_ack` value; it is stated here rather than moved onto the surface because that is a change to the Mod's publication, not to this list",
  },
  synthetic: {
    carriedBy: "surface",
    reason:
      "the claim that an action performs its effect without the NPC counter that owns it; no Host code branches on it (`isValidActionDescriptor` only admits `true`), and it cannot refuse `hello_ack` either because `KNOWN_ACTION_DESCRIPTOR_KEYS` already names the key - it is stated on the artifact because that is the only descriptor a consumer outside a running game can read",
  },
};

/** Parameter names of one C# positional record, camelCased the way the wire spells them. */
function recordMembers(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist in the Mod's sources`);
  const open = source.indexOf("(", start);
  let depth = 0;
  let end = open;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const body = source
    .slice(open + 1, end)
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/\/\*\*[\s\S]*?\*\//gu, "");
  // `splitTopLevel` strips `[property: JsonIgnore(Condition = ...)]` before it splits. Without that the parser reads
  // `Condition` out of the attribute as if it were a field - which is how a gate once named two real families with two
  // invented disagreements.
  const names = [];
  for (const part of splitTopLevel(body)) {
    const declarationText = part.trim();
    if (declarationText.length === 0) continue;
    // `Type Name = default` and `[Attribute] Type Name = default` both end in the identifier before `=` or end.
    const match = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|$)/u.exec(declarationText);
    if (match === null) continue;
    const name = match[1];
    if (name === undefined) continue;
    if (/^[A-Z]/u.test(name)) names.push(`${name[0]?.toLowerCase() ?? ""}${name.slice(1)}`);
  }
  return names;
}

/**
 * Every descriptor key the Mod can publish, from BOTH of its projections of `FarmhandActionDescriptor`.
 *
 * There are two, and they are not the same document. `FarmhandActionDescriptorWire` rides hello_ack and is the one
 * the Host's `hasOnlyKeys` gate reads at dispatch time; `FarmhandActionDescriptorProjection` is the surface artifact
 * a consumer outside a running game reads. The surface projection publishes one member the wire record does not -
 * `synthetic`, the fact that separates a commissioned purchase from an effect the Mod performs itself - which is why
 * the Host's list admits it. Reading only the wire record therefore accused the Host of tolerating a key nothing
 * sends, while the Mod published it one projection over. The population is the union, so a member added to EITHER
 * projection fails here.
 */
function modDescriptorKeys(): string[] {
  const wire = recordMembers(readFileSync(WIRE_MODELS, "utf8"), "record FarmhandActionDescriptorWire(");
  assert.ok(wire.length >= 6, `parsed only ${wire.length} wire members, so the parser is wrong, not the list`);
  const surface = recordMembers(
    readFileSync(SURFACE_PUBLICATION, "utf8"),
    "record FarmhandActionDescriptorProjection(",
  ).filter((member) => !SURFACE_REGISTRATION_KEYS.includes(member));
  assert.ok(surface.length >= 6, `parsed only ${surface.length} surface members, so the parser is wrong, not the list`);
  return [...wire, ...surface];
}

function knownDescriptorKeys(source: string): string[] {
  const start = source.indexOf("const KNOWN_ACTION_DESCRIPTOR_KEYS = [");
  assert.notEqual(start, -1, "the Host must declare the descriptor key list");
  const end = source.indexOf("] as const;", start);
  assert.notEqual(end, -1, "the list must be a const tuple");
  return [...source.slice(start, end).matchAll(/"([^"]+)"/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

test("every member of the Mod's descriptor record is a key the Host accepts", () => {
  const members = modDescriptorKeys();
  const known = new Set(knownDescriptorKeys(readFileSync(PROTOCOL, "utf8")));
  const missing = members.filter((member) => !known.has(member));
  assert.deepEqual(
    missing,
    [],
    `the Mod publishes descriptor key(s) the Host's hasOnlyKeys refuses, which fails the WHOLE hello_ack: ${missing.join(", ")}`,
  );
});

test("every descriptor member only one declaration carries is named here with the reader on the other side", () => {
  const wire = new Set(recordMembers(readFileSync(WIRE_MODELS, "utf8"), "record FarmhandActionDescriptorWire("));
  const surface = new Set(
    recordMembers(readFileSync(SURFACE_PUBLICATION, "utf8"), "record FarmhandActionDescriptorProjection(").filter(
      (member) => !SURFACE_REGISTRATION_KEYS.includes(member),
    ),
  );
  assert.ok(
    wire.size >= 6 && surface.size >= 6,
    `parsed ${wire.size} wire and ${surface.size} surface members, so the parser is wrong, not the table`,
  );

  const declared = Object.entries(SINGLE_SIDED_MEMBERS);
  for (const [member, entry] of declared)
    assert.ok(
      entry.reason.length >= 40,
      `${member} needs a reason that names who reads the side that lacks it, or says there is none`,
    );

  const both = declared.filter(([member]) => wire.has(member) && surface.has(member)).map(([member]) => member);
  assert.deepEqual(
    both,
    [],
    `stale_single_sided_member: ${both.join(", ")} is on BOTH declarations now, so it is not single-sided - delete its entry`,
  );

  const wireOnly = [...wire].filter((member) => !surface.has(member)).sort();
  const surfaceOnly = [...surface].filter((member) => !wire.has(member)).sort();
  assert.deepEqual(
    wireOnly,
    declared
      .filter(([, entry]) => entry.carriedBy === "wire")
      .map(([member]) => member)
      .sort(),
    `the wire declares member(s) the artifact does not: ${wireOnly.join(", ")} - name each one in SINGLE_SIDED_MEMBERS with the reader on the artifact side, or the statement that there is none`,
  );
  assert.deepEqual(
    surfaceOnly,
    declared
      .filter(([, entry]) => entry.carriedBy === "surface")
      .map(([member]) => member)
      .sort(),
    `the artifact declares member(s) the wire does not: ${surfaceOnly.join(", ")} - name each one in SINGLE_SIDED_MEMBERS with the reader on the wire side, or the statement that there is none`,
  );
});

test("the list carries no key the Mod cannot send, beyond the named legacy tolerances", () => {
  const members = new Set(modDescriptorKeys());
  // Keys the Host still tolerates for Mod builds older than the current records. Named here rather than deleted so the
  // assertion stays exact: a stray key that is not on this list fails, and the day one of these stops being needed the
  // list shrinks by hand. `argumentSchema` left it when the surface projection joined the population above - the
  // surface record spells the argument map that way, so the tolerance was only ever a record nobody was reading.
  const LEGACY_TOLERATED = ["evidenceSchema", "canonicalCodec"];
  const extra = knownDescriptorKeys(readFileSync(PROTOCOL, "utf8")).filter(
    (key) => !(members.has(key) || LEGACY_TOLERATED.includes(key)),
  );
  assert.deepEqual(
    extra,
    [],
    `accepted keys that are neither in the Mod's record nor named as legacy: ${extra.join(", ")}`,
  );
});
