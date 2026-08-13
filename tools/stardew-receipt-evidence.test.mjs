import assert from "node:assert/strict";
import test from "node:test";
import { hasMatchingEquipToolEvidence } from "./lib/stardew-receipt-evidence.mjs";

test("equip evidence requires matching expected and after values", () => {
  assert.equal(hasMatchingEquipToolEvidence("slot=1;before=(W) Hoe;expected=(W) Axe;after=(W) Axe"), true);
  assert.equal(hasMatchingEquipToolEvidence("after=(W) Axe;slot=1;expected=(W) Axe;before=(W) Hoe"), true);
  assert.equal(hasMatchingEquipToolEvidence("slot=1;before=(W) Hoe;expected=(W) Axe;after=(W) Hoe"), false);
  assert.equal(hasMatchingEquipToolEvidence("slot=1;before=(W) Hoe;expected=(W) Axe"), false);
  assert.equal(hasMatchingEquipToolEvidence("before=Axe;expected=Axe;after=Axe;after=Axe"), false);
});
