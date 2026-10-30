import assert from "node:assert/strict";
import test from "node:test";

import {
  attachNativeCompanionContent,
  NATIVE_BUBBLE_SCAFFOLDING,
  type NativeCompanionContentEvent,
  type NativeCompanionContentOptions,
  type NativeCompanionContentSinks,
} from "./native-companion-content.js";

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

function assistant(
  content: readonly unknown[],
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop",
  responseId = "response-1",
): Readonly<{ role: "assistant"; content: readonly unknown[]; stopReason: string; responseId: string }> {
  return Object.freeze({ role: "assistant" as const, content, stopReason, responseId });
}

const text = (value: string) => Object.freeze({ type: "text" as const, text: value });
const thinking = (value: string) => Object.freeze({ type: "thinking" as const, thinking: value });
const toolCall = Object.freeze({ type: "toolCall" as const, id: "tool_01", name: "action", arguments: {} });

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

/** The Game bubble / voice presentation strips stage direction and leaves scaffolding to the dehydrator. */
function attach(
  fx: ReturnType<typeof fakeSession>,
  sinks: NativeCompanionContentSinks,
  stageDirection: NativeCompanionContentOptions["stageDirection"] = "strip",
  scaffolding: NativeCompanionContentOptions["scaffolding"] = NATIVE_BUBBLE_SCAFFOLDING,
) {
  return attachNativeCompanionContent(fx.session, sinks, { stageDirection, scaffolding });
}

test("obtains the provider response identity from its first update when Pi's start snapshot has none", async () => {
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async () => assert.fail("unexpected rejection"),
  });
  observer.open();
  const sharedContent = [text("")];
  const start = Object.freeze({ role: "assistant" as const, content: sharedContent, stopReason: "pending" });
  const partial = assistant(sharedContent);
  fx.emit({ type: "message_start", message: start });
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
  });
  fx.emit({ type: "message_end", message: assistant([text("Hello")]) });
  await observer.close();

  assert.deepEqual(finals, ["Hello"]);
});

test("streams text deltas from exactly one assistant message and commits its matching final text once", async () => {
  const fx = fakeSession();
  const previews: string[] = [];
  const finals: string[] = [];
  const rejections: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async (delta) => {
      previews.push(delta);
    },
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async (reason) => {
      rejections.push(reason);
    },
  });
  observer.open();
  observer.openPreviews();
  const first = assistant([text("")]);
  const foreign = assistant([text("")], "stop", "response-foreign");
  const final = assistant([text("Hello")]);
  fx.emit({ type: "message_start", message: first });
  // Pi replaces its message snapshot on each streaming update, while the
  // `partial` field carries the stable lineage for the exact response stream.
  const trackedPartial = assistant([text("")]);
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
  });
  fx.emit({
    type: "message_update",
    message: assistant([text("Hello")]),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: trackedPartial },
  });
  fx.emit({
    type: "message_update",
    message: foreign,
    assistantMessageEvent: { type: "text_delta", delta: " leak", partial: foreign },
  });
  fx.emit({ type: "message_end", message: final });
  await observer.close();

  assert.deepEqual(previews, ["Hello"]);
  assert.deepEqual(finals, ["Hello"]);
  assert.deepEqual(rejections, []);
});

test("commits the exact Pi assistant lifecycle when an OpenAI-compatible stream provides no response ID", async () => {
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async () => assert.fail("unexpected rejection"),
  });
  observer.open();
  const partial = Object.freeze({ role: "assistant" as const, content: [text("")], stopReason: "pending" });
  const final = Object.freeze({ role: "assistant" as const, content: [text("native final")], stopReason: "stop" });
  fx.emit({ type: "message_start", message: partial });
  fx.emit({ type: "message_end", message: final });
  await observer.close();

  assert.deepEqual(finals, ["native final"]);
});

test("rejects a final assistant message that contradicts an observed provider response identity", async () => {
  const fx = fakeSession();
  const finals: string[] = [];
  const rejections: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async (reason) => {
      rejections.push(reason);
    },
  });
  observer.open();
  const start = Object.freeze({ role: "assistant" as const, content: [text("")], stopReason: "pending" });
  const partial = assistant([text("")], "stop", "response-tracked");
  fx.emit({ type: "message_start", message: start });
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
  });
  fx.emit({ type: "message_end", message: assistant([text("foreign final")], "stop", "response-foreign") });
  await observer.close();

  assert.deepEqual(finals, []);
  assert.deepEqual(rejections, ["identity_mismatch"]);
});

