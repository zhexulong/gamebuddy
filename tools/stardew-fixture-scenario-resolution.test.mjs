import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fixtureActions, fixtureScenario } from "./lib/stardew-native-local-player-fixture.mjs";

const SOURCE = new URL("./lib/stardew-native-local-player-fixture.mjs", import.meta.url);

/**
 * `fixtureScenario` decides a run's world from the requested harness action. Two
 * kinds of branch answer it: an ACTION-keyed branch (`action === "x"`) and an
 * ACTION-SET fallback (`actions.includes("y")`). A keyed branch placed after a
 * matching fallback is silently defeated — which is not hypothetical: the
 * play-session key published `harvest_crop` + `ship_item`, so the strawberry
 * covenant's fallback answered first and a real live run armed the WRONG world
 * (and then proved nothing about the fixture it was supposed to exercise).
 *
 * This test makes that undetectable-by-reading failure detectable: for every
 * action-keyed branch, the scenario the key actually resolves to must be the one
 * that branch declares.
 */
test("every action-keyed fixture scenario is reachable through its action set", async () => {
  const source = await readFile(SOURCE, "utf8");

  // The declared key -> scenario pairs, read from the action-keyed branch group.
  const declared = new Map();
  for (const match of source.matchAll(/if \(action === "([a-z0-9_]+)"\) return "([a-z0-9_]+)";/g)) {
    const [, action, scenario] = match;
    if (declared.has(action)) assert.fail(`duplicate action-keyed branch for ${action}`);
    declared.set(action, scenario);
  }
  assert.ok(declared.size >= 10, `expected the action-keyed branch group, found ${declared.size}`);

  const wrong = [];
  for (const [action, expected] of declared) {
    let resolved;
    try {
      resolved = fixtureScenario(fixtureActions(action), action);
    } catch (error) {
      wrong.push({ action, expected, resolved: `threw:${error.message}` });
      continue;
    }
    if (resolved !== expected) wrong.push({ action, expected, resolved });
  }

  assert.deepEqual(
    wrong,
    [],
    `action keys whose scenario is hijacked by an action-set fallback: ${JSON.stringify(wrong)}`,
  );
});
