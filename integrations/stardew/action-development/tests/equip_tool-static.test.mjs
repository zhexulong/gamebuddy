import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateEquipToolStaticDescriptor } from "../src/static-descriptor.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(directory);
const descriptor = JSON.parse(await readFile(path.join(projectDirectory, "descriptors", "equip_tool.static.json"), "utf8"));
const brief = JSON.parse(await readFile(path.join(projectDirectory, "briefs", "equip_tool.static.json"), "utf8"));

test("static equip_tool descriptor is frozen development metadata only", () => {
  assert.equal(validateEquipToolStaticDescriptor(descriptor).actionId, "equip_tool");
  assert.equal(brief.gameId, "stardew");
  assert.equal(brief.actionId, "equip_tool");
  assert.equal(brief.effect, "mutation");
  assert.match(brief.claimScope, /grants no runtime, catalog, fixture, bridge, or live-mutation capability/);
});

test("static equip_tool descriptor rejects contract drift", () => {
  assert.throws(() => validateEquipToolStaticDescriptor({ ...descriptor, developmentOnly: false }), /scope/);
  assert.throws(() => validateEquipToolStaticDescriptor({ ...descriptor, target: { ...descriptor.target, maximum: 37 } }), /target/);
  assert.throws(() => validateEquipToolStaticDescriptor({ ...descriptor, terminal: { ...descriptor.terminal, evidenceFields: ["slot", "before", "after", "expected"] } }), /terminal/);
  assert.throws(() => validateEquipToolStaticDescriptor({ ...descriptor, extra: true }), /shape/);
});
