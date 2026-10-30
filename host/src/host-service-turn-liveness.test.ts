import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * A turn that ends must not end the RUN.
 *
 * `round9` (2026-10-30) spent its last eleven minutes proving this: the companion came home at in-game 18:20, said
 * "进屋了。门槛上的泥磕掉了，手也搓干净了，锅我架上了。", and stopped. `stop=stop`, no tool call, world static - so
 * `EventPump.hasPendingDelivery` was false, `HostService.flushSoon`'s `finally` saw nothing pending, and nothing woke
 * another turn. `rx` froze at 415/415 and the clock stopped, which meant the 22:00 milestone this pipeline DOES publish
 * (`day_5_2200` appeared in the previous run) could never arrive: a Stardew clock only moves while an action is taken.
 *
 * The self-lock is the point. A static world mints no fact, and the companion is the only thing that moves the world.
 *
 * Every assertion below runs on the source with COMMENTS STRIPPED. The first version of this file did not, and it was
 * vacuous: deleting the predicate's entire second arm left the gate green, because the words "completed" and "idle"
 * appear in the docblock that explains the arm. A gate its own prose can satisfy is a gate that has stopped working.
 */
const HOST_SERVICE = stripComments(readFileSync(new URL("../src/host-service.ts", import.meta.url), "utf8"));

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The predicate's DECLARATION body, not its call site.
 *
 * `indexOf` finds `else if (... && this.#turnOwesAnother())` first, which is the call - the same mistake this repository
 * has paid for twice. The declaration is the one that names its parameter list.
 */
function predicateBody(source: string): string {
  const at = source.indexOf("#turnOwesAnother(): boolean {");
  assert.ok(
    at > 0,
    "the predicate must be declared with an explicit return type, which is what distinguishes it from its call site",
  );
  let depth = 0;
  let started = false;
  for (let i = source.indexOf("{", at); i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
      started = true;
    } else if (source[i] === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error("predicate body is unbalanced");
}

test("the flush loop re-wakes on a turn that produced no work, not only on a pending fact", () => {
  // Anchored between `flushSoon`'s own `finally` and the predicate's DECLARATION, which is what follows it in this file.
  //
  // Two earlier versions of this assertion were vacuous, both for the same reason - it named a block loosely and the
  // name resolved to something else. `lastIndexOf("finally {")` bound to a DIFFERENT function's finally (there are two
  // in this file); slicing `flushSoon` to `scheduleRetry` included the predicate's own declaration, so the CALL could be
  // deleted and the gate stayed green on the declaration. A gate has to name the block it means.
  const flushAt = HOST_SERVICE.indexOf("private async flushSoon(");
  assert.ok(flushAt > 0, "flushSoon is still the one drain entry point");
  const finallyAt = HOST_SERVICE.indexOf("} finally {", flushAt);
  const declarationAt = HOST_SERVICE.indexOf("#turnOwesAnother(): boolean {", finallyAt);
  assert.ok(finallyAt > flushAt, "flushSoon still has its drain block");
  assert.ok(declarationAt > finallyAt, "the predicate is declared after the block that calls it");
  const finallyBlock = HOST_SERVICE.slice(finallyAt, declarationAt);
  assert.match(
    finallyBlock,
    /#turnOwesAnother\(\)/,
    "flushSoon's finally must CALL the predicate, or a spoken-only turn never re-arms",
  );
});

test("a spoken-only turn is a reason to wake again, and that reason is stated", () => {
  const body = predicateBody(HOST_SERVICE);
  assert.match(body, /hasPendingDelivery/, "pending delivery is still one reason; the fix adds, it does not replace");
  assert.match(body, /#idleTurnsWithoutWork/, "the second reason reads the counter of turns that settled without work");
  assert.match(
    body,
    /#lastTurnOutcome\s*===\s*"completed"/,
    "and it requires the turn to have SETTLED, so an aborted or errored turn does not trigger a retry loop",
  );
});

test("the counter is fed by what the turn did, not by how it ended", () => {
  // `completed` covers both "acted" and "only spoke" - the distinction lives in `turnProducedWork`, which only the layer
  // that sees Pi's event stream can set.
  assert.match(
    HOST_SERVICE,
    /turnProducedWork\s*\?\s*0\s*:\s*this\.#idleTurnsWithoutWork\s*\+\s*1/,
    "a turn that worked clears the counter; a turn that only spoke advances it",
  );
});

test("the re-wake cannot spin", () => {
  const body = predicateBody(HOST_SERVICE);
  // The bound is the whole safety argument: an unconditional re-wake is a hot loop against the provider.
  assert.match(body, /#idleTurnsWithoutWork\s*<\s*\d+/, "the predicate carries a numeric bound");
});
