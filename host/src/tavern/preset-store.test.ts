import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { canonicalHash } from "./artifact-store.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { type PresetDocument, validatePresetDocument, withPromptEnabled } from "./preset-document.js";
import { PRESET_NAME_CHARS } from "./browser-contract/index.js";
import { createPresetStore, type PresetStore } from "./preset-store.js";

// The store writes and deletes through the Host's path lock, whose release needs the reclaimer the runtime binds.
bindWindowsStaleLockReclaimer(createBuildWindowsStaleLockReclaimer());

/**
 * A SillyTavern preset carrying the whole A4 §2.2 field set - a marker entry, an in-chat entry at `injection_depth:
 * 4`, a post-history entry, the document's sampling keys, and two keys no SillyTavern version defines. It is not the
 * gate's fixture: the gate measures the invariant at the store's real boundary, this file measures the operations a
 * caller performs and the refusals they get.
 */
const PRESET = Object.freeze({
  name: "Test Preset",
  x_author_note: "an unrecognised document key",
  temperature: 0.9,
  top_p: 0.95,
  top_k: 40,
  repetition_penalty: 1.05,
  openai_max_context: 8192,
  openai_max_tokens: 400,
  prompts: [
    {
      identifier: "main",
      name: "Main Prompt",
      content: "Write {{char}}'s next reply.",
      role: "system",
      enabled: true,
      system_prompt: true,
      marker: false,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      forbid_overrides: false,
      extension: false,
      injection_trigger: [],
    },
    { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true },
    {
      identifier: "style_reinforcement",
      name: "风格强化（深度注入）",
      content: "下一条回复请保持{{char}}的说话风格。{{random::轻微::明显}}",
      role: "user",
      enabled: true,
      system_prompt: false,
      marker: false,
      injection_position: 1,
      injection_depth: 4,
      injection_order: 100,
      forbid_overrides: true,
      extension: false,
      injection_trigger: ["normal", "swipe"],
      extensions: { "author-probe": { unknownEntryKey: true } },
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "style_reinforcement", enabled: true },
      ],
    },
  ],
});

