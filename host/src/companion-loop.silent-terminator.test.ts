import assert from "node:assert/strict";
import test from "node:test";

import { companionArrivalFact } from "./companion-arrival-fact.js";
import { CompanionLoop, silentTerminatorReason } from "./companion-loop.js";
import { FACT_PRODUCER, TURN_OPENING, type TurnOpening, turnAccountLine } from "./event-pump.js";
import { createExpressionTurnGate, EXPRESSION_ONLY_TOOL_NAMES } from "./expression-turn-gate.js";

/**
 * A SILENT TERMINATOR DOES NOT SPEAK, and a turn the PLAYER opened always does.
 *
 * <p>
 * THE MEASUREMENT THIS GATE IS BUILT FROM (`round78`, 2026-11-19: 32 consumed batches, 88 assistant rounds):
 * `tool rounds 62 · with text 0` and `no-tool rounds 26 · with text 25 · chars 322` - every line she wrote sat in a round
 * of its own AFTER the last tool result, and 21 of those 25 were narration. So the gesture is the one channel that never
 * writes prose, and it is what ends a turn the world opened.
 * </p>
 * <p>
 * THE POPULATION IS THE DECLARATION, NOT A LIST: every tool name derived from `EXPRESSION_ONLY_ACTION_IDS` is driven
 * through both openers, so a third expression action is examined here the day it is declared. The property is the guard
 * the whole rule is judged on - a world-opened turn presents ZERO text and accounts the swallow BY NAME, and a
 * player-opened turn with the same shape presents its line, because an answer to the person is the product.
 * </p>
 * <p>
 * FALSIFIER: the two drives are the same shape (one expression call, one sentence after it) and differ only in the opener,
 * so a rule that swallowed both would fail the player-opened case by name and a rule that swallowed neither would fail the
 * world-opened one.
 * </p>
 */

/** A real Mod snapshot payload, reduced to the clock and place the arrival fact reads. */
const SNAPSHOT_PAYLOAD = Object.freeze({
  revision: 1,
  presentationLocale: "zh-CN",
  timeOfDay: 610,
  dayOfMonth: 4,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  location: "Farm",
});

/** The line she writes when nothing ends her turn - round78's own most common shape, a bracketed stage direction. */
const NARRATION = "（往北出农场）";

type Emit = (event: unknown) => void;

const textPart = (value: string) => Object.freeze({ type: "text" as const, text: value });
const toolPart = (name: string) => Object.freeze({ type: "toolCall" as const, id: "call_01", name, arguments: {} });
const assistant = (content: readonly unknown[], stopReason: "stop" | "toolUse") =>
  Object.freeze({ role: "assistant" as const, content, stopReason, responseId: "response-1" });

/**
 * One turn as Pi streams it: the batch is consumed, the model calls ONE expression tool, the tool returns, the model then
 * writes the line a no-tool round produces, and the run settles.
 *
 * <p>
 * The tool result is the moment the gate is read, because that is the moment the tool mints its result - so the reading
 * recorded here is the answer the mounted tool would have received, taken from the real boundary rather than restated.
 * </p>
 */