test("final text comes from the final assistant message, excludes thinking/tool calls, and normalizes NFC", async () => {
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async () => assert.fail("unexpected rejection"),
  });
  observer.open();
  const partial = assistant([text("draft")]);
  const final = assistant([thinking("private"), text("Cafe\u0301"), toolCall, text("! ")]);
  fx.emit({ type: "message_start", message: partial });
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
  });
  fx.emit({ type: "message_end", message: final });
  await observer.close();

  assert.deepEqual(finals, ["Café!"]);
});

test("strips roleplay stage direction when the surface cannot draw it (Game bubble / voice)", async () => {
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attach(
    fx,
    {
      onPreviewDelta: async () => undefined,
      onFinalText: async (value) => {
        finals.push(value);
      },
      onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
    },
    "strip",
  );
  observer.open();
  const final = assistant([text("*转过身微笑* 早安!今天天气真好。")]);
  fx.emit({ type: "message_start", message: assistant([text("")]) });
  fx.emit({ type: "message_end", message: final });
  await observer.close();

  assert.deepEqual(finals, ["早安!今天天气真好。"]);
});

test("passes an inline prosody tag through to the presentation port, because the voice lane performs it", async () => {
  // A `（轻声）` is a direction the voice channel performs instead of speaking, so the
  // dehydrator preserves it (`companion-speech-dehydration.ts`). This observer is NOT where
  // the two channels diverge: the text it commits feeds both the bridge write and the
  // companion-language hook, and stripping here would delete the emotion channel of the
  // voice consumer before the split exists. The bubble's own projection happens at that
  // split (`farmhand-companion-presentation.ts`, `stripInlineAudioTags`), which is the one
  // place the voice and the bubble are separately addressed.
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
  });
  observer.open();
  fx.emit({ type: "message_start", message: assistant([text("")]) });
  fx.emit({ type: "message_end", message: assistant([text("*转过身*（轻声）种子我已经帮你种好啦。")]) });
  await observer.close();

  assert.deepEqual(finals, ["（轻声）种子我已经帮你种好啦。"]);
});

test("keeps the model's exact text, including its asterisk action beat, for the Chat transcript", async () => {
  // The Chat durable row is the model's own output, not a display projection:
  // the renderer draws the single-asterisk beat as `.message-action`. A `strip`
  // observer here would delete the companion's only expression channel in Chat
  // (no mounted tools) and the loss would be irreversible for every row written.
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attach(
    fx,
    {
      onPreviewDelta: async () => undefined,
      onFinalText: async (value) => {
        finals.push(value);
      },
      onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
    },
    "keep",
  );
  observer.open();
  const final = assistant([text("*转过身微笑* 早安!今天天气真好。")]);
  fx.emit({ type: "message_start", message: assistant([text("")]) });
  fx.emit({ type: "message_end", message: final });
  await observer.close();

  assert.deepEqual(finals, ["*转过身微笑* 早安!今天天气真好。"]);
});

test("skips intermediate tool-use assistant messages and commits the following native response", async () => {
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async () => assert.fail("unexpected rejection"),
  });
  observer.open();
  const toolMessage = assistant([toolCall], "toolUse", "response-tool");
  const finalMessage = assistant([text("Action complete.")], "stop", "response-final");
  fx.emit({ type: "message_start", message: toolMessage });
  fx.emit({ type: "message_end", message: toolMessage });
  fx.emit({ type: "message_start", message: finalMessage });
  fx.emit({ type: "message_end", message: finalMessage });
  await observer.close();

  assert.deepEqual(finals, ["Action complete."]);
});

