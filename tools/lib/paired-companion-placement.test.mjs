import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { awaitCompanionPlacement } from "./paired-companion-placement.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "gb-placement-"));

/**
 * One publication and one report, in the shape BOTH processes write: `action=placement`, the tile the record is about,
 * the tile that was asked for, and the generation that binds a report to the publication it answers.
 */
const placementRows = ({
  generation = "gen-paired-1",
  published = { x: 33, y: 16 },
  placed = { x: 34, y: 17 },
} = {}) => [
  {
    action: "placement",
    state: "published",
    reasonCode: "paired_companion_placement_published",
    location: "Farm",
    x: published.x,
    y: published.y,
    requestedX: published.x,
    requestedY: published.y,
    detail: `generation=${generation}`,
  },
  ...(placed === null
    ? []
    : [
        {
          action: "placement",
          state: "placed",
          reasonCode: "paired_companion_placement_reported",
          location: "Farm",
          x: placed.x,
          y: placed.y,
          requestedX: published.x,
          requestedY: published.y,
          detail: `generation=${generation}`,
        },
      ]),
];

/**
 * HER PLACEMENT IS AN ACT ON THE STREAM, NOT A TILE S1 ASSUMED.
 *
 * The Host publishes the tile with a generation; her own process stands there through the engine's own warp and reports
 * the tile it reached. Three readings follow, and each one is a different failure a launch can have:
 *   * a publication with no report is NOT a placement - the budget runs out and the refusal names the published tile and
 *     the wall time, so a slice that never had a body in its world says so instead of reporting `fixture_missing`;
 *   * a report carrying ANOTHER generation is a report from a different launch and confirms nothing;
 *   * a refusal her process wrote ends the wait under HER code, because a tile she could not stand on is a named fact and
 *     reporting it as a timeout would replace it with this run's clock.
 */
test("S1 refuses to start until HER process reports standing on the published tile, and names what is missing", async () => {
  const dir = scratch();
  try {
    const recordsPath = join(dir, "host-player-records.jsonl");
    writeFileSync(
      recordsPath,
      placementRows({ placed: null })
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    let clock = 0;
    const unconfirmed = await awaitCompanionPlacement({
      path: recordsPath,
      timeoutMs: 50,
      now: () => (clock += 25),
      pollMs: 0,
    });
    assert.equal(unconfirmed.confirmed, false);
    assert.match(
      unconfirmed.reasonCode,
      /^paired_companion_placement_unconfirmed:33,16:\d+$/u,
      "the refusal names the tile the Host published and the wait it cost",
    );
    assert.deepEqual(unconfirmed.publishedTile, { x: 33, y: 16 });
    assert.equal(unconfirmed.placedTile, null);

    // A report from ANOTHER launch: same action, same shape, a different generation - and therefore not an answer to
    // this publication.
    writeFileSync(
      recordsPath,
      [
        ...placementRows({ placed: null }),
        { ...placementRows({ generation: "gen-earlier-launch" })[0], state: "placed" },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const stale = await awaitCompanionPlacement({ path: recordsPath, timeoutMs: 0, now: () => 0, pollMs: 0 });
    assert.equal(stale.confirmed, false, "a report bound to another generation cannot confirm this placement");

    // Her own refusal, carried through under her code.
    writeFileSync(
      recordsPath,
      [
        ...placementRows({ placed: null }),
        {
          action: "placement",
          state: "rejected",
          reasonCode: "paired_companion_placement_tile_not_standable:33,16",
          location: "Farm",
          x: 34,
          y: 17,
          requestedX: 33,
          requestedY: 16,
          detail: "generation=gen-paired-1",
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const refused = await awaitCompanionPlacement({ path: recordsPath, timeoutMs: 0, now: () => 0, pollMs: 0 });
    assert.equal(refused.confirmed, false);
    assert.equal(refused.reasonCode, "paired_companion_placement_tile_not_standable:33,16");

    // And the answer itself: the report names the tile she reached, not the one that was requested.
    writeFileSync(
      recordsPath,
      placementRows()
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const confirmed = await awaitCompanionPlacement({ path: recordsPath, timeoutMs: 0, now: () => 0, pollMs: 0 });
    assert.equal(confirmed.confirmed, true);
    assert.deepEqual(confirmed.placedTile, { x: 34, y: 17 });
    assert.deepEqual(confirmed.publishedTile, { x: 33, y: 16 });
    assert.equal(confirmed.generation, "gen-paired-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a launch with no placement publication says so by name, and never waits out a slice it cannot measure", async () => {
  const dir = scratch();
  try {
    const recordsPath = join(dir, "host-player-records.jsonl");
    // The Host player's steps are on the stream and the publication is NOT: she was never told where to stand.
    writeFileSync(
      recordsPath,
      JSON.stringify({
        seq: 1,
        stepId: "walk",
        action: "walk_to_tile",
        state: "succeeded",
        reasonCode: "walked_to_tile",
        x: 39,
        y: 19,
      }),
    );
    const placement = await awaitCompanionPlacement({ path: recordsPath, timeoutMs: 0, now: () => 7, pollMs: 0 });
    assert.equal(placement.confirmed, false);
    assert.match(placement.reasonCode, /^paired_companion_placement_unconfirmed:unpublished:\d+$/u);
    assert.equal(placement.publishedTile, null);
    // No stream at all is the same refusal, not a crash: the runner must be able to say a lane was never armed.
    const unarmed = await awaitCompanionPlacement({ path: null, timeoutMs: 0, now: () => 0, pollMs: 0 });
    assert.equal(unarmed.confirmed, false);
    assert.match(unarmed.reasonCode, /^paired_companion_placement_unconfirmed:unpublished:/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Host refusal with nothing published is the answer S1 reports, not a timeout", async () => {
  const dir = scratch();
  try {
    const recordsPath = join(dir, "records.jsonl");
    // The shape the Host writes when it cannot resolve her: `action=placement,state=rejected` with the named code and no
    // generation, because there was no tile to publish. A waiter that only looked for a publication would time out and
    // report its own clock instead of the Host's reason.
    writeFileSync(
      recordsPath,
      JSON.stringify({
        action: "placement",
        state: "rejected",
        reasonCode: "paired_companion_farmhand_unavailable",
        location: "Farm",
        x: 0,
        y: 0,
        requestedX: 0,
        requestedY: 0,
        detail: "generation=",
      }),
    );
    const placement = await awaitCompanionPlacement({ path: recordsPath, timeoutMs: 0, now: () => 0, pollMs: 0 });
    assert.equal(placement.confirmed, false);
    assert.equal(placement.reasonCode, "paired_companion_farmhand_unavailable");
    assert.equal(placement.publishedTile, null);
    assert.equal(placement.generation, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
