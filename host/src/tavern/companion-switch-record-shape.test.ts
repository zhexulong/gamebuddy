import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMPANION_SWITCH_REQUEST_KEYS, createCompanionSwitchRequest } from "./companion-switch-request.js";

/**
 * One record, two languages, and a refusal on the launcher side when they disagree.
 *
 * The player's choice of companion is written by this Host (`companion-switch-request.ts`) and read
 * by the desktop launcher (`desktop/GameBuddy.Desktop/CompanionSwitch.cs`), which requires the
 * record's key set EXACTLY: an extra key there is a refusal of every record, and so is a key the
 * writer never writes. `companion-switch-request.ts` states that this file is the gate for that
 * fact, and until now no such file existed - the two mirrors were kept in step by hand.
 *
 * The population is therefore not a list written here. It is the record the writer actually
 * produces, the key table this Host declares for it, and the exact-property list the launcher's
 * reader enforces, read out of its source. Every drift is named with the key and the side it is
 * missing on, so a red run says which mirror to fix instead of "records stopped being applied".
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The launcher's reader, found by walking up rather than by counting `..`: the same file is read
 * from `host/src/tavern` and from the compiled `host/dist-test/tavern`, which sit at different
 * depths. A source this gate cannot find is a blocked gate, never a pass.
 */
function launcherReaderSource(): string {
  for (let directory = HERE; ; directory = dirname(directory)) {
    const candidate = join(directory, "desktop", "GameBuddy.Desktop", "CompanionSwitch.cs");
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    if (dirname(directory) === directory)
      throw new Error(`companion_switch_reader_source_missing: walked up from ${HERE}`);
  }
}

/**
 * The keys the launcher requires, read from the exact-property list its request reader enforces.
 *
 * The list is located by the record's IDENTITY rather than by any of its keys: the reader checks
 * the record's `schemaVersion` against `RequestSchema`, and the shape it enforces is the last
 * exact-property check before that comparison. Anchoring on a key would make the most likely
 * drift - a key the reader dropped - unreadable as a drift, because the check would then find no
 * shape at all and blame the file instead of the key.
 */
function launcherReadKeys(source: string): readonly string[] {
  const anchor = source.indexOf(SchemaAnchor);
  assert.ok(
    anchor >= 0,
    `companion_switch_reader_shape_count: CompanionSwitch.cs never compares the record it reads to RequestSchema (${SchemaAnchor})`,
  );

  const shapes = [...source.slice(0, anchor).matchAll(ExactPropertiesCall)];
  const call = shapes.at(-1);
  assert.ok(
    call !== undefined,
    "companion_switch_reader_shape_count: CompanionSwitch.cs enforces no exact-property shape before RequestSchema",
  );

  const list = call.groups?.keys;
  assert.ok(list !== undefined, "companion_switch_reader_shape_count: the enforced shape carries no key list");
  return [...list.matchAll(KeyLiteral)].flatMap((literal) => {
    const key = literal.groups?.key;
    return key === undefined ? [] : [key];
  });
}

/** The one place the launcher's request reader asserts which record it is reading. */
const SchemaAnchor = 'StringEquals(value.GetProperty("schemaVersion"), RequestSchema)';

/** The launcher's exact-property check over the record it is about to read, and its key literals. */
const ExactPropertiesCall = /!ExactProperties\(value, \[(?<keys>[^\]]*)\]\)/gu;

const KeyLiteral = /"(?<key>[A-Za-z][A-Za-z0-9]*)"/gu;

function keysOnly(side: string, keys: readonly string[], reading: string) {
  assert.ok(
    keys.length > 0,
    `record_key_population_empty: ${side} spells no key, so this gate examined 0 - ${reading}`,
  );
}

test("the switch request's key set is one fact across the writer, its declaration, and the launcher", () => {
  // The record as the writer produces it: the real function, the real output, not a copy.
  const written: readonly string[] = Object.keys(
    createCompanionSwitchRequest({
      requestId: "request-01",
      expectedActiveCompanionId: "companion-in-play",
      targetCompanionId: "companion-target",
      targetContinuityId: "continuity-target",
    }),
  );
  const declared: readonly string[] = COMPANION_SWITCH_REQUEST_KEYS;
  const read = launcherReadKeys(launcherReaderSource());

  const examined = new Set([...written, ...declared, ...read]).size;
  const reading =
    `examined ${String(examined)} keys · written ${String(written.length)} · declared ${String(declared.length)} ` +
    `· read ${String(read.length)}`;
  console.log(`companion_switch_request_record: ${reading}`);

  keysOnly("the writer", written, reading);
  keysOnly("the declared table", declared, reading);
  keysOnly("the launcher reader", read, reading);

  const drifts = [
    ...written.filter((key) => !declared.includes(key)).map((key) => `record_key_drift: ${key} written not declared`),
    ...declared.filter((key) => !written.includes(key)).map((key) => `record_key_drift: ${key} declared not written`),
    ...written.filter((key) => !read.includes(key)).map((key) => `record_key_drift: ${key} written not read`),
    ...read.filter((key) => !written.includes(key)).map((key) => `record_key_drift: ${key} read not written`),
  ];

  assert.deepEqual(drifts, [], `${reading} · ${drifts.length} drift(s): ${drifts.join(", ")}`);
});
