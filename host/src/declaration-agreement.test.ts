import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hostFamilyRules,
  hostSnapshotKeys,
  hostValidators,
  lowerFirst,
  modFamilies,
  modRecords,
  validatorFor,
} from "./wire-declaration.test-support.js";

/**
 * EVERY FIELD THE MOD PUBLISHES MUST BE A FIELD THE HOST READS - AND VICE VERSA.
 *
 * <p>
 * `snapshot-loopback.test.ts` proves the Host accepts a real sample, but only for the families a headless world can
 * construct (7 of 79). This gate closes the rest by comparing the two DECLARATIONS, which exist for every family:
 * </p>
 *
 * <pre>
 *   Mod    public sealed record BridgeXxxTarget(string TargetId, string Location, int X, ...)
 *   Host   function isXxxTargetFact(value): hasExactKeys(value, ["targetId", "location", "x", ...])
 * </pre>
 *
 * <p>
 * A field on one side and not the other is a wire break in one direction or the other: the Mod publishes what the Host
 * rejects (`invalid_snapshot`, the bridge closes on the first real farm) or the Host demands what the Mod never sends
 * (every snapshot refused). Both are what this repository spent a week discovering one live run at a time.
 * </p>
 *
 * <p>
 * Population is derived on BOTH sides - the C# `BridgeSnapshot` declaration names the families and their record types, and
 * the TypeScript is read for its key lists - so a family added to either side is covered without editing this file. A
 * family the C# side declares but the Host has no validator for is reported too: silence is not acceptance.
 * </p>
 */

test("every field the Mod publishes is a field the Host validates", () => {
  const records = modRecords();
  const families = modFamilies();
  const validators = hostValidators();
  const rules = hostFamilyRules();
  const snapshotKeys = hostSnapshotKeys();

  assert.ok(records.size > 50, `the Mod's records must have been parsed (found ${records.size})`);
  assert.ok(families.size > 50, `BridgeSnapshot must declare its families (found ${families.size})`);
  assert.ok(validators.size > 50, `the Host's validators must have been parsed (found ${validators.size})`);

  const disagreements = [];
  const withoutValidator = [];
  for (const [family, recordName] of families) {
    const fields = records.get(recordName);
    if (fields === undefined) {
      disagreements.push(`${family}: publishes ${recordName}, which does not exist in BridgeProtocolModels.cs`);
      continue;
    }
    const wireName = lowerFirst(family);
    const matched = validatorFor(wireName, rules, validators);
    if ("missing" in matched) {
      // A key in SNAPSHOT_KEYS with no array rule is a scalar or object validated on its own, not a family whose rows
      // are checked one by one. The Host still guarantees it is a key it knows; that is the guarantee available here,
      // and saying so is more honest than reporting drift this gate cannot see into.
      if (snapshotKeys.has(wireName)) continue;
      withoutValidator.push(`${family}: ${matched.missing}`);
      continue;
    }
    const validator = matched.name;
    const published = new Set(fields.map((field) => lowerFirst(field.name)));
    const validated = new Set(matched.validator.keys);
    // A validator may name an OPTIONAL key the record omits: `BridgeDoor` has no `accessible`, and `isWarp` (shared with
    // `warps`) accepts one because the Mod omits a null member on the wire. This list is deliberately one entry long - a
    // second entry needs its own reason here, because "the validator is looser than the record" is otherwise exactly the
    // drift this gate reports.
    const OPTIONAL_ON_THE_WIRE = new Map([
      ["accessible", "a null measurement is omitted, so absence means not measured"],
    ]);
    for (const field of published)
      if (!validated.has(field))
        disagreements.push(`${family}.${field}: the Mod publishes it and \`${validator}\` does not name it`);
    for (const key of validated)
      if (!published.has(key) && !OPTIONAL_ON_THE_WIRE.has(key))
        disagreements.push(`${family}.${key}: \`${validator}\` demands it and the Mod does not publish it`);
  }

  assert.deepEqual(
    disagreements,
    [],
    `a field on one side only is a wire break in one direction: the Mod sends what the Host rejects, or the Host demands\n` +
      `what the Mod never sends.\n${disagreements.join("\n")}`,
  );
  assert.deepEqual(
    withoutValidator,
    [],
    `a family with no Host validator is accepted unexamined, which is not the same as accepted correctly:\n` +
      withoutValidator.join("\n"),
  );
});

test("the comparison is not vacuous: a known family and its field are found", () => {
  // A parser that matched nothing would report perfect agreement with everything. `treeChopSourceTargets` is the family
  // whose `health` field this repository got wrong in both directions, so it must be present on both sides.
  const families = modFamilies();
  assert.equal(families.get("TreeChopSourceTargets"), "BridgeTreeChopSourceTarget");
  const fields = modRecords().get("BridgeTreeChopSourceTarget");
  assert.ok(fields !== undefined, "BridgeTreeChopSourceTarget must be parsed");
  assert.ok(
    fields.some((field) => field.name === "Health"),
    `its fields must be read; parsed [${fields.map((field) => `${field.type} ${field.name}`).join(", ")}]`,
  );
  const validator = hostValidators().get("isTreeChopSourceTargetFact");
  assert.ok(validator !== undefined && validator !== null, "isTreeChopSourceTargetFact must be parsed");
  assert.ok(validator.keys.includes("health"), `its keys must be read; parsed [${validator.keys.join(", ")}]`);
});
