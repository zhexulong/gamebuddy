/**
 * The directive as the Host's own ingress and ledger: refused when it cannot be honest, held when it can, and stamped
 * onto every plan admitted while it is current.
 *
 * The two failures this pins are both about authority rather than wording: a directive with no world day can never
 * expire, and a plan with no stamp can never be told apart from one admitted under a directive that no longer stands.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionInterruption } from "./companion-interruption.js";
import { CompanionEventPump } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";

function harness() {
  const delivered: { disposition: string; body: Record<string, unknown> }[] = [];
  const pump = new CompanionEventPump();
  const loop = {
    pump,
    turnProducedWork: true,
    async flush() {
      const outcome = await pump.flush({
        async deliver(text: string, disposition: string) {
          delivered.push({ disposition, body: JSON.parse(text) as Record<string, unknown> });
        },
      });
      return outcome ?? "completed";
    },
    async abortAndClear() {},
  };
  const service = new CompanionHostService(
    loop as never,
    { onFact: () => () => undefined, onLifecycle: () => () => undefined } as never,
    undefined,
    createCompanionInterruption(),
    async () => undefined,
    async () => undefined,
  );
  return { pump, service, delivered };
}

const DAY_SIX_SNAPSHOT = Object.freeze({
  source: "stardew_mod",
  kind: "snapshot" as const,
  eventId: "snapshot_1",
  correlationId: "snapshot_1",
  revision: 1,
  payload: Object.freeze({ revision: 1, year: 1, seasonIndex: 0, dayOfMonth: 6, timeOfDay: 600 }),
});

test("a directive with no world day is refused by name: it could never expire", async () => {
  const { service } = harness();
  const refused = await service.acceptDirectiveText("找片水，钓条鱼回来。");
  assert.deepEqual(refused, { accepted: false, reasonCode: "directive_world_day_unavailable" });
  assert.equal(service.directive, null);
});

test("an empty directive is refused with the same precedence player input has", async () => {
  const { pump, service } = harness();
  pump.enqueueFact(DAY_SIX_SNAPSHOT);
  assert.deepEqual(await service.acceptDirectiveText("   "), { accepted: false, reasonCode: "player_input_empty" });
  assert.equal(service.directive, null);
});

test("an accepted directive is issued for the world's own day and delivered in the batch it owes", async () => {
  const { pump, service, delivered } = harness();
  pump.enqueueFact(DAY_SIX_SNAPSHOT);
  const accepted = await service.acceptDirectiveText("找片水，钓条鱼回来。");
  assert.equal(accepted.accepted, true);

  const directive = service.directive;
  assert.equal(directive?.state, "current");
  assert.equal(directive?.text, "找片水，钓条鱼回来。");
  assert.deepEqual(directive?.worldDay, { year: 1, seasonIndex: 0, dayOfMonth: 6 });
  const carried = delivered.at(-1)?.body.directive as { directiveId: string } | null;
  assert.equal(carried?.directiveId, directive?.directiveId, "the batch the directive owes carries it");
});

test("a plan admitted under A keeps A after A is superseded, and the alignment says so", async () => {
  const { pump, service } = harness();
  pump.enqueueFact(DAY_SIX_SNAPSHOT);
  await service.acceptDirectiveText("找片水，钓条鱼回来。");
  const first = service.directive;
  assert.ok(first !== null);
  const admittedUnderFirst = service.stampProgramDirective("program_a");
  assert.equal(admittedUnderFirst.directiveId, first.directiveId);
  assert.deepEqual(admittedUnderFirst.directiveWorldDay, { year: 1, seasonIndex: 0, dayOfMonth: 6 });

  await service.acceptDirectiveText("去镇上买种。");
  const second = service.directive;
  assert.ok(second !== null);
  assert.notEqual(second.directiveId, first.directiveId);
  assert.equal(second.supersedes, first.directiveId);
  service.stampProgramDirective("program_b");

  // The FIRST plan's stamp was not rewritten: it records what authorized it, not what is current now.
  assert.equal(service.programDirectiveStamp("program_a").directiveId, first.directiveId);
  const alignment = service.directiveAlignment();
  assert.equal(alignment.plansUnderCurrent, 1);
  assert.equal(alignment.plansUnderRetired, 1);
  assert.equal(alignment.plansWithoutDirective, 0);
  assert.equal(alignment.staleWork, 1, "the plan admitted under the superseded directive is the stale work");
  assert.deepEqual(alignment.alignment, { state: "measured", numerator: 1, denominator: 2, value: 0.5 });

  // A settled plan leaves `staleWork` without leaving the retired count: history is not outstanding work.
  service.settleProgramDirective("program_a");
  assert.equal(service.directiveAlignment().staleWork, 0);
  assert.equal(service.directiveAlignment().plansUnderRetired, 1);
});

test("a plan admitted with no directive is stamped null, and nothing revokes it", async () => {
  const { service } = harness();
  assert.equal(service.stampProgramDirective("program_c").directiveId, null);
  const alignment = service.directiveAlignment();
  assert.equal(alignment.plansUnderCurrent, 0);
  assert.equal(alignment.plansUnderRetired, 0);
  assert.equal(alignment.plansWithoutDirective, 1);
  assert.equal(alignment.staleWork, 0);
  assert.deepEqual(alignment.presence, { state: "not_measured", missingField: "game_session.deliveredTurns" });
});

test("the ledger my_work reads names the current directive and every plan's stamp", async () => {
  const { pump, service } = harness();
  pump.enqueueFact(DAY_SIX_SNAPSHOT);
  await service.acceptDirectiveText("找片水，钓条鱼回来。");
  const current = service.directive;
  service.stampProgramDirective("program_a");
  const ledger = service.programDirectiveLedger();
  assert.ok(ledger !== null);
  assert.equal(ledger.currentDirectiveId, current?.directiveId);
  assert.equal(ledger.stamps.get("program_a"), current?.directiveId);
  assert.equal(ledger.stamps.size, 1);
});
