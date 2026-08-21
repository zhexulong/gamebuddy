import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

test("Tavern semantic references attest locked source", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["tools/verify-tavern-semantic-references.mjs"]);
  assert.match(stdout, /verified 9 Tavern semantic references and 2 fixtures/);
});
