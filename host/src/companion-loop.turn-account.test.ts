import assert from "node:assert/strict";
import test from "node:test";
import { CompanionLoop } from "./companion-loop.js";
import { programSettledDigest } from "./program-settlement-digest.js";
import { FACT_PRODUCER, turnAccountLine } from "./event-pump.js";

/**
 * THE ACCOUNT IS PRINTED AT THE DECISION, AND ONLY FOR A TURN THE PUMP OPENED.
 *
 * <p>
 * The defect these cases exist for, measured on a live run: `.tmp/lane-roundw2.md` §9 - a 90 706 ms attached
 * window whose entry stderr carried `BODY_PROGRAM_MOUNT mounted:true` and
 * `NATIVE_COMPANION_TURN_DELIVERY {textParts:1, presented:1, bubbles:1, lease:{admitted:true},
 * carried:["snapshot","world_fact"]}` and **no** `GAME_TURN_ACCOUNT` line. A batch exists only on the pump's opened
 * branch, so a turn was opened, delivered and presented, and the account said nothing about it.
 * </p>
 * <p>
 * The line was derived from `turnAccount.lastDecision` *after* the delivery, and the pump clears that field on every
 * path that answers a second call `held`. The live run is narrower than the class, and worth writing down: its STOP
 * cleared the pump (`abortAndClear`) while the turn it had just counted was still in flight, so the turn settled into a
 * pump that no longer held it and the report found no decision. The account is the run's only proof that "fewer turns"
 * is not "lost turns", so it has to come from the decision itself, at the moment the turn opens.
 */
function settledDigest(programId: string) {
  const digest = programSettledDigest({
    programId,
    settledAtMs: 4_242,
    compiled: [
      {
        nodeId: "n01",
        actionId: "move_to_tile",
        arguments: { x: { type: "integer", canonicalValue: "5" }, y: { type: "integer", canonicalValue: "8" } },
      },
    ],
    status: {
      code: "found",
      snapshot: {
        programId,
        state: "succeeded",
        catalogRevision: 3,
        stopEpoch: 0,
        eventHighWater: 90,
        nodes: [{ nodeId: "n01", state: "succeeded" }],
      },
    },
    nowMs: 7,
  });
  assert.notEqual(digest, undefined, "the settled digest must exist for this case to mean anything");
  return digest!;
}

type SessionEvent = {
  type: string;
  messages?: readonly unknown[];
  message?: unknown;
  assistantMessageEvent?: unknown;
  aborted?: boolean;
};

/**
 * A Pi session that answers one batch with one assistant message saying `text`, holding the answer until `release`.
 *
 * `delivering` resolves the instant the batch reached the session, which is what lets a case act on the pump *while*
 * the turn is in flight - the window in which the account used to lose its decision.
 */
function gatedSession(text: string, gate: { delivering: () => void; waited: Promise<void> }) {
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async sendUserMessage(batch: string) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
      gate.delivering();
      await gate.waited;
      const snapshot = { id: "assistant_settlement", role: "assistant", content: [], stopReason: "pending" };
      emit({ type: "message_start", message: snapshot });
      emit({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: snapshot },
      });
      emit({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: snapshot },
      });
      emit({
        type: "message_end",
        message: {
          id: "assistant_settlement",
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
        },
      });
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: SessionEvent) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
}

/** The turn observer that lets the run's words reach the surface, so the account's delivery halves are measured too. */
const presentingObserver = Object.freeze({
  beginPlayerBatch() {},
  endBatch() {},
  async presentNativeAssistantContent() {},
});

/** Every `GAME_TURN_ACCOUNT` line `run` printed to stderr. */
async function accountLines(run: () => Promise<void>): Promise<readonly string[]> {
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = stderrWrite;
  }
  return printed.split("\n").filter((entry) => entry.startsWith("GAME_TURN_ACCOUNT "));
}