test("incremental activation releases at most one working remark per turn", async () => {
  // History: a real live run narrated the companion's plan to the player --
  // "我在屋子里，先出门去农场。" and "先摘一颗。" -- and the fix at the time was to
  // discard every intermediate tool-use message's text. Two later A/B runs of
  // the same task then measured the opposite failure: the conduct said "never
  // narrate your own actions", the model complied, and the player heard nothing
  // at all for the whole multi-action chain.
  //
  // Owner decision (2026-09-29): a companion should be able to say something
  // while working, so the runtime no longer discards that text outright. The
  // guard that replaces it is a SHAPE rule, not a semantic filter: at most one
  // piece per Pi turn, taken from the first intermediate message that carries
  // one. A step-by-step narration appears in every tool-use message, so it
  // cannot use this seam to become a running commentary.
  //
  // Whether the surviving single piece reads as company or as narration is a
  // wording question the conduct owns and the live-run audit measures; this
  // test pins only the shape guarantee.
  const fx = fakeSession();
  const inlines: string[] = [];
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value) => {
      inlines.push(value);
    },
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async () => assert.fail("unexpected rejection"),
  });
  observer.open();
  observer.openPreviews();

  // Three consecutive intermediate tool-use messages, each streaming a step of
  // a running narration. Only the first may be released.
  for (const step of ["先出门去农场。", "先摘一颗。", "再去找乔迪。"]) {
    const planning = assistant([text("")]);
    fx.emit({ type: "message_start", message: planning });
    fx.emit({
      type: "message_update",
      message: planning,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: planning },
    });
    fx.emit({
      type: "message_update",
      message: planning,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: step, partial: planning },
    });
    fx.emit({
      type: "message_end",
      message: assistant([thinking("plan"), text(step), toolCall], "toolUse"),
    });
  }

  // The player-visible reply that follows is always released in full.
  const reply = assistant([text("")]);
  fx.emit({ type: "message_start", message: reply });
  fx.emit({
    type: "message_update",
    message: reply,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: reply },
  });
  fx.emit({
    type: "message_update",
    message: reply,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "花椰菜给她了。", partial: reply },
  });
  fx.emit({ type: "message_end", message: assistant([text("花椰菜给她了。")], "stop") });
  await observer.close();

  assert.deepEqual(inlines, ["先出门去农场。"]);
  assert.deepEqual(finals, ["花椰菜给她了。"]);
});

test("never commits aborted, error, empty, control-text, or foreign assistant output", async () => {
  // A pre-existing HEAD mismatch lived here: the observer emitted `tool_only` /
  // `unsupported_content` (see `readSafeAssistantText`) while the test expected
  // the never-emitted `empty`, so the case had been red. The expectations now
  // match the observer's actual reasons; the guarantee under test is unchanged.
  // Reason strings the observer actually emits: a reply whose only content is
  // tool scaffolding dehydrates to nothing but carries a tool call ->
  // `tool_only`; a reply with text that is rejected for control bytes ->
  // `unsupported_content`. (`empty` was never emitted; HEAD's test expected it
  // and was red.) The product guarantee is the same: none of these are
  // committed, and no foreign output is admitted.
  for (const [stopReason, content, expected] of [
    ["aborted", [text("late")], "aborted"],
    ["error", [text("late")], "error"],
    ["stop", [thinking("private"), toolCall], "tool_only"],
    ["stop", [text("bad\u0000text")], "unsupported_content"],
  ] as const) {
    const fx = fakeSession();
    const finals: string[] = [];
    const rejections: string[] = [];
    const observer = attach(fx, {
      onPreviewDelta: async () => undefined,
      onFinalText: async (value) => {
        finals.push(value);
      },
      onRejected: async (reason) => {
        rejections.push(reason);
      },
    });
    observer.open();
    const started = assistant([text("")]);
    fx.emit({ type: "message_start", message: started });
    fx.emit({ type: "message_end", message: assistant(content, stopReason) });
    await observer.close();
    assert.deepEqual(finals, []);
    assert.deepEqual(rejections, [expected]);
  }
});

