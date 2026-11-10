/**
 * A hold whose only release is an event OTHER than the one that caused it is a deadlock, not a guard.
 *
 * <p>
 * The measured case (2026-11-11): the Mod answered `body_owned_by_navigation` - a warp, or a walk the Mod owns - and
 * the pump released only on `day_started`. The day advances when the companion acts, and she could not act because the
 * pump held her turn, so the two waited for each other and the session delivered nothing again.
 * </p>
 * <p>
 * Two gates, both population-derived from the Mod's own source rather than from a list kept here:
 * </p>
 * <ol>
 * <li>`transition_without_a_release:<code>` - every `body_owned_by_*` code the Mod can emit is released by the game's
 * own statement that the transition ended, not by a timeout (a timeout would be a second authority that can disagree
 * with the game).</li>
 * <li>`transition_holds_a_free_body:<code>` - a snapshot showing the body free clears the hold, and everything that
 * queued behind it is delivered in one batch, with the release fact.</li>
 * </ol>
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CompanionEventPump, type PendingBatch, type WorldFact } from "./event-pump.js";

const MOD_ROOT = join(import.meta.dirname, "..", "..", "integrations", "stardew");

/**
 * Every `body_owned_by_*` code the Mod can emit, with the file that spells it.
 *
 * The population comes from the producer: a code added there is checked here without anyone remembering to add it.
 * `tests/` is out of scope - a test publishes nothing - and so are the compiler's own output directories.
 */
function modBodyOwnerCodes(): readonly Readonly<{ code: string; where: string }>[] {
  const found = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "bin" || entry.name === "obj" || entry.name === "tests") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".cs")) continue;
      for (const match of readFileSync(path, "utf8").matchAll(/"body_owned_by_[a-z0-9_]+"/gu)) {
        const code = match[0].slice(1, -1);
        if (!found.has(code)) found.set(code, entry.name);
      }
    }
  };
  walk(MOD_ROOT);
  return Object.freeze([...found].map(([code, where]) => Object.freeze({ code, where })));
}

/** The refusal's own execution: the request the Mod turned down, which is never the owner. */
const REFUSED_EXECUTION = "exec_refused";
const OWNER_EXECUTION = "exec_owner_7f3a";
const OWNER_ACTION = "owner_action_label";

/**
 * The Mod's refusal, in the shape it publishes one: `reasonCode` is the code, and the owner it names travels in the
 * evidence detail (`farmhandexecutioncontroller.cs:881`).
 */
function refusal(code: string, detail: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `refusal_${code}`,
    correlationId: REFUSED_EXECUTION,
    executionId: REFUSED_EXECUTION,
    revision: 1,
    payload: Object.freeze({
      state: "rejected",
      executionId: REFUSED_EXECUTION,
      requestId: "request_refused",
      actionId: "pickup_item",
      reasonCode: code,
      evidence: detail,
    }),
  };
}

/** The owner's own terminal receipt: the game saying the transition it was running has finished. */
function ownerTerminalReceipt(executionId: string, actionId: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `owner_terminal_${executionId}`,
    correlationId: executionId,
    executionId,
    revision: 2,
    payload: Object.freeze({ state: "succeeded", executionId, actionId, revision: 2 }),
  };
}

/** A snapshot of the body, as the Mod reads it: `actionable` is its own admission gate for that reading. */
function snapshot(revision: number, actionable: boolean): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    eventId: `snapshot_${String(revision)}`,
    correlationId: `snapshot_${String(revision)}`,
    revision,
    payload: Object.freeze({ revision, location: "Farm", actionable }),
  };
}

/** An ordinary observation that arrives while the body is held, so a release has something to carry. */
function queuedObservation(eventId: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    revision: 1,
    semanticKind: "npc_dialogue_presented",
    payload: Object.freeze({ speaker: "Marnie", pages: ["早上好。"], isQuestion: false, choices: [] }),
  };
}

function collector(batches: PendingBatch[]): { deliver(batch: PendingBatch): Promise<void> } {
  return {
    async deliver(batch) {
      batches.push(batch);
    },
  };
}

/** Enter the hold with one refusal, then offer ONE release fact; report what the pump did at each step. */
async function holdThenRelease(code: string, detail: string, release: WorldFact) {
  const pump = new CompanionEventPump();
  pump.enqueueFact(refusal(code, detail));
  const held = pump.isWorldTransition;

  // Something happens in the world while the body is held: it QUEUES, and the hold must not let it through.
  pump.enqueueFact(queuedObservation("observation_during_hold"));
  const duringHold: PendingBatch[] = [];
  await pump.flush(collector(duringHold));

  pump.enqueueFact(release);
  const released = !pump.isWorldTransition;
  const afterRelease: PendingBatch[] = [];
  await pump.flush(collector(afterRelease));
  return { held, duringHold, released, afterRelease };
}

const OWNER_DETAIL = `owner_execution_id=${OWNER_EXECUTION};owner_action=${OWNER_ACTION};interruptible=false;phase=committed;cancel_safe=false`;

