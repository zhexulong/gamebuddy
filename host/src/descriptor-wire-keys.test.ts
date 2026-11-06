// The Mod's descriptor record is the producer; this list is the consumer's gate. `hasOnlyKeys` refuses the WHOLE
// hello_ack when one key is unknown, so a missing entry here is a live run that dies at hello with
// `invalid_hello_ack` - measured 2026-11-06, four runs. The population comes from the Mod's own record, so a member
// added there fails here instead of after a game launch.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const MODELS = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const PROTOCOL = "host/src/protocol.ts";

/** Parameter names of `record FarmhandActionDescriptorWire(...)`, camelCased the way the wire spells them. */
function descriptorWireMembers(source: string): string[] {
  const start = source.indexOf("record FarmhandActionDescriptorWire(");
  assert.notEqual(start, -1, "FarmhandActionDescriptorWire must exist in the Mod's models");
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
  const names = [];
  for (const part of body.split(",")) {
    const declaration = part.trim();
    if (declaration.length === 0) continue;
    // `Type Name = default` and `[Attribute] Type Name = default` both end in the identifier before `=` or end.
    const match = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|$)/u.exec(declaration);
    if (match === null) continue;
    const name = match[1];
    if (name === undefined) continue;
    if (/^[A-Z]/u.test(name)) names.push(`${name[0]?.toLowerCase() ?? ""}${name.slice(1)}`);
  }
  return names;
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
  const members = descriptorWireMembers(readFileSync(MODELS, "utf8"));
  const known = new Set(knownDescriptorKeys(readFileSync(PROTOCOL, "utf8")));
  assert.ok(members.length >= 6, `parsed only ${members.length} members, so the parser is wrong, not the list`);
  const missing = members.filter((member) => !known.has(member));
  assert.deepEqual(
    missing,
    [],
    `the Mod publishes descriptor key(s) the Host's hasOnlyKeys refuses, which fails the WHOLE hello_ack: ${missing.join(", ")}`,
  );
});

test("the list carries no key the Mod cannot send, beyond the named legacy tolerances", () => {
  const members = new Set(descriptorWireMembers(readFileSync(MODELS, "utf8")));
  // Keys the Host still tolerates for Mod builds older than the current record. Named here rather than deleted so the
  // assertion stays exact: a stray key that is not on this list fails, and the day one of these stops being needed the
  // list shrinks by hand.
  const LEGACY_TOLERATED = ["argumentSchema", "evidenceSchema", "canonicalCodec"];
  const extra = knownDescriptorKeys(readFileSync(PROTOCOL, "utf8")).filter(
    (key) => !members.has(key) && !LEGACY_TOLERATED.includes(key),
  );
  assert.deepEqual(
    extra,
    [],
    `accepted keys that are neither in the Mod's record nor named as legacy: ${extra.join(", ")}`,
  );
});
