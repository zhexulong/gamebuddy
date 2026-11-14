import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { __gamebuddyReadPresetSegments, publishGameBuddyPresetSegments } from "@cortexkit/pi-magic-context/tavern";

import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import type { IdentityProfile } from "../identity-profile.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { createPresetAssemblyRead } from "./preset-assembly-read.js";
import { createPresetBindingStore, type PresetBindingStore } from "./preset-binding.js";
import type { MacroContext } from "./preset-macros.js";
import {
  PRESET_UNFILLED_MARKERS_PREFIX,
  PRESET_UNRESOLVED_MACROS_PREFIX,
  boundPresetSampling,
  presetRequestMacros,
  publishPresetRequestSegments,
} from "./preset-request-segments.js";
import { createPresetStore, type PresetStore } from "./preset-store.js";
import { mergeModelProviderEntry, type PiProviderEntry } from "./pi-provider-store.js";
import { type PresetSamplingValues, withPresetSampling } from "./preset-sampling.js";
import type { Scenario, UserPersona } from "./types.js";

bindWindowsStaleLockReclaimer(createBuildWindowsStaleLockReclaimer());

/**
 * One preset whose three buckets each carry a string nothing else in this file spells, so a body that contains it is
 * a body the preset reached - and one that does not is a body it did not. `temperature` and `top_p` are the sampler
 * half, distinct from any default so a composed model carrying them is a model the preset reached.
 */
const PRESET = Object.freeze({
  name: "Request Fixture",
  temperature: 0.42,
  top_p: 0.93,
  prompts: [
    { identifier: "main", name: "Main", role: "system", content: "PREFIX-SENTINEL-9f3a {{char}}" },
    { identifier: "worldInfoBefore", name: "World Info (before)", marker: true, role: "system", content: "" },
    { identifier: "chatHistory", name: "Chat History", marker: true },
    { identifier: "jailbreak", name: "Jailbreak", role: "system", content: "TAIL-SENTINEL-4c71 {{time}}" },
    {
      identifier: "directorNote",
      name: "Director note",
      role: "system",
      content: "DEPTH-SENTINEL-2b8e",
      injection_position: 1,
      injection_depth: 2,
      injection_order: 10,
    },
    {
      identifier: "styleGuard",
      name: "Style guard",
      role: "user",
      content: "DEPTH-TAIL-SENTINEL-77d0",
      injection_position: 1,
      injection_depth: 0,
      injection_order: 20,
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
        { identifier: "directorNote", enabled: true },
        { identifier: "styleGuard", enabled: true },
      ],
    },
  ],
});

const MODEL_ID = "request-fixture-model";

/** The companion these requests render for: a card that wrote all three of its own fields. */
const PROFILE: IdentityProfile = Object.freeze({
  schemaVersion: 1,
  profileId: "lane-macros.companion",
  revision: 1,
  identity: Object.freeze({
    name: "Mira",
    role: "the player's companion",
    continuity: "Keep one continuous shared experience with the player.",
  }),
  persona: Object.freeze({
    core: "DESCRIPTION-SENTINEL-1a2b. Keeps a lighthouse nobody visits.",
    interactionStyle: "PERSONALITY-SENTINEL-3c4d. Blunt, and kind about it.",
    expressionStyle: "Short spoken turns.",
  }),
});

/** The player's persona a chat bound: A4 §7.2's `{{user}}` is this name and `{{persona}}` its description. */
const PLAYER_PERSONA: UserPersona = Object.freeze({
  schemaVersion: 1,
  personaId: "lane-macros.player",
  revision: 1,
  name: "USER-SENTINEL-5e6f",
  description: "PERSONA-SENTINEL-7a8b, who keeps the lighthouse too.",
});

