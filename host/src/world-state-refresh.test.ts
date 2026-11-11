/**
 * GATE `stale_world_state_produces_no_refresh`, and the bound that keeps its repair from becoming a spin.
 *
 * <p>
 * MEASURED 2026-11-10 (`round45`): the world reading froze at `revision 352` for the last 50 turns of the run while the
 * clock walked through two `02:00` pass-outs and two day starts, and the companion dispatched nothing for 601 s. The
 * pump already said so - `world_state_stale:50;352;…` reached the model - and nothing acted on it: the only producers of
 * `observe_request` in the product are the model's own `stardew_observe` tool and the execute path's `stale_snapshot`
 * re-take, so being told the picture was old WAS the entire repair. In a narration loop, being told is exactly what she
 * does not act on.
 * </p>
 *
 * <p>
 * The population is the frozen window's own facts, replayed in the order the bundle recorded them; the property is that
 * each stale fact is followed by a request for a fresh observation or by a named refusal, never by silence. The red
 * reading is kept beside it as a fixture, because it is what every composition shipped: a pump with no port attached
 * answers the same window with no request at all.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import {
  CompanionEventPump,
  type PendingBatch,
  WORLD_STATE_REFRESH_ATTEMPTS,
  WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND,
  type WorldFact,
  type WorldStateRefreshPort,
} from "./event-pump.js";
import { WORLD_STATE_STALE_TURNS } from "./fact-brief.js";
import { CompanionHostService } from "./host-service.js";
import type { Snapshot } from "./protocol.js";

/** The world as the Mod admitted it at `revision 352`, which is the reading the frozen window re-stated 50 times. */
const STUCK_READING = {
  revision: 352,
  location: "FarmHouse",
  tile: { x: 9, y: 9 },
  stamina: 270,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 600,
  dayOfMonth: 6,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  currentTool: "(T)Axe",
  currentToolSlot: 0,
  toolSlots: [],
  inventoryItemFacts: [],
  cropTargets: [],
  harvestTargets: [],
} as unknown as Snapshot;

function snapshotFact(revision: number, reading: Snapshot = STUCK_READING): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId: `snapshot_${String(revision)}`,
    correlationId: `observe_${String(revision)}`,
    revision,
    payload: reading as never,
  });
}

function worldFact(semanticKind: string, gameTime: string, index: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `${semanticKind}_${String(index)}`,
    correlationId: `${semanticKind}_${String(index)}`,
    revision: 400,
    observedTick: index,
    gameTime,
    semanticKind,
    payload: Object.freeze({ kind: semanticKind, revision: 400 }) as Readonly<Record<string, unknown>>,
  });
}

/**
 * The facts the Mod published after the reading froze (22:26:19 - 22:55:40 in the bundle): the clock walking 12:00 ->
 * 18:00 -> 22:00 -> 24:00 -> 26:00, a pass-out, a new day, and then the same again.
 */
const FROZEN_WINDOW: readonly WorldFact[] = Object.freeze([
  worldFact("time_milestone", "1200", 2),
  worldFact("time_milestone", "1800", 3),
  worldFact("time_milestone", "2200", 4),
  worldFact("time_milestone", "2400", 5),
  worldFact("night_ended_pass_out", "2600", 6),
  worldFact("day_started", "0600", 7),
  worldFact("time_milestone", "1200", 8),
  worldFact("night_ended_pass_out", "2600", 9),
  worldFact("day_started", "0600", 10),
]);

/** One delivered turn, admitted in the order the Host admits it: the fact, then whatever the pump minted for it. */
async function deliverTurn(pump: CompanionEventPump, fact: WorldFact): Promise<PendingBatch | undefined> {
  const batches: PendingBatch[] = [];
  pump.enqueueFact(fact);
  const stale = pump.takeWorldStateStaleFact();
  if (stale !== undefined) pump.enqueueFact(stale);
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  return batches.at(0);
}

function staleFactsOf(batch: PendingBatch | undefined): readonly WorldFact[] {
  return (batch?.facts ?? []).filter((fact) => fact.semanticKind === "world_state_stale");
}

/** The refusal is published from a promise continuation, so it lands after the turn that produced it. */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Replay the frozen window, returning every stale fact it published and what each of them asked for. */
async function replayFrozenWindow(pump: CompanionEventPump): Promise<readonly WorldFact[]> {
  const stale: WorldFact[] = [];
  await deliverTurn(pump, snapshotFact(352));
  for (const fact of FROZEN_WINDOW) {
    for (const one of staleFactsOf(await deliverTurn(pump, fact))) stale.push(one);
  }
  await drained();
  return stale;
}

