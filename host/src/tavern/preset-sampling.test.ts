import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { connectionAuthPath, TavernConnectionStore } from "./connection-store.js";
import { mergeModelProviderEntry, modelProviderEntry, type PiProviderEntry } from "./pi-provider-store.js";
import {
  effectivePresetSampling,
  PRESET_FIELDS_NOT_APPLIED,
  PRESET_SAMPLING_KEYS,
  presetFieldsNotApplied,
  presetSamplingParams,
  type PresetSamplingValues,
  withPresetSampling,
} from "./preset-sampling.js";
import { TAVERN_ESCAPE_HATCH_PROVIDER_ID } from "./provider-catalog.js";

const MODEL_ID = "sampling-fixture-model";

/**
 * A preset as SillyTavern writes one: the eight sampler settings at the top level beside the endpoint
 * configuration and the prompt entries, which are not sampler settings at all.
 */
function presetDocument(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "Sampling fixture (SillyTavern Default shape)",
    chat_completion_source: "openai",
    temperature: 0.82,
    frequency_penalty: 0.13,
    presence_penalty: 0.22,
    top_p: 0.91,
    top_k: 40,
    top_a: 0.31,
    min_p: 0.04,
    repetition_penalty: 1.07,
    openai_max_context: 4095,
    openai_max_tokens: 300,
    stream_openai: true,
    n: 1,
    seed: -1,
    prompts: [{ identifier: "main", content: "{{char}} answers {{user}}.", marker: false }],
    ...overrides,
  };
}

const FIXTURE_VALUES: PresetSamplingValues = Object.freeze({
  temperature: 0.82,
  top_p: 0.91,
  top_k: 40,
  min_p: 0.04,
  top_a: 0.31,
  repetition_penalty: 1.07,
  presence_penalty: 0.22,
  frequency_penalty: 0.13,
});

let canonicalTemporaryRoot: string;

