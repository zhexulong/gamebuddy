import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECTION_SOURCES,
  projectionReads,
  REQUIRED_PROJECTED_KEYS,
  WITHHELD_SNAPSHOT_KEYS,
} from "./snapshot-projection-coverage.js";

/**
 * Every native field the model depends on is either projected, or recorded as withheld.
 *
 * The failure this pins: on 2026-10-28 a `ShippingMenu` owned the screen and the projection said
 * `Actionable: true`. The model read "nothing is in the way", said it would go and pick cauliflowers, and the game
 * clock stayed frozen at 06:00 for 31 minutes - because a modal pauses it and only `dismiss_modal` clears it.
 *
 * `actorDispositionDetail` had carried the answer since the disposition work. Nothing forced any projection to
 * read it. That is the defect this gate is about: not one missing field, but the absence of anything that notices
 * a new one.
 */

const repo = (() => {
  let dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  while (!existsSync(join(dir, "integrations"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repository root not found");
    dir = parent;
  }
  return dir;
})();

const read = (relative: string): string => readFileSync(join(repo, relative), "utf8");

test("snapshot projection coverage", async (t) => {
  await t.test("every required key is read by at least one projection", () => {
    const sources = PROJECTION_SOURCES.map((path) => ({ path, text: read(path) }));
    const unread = REQUIRED_PROJECTED_KEYS.filter(
      (key) => !sources.some((source) => projectionReads(source.text, key)),
    );
    assert.deepEqual(
      unread,
      [],
      `these keys reach Snapshot but no projection reads them: ${unread.join(", ")}. Project it, or declare it in WITHHELD_SNAPSHOT_KEYS with the reason.`,
    );
  });

  await t.test("the disposition detail is projected, because it is the field that names a blocking modal", () => {
    // Named separately from the loop above: this is the field whose absence cost a run, and a future refactor that
    // drops it should fail by saying so rather than as one line of a list.
    const source = read("host/src/snapshot-projection.ts");
    assert.equal(projectionReads(source, "actorDispositionDetail"), true);
    assert.equal(projectionReads(source, "actorDispositionKind"), true);
  });

  await t.test("a withheld key carries a reason", () => {
    for (const [key, reason] of Object.entries(WITHHELD_SNAPSHOT_KEYS)) {
      assert.ok(reason.trim().length > 0, `${key} is withheld with an empty reason`);
    }
  });

  await t.test("the reader ignores comments, so prose about a field is not mistaken for reading it", () => {
    // The gate reads source text, and its own subject matter is prose about snapshot fields. Without this the
    // check would count a comment as a read - which is exactly the "a check only reads what it is given" failure
    // this file exists for.
    assert.equal(
      projectionReads("// actorDispositionDetail is not read here\nconst x = 1;\n", "actorDispositionDetail"),
      false,
    );
    assert.equal(
      projectionReads("/* snapshot.actorDispositionDetail */\nconst x = 1;\n", "actorDispositionDetail"),
      false,
    );
    assert.equal(projectionReads("const a = snapshot.actorDispositionDetail;", "actorDispositionDetail"), true);
    assert.equal(projectionReads("const { actorDispositionDetail } = snapshot;", "actorDispositionDetail"), true);
  });
});
