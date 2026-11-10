import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { type PresetBindingStore, createPresetBindingStore } from "./preset-binding.js";
import { createPresetStore, type PresetStore } from "./preset-store.js";

// The binding writes and deletes through the Host's path lock, whose release needs the reclaimer the runtime binds.
bindWindowsStaleLockReclaimer(createBuildWindowsStaleLockReclaimer());

/**
 * A preset small enough to read in one glance but carrying both facts the binding interacts with: an entry the
 * player can switch off (which bumps the revision, and must not disturb the binding) and a stored document the store
 * re-derives its summary from.
 */
const PRESET = Object.freeze({
  name: "Binding Fixture",
  temperature: 0.7,
  prompts: [
    { identifier: "main", name: "Main Prompt", content: "Write {{char}}'s next reply.", role: "system" },
    { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "chatHistory", enabled: true },
      ],
    },
  ],
});

type Bound = Readonly<{ root: string; presets: PresetStore; binding: PresetBindingStore }>;

async function withBinding(work: (bound: Bound) => Promise<void>): Promise<void> {
  const root = await canonicalTestRoot("preset-binding-");
  const playerRoot = join(root, "tavern", "v1", "players", "player");
  try {
    const presets = createPresetStore({ runtimeRoot: root, playerRoot });
    await work({ root, presets, binding: createPresetBindingStore({ runtimeRoot: root, playerRoot }, presets) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const bindingPath = (root: string): string => join(root, "tavern", "v1", "players", "player", "preset-binding.json");

test("a player who has bound nothing reads no binding - the file's absence, not an invented default", async () => {
  await withBinding(async ({ presets, binding }) => {
    // The store's own answer first: it holds the preset, so the absence below is about the BINDING and not about an
    // empty store.
    await presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    assert.equal(await binding.read(), null);
  });
});

test("a bound preset is still in force from a second store over the same root", async () => {
  await withBinding(async ({ root, presets, binding }) => {
    await presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    assert.deepEqual(await binding.bind("fixture"), { presetId: "fixture" });
    // A fresh reader - the next Host start - must find the same fact, which is the whole of "durable".
    const reopened = createPresetBindingStore(
      { runtimeRoot: root, playerRoot: join(root, "tavern", "v1", "players", "player") },
      presets,
    );
    assert.deepEqual(await reopened.read(), { presetId: "fixture" });
  });
});

test("binding a preset the store does not hold is refused by the store's own code and writes nothing", async () => {
  await withBinding(async ({ binding }) => {
    await assert.rejects(() => binding.bind("absent"), /preset_not_found:absent/);
    assert.equal(await binding.read(), null);
  });
});

test("the binding survives the preset's own revision bump, because it names an id and never a revision", async () => {
  await withBinding(async ({ presets, binding }) => {
    await presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await binding.bind("fixture");
    const revised = await presets.setEnabled("fixture", "main", false);
    assert.equal(revised.revision, 2);
    assert.deepEqual(await binding.read(), { presetId: "fixture" });
    // And the store still answers for that id at the revision the player left it at.
    assert.equal((await presets.read("fixture")).revision, 2);
  });
});

test("a preset deleted after being bound is still named by the binding, not silently forgotten", async () => {
  await withBinding(async ({ presets, binding }) => {
    await presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await binding.bind("fixture");
    await presets.delete("fixture");
    // The store no longer holds it; the binding still names it. The readout is what turns the difference into a fact a
    // player can act on, and it can only do that if this module keeps the name it was given.
    assert.deepEqual(await binding.read(), { presetId: "fixture" });
  });
});

test("clear answers what it removed and clears again as null", async () => {
  await withBinding(async ({ presets, binding }) => {
    await presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await binding.bind("fixture");
    assert.deepEqual(await binding.clear(), { presetId: "fixture" });
    assert.equal(await binding.read(), null);
    // Nothing bound is an ordinary state, not a refusal: clearing twice is what a player's toggle does.
    assert.equal(await binding.clear(), null);
  });
});

test("two bindings leave one id in one file, and nothing else in it", async () => {
  await withBinding(async ({ root, presets, binding }) => {
    await presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await presets.import({ presetId: "second", document: structuredClone(PRESET) });
    await binding.bind("fixture");
    await binding.bind("second");
    assert.deepEqual(await binding.read(), { presetId: "second" });
    const stored = JSON.parse(await readFile(bindingPath(root), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(stored).sort(), ["presetId", "schemaVersion"]);
    assert.equal(stored.presetId, "second");
  });
});

test("a binding file of another schema fails closed by name instead of reading as no binding", async () => {
  await withBinding(async ({ root, binding }) => {
    await mkdir(dirname(bindingPath(root)), { recursive: true });
    await writeFile(bindingPath(root), JSON.stringify({ schemaVersion: 2, presetId: "fixture" }), "utf8");
    // `null` is this module's word for "nothing was ever bound", so a file it cannot interpret must not answer `null`:
    // that would silently unbind a preset and leave the player's choice invisible.
    await assert.rejects(() => binding.read(), /invalid_preset_binding/);
    await writeFile(bindingPath(root), JSON.stringify({ schemaVersion: 1, presetId: "fixture", revision: 1 }), "utf8");
    await assert.rejects(() => binding.read(), /invalid_preset_binding/);
    await writeFile(bindingPath(root), JSON.stringify({ schemaVersion: 1, presetId: "" }), "utf8");
    await assert.rejects(() => binding.read(), /invalid_preset_binding/);
  });
});
