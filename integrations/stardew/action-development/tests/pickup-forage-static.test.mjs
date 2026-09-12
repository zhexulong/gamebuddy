import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validatePickupForageStaticDescriptor } from "../src/static-descriptor.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(directory);
const descriptor = JSON.parse(await readFile(path.join(projectDirectory, "descriptors", "pickup_forage.static.json"), "utf8"));
const brief = JSON.parse(await readFile(path.join(projectDirectory, "briefs", "pickup_forage.static.json"), "utf8"));

test("pickup_forage static descriptor freezes required sceneTarget and existing args", () => {
  assert.equal(validatePickupForageStaticDescriptor(descriptor).actionId, "pickup_forage");
  assert.equal(brief.actionId, "pickup_forage");
  assert.equal(brief.contractVersion, 2);
});

test("pickup_forage descriptor rejects optional sceneTarget and argument drift", () => {
  assert.throws(() => validatePickupForageStaticDescriptor({ ...descriptor, target: { ...descriptor.target, required: false } }), /target/);
  assert.throws(() => validatePickupForageStaticDescriptor({ ...descriptor, arguments: { requiredProperties: ["x", "y"] } }), /arguments/);
});