/** The scenario a chat bound: A4 §7.2's `{{scenario}}`. */
const BOUND_SCENARIO: Scenario = Object.freeze({
  schemaVersion: 1,
  scenarioId: "lane-macros.scenario",
  revision: 1,
  text: "SCENARIO-SENTINEL-9c0d, {{char}} and {{user}} on a grey morning.",
  provenance: "imported",
  owner: "companion_default",
});

/**
 * One preset whose Main entry spells exactly the five macros A4 §7.2 calls load-bearing, each wrapped in brackets so a
 * rendered value and an absent one read differently in one assertion.
 */
const MACRO_PRESET = Object.freeze({
  name: "Macro Fixture",
  prompts: [
    {
      identifier: "main",
      name: "Main",
      role: "system",
      content: "[{{char}}|{{user}}|{{description}}|{{personality}}|{{scenario}}|{{persona}}]",
    },
    { identifier: "chatHistory", name: "Chat History", marker: true },
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

type Bound = Readonly<{
  root: string;
  projectDir: string;
  presets: PresetStore;
  binding: PresetBindingStore;
}>;

async function withBoundPreset(
  work: (bound: Bound) => Promise<void>,
  bound = true,
  document: unknown = PRESET,
): Promise<void> {
  const root = await canonicalTestRoot("preset-request-");
  try {
    const playerRoot = join(root, "tavern", "v1", "players", "player");
    const presets = createPresetStore({ runtimeRoot: root, playerRoot });
    await presets.import({ presetId: "fixture", document });
    // A second stored preset that is never bound: it is what makes "only the preset in force has a composed model"
    // observable, because the runtime composes `models.json` from the bound one and from nothing else.
    await presets.import({ presetId: "other", document: { ...PRESET, name: "Other", temperature: 0.77 } });
    const binding = createPresetBindingStore({ runtimeRoot: root, playerRoot }, presets);
    if (bound) await binding.bind("fixture");
    await work({ root, projectDir: join(root, "runtime"), presets, binding });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const publish = (bound: Bound, macros: MacroContext = presetRequestMacros({ profile: PROFILE })) =>
  publishPresetRequestSegments({
    projectDir: bound.projectDir,
    presets: bound.presets,
    binding: bound.binding,
    macros,
    markers: Object.freeze({}),
  });

/** The array a Chat request starts from: the Host's own system floor and one player line. */
const baseMessages = (): unknown[] => [
  { role: "system", content: [{ type: "text", text: "HOST FLOOR" }] },
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null ? String((block as { text?: unknown }).text ?? "") : "",
    )
    .join("");
}

/**
 * The seam's own channel, read back the way the vendor reads it: the publication is keyed by the project directory the
 * context pass reports as `ctx.cwd`, so a bound preset must be visible under exactly that key and an unbound one must
 * leave nothing there. Both directions go through the package's real `./tavern` exports - the registry is never
 * spelled a second time here.
 */
test("a bound preset reaches the seam, and unbinding withdraws it", async () => {
  await withBoundPreset(async (bound) => {
    const assembly = await publish(bound);
    assert.ok(assembly !== null, "a bound preset must publish an assembly");
    assert.deepEqual(__gamebuddyReadPresetSegments(bound.projectDir), {
      segments: assembly.segments,
      assemble: assembly.assemble,
    });
    assert.equal(assembly.segments.before.length, 1);
    assert.equal(assembly.segments.after.length, 1);
    assert.deepEqual(
      assembly.segments.depth.map((block) => block.depth),
      [2, 0],
    );

    await bound.binding.clear();
    assert.equal(await publish(bound), null, "an unbound preset must publish nothing");
    assert.equal(__gamebuddyReadPresetSegments(bound.projectDir), undefined, "unbinding must withdraw the publication");
  });
});

test("the three buckets land where §2.4 places them: prefix in the head, tail after the transcript, depth from the end", async () => {
  await withBoundPreset(async (bound) => {
    const assembly = await publish(bound);
    assert.ok(assembly !== null);
    const placed = assembly.assemble({ messages: baseMessages(), ...assembly.segments }).messages as readonly unknown[];

    // The stable prefix joins the leading system message's text rather than becoming a second system message, which
    // `resolveTranscript` would drop on a transport without mid-conversation system messages.
    assert.match(textOf(placed[0]), /^HOST FLOOR/, "the Host floor must stay first in the head");
    assert.match(textOf(placed[0]), /PREFIX-SENTINEL-9f3a/, "the preset's prefix entry must reach the head");
    assert.equal(placed.filter((message) => (message as { role?: string }).role === "system").length, 1);

    // `depth: 2` counts back from the end of the assembled array: [head, hello, after] -> index 1.
    assert.match(textOf(placed[1]), /DEPTH-SENTINEL-2b8e/);
    // `depth: 0` is the tail, and it is placed after the post-history entry.
    assert.match(textOf(placed[placed.length - 1]), /DEPTH-TAIL-SENTINEL-77d0/);
    assert.match(textOf(placed[placed.length - 2]), /TAIL-SENTINEL-4c71/);
    // Everything after the head is a `user` message, so no transport hoists it.
    assert.deepEqual(
      placed.slice(1).map((message) => (message as { role?: string }).role),
      ["user", "user", "user", "user"],
    );
    assert.equal(
      assembly.assemble({ messages: baseMessages(), ...assembly.segments }).prefixHash,
      assembly.pass.prefixHash,
    );
  });
});

test("a marker with no source and a macro this product will not evaluate are reported by name, never dropped", async () => {
  await withBoundPreset(async (bound) => {
    const written: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await publish(bound);
    } finally {
      process.stderr.write = write;
    }
    const unfilled = written.find((line) => line.startsWith(PRESET_UNFILLED_MARKERS_PREFIX));
    assert.ok(unfilled !== undefined, "an unfillable marker must be printed");
    assert.match(unfilled, /worldInfoBefore/);
    const unresolved = written.find((line) => line.startsWith(PRESET_UNRESOLVED_MACROS_PREFIX));
    assert.ok(unresolved !== undefined, "a declined macro must be printed");
    assert.match(unresolved, /time\(jailbreak\)/);
  });
});

/**
 * A4 §7.2's five load-bearing macros, through the real publication: each one renders the field that owns it.
 *
 * This is the assertion the finding was missing. All five are `implemented: true`, so before this the evaluator returned
 * the empty string for each of them and `unresolved` stayed empty: a preset's Main Prompt arrived as
 * `[Mira|||||]` and no channel said a word about it.
 */
test("the five load-bearing macros render the fields that own them, never an empty string", async () => {
  await withBoundPreset(
    async (bound) => {
      const assembly = await publish(
        bound,
        presetRequestMacros({ profile: PROFILE, persona: PLAYER_PERSONA, scenario: BOUND_SCENARIO }),
      );
      assert.ok(assembly !== null);
      assert.equal(
        assembly.segments.before[0],
        [
          "[Mira",
          // `{{user}}` is the bound persona's name, chosen by `macro-engine.ts`'s one player-reference rule.
          "USER-SENTINEL-5e6f",
          "DESCRIPTION-SENTINEL-1a2b. Keeps a lighthouse nobody visits.",
          "PERSONALITY-SENTINEL-3c4d. Blunt, and kind about it.",
          // A scenario is authored text like any other, so it renders through the same table the authored context
          // renders it with: its own `{{char}}`/`{{user}}` resolve instead of reaching the model as placeholders.
          "SCENARIO-SENTINEL-9c0d, Mira and USER-SENTINEL-5e6f on a grey morning.",
          "PERSONA-SENTINEL-7a8b, who keeps the lighthouse too.]",
        ].join("|"),
      );
      assert.deepEqual(assembly.pass.unresolved, [], "every macro was answerable, so none is reported");
    },
    true,
    MACRO_PRESET,
  );
});

/**
 * The other half of the same rule: a macro this assembly was NOT handed keeps its token and is reported by name.
 *
 * "Not given to this assembly" and "the field is empty" are different facts, and only the second may render as nothing.
 * A literal `{{persona}}` beside `preset_unresolved_macros:` tells the player the preset's sentence lost something; an
 * empty string tells them the preset wrote a shorter sentence than it did.
 */
test("a macro this assembly was not handed keeps its token and is reported by name", async () => {
  await withBoundPreset(
    async (bound) => {
      const written: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let before: string | undefined;
      try {
        const assembly = await publish(bound);
        assert.ok(assembly !== null);
        before = assembly.segments.before[0];
        assert.deepEqual(assembly.pass.unresolved, [
          { name: "persona", entries: ["main"] },
          { name: "scenario", entries: ["main"] },
        ]);
      } finally {
        process.stderr.write = write;
      }
      assert.equal(
        before,
        // No persona is bound here, so `{{user}}` is the locale's own word for the player - this run's default
        // (`macro-engine.ts`), not an empty slot. The profile's own two fields still render.
        "[Mira|User|DESCRIPTION-SENTINEL-1a2b. Keeps a lighthouse nobody visits.|PERSONALITY-SENTINEL-3c4d. Blunt, and kind about it.|{{scenario}}|{{persona}}]",
      );
      const unresolved = written.find((line) => line.startsWith(PRESET_UNRESOLVED_MACROS_PREFIX));
      assert.ok(unresolved !== undefined, "an unanswerable macro must be printed");
      assert.match(unresolved, /persona\(main\)/);
      assert.match(unresolved, /scenario\(main\)/);
    },
    true,
    MACRO_PRESET,
  );
});

/**
 * Empty is an answer only when the authority says the field is empty: a companion whose card wrote no description has
 * no description, and that must not be dressed up as `{{description}}` - a token would claim this assembly could not
 * read a profile it is holding.
 */
test("a field the companion genuinely has not renders empty, and is not reported as unresolved", async () => {
  const bare: IdentityProfile = Object.freeze({
    schemaVersion: 1,
    profileId: "lane-macros.bare",
    revision: 1,
    identity: Object.freeze({ name: "Mira", role: "the player's companion", continuity: "Keep one story." }),
  });
  await withBoundPreset(
    async (bound) => {
      const assembly = await publish(bound, presetRequestMacros({ profile: bare }));
      assert.ok(assembly !== null);
      assert.equal(assembly.segments.before[0], "[Mira|User|||{{scenario}}|{{persona}}]");
      assert.deepEqual(
        assembly.pass.unresolved.map((macro) => macro.name),
        ["persona", "scenario"],
        "only the two values this assembly was not handed are reported",
      );
    },
    true,
    MACRO_PRESET,
  );
});

/**
 * The sampler half, through the product's own chain: the bound document's values, the provider entry, and the model the
 * real runtime composes from `models.json`. `model.samplingParams` is the bag the `openai-completions` adapter merges
 * into the request body LAST (design §5), so this reading is the value the wire carries.
 */
async function composedModel(agentDir: string, values: PresetSamplingValues | null) {
  await mkdir(agentDir, { recursive: true });
  const base: PiProviderEntry = Object.freeze({
    name: "fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [{ id: MODEL_ID }],
  });
  const entry = values === null ? base : withPresetSampling(base, MODEL_ID, values);
  await mergeModelProviderEntry(join(agentDir, "models.json"), "fixture", entry);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return runtime.getModel("fixture", MODEL_ID);
}

test("a bound preset's sampler values compose onto the model Pi sends, and unbinding leaves none", async () => {
  await withBoundPreset(async (bound) => {
    const values = await boundPresetSampling(bound);
    assert.deepEqual({ ...(values ?? {}) }, { temperature: 0.42, top_p: 0.93 });

    const model = await composedModel(join(bound.root, "agent"), values);
    assert.ok(model !== undefined, "the real runtime must compose the model this entry describes");
    assert.deepEqual(model.samplingParams, { temperature: 0.42, top_p: 0.93 });

    await bound.binding.clear();
    assert.equal(await boundPresetSampling(bound), null, "unbinding must leave no values to carry");
    const unbindModel = await composedModel(join(bound.root, "agent-unbound"), null);
    assert.ok(unbindModel !== undefined);
    assert.equal(unbindModel.samplingParams, undefined);
  });
});

/**
 * The panel's read: only the preset IN FORCE has a composed model, because the runtime composes `models.json` from that
 * one document. Every other row says `no_composed_model` rather than the values its own file declares - the false
 * reading §5 exists to delete - and a bound preset whose values are genuinely absent from the composed model still
 * fails closed with `preset_sampling_not_applied`, which is the signal that the splice did not take.
 */
test("the panel read carries a sampling reading for the bound row only, and still fails closed on a splice that did not take", async () => {
  await withBoundPreset(async (bound) => {
    const read = createPresetAssemblyRead({
      store: bound.presets,
      binding: bound.binding,
      macros: presetRequestMacros({ profile: PROFILE }),
      markers: Object.freeze({}),
      sampling: async () => ({ model: { samplingParams: { temperature: 0.42, top_p: 0.93 } }, thinkingLevel: "off" }),
    });
    const body = await read.read();
    const boundRow = body.presets.find((preset) => preset.presetId === "fixture");
    assert.ok(boundRow !== undefined);
    assert.deepEqual(
      (boundRow.sampling as readonly { key: string; value: number | null; source: string }[]).slice(0, 2),
      [
        { key: "temperature", value: 0.42, source: "preset" },
        { key: "top_p", value: 0.93, source: "preset" },
      ],
    );
    // The stored preset that is NOT in force declares its own temperature and gets no reading: the composed model
    // belongs to the bound one, and printing `other`'s written 0.77 would claim a value nothing sends.
    const otherRow = body.presets.find((preset) => preset.presetId === "other");
    assert.ok(otherRow !== undefined);
    assert.deepEqual(otherRow.sampling, { unavailable: "no_composed_model" });

    const unboundRead = createPresetAssemblyRead({
      store: bound.presets,
      binding: bound.binding,
      macros: presetRequestMacros({ profile: PROFILE }),
      markers: Object.freeze({}),
      sampling: async () => ({ model: { samplingParams: {} }, thinkingLevel: "off" }),
    });
    await bound.binding.clear();
    const unbound = await unboundRead.read();
    assert.deepEqual(
      unbound.presets.map((preset) => preset.sampling),
      [{ unavailable: "no_composed_model" }, { unavailable: "no_composed_model" }],
    );

    await bound.binding.bind("fixture");
    const stale = createPresetAssemblyRead({
      store: bound.presets,
      binding: bound.binding,
      macros: presetRequestMacros({ profile: PROFILE }),
      markers: Object.freeze({}),
      sampling: async () => ({ model: { samplingParams: { temperature: 0.1 } }, thinkingLevel: "off" }),
    });
    await assert.rejects(() => stale.read(), { message: /preset_sampling_not_applied:temperature/ });
  });
});

test("an unbounded project directory publishes nothing at all", async () => {
  await withBoundPreset(async (bound) => {
    assert.equal(await publish(bound), null);
    assert.equal(__gamebuddyReadPresetSegments(bound.projectDir), undefined);
  }, false);
});

test("a publication for another directory is not visible to this one", async () => {
  await withBoundPreset(async (bound) => {
    const assembly = await publish(bound);
    assert.ok(assembly !== null);
    publishGameBuddyPresetSegments(join(bound.root, "elsewhere"), {
      segments: assembly.segments,
      assemble: assembly.assemble,
    });
    assert.equal(__gamebuddyReadPresetSegments(join(bound.root, "elsewhere")) !== undefined, true);
    assert.notEqual(__gamebuddyReadPresetSegments(bound.projectDir), undefined);
  });
});
