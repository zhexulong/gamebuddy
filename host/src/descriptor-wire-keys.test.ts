// The Mod's descriptor records are the producer; this list is the consumer's gate. `hasOnlyKeys` refuses the WHOLE
// hello_ack when one key is unknown, so a missing entry here is a live run that dies at hello with
// `invalid_hello_ack` - measured 2026-11-06, four runs. The population comes from the Mod's own records, so a member
// added there fails here instead of after a game launch.

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