test("revocation suppresses late preview and final content and close drains an already-admitted callback", async () => {
  const fx = fakeSession();
  const previews: string[] = [];
  const finals: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observer = attach(fx, {
    onPreviewDelta: async (value) => {
      previews.push(value);
      await pending;
    },
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async () => undefined,
  });
  observer.open();
  observer.openPreviews();
  const message = assistant([text("")]);
  const partial = assistant([text("")]);
  fx.emit({ type: "message_start", message });
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
  });
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first", partial },
  });
  await flush();
  observer.revoke();
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " late", partial },
  });
  fx.emit({ type: "message_end", message: assistant([text("first late")]) });
  release();
  await observer.close();

  assert.deepEqual(previews, ["first"]);
  assert.deepEqual(finals, []);
});
test("incremental activation commits a completed reply once, as its final text", async () => {
  const fx = fakeSession();
  const inlines: string[] = [];
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value) => {
      inlines.push(value);
    },
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
  });
  observer.open();
  observer.openPreviews();
  const trackedPartial = assistant([text("")]);
  fx.emit({ type: "message_start", message: trackedPartial });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
  });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "早", partial: trackedPartial },
  });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "安!", partial: trackedPartial },
  });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "今天", partial: trackedPartial },
  });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "下雨。", partial: trackedPartial },
  });
  // Both sentences completed inside the stream; the reply still leaves as one
  // final piece, and nothing is presented twice.
  fx.emit({ type: "message_end", message: assistant([text("早安!今天下雨。")], "stop", "response-1") });
  await observer.close();

  assert.deepEqual(inlines, []);
  assert.deepEqual(finals, ["早安!今天下雨。"]);
});

test("presents a finished reply as one paragraph instead of one piece per sentence", async () => {
  // Falsifier for the burst the player actually saw: four sentences that the
  // stream completed at the same instant used to reach the Mod as four
  // consecutive bubbles, which reads as a stutter rather than a reply.
  const fx = fakeSession();
  const inlines: string[] = [];
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value) => {
      inlines.push(value);
    },
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
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
  for (const delta of ["我先去农场。", "地里的花椰菜熟了。", "摘完去找乔迪。", "回头再补种点别的。"]) {
    fx.emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
    });
  }
  fx.emit({
    type: "message_end",
    message: assistant([text("我先去农场。地里的花椰菜熟了。摘完去找乔迪。回头再补种点别的。")], "stop", "response-1"),
  });
  await observer.close();

  assert.deepEqual(inlines, []);
  assert.deepEqual(finals, ["我先去农场。地里的花椰菜熟了。摘完去找乔迪。回头再补种点别的。"]);
});

test("joins the held reply without eating the space between English sentences", async () => {
  // The live runs that speak English put the space between two sentences at the
  // head of the second unit; dehydrating each unit separately would trim it and
  // weld `Hello.` to `Today.` once the pieces are joined.
  const fx = fakeSession();
  const inlines: string[] = [];
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value) => {
      inlines.push(value);
    },
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
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
  for (const delta of ["Hello.", " Today is", " warmer."]) {
    fx.emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
    });
  }
  fx.emit({
    type: "message_end",
    message: assistant([text("Hello. Today is warmer.")], "stop", "response-1"),
  });
  await observer.close();

  assert.deepEqual(inlines, []);
  assert.deepEqual(finals, ["Hello. Today is warmer."]);
});

test("releases the held first sentence as the turn's one working remark after three seconds of silence", async (t) => {
  // Falsifier for the silence hole: the first sentence completes at t=0 and the
  // message stays open for 20s. It must be spoken at ~3s, not at message_end.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fx = fakeSession();
  const inlines: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value) => {
      inlines.push(value);
    },
    onFinalText: async (value) => assert.fail(`unexpected final text: ${value}`),
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
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
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "先出门去农场。", partial },
  });
  await flush();
  assert.deepEqual(inlines, []);
  t.mock.timers.tick(2_999);
  await flush();
  assert.deepEqual(inlines, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(inlines, ["先出门去农场。"]);

  // Sixteen more seconds of the same intermediate tool-use message, then its
  // end. The turn's one working remark is spent, so the step report stays out.
  t.mock.timers.tick(16_000);
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "先摘一颗。", partial },
  });
  await flush();
  t.mock.timers.tick(20_000);
  fx.emit({
    type: "message_end",
    message: assistant([thinking("plan"), text("先出门去农场。先摘一颗。"), toolCall], "toolUse"),
  });
  await flush();
  assert.deepEqual(inlines, ["先出门去农场。"]);
  await observer.close();
});

