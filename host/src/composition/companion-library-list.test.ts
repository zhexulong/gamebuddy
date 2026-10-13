import assert from "node:assert/strict";
import test from "node:test";

import { mergeMountedCompanionList } from "./companion-library-list.js";

const handleFor = (companionId: string): string => `handle-${companionId}`;

test("the mounted companion appears in the library list exactly once", () => {
  // The failure this catches: the management list rendered the current
  // companion twice. The mounted entry was spliced in front AND the library
  // (which also carries the current companion) was mapped without filtering, so
  // the same handle and name appeared on two rows.
  const list = mergeMountedCompanionList(
    [
      { companionId: "companion_01", name: "琥珀" },
      { companionId: "companion_02", name: "小满" },
    ],
    "companion_01",
    "琥珀",
    handleFor,
  );

  assert.deepEqual(list, [
    { handle: "handle-companion_01", name: "琥珀", isCurrent: true },
    { handle: "handle-companion_02", name: "小满", isCurrent: false },
  ]);
  // The exact regression, by the identity the list carries: the current
  // companion's handle is present once. A plain concat yields two.
  assert.equal(list.filter((entry) => entry.handle === "handle-companion_01").length, 1);
  assert.equal(list.length, 2);
});

test("an unreadable mounted profile keeps the library copy instead of dropping the companion", () => {
  // The dedupe must not turn the defense-in-depth path into a disappearance:
  // with no mounted name to prepend, the library copy is the only entry.
  const list = mergeMountedCompanionList(
    [{ companionId: "companion_01", name: "琥珀" }],
    "companion_01",
    undefined,
    handleFor,
  );

  assert.deepEqual(list, [{ handle: "handle-companion_01", name: "琥珀", isCurrent: true }]);
});