test("transition_without_a_release: every body_owned_by_* code the Mod emits is released by the game, not by a timeout", async (t) => {
  const codes = modBodyOwnerCodes();
  // Zero population is a broken scan, never a pass: nothing was examined, so nothing was proven.
  assert.ok(
    codes.length > 0,
    `examined 0 of the Mod's body-owner codes under ${MOD_ROOT}: the scan is wrong, not the product`,
  );
  t.diagnostic(
    `transition_release_population:examined=${String(codes.length)}:codes=${codes.map((entry) => `${entry.code}@${entry.where}`).join(",")}`,
  );

  const releases: readonly Readonly<{ name: string; fact: WorldFact }>[] = [
    { name: "the owner's terminal receipt", fact: ownerTerminalReceipt(OWNER_EXECUTION, OWNER_ACTION) },
    { name: "a snapshot showing the body free", fact: snapshot(9, true) },
  ];

  const unreleased: string[] = [];
  for (const { code } of codes) {
    for (const release of releases) {
      const outcome = await holdThenRelease(code, OWNER_DETAIL, release.fact);
      assert.equal(outcome.held, true, `${code} must hold delivery while the transition is in progress`);
      assert.equal(outcome.duringHold.length, 0, `${code} must not deliver while the body is owned`);
      if (!outcome.released)
        unreleased.push(
          `transition_without_a_release:${code} <- ${release.name} leaves the hold in place, so delivery waits for a different event than the one that caused it`,
        );
    }
  }
  assert.deepEqual(
    unreleased,
    [],
    "a hold whose only release is a different event than the one that caused it is a deadlock",
  );
});

test("transition_holds_a_free_body: a snapshot that shows the body free releases the hold and delivers what queued", async () => {
  // The exact shape that froze a session: a navigation refusal, then a world that is plainly free again.
  const outcome = await holdThenRelease(
    "body_owned_by_navigation",
    `owner_execution_id=${OWNER_EXECUTION};owner_action=navigate_to_destination;interruptible=false;phase=committed;cancel_safe=false`,
    snapshot(4, true),
  );

  assert.equal(outcome.held, true, "the refusal must hold delivery in the first place");
  assert.equal(outcome.duringHold.length, 0, "and nothing reaches the companion while the body is owned");
  assert.equal(
    outcome.released,
    true,
    "transition_holds_a_free_body:body_owned_by_navigation - a snapshot whose `actionable` is true is the Mod's own admission gate saying the body is free",
  );
  assert.equal(
    outcome.afterRelease.length,
    1,
    "everything that queued arrives in one batch, with the fact that released it",
  );
  const delivered = outcome.afterRelease[0]!;
  const deliveredIds = delivered.facts.map((fact) => fact.eventId);
  assert.ok(
    deliveredIds.includes("observation_during_hold"),
    "the observation from inside the hold is delivered, not dropped on release",
  );
  assert.ok(deliveredIds.includes("snapshot_4"), "and the snapshot that ended it is delivered with it");
});

test("the owner's own terminal receipt ends the hold, read from the Mod's evidence detail", async () => {
  // `owner_execution_id` and `owner_action` ride in the refusal's evidence string, not as payload keys; a refusal that
  // carries an execution id is released by THAT execution finishing, whichever comes first.
  const outcome = await holdThenRelease(
    "body_owned_by_navigation",
    OWNER_DETAIL,
    ownerTerminalReceipt(OWNER_EXECUTION, OWNER_ACTION),
  );
  assert.equal(outcome.released, true, "the owner's terminal receipt is the game saying the transition finished");
  assert.equal(outcome.afterRelease.length, 1, "and what queued is delivered with it");
});

test("an unrelated execution settling says nothing about this hold", async () => {
  // The invariant that makes the receipt release safe: the refusal that STARTED the hold is itself a terminal receipt,
  // and another execution finishing is not evidence about this one.
  const pump = new CompanionEventPump();
  pump.enqueueFact(refusal("body_owned_by_navigation", OWNER_DETAIL));
  pump.enqueueFact(ownerTerminalReceipt("exec_something_else", "move_to_tile"));
  assert.equal(pump.isWorldTransition, true, "a receipt for a different execution must not release the hold");
});

test("the Mod's `unknown` owner token falls back to the action it named", async () => {
  // `OwnerToken` writes `unknown` when the Mod has no execution id for the holder (a coordinator-driven navigation is
  // one). Matching on that literal would make the hold unreleasable, so the action label is the fallback identity.
  const detail =
    "owner_execution_id=unknown;owner_action=navigate_to_destination;interruptible=false;phase=committed;cancel_safe=false";
  const relevant = await holdThenRelease(
    "body_owned_by_navigation",
    detail,
    ownerTerminalReceipt("exec_whoever", "navigate_to_destination"),
  );
  assert.equal(relevant.released, true, "the named owner action ending is the release the Mod left available");

  const unrelated = await holdThenRelease(
    "body_owned_by_navigation",
    detail,
    ownerTerminalReceipt("exec_whoever", "move_to_tile"),
  );
  assert.equal(unrelated.released, false, "a different action settling is not this owner ending");
});

test("a snapshot from before the hold is not the body being free again", async () => {
  // The pump already held this reading when the refusal arrived: a re-published copy of it describes a moment before
  // the transition, and treating it as a release would put the bookkeeping back through the stage.
  const pump = new CompanionEventPump();
  pump.enqueueFact(snapshot(3, true));
  pump.enqueueFact(refusal("body_owned_by_navigation", OWNER_DETAIL));
  assert.equal(pump.isWorldTransition, true);
  pump.enqueueFact(snapshot(3, true));
  assert.equal(pump.isWorldTransition, true, "the same reading twice is one observation, not two");
  pump.enqueueFact(snapshot(4, false));
  assert.equal(pump.isWorldTransition, true, "a NEWER snapshot that still reads busy keeps the hold");
  pump.enqueueFact(snapshot(5, true));
  assert.equal(pump.isWorldTransition, false, "the newest snapshot saying free is the release");
});
