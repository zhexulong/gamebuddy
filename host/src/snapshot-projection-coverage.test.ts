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

/** The wire schema's own property set for `Snapshot`: the authority the coverage population is derived from. */
function wireSnapshotKeys(): readonly string[] {
  const document = JSON.parse(read("protocol/bridge-v1.schema.json")) as {
    $defs: { snapshot: { properties: Record<string, unknown> } };
  };
  return Object.keys(document.$defs.snapshot.properties).sort();
}

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

  await t.test("every wire snapshot key is read by a projection or withheld by name", () => {
    // The population comes from the WIRE SCHEMA, not a hand list: a field added to the Mod is then a named
    // failure here rather than a fact nobody noticed. This is what the hand-written seventeen-key list this
    // replaced could not do - it stayed green while six published sense fields reached no projection.
    const sources = PROJECTION_SOURCES.map((path) => ({ path, text: read(path) }));
    const unaccounted = wireSnapshotKeys().filter(
      (key) => !sources.some((source) => projectionReads(source.text, key)) && !(key in WITHHELD_SNAPSHOT_KEYS),
    );
    assert.deepEqual(
      unaccounted,
      [],
      `these wire snapshot fields reach the model unprojected and undeclared: ${unaccounted.join(", ")}. Project it, or declare it in WITHHELD_SNAPSHOT_KEYS with the reason.`,
    );
  });

  await t.test("a declared key names a field the wire actually publishes", () => {
    // The mirror of the account above: a declaration that outlives its field is a decision about nothing, and the
    // gate must fail on the drift (a renamed field) rather than silently narrowing its own population.
    const wire = new Set(wireSnapshotKeys());
    const stale = [...Object.keys(WITHHELD_SNAPSHOT_KEYS), ...REQUIRED_PROJECTED_KEYS]
      .filter((key) => !wire.has(key))
      .sort();
    assert.deepEqual(
      stale,
      [],
      `REQUIRED_PROJECTED_KEYS/WITHHELD_SNAPSHOT_KEYS name fields the wire does not publish: ${stale.join(", ")}`,
    );
  });

  await t.test("the six sense fields published but read by no projection are accounted for by name", () => {
    // Named separately from the loop above: these are the fields the 2026-11-02 review measured as reaching no
    // projection, and dropping any of them should fail by naming it rather than as one line of a list.
    const sources = PROJECTION_SOURCES.map((path) => ({ path, text: read(path) }));
    for (const key of [
      "weather",
      "cropTargets",
      "npcRelationshipTargets",
      "animalProductTargets",
      "scytheCropTargets",
      "animalDoorTargets",
    ])
      assert.ok(
        sources.some((source) => projectionReads(source.text, key)) || key in WITHHELD_SNAPSHOT_KEYS,
        `sense field ${key} reaches the model unprojected and undeclared`,
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
