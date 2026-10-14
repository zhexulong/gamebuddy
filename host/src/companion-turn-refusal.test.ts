import assert from "node:assert/strict";
import test from "node:test";

import { isRefusedTurnEvent, MAGIC_CONTEXT_REFUSED_TURN_ENTRY_TYPE } from "./companion-turn-refusal.js";

/** Pi's own `entry_appended` shape for `pi.appendEntry(customType, data)`. */
function entryAppended(customType: string) {
  return {
    type: "entry_appended",
    entry: {
      type: "custom",
      customType,
      data: { message: "Magic Context could not safely prepare this turn; send your message again." },
      id: "entry_01",
      parentId: null,
      timestamp: "2026-10-14T00:00:00.000Z",
    },
  };
}

test("Magic Context's own refusal entry is a refused turn", () => {
  assert.equal(isRefusedTurnEvent(entryAppended(MAGIC_CONTEXT_REFUSED_TURN_ENTRY_TYPE) as never), true);
});

test("another extension's custom entry is not a refused turn", () => {
  // Pi emits `entry_appended` for every custom entry, so the entry type is the whole discriminant.
  assert.equal(isRefusedTurnEvent(entryAppended("codemode-store") as never), false);
});

test("an ordinary Pi event is not a refused turn", () => {
  assert.equal(isRefusedTurnEvent({ type: "agent_settled", aborted: true } as never), false);
  assert.equal(isRefusedTurnEvent({ type: "message_start", message: { role: "user", content: [] } } as never), false);
});
