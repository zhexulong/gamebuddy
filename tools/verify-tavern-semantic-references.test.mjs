import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { promisify } from "node:util";

// The referenced fixtures live in the separately mounted private `design/`
// repository, so a checkout without that mount skips rather than fails.
const referenceMountSkipReason = existsSync(
  new URL("../design/references/tavern/st-semantic-references-v1.json", import.meta.url),
)
  ? false
  : "requires the design/ reference mount (design/references/tavern/st-semantic-references-v1.json), which a repository checkout does not create";

test("Tavern semantic references attest locked source", { skip: referenceMountSkipReason }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["tools/verify-tavern-semantic-references.mjs"]);
  assert.match(stdout, /verified 9 Tavern semantic references and 2 fixtures/);
});
