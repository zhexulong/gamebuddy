import assert from "node:assert/strict";
import test from "node:test";

import { parseStrictBridgeJson } from "./strict-bridge-json.js";

test("strict bridge JSON accepts canonical frames and rejects duplicate decoded keys", () => {
  assert.deepEqual(parseStrictBridgeJson('{"scope":{"saveId":"save_01"},"payload":{}}'), {
    scope: { saveId: "save_01" },
    payload: {},
  });

  for (const source of [
    '{"payload":{},"payload":{}}',
    '{"payload":{"scope":1,"\\u0073cope":2}}',
    '{"scope":{"saveId":"save_01",},"payload":{}}',
  ])
    assert.throws(() => parseStrictBridgeJson(source), /invalid_strict_bridge_json/);
});