async function withStore(work: (store: PresetStore, root: string) => Promise<void>): Promise<void> {
  const root = await canonicalTestRoot("preset-store-");
  try {
    await work(
      createPresetStore({ runtimeRoot: root, playerRoot: join(root, "tavern", "v1", "players", "player") }),
      root,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const presetPath = (root: string): string =>
  join(root, "tavern", "v1", "players", "player", "presets", "fixture", "preset.json");

test("import then export returns the document the import accepted, field for field", async () => {
  await withStore(async (store) => {
    const imported = await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    assert.equal(imported.revision, 1);
    assert.deepEqual(await store.export("fixture"), PRESET);
  });
});

test("a second import through the export changes nothing at all", async () => {
  await withStore(async (store) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    const exported = await store.export("fixture");
    await store.import({ presetId: "copy", document: exported });
    assert.deepEqual(await store.export("copy"), exported);
    assert.deepEqual(
      (await store.list()).map((summary) => summary.presetId),
      ["copy", "fixture"],
    );
  });
});

test("an entry's own unknown key and the document's unknown key survive the store", async () => {
  await withStore(async (store) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    const exported = await store.export("fixture");
    assert.equal(exported.x_author_note, "an unrecognised document key");
    const style = (exported.prompts as readonly Record<string, unknown>[]).find(
      (entry) => entry.identifier === "style_reinforcement",
    );
    assert.deepEqual(style?.extensions, { "author-probe": { unknownEntryKey: true } });
  });
});

/**
 * The Existence boundary that a normalising reader gets wrong: every one of these is falsy, and every one of them is a
 * decision its author made - `depth 0` means "after the last message", not "unset".
 */
test("falsy field values are preserved rather than treated as absent", async () => {
  const preset = {
    prompts: [
      {
        identifier: "boundary",
        name: "",
        content: "",
        role: "assistant",
        enabled: false,
        system_prompt: false,
        marker: false,
        injection_position: 1,
        injection_depth: 0,
        injection_order: 0,
        forbid_overrides: false,
        extension: false,
        injection_trigger: [],
        extensions: {},
      },
    ],
    temperature: 0,
  };
  await withStore(async (store) => {
    await store.import({ presetId: "boundary", document: structuredClone(preset) });
    const exported = await store.export("boundary");
    assert.deepEqual(exported, preset);
    const [entry] = exported.prompts as readonly Record<string, unknown>[];
    assert.equal(Object.hasOwn(entry as object, "injection_depth"), true);
    assert.equal(entry?.injection_depth, 0);
  });
});

/**
 * The published bound IS the writer's bound: a name the wire would refuse never reaches the store.
 *
 * Measured before this: the contract published `maxLength: 256` for the surface's `name` and nothing enforced it, so a
 * document with a 200-character name imported cleanly, listed cleanly, and the read's own schema check then answered
 * `preset_assembly_read_unavailable` for the WHOLE listing - one label blanking every preset the player had. Both
 * halves are asserted: a name AT the bound is stored, and one character past it is refused with its length and the
 * ceiling, before anything is written.
 */
test("a document name is stored up to the wire's own bound and refused past it by name", async () => {
  await withStore(async (store) => {
    const atBound = { ...structuredClone(PRESET), name: "N".repeat(PRESET_NAME_CHARS) };
    assert.equal(
      (await store.import({ presetId: "at-bound", document: atBound })).summary.name?.length,
      PRESET_NAME_CHARS,
      "a name the wire publishes is a name the store accepts",
    );
    await assert.rejects(
      store.import({
        presetId: "over",
        document: { ...structuredClone(PRESET), name: "N".repeat(PRESET_NAME_CHARS + 1) },
      }),
      { message: `preset_name_over_ceiling:${String(PRESET_NAME_CHARS + 1)}:${String(PRESET_NAME_CHARS)}` },
    );
    assert.deepEqual(
      (await store.list()).map((summary) => summary.presetId),
      ["at-bound"],
      "the refused document left nothing behind",
    );
  });
});

test("importing an id that is already taken is refused instead of overwriting the preset", async () => {
  await withStore(async (store) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await assert.rejects(store.import({ presetId: "fixture", document: { prompts: [] } }), {
      message: "preset_already_imported:fixture",
    });
    assert.deepEqual(await store.export("fixture"), PRESET);
  });
});

test("delete removes the preset from list and from read, and import works again afterwards", async () => {
  await withStore(async (store) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await store.delete("fixture");
    assert.deepEqual(await store.list(), []);
    await assert.rejects(store.read("fixture"), { message: "preset_not_found:fixture" });
    await assert.rejects(store.export("fixture"), { message: "preset_not_found:fixture" });
    assert.equal((await store.import({ presetId: "fixture", document: structuredClone(PRESET) })).revision, 1);
  });
});

test("delete of a preset that is not stored is refused rather than treated as success", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.delete("absent"), { message: "preset_not_found:absent" });
  });
});

test("the summary a listing reads is derived from the document: counts, markers and depth entries", async () => {
  await withStore(async (store) => {
    const record = await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    assert.deepEqual(record.summary, {
      presetId: "fixture",
      revision: 1,
      name: "Test Preset",
      promptCount: 3,
      markerIdentifiers: ["chatHistory"],
      depthInjectionIdentifiers: ["style_reinforcement"],
      promptOrderGroups: 1,
    });
    assert.deepEqual(await store.list(), [record.summary]);
  });
});

test("setEnabled switches an entry in both places SillyTavern keeps that fact, and bumps the revision", async () => {
  await withStore(async (store) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    const updated = await store.setEnabled("fixture", "main", false);
    assert.equal(updated.revision, 2);
    const exported = await store.export("fixture");
    const entries = exported.prompts as readonly Record<string, unknown>[];
    assert.equal(entries.find((entry) => entry.identifier === "main")?.enabled, false);
    const order = (exported.prompt_order as readonly Record<string, unknown>[])[0]?.order;
    assert.equal((order as readonly Record<string, unknown>[])[0]?.enabled, false);
    // Everything else is untouched: the mutation is one entry's on/off state, not a rewrite of the preset.
    assert.deepEqual(
      entries.map((entry) => Object.keys(entry).length),
      [13, 4, 14],
    );
    assert.equal(exported.temperature, 0.9);
    assert.equal((entries[1] as Record<string, unknown>).marker, true);
  });
});

