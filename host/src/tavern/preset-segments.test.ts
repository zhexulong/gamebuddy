import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import type { MacroContext } from "./preset-macros.js";
import { type PresetBindingStore, createPresetBindingStore } from "./preset-binding.js";
import { type PresetPass, renderPresetPass } from "./preset-segments.js";
import { createPresetStore, type PresetStore } from "./preset-store.js";

bindWindowsStaleLockReclaimer(createBuildWindowsStaleLockReclaimer());

/**
 * A preset that exercises all three buckets and every way an entry can be absent from the request: a marker with a
 * source, a marker without one, a `role: "user"` entry in the prefix, an entry switched off in `prompt_order`, a
 * post-history entry spelling a macro this product declines, and two depth entries at different depths.
 */
const PRESET = Object.freeze({
  name: "Pass Fixture",
  prompts: [
    { identifier: "main", name: "Main", role: "system", content: "Write {{char}}'s next reply." },
    { identifier: "worldInfoBefore", name: "World Info (before)", marker: true, role: "system", content: "" },
    { identifier: "charDescription", name: "Character Description", marker: true, role: "system", content: "" },
    { identifier: "style", name: "Style", role: "user", content: "Keep sentences short." },
    { identifier: "chatHistory", name: "Chat History", marker: true },
    { identifier: "jailbreak", name: "Jailbreak", role: "system", content: "Stay in {{char}}'s voice. {{time}}" },
    { identifier: "inactive", name: "Switched off", role: "system", content: "Never sent." },
    {
      identifier: "directorNote",
      name: "Director note",
      role: "system",
      content: "Pace it slowly.",
      injection_position: 1,
      injection_depth: 4,
      injection_order: 100,
    },
    {
      identifier: "styleGuard",
      name: "Style guard",
      role: "user",
      content: "No purple prose.",
      injection_position: 1,
      injection_depth: 0,
      injection_order: 10,
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "style", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
        { identifier: "inactive", enabled: false },
        { identifier: "directorNote", enabled: true },
        { identifier: "styleGuard", enabled: true },
      ],
    },
  ],
});

const MACROS: MacroContext = Object.freeze({
  char: "Mira",
  user: "the player",
  description: "Mira tends the greenhouse.",
  personality: "Dry.",
  scenario: "An evening in the greenhouse.",
  persona: "A neighbour.",
  itemId: "",
});
const MARKERS: Readonly<Record<string, string>> = Object.freeze({ charDescription: "Mira tends the greenhouse." });

type Bound = Readonly<{ presets: PresetStore; binding: PresetBindingStore }>;