test("stale_world_state_produces_no_refresh: every stale fact is followed by a request or a named refusal", async () => {
  // THE RED READING, kept as the fixture. A pump nobody wired is what every composition shipped at HEAD: the frozen
  // window produces stale facts and answers them with no request at all - the 601 s of silence, reproduced from the
  // bundle's own facts rather than described.
  const unattached = new CompanionEventPump();
  const unattachedStale = await replayFrozenWindow(unattached);
  assert.ok(unattachedStale.length > 0, "the window must produce stale facts, or this gate has nothing to read");
  assert.equal(
    unattached.worldStateRefresh.attached,
    false,
    "a pump nobody wired cannot refresh, and that condition must be readable rather than silent",
  );
  assert.equal(unattached.worldStateRefresh.probes, 0, "the defect this gate names: stale, and nothing asks");

  // THE PROPERTY: each stale fact is answered by one request, in the same admission that publishes it, so the reading she
  // is handed next is one she was not asked to go and fetch herself.
  const pump = new CompanionEventPump();
  const asked: string[] = [];
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe(): Promise<unknown> {
        asked.push(`observe_${String(asked.length + 1)}`);
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  const stale = await replayFrozenWindow(pump);
  assert.equal(pump.worldStateRefresh.attached, true);
  assert.equal(
    asked.length,
    stale.length,
    `each of the ${String(stale.length)} stale facts must be answered by one request, never by prose alone ` +
      `(measured ${String(asked.length)})`,
  );
});

test("refresh_loop_without_progress: a frozen reading is asked about at most WORLD_STATE_REFRESH_ATTEMPTS times", async () => {
  // Fifty turns of one revision against a bridge that refuses every one of them: the world never moves, so the request
  // count is the only thing that can run away. The re-arm key is the REVISION, not the turn, so the count is bounded by
  // the constant however long the freeze lasts.
  const pump = new CompanionEventPump();
  const refusals: WorldFact[] = [];
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe(): Promise<unknown> {
        throw new Error("bridge_not_authenticated");
      },
      publish: (fact: WorldFact) => {
        refusals.push(fact);
      },
    }),
  );
  await deliverTurn(pump, snapshotFact(352));
  for (let turn = 1; turn <= 50; turn += 1) await deliverTurn(pump, worldFact("time_milestone", "1200", turn));
  await drained();

  assert.equal(
    pump.worldStateRefresh.probes,
    WORLD_STATE_REFRESH_ATTEMPTS,
    `fifty turns of one frozen revision asked ${String(pump.worldStateRefresh.probes)} times; the bound is ` +
      `${String(WORLD_STATE_REFRESH_ATTEMPTS)} per crossed revision`,
  );
  assert.equal(
    refusals.length,
    1,
    "a refusal is said once per crossing: three copies of one condition would be three turns spent re-reading it",
  );
  const refused = refusals[0];
  assert.ok(refused !== undefined);
  assert.equal(refused.semanticKind, WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND);
  assert.equal(refused.revision, 352, "the refusal names the reading it could not replace");
  assert.equal(
    refused.payload.code,
    "world_state_refresh_refused:bridge_not_authenticated",
    "the reason is the route's own words, not a Host paraphrase of them",
  );
  assert.equal(pump.worldStateRefresh.refusals, 1);
});

test("a reading that actually moves re-arms the refresh, so one transient refusal cannot silence the run", async () => {
  // The bound stops a spin; it must not spend a run's only chance on a bridge that hiccuped. The next CROSSING - a
  // reading that outlived its bound again - asks again, and the revision that was refused is never asked about again.
  const pump = new CompanionEventPump();
  let refuse = true;
  let probes = 0;
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe(): Promise<unknown> {
        probes += 1;
        if (refuse) throw new Error("bridge_not_authenticated");
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  await deliverTurn(pump, snapshotFact(352));
  for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS + 1; turn += 1)
    await deliverTurn(pump, worldFact("time_milestone", "1200", turn));
  assert.equal(probes, 1, "the first crossing asks once");

  refuse = false;
  // The world is observed again at a new revision: that is the answer the probe was after, and the crossing it belonged
  // to is over.
  await deliverTurn(pump, snapshotFact(400, { ...STUCK_READING, revision: 400 } as Snapshot));
  for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS + 1; turn += 1)
    await deliverTurn(pump, worldFact("time_milestone", "1300", 100 + turn));
  assert.equal(probes, 2, "a new crossed reading is a new question");
});