// The escape-hatch connection and `models.json` are both path-locked durable stores, so this file needs the
// test-only stale-lock reclaimer every other path-lock consumer's test binds.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  canonicalTemporaryRoot = await realpath(tmpdir());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(canonicalTemporaryRoot, "gamebuddy-preset-sampling-"));
  try {
    await run(join(root, "agent"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The product's own chain, end to end up to the model the adapter sends: a stored escape-hatch connection, the
 * provider entry `modelProviderEntry` builds for it, the preset's values carried into that entry, and `models.json`
 * composed by the real runtime. Returns the composed model, so every assertion below reads what Pi will use rather
 * than a second copy of what this module meant.
 */
async function composePresetModel(
  agentDir: string,
  values: PresetSamplingValues,
  modelLayer: Readonly<Record<string, unknown>> | undefined = undefined,
): Promise<Readonly<{ model: ReturnType<ModelRuntime["getModel"]>; entry: PiProviderEntry }>> {
  const store = new TavernConnectionStore(agentDir);
  const document = await store.create({
    providerId: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
    apiKey: "synthetic-sampling-key",
    baseUrl: "http://127.0.0.1:9/v1",
    apiShape: "openai-completions",
    modelId: MODEL_ID,
  });
  assert.equal(document.connections.length, 1, "the fixture connection must be stored");
  const selection = await modelProviderEntry(agentDir, {
    provider: TAVERN_ESCAPE_HATCH_PROVIDER_ID,
    modelId: MODEL_ID,
    thinkingLevel: "high",
  });
  assert.ok(selection !== null, "the escape-hatch selection must build a provider entry");
  const carried = withPresetSampling(selection.entry, MODEL_ID, values);
  const entry = modelLayer === undefined ? carried : withModelLayer(carried, modelLayer);
  await mergeModelProviderEntry(join(agentDir, "models.json"), selection.providerId, entry);
  const runtime = await ModelRuntime.create({
    authPath: connectionAuthPath(agentDir),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return { model: runtime.getModel(selection.providerId, MODEL_ID), entry };
}

/**
 * States the `models.json` layers a preset cannot express, as another writer of that document may: whether the model
 * reasons and which levels it advertises, and/or per-level sampling params Pi merges above the model bag. The real
 * runtime composes them, so every assertion below reads the adapter's own precedence rather than this file's idea of it.
 */
function withModelLayer(entry: PiProviderEntry, layer: Readonly<Record<string, unknown>>): PiProviderEntry {
  const overrides = (entry.modelOverrides ?? {}) as Record<string, unknown>;
  const carried = (overrides[MODEL_ID] ?? {}) as Record<string, unknown>;
  return Object.freeze({
    ...entry,
    modelOverrides: { ...overrides, [MODEL_ID]: { ...carried, ...layer } },
  });
}

/** The level map a reasoning model of this family declares; every level is advertised. */
const ADVERTISED_LEVELS = Object.freeze({
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});

test("a preset contributes its sampler settings and nothing that owns the request body", () => {
  const values = presetSamplingParams(presetDocument());
  assert.deepEqual({ ...values }, { ...FIXTURE_VALUES });
  // The population is the declared key set, not the fixture's coincidences: a ninth sampler key added to the
  // authority must be carried here, and an endpoint fact must stay out.
  assert.deepEqual(Object.keys(values).sort(), [...PRESET_SAMPLING_KEYS].sort());
  for (const key of ["openai_max_tokens", "openai_max_context", "stream_openai", "n", "seed", "prompts", "model"])
    assert.equal(key in values, false, `${key} is not a sampling value and must not reach the request body`);
});

test("a preset's budget and transport fields are recognised by name and reported not_applied, never carried", () => {
  const document = presetDocument();
  const reported = presetFieldsNotApplied(document);
  // The population is the declaration: every field the table names AND the fixture carries is reported, in the
  // table's own order, so a field added to the table cannot be silently unreported.
  assert.deepEqual(
    reported.map((entry) => [entry.field, entry.disposition]),
    Object.keys(PRESET_FIELDS_NOT_APPLIED).map((field) => [field, "not_applied"]),
  );
  assert.equal(reported.find((entry) => entry.field === "openai_max_context")?.value, 4095);
  for (const entry of reported)
    assert.ok(entry.reason.length > 0, `${entry.field} must say why it is not ours, or the report is a shrug`);
  // Reported is not carried: the same field must still be absent from the sampling bag.
  for (const entry of reported)
    assert.equal(entry.field in presetSamplingParams(document), false, `${entry.field} is reported, not sent`);
  // A preset that states none of them reports nothing rather than an empty-shaped row per field.
  assert.deepEqual(presetFieldsNotApplied({ prompts: [] }), []);
  // One field present, the rest absent: the report follows the document, not the table alone.
  assert.deepEqual(
    presetFieldsNotApplied({ prompts: [], openai_max_context: 8000 }).map((entry) => entry.field),
    ["openai_max_context"],
  );
});

test("a preset with no sampler settings contributes nothing, and a non-numeric one is refused by key", () => {
  assert.deepEqual({ ...presetSamplingParams({ prompts: [] }) }, {});
  assert.deepEqual({ ...presetSamplingParams({ prompts: [], temperature: 0 }) }, { temperature: 0 });
  assert.throws(() => presetSamplingParams({ temperature: "0.7" }), {
    message: "preset_sampling_not_a_number:temperature:0.7",
  });
  assert.throws(() => presetSamplingParams({ top_p: Number.NaN }), {
    message: "preset_sampling_not_a_number:top_p:NaN",
  });
});

test("an empty value set leaves the provider entry byte-identical, so a preset with no opinion writes nothing", () => {
  const entry: PiProviderEntry = Object.freeze({
    name: "fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
  });
  assert.equal(withPresetSampling(entry, MODEL_ID, Object.freeze({})), entry);
});

test("the preset's values land in the model's sampling params and compose onto the model Pi will send", async () => {
  await withAgentDir(async (agentDir) => {
    const { model, entry } = await composePresetModel(agentDir, FIXTURE_VALUES);
    assert.deepEqual(
      (entry.modelOverrides as Record<string, unknown>)[MODEL_ID],
      { samplingParams: { ...FIXTURE_VALUES } },
      "the carry is one modelOverrides layer, not a models[] restatement",
    );
    assert.ok(model !== undefined, "the real runtime must compose the model this entry describes");
    assert.deepEqual(model.samplingParams, { ...FIXTURE_VALUES });
  });
});

test("with nothing set, no sampling params reach the composed model", async () => {
  await withAgentDir(async (agentDir) => {
    const { model, entry } = await composePresetModel(agentDir, Object.freeze({}));
    assert.equal(entry.modelOverrides, undefined);
    assert.ok(model !== undefined);
    assert.equal(model.samplingParams, undefined);
  });
});

test("the reading names the preset as the source when the composed model carries its value", async () => {
  await withAgentDir(async (agentDir) => {
    const { model } = await composePresetModel(agentDir, FIXTURE_VALUES);
    const readings = effectivePresetSampling({ model: model ?? {}, thinkingLevel: "high", preset: FIXTURE_VALUES });
    assert.deepEqual(
      readings.map((reading) => [reading.key, reading.value, reading.source]),
      PRESET_SAMPLING_KEYS.map((key) => [key, FIXTURE_VALUES[key], "preset"]),
    );
  });
});

test("the reading names the thinking level when the model advertises it and that level overrides the preset", async () => {
  await withAgentDir(async (agentDir) => {
    const { model } = await composePresetModel(agentDir, FIXTURE_VALUES, {
      reasoning: true,
      thinkingLevelMap: ADVERTISED_LEVELS,
      samplingParamsByThinkingLevel: { high: { temperature: 0.2 } },
    });
    assert.ok(model !== undefined);
    assert.equal(model.reasoning, true);
    const readings = effectivePresetSampling({ model, thinkingLevel: "high", preset: FIXTURE_VALUES });
    const byKey = new Map(readings.map((reading) => [reading.key, reading]));
    assert.deepEqual(byKey.get("temperature"), { key: "temperature", value: 0.2, source: "thinking-level" });
    // The other seven are still the preset's: one layer winning one key must not relabel the rest.
    assert.equal(byKey.get("top_p")?.source, "preset");
    assert.equal(byKey.get("top_p")?.value, FIXTURE_VALUES.top_p);
    // This is the level the adapter merges last over the model bag, so the reading above is what it will send.
    assert.deepEqual(model.samplingParamsByThinkingLevel, { high: { temperature: 0.2 } });
  });
});

test("a level the model does not advertise is not in force, so the reading keeps the preset's value", async () => {
  // Pi clamps the requested level to what the model advertises (`getSupportedThinkingLevels` returns `["off"]` for a
  // model that does not reason), so the adapter never consults a `high` layer. A reading that trusted the REQUESTED
  // level would name a value the wire never carries - the false-green this read model exists to prevent.
  await withAgentDir(async (agentDir) => {
    const { model } = await composePresetModel(agentDir, FIXTURE_VALUES, {
      samplingParamsByThinkingLevel: { high: { temperature: 0.2 } },
    });
    assert.ok(model !== undefined);
    assert.equal(model.reasoning, false, "the escape-hatch model does not reason unless a writer says so");
    const temperature = effectivePresetSampling({ model, thinkingLevel: "off", preset: FIXTURE_VALUES }).find(
      (reading) => reading.key === "temperature",
    );
    assert.deepEqual(temperature, { key: "temperature", value: FIXTURE_VALUES.temperature, source: "preset" });
  });
});

test("the reading says unset for every key nothing sets, and never invents a value", () => {
  const readings = effectivePresetSampling({ model: {}, thinkingLevel: "off", preset: Object.freeze({}) });
  assert.deepEqual(
    readings.map((reading) => [reading.key, reading.value, reading.source]),
    PRESET_SAMPLING_KEYS.map((key) => [key, undefined, "unset"]),
  );
});

test("a model's own sampling default is reported as the model's, not as the preset's", () => {
  const readings = effectivePresetSampling({
    model: { samplingParams: { top_k: 5 } },
    thinkingLevel: "off",
    preset: Object.freeze({}),
  });
  const topK = readings.find((reading) => reading.key === "top_k");
  assert.deepEqual(topK, { key: "top_k", value: 5, source: "model" });
});

test("a reading whose preset value the composed model does not carry fails closed instead of reporting it", () => {
  assert.throws(
    () =>
      effectivePresetSampling({
        model: { samplingParams: { temperature: 0.7 } },
        thinkingLevel: "off",
        preset: Object.freeze({ temperature: 0.9 }),
      }),
    { message: "preset_sampling_not_applied:temperature:preset=0.9:composed=0.7" },
  );
});
