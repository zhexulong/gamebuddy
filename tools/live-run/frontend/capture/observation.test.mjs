/*
 * red-proof: inject  `readPaintFacts` is driven against a fake Performance API that has paint entries
 * but no `largest-contentful-paint` entry - the exact shape a real page has when nobody installed an
 * observer before navigation. The first version of this reader asked for that entry type anyway and
 * reported `largestContentfulPaintMs: null` for every driver across a full run, which reads as "we
 * measured it and it was missing" rather than "this kit cannot measure it".
 *
 * The second case pins the rule that made the first version wrong: a page CAN have content while
 * `getEntriesByType("largest-contentful-paint")` is empty, because LCP is observer-driven.
 *
 * The empty-block filter is pinned separately: an editable control and a list container must not be
 * reported as "large blocks carrying almost no text". Two screenshots showed both (a 433x101 textarea on
 * Characters, a 693x320 label/value list on Game) being reported by the first version.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readPaintFacts } from "./observation.cjs";

/** A page whose Performance API answers exactly the entries we hand it. */
function fakePage(entries) {
  return {
    evaluate(fn) {
      const original = globalThis.performance;
      globalThis.performance = {
        getEntriesByType(type) {
          return entries.filter((entry) => entry.entryType === type);
        },
      };
      try {
        return Promise.resolve(fn());
      } finally {
        globalThis.performance = original;
      }
    },
  };
}

test("paint facts report first paint and FCP, and claim no LCP", async () => {
  const page = fakePage([
    { entryType: "paint", name: "first-paint", startTime: 428.4 },
    { entryType: "paint", name: "first-contentful-paint", startTime: 436.9 },
  ]);
  const paint = await readPaintFacts(page);
  assert.equal(paint.firstPaintMs, 428, "first paint is rounded to whole milliseconds");
  assert.equal(paint.firstContentfulPaintMs, 437);
  assert.equal(
    "largestContentfulPaintMs" in paint,
    false,
    "LCP needs an observer installed before navigation; this kit does not install one, so the field must be absent rather than permanently null",
  );
});

test("a page with content and no LCP entry still reports paint facts", async () => {
  /* This is the real shape: content painted, and the LCP list is empty because nothing subscribed. */
  const page = fakePage([{ entryType: "paint", name: "first-contentful-paint", startTime: 500 }]);
  const paint = await readPaintFacts(page);
  assert.equal(paint.firstContentfulPaintMs, 500);
  assert.equal("largestContentfulPaintMs" in paint, false);
});

test("a missing paint entry is null, not zero", async () => {
  const paint = await readPaintFacts(fakePage([]));
  assert.equal(paint.firstPaintMs, null, "0 would be a measurement; absence is the truth");
  assert.equal(paint.firstContentfulPaintMs, null);
});
