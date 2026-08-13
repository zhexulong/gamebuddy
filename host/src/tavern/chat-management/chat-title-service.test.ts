import assert from "node:assert/strict";
import test from "node:test";
import { createChatTitleService } from "./chat-title-service.js";

test("player title service projects explicit title metadata without opaque identifiers and uses management CAS", async () => {
  const calls: unknown[] = [];
  const service = createChatTitleService(
    {
      async resumeThread(chatThreadId, chatSurfaceSessionId) {
        calls.push(["read", chatThreadId, chatSurfaceSessionId]);
        return {
          thread: { title: null, managementRevision: 10 },
          messages: [{ text: "must not be projected" }],
        } as never;
      },
      async renameThreadTitle(input) {
        calls.push(["rename", input]);
        return { title: "A quiet morning", managementRevision: 11 } as never;
      },
    },
    { chatThreadId: "opaque_thread_01", chatSurfaceSessionId: "opaque_surface_01" },
  );
  assert.deepEqual(await service.read(), { title: null, revision: 10 });
  assert.deepEqual(await service.rename({ title: " A quiet morning ", expectedRevision: 10 }), {
    title: "A quiet morning",
    revision: 11,
  });
  assert.deepEqual(calls, [
    ["read", "opaque_thread_01", "opaque_surface_01"],
    [
      "rename",
      {
        chatThreadId: "opaque_thread_01",
        chatSurfaceSessionId: "opaque_surface_01",
        expectedManagementRevision: 10,
        title: " A quiet morning ",
      },
    ],
  ]);
});