test("a port is attached once per pump: a second attach is a wiring bug, not a policy", () => {
  const pump = new CompanionEventPump();
  const port: WorldStateRefreshPort = Object.freeze({
    observe: () => Promise.resolve(Object.freeze({})),
    publish: () => undefined,
  });
  pump.attachWorldStateRefresh(port);
  assert.throws(() => pump.attachWorldStateRefresh(port), /world_state_refresh_already_attached/u);
  assert.equal(pump.worldStateRefresh.attached, true);
});

const ASSISTANT_START = Object.freeze({ role: "assistant" as const, content: Object.freeze([]), provider: "cpa-oai" });
const textEnd = Object.freeze({
  role: "assistant" as const,
  content: Object.freeze([{ type: "text", text: "看着呢。" }]),
  stopReason: "stop",
});

/** A Pi session that answers every prompt with one spoken line, so a delivered batch settles as a real turn. */
function spokenSession() {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    prompts,
    session: {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async sendUserMessage(batch: string) {
        prompts.push(batch);
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
        emit({ type: "message_start", message: ASSISTANT_START });
        emit({ type: "message_end", message: textEnd });
        emit({ type: "agent_settled", aborted: false });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
    },
  };
}

function eventHarness() {
  let factListener: ((fact: WorldFact) => void) | undefined;
  return {
    events: {
      onFact(next: (fact: WorldFact) => void) {
        factListener = next;
        return () => {
          factListener = undefined;
        };
      },
      onLifecycle() {
        return () => undefined;
      },
    },
    emit(fact: WorldFact) {
      factListener?.(fact);
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

test("a refused refresh reaches a turn on the Host's own Host-minted-fact route", async () => {
  // The wiring the composition installs, driven through the PRODUCTION Host: `publish` is `acceptHostMintedFact` and
  // nothing else, so a refusal cannot become a second way to start a turn - and it does reach the model, with the
  // route's own reason, which is the difference between waiting out a dead bridge and reporting it.
  const adapter = eventHarness();
  const scripted = spokenSession();
  const loop = new CompanionLoop(scripted.session as never);
  const host = new CompanionHostService(loop, adapter.events as never);
  try {
    loop.pump.attachWorldStateRefresh(
      Object.freeze({
        observe: () => Promise.reject(new Error("bridge_not_authenticated")),
        publish: (fact: WorldFact) => host.acceptHostMintedFact(fact),
      }),
    );
    adapter.emit(snapshotFact(352));
    // One turn beyond the bound: the reading is a turn old when the first fact after it arrives (the snapshot rides
    // that batch), so the crossing is reached on the turn after `WORLD_STATE_STALE_TURNS`.
    for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS + 2; turn += 1) {
      adapter.emit(worldFact("time_milestone", "1200", turn));
      await settle();
    }
    const said = scripted.prompts.join("\n---\n");
    assert.match(
      said,
      /世界观察刷新被拒绝：world_state_refresh_refused:bridge_not_authenticated/u,
      "the model must be handed the refusal in words, or a dead bridge reads as a world that did not move",
    );
    assert.match(said, /world_state_stale:/u, "and the stale reading itself is still stated exactly as it was");
    assert.equal(loop.pump.worldStateRefresh.probes, 1, "one crossing, one question");
  } finally {
    host.close();
  }
});

test("the composition that installs the port is named, and what this file did not exercise is said", () => {
  // The port is attached by `createHostGameRuntimeMaterializer` where it composes the loop and the Host. Exercising THAT
  // needs a materialized Stardew session - a named-pipe bridge with a real `hello_ack` attestation, a durable runtime
  // root and a mounted Pi session - whose fixture already lives in `local-stardew-bridge-attestation.test.ts`. A second
  // copy of it here would be a second spelling of one setup, so the missing reading is named rather than faked, and the
  // judgement is left where the evidence is.
  console.log(
    "not_measured: production attach not exercised, needs one materialized Stardew session " +
      "(attested named-pipe bridge + durable runtime root) to read the attached port back off the composed Host",
  );
  const pump = new CompanionEventPump();
  assert.equal(
    pump.worldStateRefresh.attached,
    false,
    "a bare pump is unattached by construction, which is why the composition has to install one",
  );
});