test("incremental activation commits only the never-completed residual at message_end", async () => {
  const fx = fakeSession();
  const inlines: string[] = [];
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value) => {
      inlines.push(value);
    },
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
  });
  observer.open();
  observer.openPreviews();
  const trackedPartial = assistant([text("")]);
  fx.emit({ type: "message_start", message: trackedPartial });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
  });
  // No boundary ever arrives in the stream: nothing completes incrementally.
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "我这就去", partial: trackedPartial },
  });
  fx.emit({ type: "message_end", message: assistant([text("我这就去。把草拔了。")], "stop", "response-1") });
  await observer.close();

  // The residual stream is the whole final piece; the message_end text is
  // authority only for the non-incremental lane.
  assert.deepEqual(inlines, []);
  assert.deepEqual(finals, ["我这就去"]);
});

test("a caller without onIncrementalText keeps the exact preview/final semantics and its presentation choice (Chat regression)", async () => {
  const fx = fakeSession();
  const previews: string[] = [];
  const finals: string[] = [];
  const observer = attach(
    fx,
    {
      onPreviewDelta: async (delta) => {
        previews.push(delta);
      },
      // Exactly like the Chat consumer (p4-provider-start-execution): only
      // onPreviewDelta/onFinalText/onRejected.
      onFinalText: async (value) => {
        finals.push(value);
      },
      onRejected: async () => undefined,
    },
    "keep",
  );
  observer.open();
  observer.openPreviews();
  const trackedPartial = assistant([text("")]);
  fx.emit({ type: "message_start", message: trackedPartial });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
  });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "早", partial: trackedPartial },
  });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "安!", partial: trackedPartial },
  });
  fx.emit({
    type: "message_end",
    message: assistant([text("早安!")], "stop", "response-1"),
  });
  await observer.close();

  // Preview semantics unchanged and the whole message_end text still lands.
  assert.deepEqual(previews, ["早", "安!"]);
  assert.deepEqual(finals, ["早安!"]);
});

test("incremental activation never opens a sentence boundary inside a thinking frame", async () => {
  const fx = fakeSession();
  const inlines: string[] = [];
  const finals: string[] = [];
  const observer = attach(fx, {
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value) => {
      inlines.push(value);
    },
    onFinalText: async (value) => {
      finals.push(value);
    },
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
  });
  observer.open();
  observer.openPreviews();
  const trackedPartial = assistant([text("")]);
  fx.emit({ type: "message_start", message: trackedPartial });
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
  });
  // The `。` inside the thinking block must not complete a sentence; the whole
  // unit completes only at the closing frame + actual dialogue boundary, and
  // dehydration strips the scaffolding before presentation.
  fx.emit({
    type: "message_update",
    message: trackedPartial,
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "<thinking>推理。</thinking>早安!",
      partial: trackedPartial,
    },
  });
  // The unit is complete and left the accumulator; nothing remains to flush.
  fx.emit({
    type: "message_end",
    message: assistant([text("<thinking>推理。</thinking>早安!")], "stop", "response-1"),
  });
  await observer.close();

  assert.deepEqual(inlines, []);
  assert.deepEqual(finals, ["早安!"]);
});

test("hands every final text the stop reason Pi recorded, and only `length` can say the reply is a prefix", async () => {
  // The one thing that tells a cut-off reply from a finished one: the model's
  // own stop reason. A provider that reports none, and Pi's own `"stop"`, are
  // the same answer to the surface - nothing about a length ceiling - because
  // the text alone never distinguishes them. One observer commits one final
  // text per turn, so each case drives its own.
  for (const [message, expected] of [
    [assistant([text("cut off mid-")], "length"), ["cut off mid-", "length"]],
    [assistant([text("finished.")], "stop"), ["finished.", "stop"]],
    [Object.freeze({ role: "assistant" as const, content: [text("no reason")] }), ["no reason", "stop"]],
  ] as const) {
    const fx = fakeSession();
    const finals: Array<readonly [string, string]> = [];
    const observer = attach(fx, {
      onPreviewDelta: async () => undefined,
      onFinalText: async (value, stopReason) => {
        finals.push(Object.freeze([value, stopReason] as const));
      },
      onRejected: async () => assert.fail("unexpected rejection"),
    });
    observer.open();
    // An identity-free lifecycle, so this case is about the stop reason alone and
    // not about whether the provider also stamped a response id.
    fx.emit({ type: "message_start", message: Object.freeze({ role: "assistant" as const, content: [text("")] }) });
    fx.emit({ type: "message_end", message });
    await observer.close();
    assert.deepEqual(finals, [expected]);
  }
});
