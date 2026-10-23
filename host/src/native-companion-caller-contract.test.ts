import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CHAT_PACED_DELIVERY } from "./companion-delivery-pacing.js";
import {
  attachNativeCompanionContent,
  CHAT_TRANSCRIPT_SCAFFOLDING,
  CHAT_TRANSCRIPT_STAGE_DIRECTION,
  type NativeCompanionContentEvent,
  type NativeCompanionContentSinks,
} from "./native-companion-content.js";

/**
 * A live run proved the failure this file exists to prevent: the preference said
 * `paced: true`, the deployed module contained the wiring, and not one
 * `companion.delta` frame reached the browser. The cause was not the observer -
 * it was that the production caller built the observer's options WITHOUT a turn
 * identity, so `emitReaction` returned before choosing a sound and the paced turn
 * behaved exactly like an unpaced one.
 *
 * Two halves: prove the observer really is silent without an identity (so the
 * second half is not asserting nothing), and prove the production caller passes
 * one.
 */

type Listener = (event: NativeCompanionContentEvent) => void;

function fakeSession() {
  const listeners = new Set<Listener>();
  return Object.freeze({
    session: Object.freeze({
      subscribe(listener: Listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    emit(event: NativeCompanionContentEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
  });
}

const text = (value: string) => Object.freeze({ type: "text" as const, text: value });
const assistant = (content: readonly unknown[]) =>
  Object.freeze({ role: "assistant" as const, content, stopReason: "stop", responseId: "response-1" });

async function drain(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function piecesFor(turn: Readonly<{ id: string; locale: string }> | undefined): Promise<readonly string[]> {
  const fx = fakeSession();
  const pieces: string[] = [];
  const sinks: NativeCompanionContentSinks = Object.freeze({
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value: string) => {
      pieces.push(value);
    },
    onFinalText: async () => undefined,
    onRejected: async () => undefined,
  });
  const observer = attachNativeCompanionContent(fx.session, sinks, {
    stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,
    scaffolding: CHAT_TRANSCRIPT_SCAFFOLDING,
    pacing: CHAT_PACED_DELIVERY,
    ...(turn === undefined ? {} : { turn }),
  });
  observer.open();
  observer.openPreviews();
  const partial = assistant([text("")]);
  fx.emit({ type: "message_start", message: partial });
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
  });
  const reply = "我先去看看东边那片。";
  fx.emit({
    type: "message_update",
    message: assistant([text(reply)]),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply, partial },
  });
  await drain();
  fx.emit({ type: "message_end", message: assistant([text(reply)]) });
  await drain();
  await observer.close();
  return pieces;
}

test("without a turn identity the observer says nothing before the reply", async () => {
  assert.deepEqual(await piecesFor(undefined), []);
});

test("with a turn identity the same reply is preceded by a sound", async () => {
  const pieces = await piecesFor({ id: "turn_identity_01", locale: "zh" });
  assert.ok(pieces.length > 0, "an identity is what makes the sound possible");
  assert.ok(pieces[0]!.length <= 4, `the first piece is a sound: ${JSON.stringify(pieces[0])}`);
});

/**
 * The contract the production caller has to honour. Asserted against the source
 * because the value it must supply comes from scope facts that only exist inside
 * a real coordinator scope; a unit test cannot fabricate that scope, and a
 * comment would not fail when the wiring is dropped again.
 */
test("the production provider-start caller passes the turn identity to the observer", async () => {
  // Read the SOURCE, not the compiled copy: this asserts a wiring decision in the
  // file an author edits, and the compiled path would silently pass after a
  // rebuild even if the source lost the lines.
  const source = await readFile(new URL("../src/tavern/p4-provider-start-execution.ts", import.meta.url), "utf8");
  const attach = source.slice(source.indexOf("attachNativeCompanionContent("));
  const options = attach.slice(0, attach.indexOf("nativeObserver.open())"));
  assert.match(options, /turn:\s*\{/u, "the observer options must carry a turn identity");
  assert.match(options, /id:\s*scope\.facts\.turnId/u, "the identity's id comes from the turn's own facts");
  assert.match(options, /locale:\s*pacing\.locale/u, "the locale travels with the pacing choice the caller resolved");
});
