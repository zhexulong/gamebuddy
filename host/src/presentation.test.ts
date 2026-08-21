import assert from "node:assert/strict";
import test from "node:test";

import * as presentation from "./presentation.js";

test("presentation module does not define or export companion_text or companion_speak tools", () => {
  assert.equal("createCompanionPresentationTools" in presentation, false);
  assert.equal("companion_text" in presentation, false);
  assert.equal("companion_speak" in presentation, false);
});
