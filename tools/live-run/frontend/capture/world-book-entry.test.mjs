/**
 * The kit's world-book edit row and the contract's entry schema must name the same members.
 *
 * WHY THIS EXISTS
 *
 * `f94d31c6` made `enabled` required on `CompanionWorldBookEntryV1Schema`. `q-companion-world-book.cjs`
 * kept building its second write from a hand-copied `{title, keys, constant, content}`, the route refused
 * the body as `invalid_request` at `tavern-management-dialogue-web.ts:1942`, and the stale revision that
 * write exists to produce never happened - so the item that was supposed to measure a refusal measured a
 * closed editor, and the driver died 20 minutes in on a `[data-companion-world-book-cancel]` timeout.
 *
 * The population here is the contract's own schema block, read from the source the Host ships, and the
 * comparison names the drifting member so the next required (or removed) member is a millisecond-long red
 * instead of a live run's tail.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WORLD_BOOK_ENTRY_FIELDS, editRow, entryReading } from "./world-book-entry.cjs";

const CONTRACT = "host/src/tavern/browser-contract/index.ts";
const ENTRY_SCHEMA = "export const CompanionWorldBookEntryV1Schema = strictObject({";

/** The members one `strictObject({...})` block declares, in the order the contract spells them. */
function contractEntryMembers(source) {
  const start = source.indexOf(ENTRY_SCHEMA);
  if (start === -1)
    throw new Error(
      `contract_schema_not_found:CompanionWorldBookEntryV1Schema - an edit row is checked against the contract's own ` +
        `members, so a schema this file cannot read is a blocked reading, never a pass (${CONTRACT})`,
    );
  const end = source.indexOf("\n});", start);
  if (end === -1) throw new Error(`contract_schema_unterminated:CompanionWorldBookEntryV1Schema (${CONTRACT})`);
  return [...source.slice(start, end).matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gmu)].map((match) => match[1]).sort();
}

test("the kit's edit row names the contract's own world-book entry members, member for member", () => {
  const contract = contractEntryMembers(readFileSync(CONTRACT, "utf8"));
  assert.ok(
    contract.length >= 4,
    `examined ${contract.length} declared entry member(s) of CompanionWorldBookEntryV1Schema`,
  );
  const declared = [...WORLD_BOOK_ENTRY_FIELDS].sort();
  const missing = contract.filter((member) => !declared.includes(member));
  const extra = declared.filter((member) => !contract.includes(member));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `an edit row and CompanionWorldBookEntryV1Schema must name the same members, because the update route validates ` +
      `the body against the schema (host/src/tavern-management-dialogue-web.ts:1942) and answers 400 invalid_request ` +
      `before any revision is compared:\n` +
      `  + required by the contract, absent from the row: [${missing.join(", ")}]\n` +
      `  - in the row, not declared by the contract: [${extra.join(", ")}]`,
  );
});

test("an edit row carries every member the projection carried and replaces only the body", () => {
  const projected = {
    title: "Greenhouse",
    keys: ["greenhouse"],
    constant: false,
    enabled: true,
    content: "Her greenhouse.",
  };
  assert.deepEqual(
    editRow(projected, "The glass is new."),
    { ...projected, content: "The glass is new." },
    "a row the player rewrote keeps every other member of the entry the Host projected",
  );
  assert.deepEqual(editRow(projected), projected, "a row the player did not touch is sent back as it was read");
});

test("an edit row built from a projection carrying an undeclared member is refused by name", () => {
  const projected = {
    title: "Greenhouse",
    keys: ["greenhouse"],
    constant: false,
    enabled: true,
    content: "Her greenhouse.",
    priority: 4,
  };
  assert.throws(
    () => editRow(projected),
    /a world-book projection carries \[priority\], which this kit's edit row does not declare/,
    "the refusal names the member the contract grew, so the next one is not carried blind into a write",
  );
});

/**
 * The optional half is optional on BOTH sides.
 *
 * `secondaryKeys` and `selectiveLogic` are `Type.Optional` in the contract, so a book whose cards never
 * declared a second condition projects without them - which is the population the live run's companion
 * reads. A row check spelled as equality would refuse that projection, and the refusal would land on the
 * one write that exists to move the book's revision while an editor pins the old one.
 */
test("an edit row accepts a projection without the optional members, and carries them when they are there", () => {
  const withoutOptional = {
    title: "Greenhouse",
    keys: ["greenhouse"],
    constant: false,
    enabled: true,
    content: "Her greenhouse.",
  };
  assert.deepEqual(
    editRow(withoutOptional, "The glass is new."),
    { ...withoutOptional, content: "The glass is new." },
    "a card that declares no second condition projects no second condition, and the row keeps it that way",
  );
  const withOptional = { ...withoutOptional, secondaryKeys: ["glass"], selectiveLogic: 0 };
  assert.deepEqual(
    editRow(withOptional, "The glass is new."),
    { ...withOptional, content: "The glass is new." },
    "a card that DOES declare one keeps both members: a save must not mint a mode, nor drop the one it read",
  );
});

test("an entry reading reports the fields the driver asserts on, and invents none", () => {
  const reading = entryReading({
    title: "Greenhouse",
    keys: ["greenhouse"],
    constant: false,
    enabled: true,
    content: "Her greenhouse.",
  });
  assert.deepEqual(Object.keys(reading).sort(), ["chars", "constant", "enabled", "head", "keys", "title"]);
  assert.equal(reading.enabled, true, "the switch is a field the reading carries, not one it derives away");
  assert.equal(reading.chars, 15);
  assert.equal(reading.head, "Her greenhouse.");
});
