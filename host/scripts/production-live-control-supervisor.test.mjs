import assert from "node:assert/strict";
import test from "node:test";

import * as supervisor from "./production-live-control-supervisor.mjs";

test("arbitrary production live-control preview launch API is destructively removed", () => {
  assert.equal(Object.hasOwn(supervisor, "runProductionLiveControlPreview"), false);
  assert.equal(supervisor.PRODUCTION_LIVE_CONTROL_PREVIEW_REMOVED, "production_live_control_preview_removed");
});