function expressionTurnSession(toolName: string, gateReadings: boolean[], gate: { worldOpened: boolean }) {
  const listeners = new Set<Emit>();
  const emit: Emit = (event) => {
    for (const listener of [...listeners]) listener(event);
  };
  const stream = (parts: readonly string[], final: ReturnType<typeof assistant>) => {
    const start = assistant([], final.stopReason);
    emit({ type: "message_start", message: start });
    parts.forEach((part, index) => {
      emit({
        type: "message_update",
        message: start,
        assistantMessageEvent: { type: "text_start", contentIndex: index, partial: start },
      });
      emit({
        type: "message_update",
        message: start,
        assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: part, partial: start },
      });
    });
    emit({ type: "message_end", message: final });
  };
  return Object.freeze({
    async sendUserMessage(batch: string): Promise<void> {
      emit({ type: "message_start", message: { role: "user", content: [textPart(batch)] } });
      const call = assistant([toolPart(toolName)], "toolUse");
      emit({ type: "message_start", message: call });
      emit({ type: "message_end", message: call });
      gateReadings.push(gate.worldOpened);
      emit({ type: "tool_execution_start", toolCallId: "call_01", toolName, args: {} });
      emit({ type: "tool_execution_end", toolCallId: "call_01", toolName, result: { content: [] }, isError: false });
      stream([NARRATION], assistant([textPart(NARRATION)], "stop"));
      emit({ type: "agent_settled", aborted: false });
    },
    async abort(): Promise<void> {},
    clearQueue(): void {},
    async waitForIdle(): Promise<void> {},
    subscribe(listener: Emit): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

type Driven = Readonly<{
  opener: TurnOpening;
  tool: string;
  presented: readonly string[];
  gateReadings: readonly boolean[];
  delivery: unknown;
  account: string;
}>;

/** Open one turn with the given opener and hand the loop the same shape in both cases. */
async function drive(opener: TurnOpening, toolName: string): Promise<Driven> {
  const presented: string[] = [];
  const gateReadings: boolean[] = [];
  const gate = createExpressionTurnGate();
  const loop = new CompanionLoop(expressionTurnSession(toolName, gateReadings, gate) as never, {
    beginPlayerBatch(): void {},
    endBatch(): void {},
    async presentNativeAssistantContent(content): Promise<void> {
      if (content.text.length > 0) presented.push(content.text);
    },
  });
  loop.attachExpressionTurnGate(gate);
  if (opener === TURN_OPENING.playerInput)
    loop.pump.enqueuePlayerInput({
      source: "player_text",
      inputId: "input_01",
      eventId: "player_source_01",
      text: "早。",
      locale: "zh-CN",
      timestampMs: 1,
    });
  else loop.pump.enqueueFact(companionArrivalFact(SNAPSHOT_PAYLOAD)!, FACT_PRODUCER.companionArrival);
  await loop.flush();
  return Object.freeze({
    opener,
    tool: toolName,
    presented: Object.freeze([...presented]),
    gateReadings: Object.freeze([...gateReadings]),
    delivery: loop.lastTurnDelivery,
    account: turnAccountLine(loop.pump.turnAccount),
  });
}

test("a_silent_terminator_does_not_speak: world-opened swallows the line by name, player-opened delivers it", async () => {
  const expressionTools = [...EXPRESSION_ONLY_TOOL_NAMES].sort();
  // A GATE WITH NO POPULATION AGREES WITH ITSELF. The expression set is a declaration, so an empty one is blocked here
  // rather than passing as "nothing to check".
  assert.ok(
    expressionTools.length > 0,
    "the expression declaration produced no tool names, so this gate would examine nothing",
  );
  const worldOpenedOpeners = TURN_OPENING.worldFact;
  const findings: string[] = [];
  const driven: Driven[] = [];
  for (const tool of expressionTools) {
    driven.push(await drive(worldOpenedOpeners, tool));
    driven.push(await drive(TURN_OPENING.playerInput, tool));
  }
  let worldOpened = 0;
  let swallowed = 0;
  let playerOpened = 0;
  let presented = 0;
  for (const turn of driven) {
    // THE GATE ITSELF, read at the moment the tool minted its result: a world-opened turn must have opened it, and a
    // turn the person opened must have left it closed - which is what makes the tool result carry no hint at all.
    const expectedGate = turn.opener !== TURN_OPENING.playerInput;
    if (turn.gateReadings.length !== 1 || turn.gateReadings[0] !== expectedGate)
      findings.push(
        `expression_gate_read_wrong:${turn.tool}:${turn.opener}:expected=${String(expectedGate)};read=${JSON.stringify(turn.gateReadings)}`,
      );
    if (turn.opener === TURN_OPENING.playerInput) {
      playerOpened += 1;
      if (turn.presented.length > 0) presented += 1;
      else
        findings.push(
          `player_opened_turn_was_swallowed:${turn.tool}:${turn.opener}:the person was owed an answer and the turn presented nothing`,
        );
      if (turn.account.includes(silentTerminatorReason(TURN_OPENING.playerInput)))
        findings.push(`player_opened_turn_counted_as_swallowed:${turn.tool}:${turn.account}`);
      continue;
    }
    worldOpened += 1;
    const reason = silentTerminatorReason(turn.opener);
    const delivery = turn.delivery as { delivered?: number; reason?: string } | undefined;
    if (turn.presented.length === 0 && delivery?.delivered === 0 && delivery.reason === reason) {
      swallowed += 1;
      if (!turn.account.includes(`${reason}: 1`))
        findings.push(
          `world_opened_swallow_not_accounted:${turn.tool}:${turn.opener}:the account does not name ${reason}:1`,
        );
      continue;
    }
    findings.push(
      `world_opened_turn_presented_text:${turn.tool}:${turn.opener}:presented=${JSON.stringify(turn.presented)};delivery=${JSON.stringify(turn.delivery)}`,
    );
  }
  const line = `turns examined ${String(driven.length)} · world-opened ${String(worldOpened)} · swallowed ${String(swallowed)} · player-opened ${String(playerOpened)} · presented ${String(presented)}`;
  process.stderr.write(`${line}\n`);
  assert.deepEqual(findings, [], `${line}\n${findings.join("\n")}`);
  assert.equal(swallowed, worldOpened, `${line}: every world-opened turn with only an expression call must be swallowed`);
  assert.equal(presented, playerOpened, `${line}: every player-opened turn with the same shape must be presented`);
});