async function withPreset(work: (bound: Bound) => Promise<void>): Promise<void> {
  const root = await canonicalTestRoot("preset-segments-");
  try {
    const playerRoot = join(root, "tavern", "v1", "players", "player");
    const presets = createPresetStore({ runtimeRoot: root, playerRoot });
    await work({ presets, binding: createPresetBindingStore({ runtimeRoot: root, playerRoot }, presets) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const render = (bound: Bound, markers: Readonly<Record<string, string>> = MARKERS): Promise<PresetPass | null> =>
  renderPresetPass({ presets: bound.presets, binding: bound.binding, macros: MACROS, markers });

const identifiers = (segments: readonly { identifier: string }[]): readonly string[] =>
  segments.map((segment) => segment.identifier);

test("nothing bound renders nothing at all - the fact, not an empty assembly", async () => {
  await withPreset(async (bound) => {
    await bound.presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    // The store holds the preset, so the `null` below is about the BINDING and not about an empty store.
    assert.equal(await render(bound), null);
  });
});

test("the bound preset's enabled entries fill the three buckets in the preset's own order", async () => {
  await withPreset(async (bound) => {
    await bound.presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await bound.binding.bind("fixture");
    const pass = await render(bound);
    assert.ok(pass !== null);

    // Before the chatHistory cut, in prompt_order: the marker with a source is present, the marker without one is
    // NOT (it has no text to send), and the `role: "user"` entry keeps its role.
    assert.deepEqual(identifiers(pass.before), ["main", "charDescription", "style"]);
    assert.deepEqual(
      pass.before.map((segment) => segment.role),
      ["system", "system", "user"],
    );
    assert.equal(pass.before[0]!.text, "Write Mira's next reply.");
    assert.equal(pass.before[1]!.text, "Mira tends the greenhouse.");

    // After the cut: the post-history entry, rendered through the same macro table.
    assert.deepEqual(identifiers(pass.after), ["jailbreak"]);
    assert.ok(pass.after[0]!.text.startsWith("Stay in Mira's voice."), pass.after[0]!.text);

    // Inside the transcript, deepest first, each carrying its own depth and role.
    assert.deepEqual(identifiers(pass.depth), ["directorNote", "styleGuard"]);
    assert.deepEqual(
      pass.depth.map((segment) => segment.depth),
      [4, 0],
    );
    assert.deepEqual(
      pass.depth.map((segment) => segment.role),
      ["system", "user"],
    );

    assert.equal(pass.presetId, "fixture");
    assert.equal(pass.revision, 1, "the pass reports the revision the store actually holds");
  });
});

test("a switched-off entry reaches no bucket and is listed as switched off", async () => {
  await withPreset(async (bound) => {
    await bound.presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await bound.binding.bind("fixture");
    const pass = await render(bound);
    assert.ok(pass !== null);
    assert.deepEqual(pass.disabled, ["inactive"]);
    for (const segment of [...pass.before, ...pass.after, ...pass.depth])
      assert.notEqual(segment.identifier, "inactive", "a switched-off entry must not be rendered anywhere");
    assert.ok(!pass.before.some((segment) => segment.text.includes("Never sent.")));
  });
});

test("a marker with no source is named and contributes nothing, and one with a source is sent in its slot", async () => {
  await withPreset(async (bound) => {
    await bound.presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await bound.binding.bind("fixture");
    const pass = await render(bound);
    assert.ok(pass !== null);
    assert.deepEqual(pass.unfilled, ["worldInfoBefore"]);
    assert.ok(!identifiers(pass.before).includes("worldInfoBefore"));

    // The slot is a SLOT: the same preset with the world book supplied sends it, at the position the marker holds.
    const filled = await render(bound, { ...MARKERS, worldInfoBefore: "A bound world book." });
    assert.ok(filled !== null);
    assert.deepEqual(identifiers(filled.before), ["main", "worldInfoBefore", "charDescription", "style"]);
    assert.deepEqual(filled.unfilled, []);
    assert.equal(filled.before[1]!.text, "A bound world book.");
  });
});

test("a macro the rendered text leaves unresolved is named with the entry that spells it", async () => {
  await withPreset(async (bound) => {
    await bound.presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await bound.binding.bind("fixture");
    const pass = await render(bound);
    assert.ok(pass !== null);
    // The population is what the request carries: the tail entry spells `{{time}}`, which this product declines.
    assert.ok(pass.after[0]!.text.includes("{{time}}"), pass.after[0]!.text);
    assert.deepEqual(pass.unresolved, [{ name: "time", entries: ["jailbreak"] }]);
  });
});

test("the prefix hash is content-addressed: two renders agree, and the preset's own edit moves it", async () => {
  await withPreset(async (bound) => {
    await bound.presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await bound.binding.bind("fixture");
    const first = await render(bound);
    const second = await render(bound);
    assert.ok(first !== null && second !== null);
    assert.equal(first.prefixHash, second.prefixHash, "the same preset must render the same prefix on every pass");
    assert.match(first.prefixHash, /^[0-9a-f]{64}$/u);

    // Switching the `style` entry off changes the prefix bytes, so the hash must move with them - a hash that ignored
    // the content would be a number nobody could act on.
    await bound.presets.setEnabled("fixture", "style", false);
    const edited = await render(bound);
    assert.ok(edited !== null);
    assert.notEqual(edited.prefixHash, first.prefixHash);
    assert.deepEqual(identifiers(edited.before), ["main", "charDescription"]);
    assert.equal(edited.revision, 2, "the pass reports the revision the edit produced");
  });
});

test("a binding whose preset is gone fails closed by the store's own code, never as 'nothing bound'", async () => {
  await withPreset(async (bound) => {
    await bound.presets.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await bound.binding.bind("fixture");
    await bound.presets.delete("fixture");
    // `null` would render an unassembled request while the player believes a preset is in force; the store's own
    // refusal names the id instead.
    await assert.rejects(() => render(bound), /preset_not_found:fixture/);
  });
});
