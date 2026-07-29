import assert from "node:assert/strict";
import test from "node:test";

import { describePhase0Host, PHASE_0_HOST_NAME } from "./phase0.js";

test("Phase 0 host is intentionally a dependency-free scaffold", () => {
  assert.equal(PHASE_0_HOST_NAME, "gamebuddy-companion-host");
  assert.equal(describePhase0Host(), "gamebuddy-companion-host: scaffold only");
});
