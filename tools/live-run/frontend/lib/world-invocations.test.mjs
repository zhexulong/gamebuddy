/*
 * red-proof: inject  `worldInvocations` returning the shared list alone (no per-owner invocations), and this
 * suite fails on
 *
 *   "every roster driver runs in exactly one invocation, and a world-owning one runs alone"
 *     AssertionError: x-game-death ends or occupies the world it is measured on and this runner gives it no
 *     mount of its own: the next state driver arrives at a world it did not launch (world_not_owned_by_this_driver)
 *
 * The population is the ROSTER (`phases/drivers.mjs`), imported rather than copied, so a state driver added
 * tomorrow is covered without editing this file - and the two flags that decide the split are the roster's own.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DRIVERS } from "../phases/drivers.mjs";
import { describeWorldInvocations, worldInvocations } from "./world-invocations.mjs";

const ROSTER = worldInvocations(DRIVERS);
const OWNERS = DRIVERS.filter((driver) => driver.ownWorld === true).map((driver) => driver.key);

test("the population is the roster's own world-owning drivers, and it is not empty", () => {
  assert.ok(
    OWNERS.length > 0,
    `the roster names no world-owning driver (${DRIVERS.length} driver(s) read): a full round that measures no end state has lost the population this split exists for`,
  );
  assert.deepEqual(
    ROSTER.invocations.map((invocation) => invocation.driver),
    OWNERS,
    "the invocations are the roster's world-owning drivers, in roster order",
  );
  assert.deepEqual(ROSTER.problems, [], `the roster's own split is refused: ${JSON.stringify(ROSTER.problems)}`);
});

test("every roster driver runs in exactly one invocation, and a world-owning one runs alone", () => {
  const runs = new Map();
  const record = (key, where) => runs.set(key, [...(runs.get(key) ?? []), where]);
  for (const key of ROSTER.shared) record(key, "shared");
  for (const invocation of ROSTER.invocations) for (const key of invocation.drivers) record(key, invocation.driver);
  for (const driver of DRIVERS) {
    const places = runs.get(driver.key) ?? [];
    assert.equal(places.length > 0, true, `${driver.key} (${driver.file}) runs in no invocation at all`);
    if (driver.ownWorld === true) {
      assert.deepEqual(
        places,
        [driver.key],
        `${driver.key} ends or occupies the world it is measured on and this runner gives it no mount of its own: the next state driver arrives at a world it did not launch (world_not_owned_by_this_driver)`,
      );
      continue;
    }
    /*
     * A driver that owns no world runs in the shared invocation, and a LAUNCH-CHAIN driver runs again in every
     * world invocation - that is what brings those worlds up. Any other second appearance is a driver paid for
     * twice with nothing to show for it.
     */
    assert.equal(places[0], "shared", `${driver.key} does not own a world and does not run in the shared invocation`);
    const repeats = places.slice(1);
    if (ROSTER.bringers.includes(driver.key))
      assert.deepEqual(
        repeats,
        ROSTER.invocations.map((invocation) => invocation.driver),
        `${driver.key} brings the world up for every world-owning driver, and its invocations are ${JSON.stringify(repeats)}`,
      );
    else
      assert.deepEqual(
        repeats,
        [],
        `${driver.key} does not own a world and is not a launch-chain driver, yet it runs again`,
      );
  }
});

test("a world invocation runs the launch chain first and the world-owning driver last", () => {
  for (const invocation of ROSTER.invocations) {
    const owners = invocation.drivers.filter((key) => OWNERS.includes(key));
    assert.deepEqual(
      owners,
      [invocation.driver],
      `${invocation.driver}'s invocation carries more than one world-owning driver`,
    );
    assert.deepEqual(
      invocation.drivers.slice(0, -1),
      ROSTER.bringers,
      `${invocation.driver}'s invocation does not run the launch-chain driver(s) ${JSON.stringify(ROSTER.bringers)} before it: a state driver alone on a fresh mount settles at attachment=none and measures nothing (2026-11-22, lane YZOWN)`,
    );
    assert.equal(
      invocation.drivers.at(-1),
      invocation.driver,
      `${invocation.driver} is not the last driver of its own invocation`,
    );
  }
  assert.ok(ROSTER.bringers.length > 0, "the roster names no launch chain (`requiresGame`, not `ownWorld`) at all");
});

test("a world-owning driver with no launch chain is refused by name, never mounted and measured empty", () => {
  const reading = worldInvocations([
    { key: "w-launch", requiresGame: true },
    { key: "x-alone", requiresGame: true, ownWorld: true },
  ]);
  assert.deepEqual(reading.bringers, ["w-launch"]);
  assert.deepEqual(reading.problems, [], "a roster that HAS a launch chain refuses nothing");

  const refused = worldInvocations([{ key: "x-alone", requiresGame: true, ownWorld: true }]);
  assert.equal(refused.problems.length, 1, `expected one refusal, got ${JSON.stringify(refused.problems)}`);
  assert.equal(refused.problems[0].code, "world_owner_without_launch_chain");
  assert.match(refused.problems[0].detail, /x-alone/u, "the refusal must name the driver it is about");
});

test("the split is printed with its population and its cost before the mounts are paid for", () => {
  const line = describeWorldInvocations(ROSTER);
  for (const owner of OWNERS) assert.match(line, new RegExp(owner, "u"), `the printed split does not name ${owner}`);
  assert.match(
    line,
    new RegExp(String(OWNERS.length), "u"),
    "the printed split does not state how many mounts it costs",
  );
  assert.match(
    describeWorldInvocations(worldInvocations([{ key: "a-surfaces" }])),
    /no roster driver owns a world/u,
    "a roster with no world-owning driver says so instead of printing an empty sentence",
  );
});
