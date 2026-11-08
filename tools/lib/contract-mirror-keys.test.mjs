/**
 * The browser mirror's candidate key lists must equal the contract's own candidate schema.
 *
 * WHY THIS EXISTS
 *
 * `f0ecdf6b` made the Host send `modLoader` - a member `host/src/game-browser-contract/index.ts` has always declared as
 * `Type.Optional`. The browser's mirror validated candidates by whole key SETS (one list without `location`, one with
 * it), so a candidate carrying `modLoader` matched neither, `invalid_stardew_installation_candidate` was thrown, and the
 * live run `frontend-l` showed the player `无法读取游戏安装搜索结果。` while the Host had answered `resolved` with one
 * candidate. Six named assertions failed on that one sentence.
 *
 * The two lists are a second spelling of one fact. This test derives both sides - the contract's schema and the mirror's
 * lists - and reports the symmetric difference by name, so the next member to be added on either side fails here in
 * milliseconds instead of in a twenty-driver run.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CONTRACT = "host/src/game-browser-contract/index.ts";
const SETTINGS_CONTRACT = "host/src/game-browser-contract/index.ts";
const MIRROR = "dialogue-web/src/composed-reference-game-browser-api.ts";

/** The members of one `strictObject({...})` schema block, split by whether the contract marks them optional. */
function contractMembers(source, schemaName) {
  const start = source.indexOf(`const ${schemaName} = strictObject({`);
  if (start === -1) throw new Error(`contract_schema_not_found:${schemaName}`);
  const end = source.indexOf("\n});", start);
  if (end === -1) throw new Error(`contract_schema_unterminated:${schemaName}`);
  const block = source.slice(start, end);
  const required = new Set();
  const optional = new Set();
  for (const match of block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*(Type\.Optional\()?/gmu)) {
    (match[2] === undefined ? required : optional).add(match[1]);
  }
  return { required, optional };
}

/** One `const NAME = [...] as const;` list from the mirror. */
function mirrorList(source, name) {
  const match = new RegExp(`const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`, "u").exec(source);
  if (match === null) throw new Error(`mirror_list_not_found:${name}`);
  return new Set([...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]));
}

const diff = (left, right) => ({
  missing: [...left].filter((member) => !right.has(member)).sort(),
  extra: [...right].filter((member) => !left.has(member)).sort(),
});

/** The two-sided assertion, so both schemas are checked by one rule rather than two copies of it. */
function assertMirrorMatchesContract({ label, schemaName, contract, mirror, requiredList, optionalList, consequence }) {
  const schema = contractMembers(contract, schemaName);
  const mirroredRequired = mirrorList(mirror, requiredList);
  const mirroredOptional = mirrorList(mirror, optionalList);

  const required = diff(schema.required, mirroredRequired);
  assert.deepEqual(
    required,
    { missing: [], extra: [] },
    `the contract's required ${label} members and the mirror's differ:\n` +
      `  + required by the contract, absent from the mirror: [${required.missing.join(", ")}]\n` +
      `  - in the mirror, not required by the contract: [${required.extra.join(", ")}]`,
  );

  const optional = diff(schema.optional, mirroredOptional);
  assert.deepEqual(
    optional,
    { missing: [], extra: [] },
    `the contract's OPTIONAL ${label} members and the mirror's differ. ${consequence}\n` +
      `  + declared optional by the contract, not allowed by the mirror: [${optional.missing.join(", ")}]\n` +
      `  - allowed by the mirror, not declared by the contract: [${optional.extra.join(", ")}]`,
  );

  // And the populations are not empty, so this cannot pass by having found nothing.
  assert.ok(schema.required.size >= 4, `examined ${schema.required.size} required ${label} member(s)`);
  assert.ok(
    mirroredRequired.size === schema.required.size,
    `the mirror lists all ${schema.required.size} required member(s)`,
  );
}

test("the mirror's required and optional candidate keys are the contract's, member for member", () => {
  assertMirrorMatchesContract({
    label: "candidate",
    schemaName: "GameCandidateV1Schema",
    contract: readFileSync(CONTRACT, "utf8"),
    mirror: readFileSync(MIRROR, "utf8"),
    requiredList: "INSTALLATION_CANDIDATE_REQUIRED_KEYS",
    optionalList: "INSTALLATION_CANDIDATE_OPTIONAL_KEYS",
    consequence: "A member missing on the mirror's side is rejected at runtime as an invalid candidate.",
  });
});

/**
 * The player-settings reply, where the same defect shipped a second time.
 *
 * `windowMode` and `deniedActions` are `Type.Optional` in `StardewPlayerSettingsV1Schema`, and the mirror listed all seven
 * members in one exact-key check - so a player who never chose a window mode (a five-key reply) was refused, and the
 * surface said the settings could not be read with nothing to retry. Reported by a frontend reviewer 2026-11-08 from
 * `g-defects.txt`, verified here against the contract's own schema.
 */
test("the mirror's player-settings keys are the contract's, and its optional members stay optional", () => {
  assertMirrorMatchesContract({
    label: "player-settings",
    schemaName: "StardewPlayerSettingsV1Schema",
    contract: readFileSync(SETTINGS_CONTRACT, "utf8"),
    mirror: readFileSync(MIRROR, "utf8"),
    requiredList: "SETTINGS_REQUIRED_KEYS",
    optionalList: "SETTINGS_OPTIONAL_KEYS",
    consequence: "A required member the contract marks optional leaves the settings surface unreadable.",
  });
});