test("a turn that opened prints its account even when a second flush is held while it is in flight", async () => {
  let delivering = (): void => {};
  const inFlight = new Promise<void>((resolve) => {
    delivering = resolve;
  });
  let release = (): void => {};
  const gate = {
    delivering,
    waited: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const loop = new CompanionLoop(gatedSession("地浇完了。", gate) as never, presentingObserver);
  loop.pump.enqueueFact(settledDigest("plan_turn_account"), FACT_PRODUCER.adapterIngress);
  const lines = await accountLines(async () => {
    const flushing = loop.flush();
    await inFlight;
    // THE PUMP'S OWN CONTRACT, exercised while the turn it opened is still running: a delivery already in flight is
    // the same turn, not another one, and the answer is `held` - which clears the previous decision so a caller cannot
    // read a hold as this flush's answer.
    const second = await loop.pump.flush({ deliver: async () => "completed" });
    assert.equal(second.kind, "held", "the second call is a hold, not a turn");
    release();
    await flushing;
  });

  assert.equal(
    lines.length,
    1,
    `the opened turn's account was not printed; the pump's own delivery record was: ${turnAccountLine(loop.pump.turnAccount)}`,
  );
  const line = lines[0]!;
  assert.match(line, /turns opened 1 \{player_input: 0, world_fact: 1 \{adapter_ingress: 1\}, due: 0\}/u);
  assert.equal(
    loop.pump.turnAccount.opened,
    1,
    "and the number the line carries is the pump's own count of opened turns, not a second reading of it",
  );
});

test("a turn that opened prints its account even when its delivery never reached the model", async () => {
  const loop = new CompanionLoop(
    {
      async sendUserMessage() {
        throw new Error("pi_delivery_rejected");
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe() {
        return () => {};
      },
    } as never,
    presentingObserver,
  );
  loop.pump.enqueueFact(settledDigest("plan_turn_account_rejected"), FACT_PRODUCER.adapterIngress);
  const lines = await accountLines(async () => {
    await assert.rejects(loop.flush(), /pi_delivery_rejected/u);
  });

  assert.equal(
    lines.length,
    1,
    "a turn the pump opened is a decision the run paid for, whatever its delivery then did: a silent account cannot tell that from a run that opened nothing",
  );
  assert.match(lines[0]!, /turns opened 1 \{player_input: 0, world_fact: 1 \{adapter_ingress: 1\}, due: 0\}/u);
});

test("a STOP that clears the pump while a turn is in flight does not take that turn's account with it", async () => {
  // THE LIVE RUN'S OWN SHAPE, reproduced: `host-service` `#interrupt` clears the pump synchronously when STOP is admitted
  // (`abortAndClear`, `pump.clear()`), while the turn it counted is still running, and only then waits for that turn.
  // Everything the account was holding - `opened`, the opener histogram, `lastDecision` - is gone before the delivery
  // returns, which is why a run whose window ended in its own STOP printed no account for the turn it had opened.
  let delivering = (): void => {};
  const inFlight = new Promise<void>((resolve) => {
    delivering = resolve;
  });
  let release = (): void => {};
  const gate = {
    delivering,
    waited: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const loop = new CompanionLoop(gatedSession("我回来了。", gate) as never, presentingObserver);
  loop.pump.enqueueFact(settledDigest("plan_turn_account_stopped"), FACT_PRODUCER.adapterIngress);
  const lines = await accountLines(async () => {
    const flushing = loop.flush();
    await inFlight;
    // Not awaited yet: the STOP's own barrier is this turn, so awaiting it here would wait for the release below.
    const stopping = loop.abortAndClear();
    assert.equal(
      loop.pump.turnAccount.opened,
      0,
      "the premise: the STOP's clear runs while the turn is in flight, so the pump no longer holds the turn it counted",
    );
    release();
    await stopping;
    await flushing;
  });

  assert.equal(
    lines.length,
    1,
    `the turn was opened before the STOP and its account had to be printed then: ${JSON.stringify(lines)}`,
  );
  assert.match(lines[0]!, /turns opened 1 \{player_input: 0, world_fact: 1 \{adapter_ingress: 1\}, due: 0\}/u);
});

test("a flush that owes no turn prints no account line at all", async () => {
  const loop = new CompanionLoop(gatedSession("不该说话。", { delivering() {}, waited: Promise.resolve() }) as never);
  const lines = await accountLines(async () => {
    await loop.flush();
  });

  assert.deepEqual(lines, [], `a call that owed no turn is not a decision the run paid for: ${JSON.stringify(lines)}`);
  assert.equal(loop.pump.turnAccount.opened, 0, "and it opened nothing to report");
});
