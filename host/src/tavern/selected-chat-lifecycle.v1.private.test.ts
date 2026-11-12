import assert from "node:assert/strict";
import test from "node:test";

import { chatLifecycleRouteEnabled, SELECTED_CHAT_LIFECYCLE_V1 } from "./selected-chat-lifecycle.v1.js";

test("selected lifecycle profile exposes only active list and archive", () => {
  assert.deepEqual(
    SELECTED_CHAT_LIFECYCLE_V1.routes.map((route) => [route.method, route.path]),
    [
      ["GET", "/chat-lifecycle"],
      ["POST", "/chat-lifecycle/archive"],
    ],
  );
  assert.equal(chatLifecycleRouteEnabled("chat-lifecycle-archive"), true);
  assert.equal(chatLifecycleRouteEnabled("chat-management-rename"), false);
});
