import assert from "node:assert/strict";
import test from "node:test";

import { attachNativeCompanionContent, type NativeCompanionContentEvent } from "./native-companion-content.js";

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

test("obtains the provider response identity from its first update when Pi's start snapshot has none", async () => {
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attachNativeCompanionContent(fx.session, {
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
  const observer = attachNativeCompanionContent(fx.session, {
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
  const observer = attachNativeCompanionContent(fx.session, {
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
  const observer = attachNativeCompanionContent(fx.session, {
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
  const observer = attachNativeCompanionContent(fx.session, {
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

test("skips intermediate tool-use assistant messages and commits the following native response", async () => {
  const fx = fakeSession();
  const finals: string[] = [];
  const observer = attachNativeCompanionContent(fx.session, {
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

test("never commits aborted, error, empty, control-text, or foreign assistant output", async () => {
  for (const [stopReason, content, expected] of [
    ["aborted", [text("late")], "aborted"],
    ["error", [text("late")], "error"],
    ["stop", [thinking("private"), toolCall], "empty"],
    ["stop", [text("bad\u0000text")], "empty"],
  ] as const) {
    const fx = fakeSession();
    const finals: string[] = [];
    const rejections: string[] = [];
    const observer = attachNativeCompanionContent(fx.session, {
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
  const observer = attachNativeCompanionContent(fx.session, {
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
