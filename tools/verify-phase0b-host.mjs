import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCompanionRuntime,
  PHASE_0B_ALLOWED_TOOL_NAMES,
} from "../host/dist/runtime.js";

const root = await mkdtemp(join(tmpdir(), "gamebuddy-phase0b-smoke-"));
const identity = {
  playerId: "phase0b_player",
  saveId: "phase0b_save",
  worldId: "phase0b_world",
  companionId: "phase0b_companion",
};

try {
  const runtime = await createCompanionRuntime(identity, root);
  try {
    assert.deepEqual(runtime.session.agent.state.tools.map((tool) => tool.name), PHASE_0B_ALLOWED_TOOL_NAMES);
    assert.equal(runtime.extensions.length, 1);
    assert.match(runtime.extensions[0], /pi-magic-context/);
  } finally {
    runtime.session.dispose();
  }
  console.log("GameBuddy Phase 0B Host isolation smoke passed.");
} finally {
  // Node's experimental SQLite handle can release asynchronously on Windows.
  // Cleanup must not turn a passed isolation smoke into a false failure.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 0 });
      break;
    } catch (error) {
      if (attempt === 9) {
        console.warn(`Could not remove temporary Phase 0B smoke data: ${root} (${error.code ?? error})`);
      } else {
        await delay(250);
      }
    }
  }
}
