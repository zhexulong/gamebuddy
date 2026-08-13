import assert from "node:assert/strict";
import test from "node:test";
import { SELECTED_L3_V1, selectedL3BootstrapModel, selectedL3RouteEnabled } from "./selected-l3.v1.js";

test("selected L3 v1 makes its versioned route and navigation model authoritative", () => {
  const model = selectedL3BootstrapModel();
  assert.deepEqual(model.profile, { schemaVersion: 1, id: "selected_l3_v1" });
  assert.deepEqual(
    model.navigation.map((item) => item.routeId),
    ["library", "manage-chats", "new-companion", "new-chat-selections", "worldbook-read", "imports"],
  );
  assert.ok(SELECTED_L3_V1.routes.every((route) => SELECTED_L3_V1.flows.includes(route.flow)));
  assert.ok(SELECTED_L3_V1.navigation.every((item) => selectedL3RouteEnabled(item.routeId)));
  assert.equal(selectedL3RouteEnabled("worldbook-read"), true);
  assert.equal(selectedL3RouteEnabled("worldbook-bind"), true);
  assert.equal(selectedL3RouteEnabled("response-regenerate"), false);
  assert.equal(selectedL3RouteEnabled("group-chat"), false);
});