test("setEnabled refuses an identifier the preset does not carry, by name", async () => {
  await withStore(async (store) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await assert.rejects(store.setEnabled("fixture", "nope", true), {
      message: "preset_prompt_not_found:nope",
    });
    await assert.rejects(store.setEnabled("fixture", "", true), { message: "invalid_preset_request" });
  });
});

test("a stored summary that no longer describes its document fails closed by name", async () => {
  await withStore(async (store, root) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    const path = presetPath(root);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.artifact.summary.promptCount = 99;
    // The envelope hash is recomputed so the file is internally consistent: the defect under test is a summary that
    // does not describe its own document, not a corrupted envelope.
    envelope.canonicalHash = canonicalHash(envelope.artifact);
    await writeFile(path, JSON.stringify(envelope), "utf8");
    await assert.rejects(store.read("fixture"), { message: "preset_summary_drift:fixture" });
  });
});

test("a structurally impossible preset is refused by naming the offending field, not 'invalid preset'", () => {
  assert.throws(() => validatePresetDocument("not a preset"), { message: "preset_document_not_an_object:preset" });
  assert.throws(() => validatePresetDocument({ prompts: {} }), { message: "preset_prompts_not_an_array:prompts" });
  assert.throws(() => validatePresetDocument({ prompts: [{}] }), {
    message: "preset_prompt_entry_missing_identifier:prompts[0].identifier",
  });
  assert.throws(() => validatePresetDocument({ prompts: [{ identifier: "a" }, { name: "no id" }] }), {
    message: "preset_prompt_entry_missing_identifier:prompts[1].identifier",
  });
  assert.throws(() => validatePresetDocument({ prompts: [{ identifier: "a" }, "entry"] }), {
    message: "preset_prompt_entry_not_an_object:prompts[1]",
  });
});

test("the validator does not reinterpret a field whose type is not what A4 documents", () => {
  // Refusing this would be this repo inventing a stricter format than the one it promises to preserve. `prompt_order`
  // is not part of the structural contract either: SillyTavern reads a preset without one.
  const document = validatePresetDocument({
    prompts: [{ identifier: "a", injection_depth: "4", marker: "yes", role: 7 }],
    prompt_order: "not an array",
  });
  assert.deepEqual(document, {
    prompts: [{ identifier: "a", injection_depth: "4", marker: "yes", role: 7 }],
    prompt_order: "not an array",
  });
});

test("withPromptEnabled leaves prompt_order alone when the preset has none", () => {
  const document = validatePresetDocument({ prompts: [{ identifier: "a", enabled: true }] });
  assert.deepEqual(withPromptEnabled(document, "a", false), { prompts: [{ identifier: "a", enabled: false }] });
});

test("an invalid or traversing preset id is refused before anything is written", async () => {
  await withStore(async (store) => {
    for (const presetId of ["", "../escape", "with space", "x".repeat(129)]) {
      await assert.rejects(store.import({ presetId, document: structuredClone(PRESET) }), {
        message: "invalid_preset_id",
      });
      await assert.rejects(store.read(presetId), { message: "invalid_preset_id" });
    }
    assert.deepEqual(await store.list(), []);
  });
});

test("an unreadable stored preset fails closed instead of listing a partial document", async () => {
  await withStore(async (store, root) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    await writeFile(presetPath(root), '{"schemaVersion":1}', "utf8");
    await assert.rejects(store.read("fixture"), { message: "invalid_preset_artifact:fixture" });
    await assert.rejects(store.list(), { message: "invalid_preset_artifact:fixture" });
  });
});

test("the exported document is the stored artifact's own, so a caller cannot mutate the store's copy", async () => {
  await withStore(async (store) => {
    await store.import({ presetId: "fixture", document: structuredClone(PRESET) });
    const exported = (await store.export("fixture")) as PresetDocument & { prompts: Record<string, unknown>[] };
    assert.equal(Object.isFrozen(exported), true);
    assert.equal(Object.isFrozen(exported.prompts), true);
    assert.equal(Object.isFrozen(exported.prompts[0]), true);
  });
});
