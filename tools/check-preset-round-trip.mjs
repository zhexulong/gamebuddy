#!/usr/bin/env node
/**
 * Gate: `preset_round_trip` - a SillyTavern preset keeps its fields and its entries through import -> export -> re-import.
 *
 * WHY. design/architecture/tavern-preset-compatibility.md §2.2 rules that a preset's fields are preserved verbatim
 * and never flattened, and §2.1 says the export operation exists for exactly one reason: the round trip is the only
 * measurable form of that promise. Without it, "we do not lose anything" is a sentence. The defect it is written
 * against is the one the PLAN document records as its first lesson: an assembler that rebuilds an entry from a field
 * list silently drops `marker` and `injection_depth`, and those two are the whole value of a modern preset.
 *
 * POPULATION, derived rather than listed:
 *   - every prompt entry in the fixture below (its entries, its identifiers, every field on each) is compared;
 *   - every field name `PRESET_PROMPT_FIELDS` publishes (host/src/tavern/preset-document.ts, taken from A4 §2.2) must
 *     appear on at least one fixture entry, so a field added to the authority that the fixture does not carry is red
 *     here instead of being silently unexamined.
 *   `examined N prompt entries, M fields across them, J document keys, compared over K readings` is printed, and an
 *   empty population is BLOCKED, never green.
 *
 * The store is the artifact this gate measures: it imports `host/dist-test/tavern/preset-store.js`, the build the Host
 * test suite runs. Absent, the run reports `preset_round_trip_skipped:` and exits 0 without a verdict, because a
 * measurement that could not run is not a measurement that passed.
 *
 * red-proof: inject  a store that drops `injection_depth` from every entry on write -> `"status":"failed"`, exit 1,
 *                    and `preset_round_trip_field_missing:prompts[main].injection_depth` for each of the fixture's five
 *                    in-chat entries on the import_to_export and source_to_reexport readings (tools/check-preset-round-trip.test.mjs)
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const STORE_MODULE = "host/dist-test/tavern/preset-store.js";
const DOCUMENT_MODULE = "host/dist-test/tavern/preset-document.js";

/**
 * The fixture: SillyTavern's own `default/content/presets/openai/Default.json` (v1.18.0, 12 entries, 8 markers, 2
 * `prompt_order` groups), carried here in full because `ref/` is git-ignored and a gate cannot read a fixture the
 * checkout does not have. Two entries from A4 §11.1/§11.2 are added - one Relative, one in-chat at `injection_depth:
 * 4` - because the stock file predates the depth fields and a fixture without them would examine exactly the fields
 * that a flattening defect destroys. One document-level key and one entry-level key are deliberately NOT SillyTavern's
 * (`x_author_note`, `extensions`), because "unknown keys survive" is the other half of §2.2 and a fixture made only of
 * known fields cannot test it.
 */
export const FIXTURE_PRESET = Object.freeze({
  name: "Default (preset round-trip fixture)",
  x_author_note: "not a SillyTavern field: proves an unrecognised document key survives the round trip",
  chat_completion_source: "openai",
  temperature: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  top_p: 1,
  top_k: 0,
  top_a: 0,
  min_p: 0,
  repetition_penalty: 1,
  openai_max_context: 4095,
  openai_max_tokens: 300,
  stream_openai: true,
  prompts: [
    {
      identifier: "main",
      name: "Main Prompt",
      system_prompt: true,
      role: "system",
      content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
      enabled: true,
      marker: false,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      forbid_overrides: false,
      extension: false,
      injection_trigger: [],
    },
    {
      identifier: "nsfw",
      name: "Auxiliary Prompt",
      system_prompt: true,
      role: "system",
      content: "",
      enabled: true,
      marker: false,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      forbid_overrides: false,
      extension: false,
      injection_trigger: [],
    },
    { identifier: "dialogueExamples", name: "Chat Examples", system_prompt: true, marker: true },
    {
      identifier: "jailbreak",
      name: "Post-History Instructions",
      system_prompt: true,
      role: "system",
      content: "",
      enabled: true,
      marker: false,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      forbid_overrides: false,
      extension: false,
      injection_trigger: [],
    },
    { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true },
    { identifier: "worldInfoAfter", name: "World Info (after)", system_prompt: true, marker: true },
    { identifier: "worldInfoBefore", name: "World Info (before)", system_prompt: true, marker: true },
    {
      identifier: "enhanceDefinitions",
      role: "system",
      name: "Enhance Definitions",
      content:
        "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
      system_prompt: true,
      marker: false,
    },
    { identifier: "charDescription", name: "Char Description", system_prompt: true, marker: true },
    { identifier: "charPersonality", name: "Char Personality", system_prompt: true, marker: true },
    { identifier: "scenario", name: "Scenario", system_prompt: true, marker: true },
    { identifier: "personaDescription", name: "Persona Description", system_prompt: true, marker: true },
    {
      identifier: "my_rules_prompt",
      name: "写作规则",
      content: "写作时务必：\n1. 保持第三人称视角\n2. 每次回复至少 300 字\n3. 角色名：{{char}}",
      role: "system",
      enabled: true,
      system_prompt: false,
      marker: false,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      forbid_overrides: false,
      extension: false,
      injection_trigger: [],
    },
    {
      identifier: "style_reinforcement",
      name: "风格强化（深度注入）",
      content: "请注意：下一条回复请保持角色{{char}}的说话风格。{{random::轻微::明显地}}",
      role: "system",
      enabled: true,
      system_prompt: false,
      marker: false,
      injection_position: 1,
      injection_depth: 4,
      injection_order: 100,
      forbid_overrides: true,
      extension: false,
      injection_trigger: ["normal", "swipe", "regenerate"],
      extensions: { "author-probe": { unknownKey: true } },
    },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "charPersonality", enabled: true },
        { identifier: "scenario", enabled: true },
        { identifier: "enhanceDefinitions", enabled: false },
        { identifier: "nsfw", enabled: true },
        { identifier: "worldInfoAfter", enabled: true },
        { identifier: "dialogueExamples", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
        { identifier: "my_rules_prompt", enabled: true },
        { identifier: "style_reinforcement", enabled: true },
      ],
    },
    {
      character_id: 100001,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "personaDescription", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "charPersonality", enabled: true },
        { identifier: "scenario", enabled: true },
        { identifier: "enhanceEffects", enabled: false },
        { identifier: "nsfw", enabled: true },
        { identifier: "worldInfoAfter", enabled: true },
        { identifier: "dialogueExamples", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
      ],
    },
  ],
});

const promptEntriesOf = (document) => (Array.isArray(document?.prompts) ? document.prompts : []);

/**
 * Every way `candidate` fails to be `original`, named by the field or the entry it lost, added or changed.
 *
 * The comparison is field-by-field rather than schema-by-schema on purpose: "invalid preset" is what a normalising
 * reader says, and it tells the person holding a 300-entry preset nothing. A claim of equality is worth exactly the
 * precision of the difference it can print.
 */
export function comparePresetDocuments(original, candidate) {
  const findings = [];
  const originalKeys = Object.keys(original);
  const candidateKeys = Object.keys(candidate);
  for (const key of originalKeys)
    if (!candidateKeys.includes(key)) findings.push({ code: "document_field_missing", path: key });
  for (const key of candidateKeys)
    if (!originalKeys.includes(key)) findings.push({ code: "document_field_added", path: key });
  for (const key of originalKeys) {
    if (key === "prompts" || !candidateKeys.includes(key)) continue;
    if (!isDeepStrictEqual(original[key], candidate[key])) findings.push({ code: "document_value_changed", path: key });
  }

  const originalEntries = promptEntriesOf(original);
  const candidateEntries = promptEntriesOf(candidate);
  const identifiers = (entries) => entries.map((entry) => entry?.identifier);
  const originalIds = identifiers(originalEntries);
  const candidateIds = identifiers(candidateEntries);
  for (const identifier of originalIds)
    if (!candidateIds.includes(identifier)) findings.push({ code: "entry_missing", path: `prompts[${identifier}]` });
  for (const identifier of candidateIds)
    if (!originalIds.includes(identifier)) findings.push({ code: "entry_added", path: `prompts[${identifier}]` });
  // Order is compared over the entries BOTH documents carry: a removal shifts every later index, and reporting that
  // shift as a fistful of reorderings would bury the one finding that matters - the entry that is gone.
  const originalCommon = originalIds.filter((identifier) => candidateIds.includes(identifier));
  const candidateCommon = candidateIds.filter((identifier) => originalIds.includes(identifier));
  originalCommon.forEach((identifier, index) => {
    if (candidateCommon[index] === identifier) return;
    findings.push({
      code: "entry_order_changed",
      path: `prompts[${originalIds.indexOf(identifier)}]`,
      detail: `${identifier} is now at prompts[${candidateIds.indexOf(identifier)}]`,
    });
  });

  for (const entry of originalEntries) {
    const identifier = entry?.identifier;
    const roundTripped = candidateEntries.find((other) => other?.identifier === identifier);
    if (roundTripped === undefined) continue;
    const path = `prompts[${identifier}]`;
    for (const field of Object.keys(entry))
      if (!Object.hasOwn(roundTripped, field)) findings.push({ code: "field_missing", path: `${path}.${field}` });
    for (const field of Object.keys(roundTripped))
      if (!Object.hasOwn(entry, field)) findings.push({ code: "field_added", path: `${path}.${field}` });
    for (const field of Object.keys(entry))
      if (Object.hasOwn(roundTripped, field) && !isDeepStrictEqual(entry[field], roundTripped[field]))
        findings.push({
          code: "field_value_changed",
          path: `${path}.${field}`,
          detail: `${JSON.stringify(entry[field])} -> ${JSON.stringify(roundTripped[field])}`,
        });
  }
  return findings;
}

/** Whether every field A4 §2.2 publishes appears on at least one fixture entry. */
export function uncoveredDocumentedFields(fields, document) {
  const present = new Set(promptEntriesOf(document).flatMap((entry) => Object.keys(entry)));
  return fields.filter((field) => !present.has(field));
}

async function loadArtifact() {
  try {
    const [store, document, pathLock, reclaimer] = await Promise.all([
      import(new URL(`../${STORE_MODULE}`, import.meta.url).href),
      import(new URL(`../${DOCUMENT_MODULE}`, import.meta.url).href),
      import(new URL("../host/dist-test/path-lock.js", import.meta.url).href),
      import(new URL("../host/dist-test/windows-stale-lock-reclaimer/index.js", import.meta.url).href),
    ]);
    // The store takes a path lock, and on Windows that lock's release needs the reclaimer the Host binds at startup.
    // A gate that skipped this would fail on its own cleanup rather than on the preset it came to measure.
    pathLock.bindWindowsStaleLockReclaimer(reclaimer.createBuildWindowsStaleLockReclaimer());
    return { store, document };
  } catch {
    return null;
  }
}

/** One import -> export -> re-import -> export cycle through the real store, returning both readings. */
export async function roundTripPreset({ root, fixture = FIXTURE_PRESET } = {}) {
  const artifact = await loadArtifact();
  if (artifact === null) return { measured: false };
  const workspace = root ?? (await mkdtemp(join(tmpdir(), "gb-preset-round-trip-")));
  try {
    const store = artifact.store.createPresetStore({
      runtimeRoot: workspace,
      playerRoot: join(workspace, "tavern", "v1", "players", "round-trip"),
    });
    const imported = await store.import({ presetId: "fixture", document: globalThis.structuredClone(fixture) });
    const exported = await store.export("fixture");
    const reimported = await store.import({ presetId: "fixture-reimported", document: exported });
    const reexported = await store.export("fixture-reimported");
    return {
      measured: true,
      fields: artifact.document.PRESET_PROMPT_FIELDS,
      entries: promptEntriesOf(fixture),
      documentKeys: Object.keys(fixture),
      readings: [
        { id: "import_to_export", findings: comparePresetDocuments(fixture, exported) },
        { id: "export_to_reimport", findings: comparePresetDocuments(exported, reexported) },
        { id: "source_to_reexport", findings: comparePresetDocuments(fixture, reexported) },
      ],
      imported: imported.summary,
      reimported: reimported.summary,
    };
  } finally {
    if (root === undefined) await rm(workspace, { recursive: true, force: true });
  }
}

const describe = (finding) =>
  `preset_round_trip_${finding.code}:${finding.path}${finding.detail === undefined ? "" : ` (${finding.detail})`}`;

/**
 * The verdict, in one place so the falsifier can drive it: an empty population is `blocked` (a reading that examined
 * nothing agrees with itself), any finding or unexamined documented field is `failed`, and only then is it `passed`.
 */
export function presetRoundTripStatus({ entries, findings, uncovered }) {
  if (entries === 0) return "blocked";
  return findings === 0 && uncovered === 0 ? "passed" : "failed";
}

async function main() {
  const result = await roundTripPreset();
  if (!result.measured) {
    process.stdout.write(
      `preset_round_trip_skipped: ${STORE_MODULE} is not built, so the round trip was not measured ` +
        "(build it with `pnpm --dir host build:test`)\n",
    );
    process.stdout.write(
      `${JSON.stringify({
        gate: "preset_round_trip",
        status: "blocked",
        checks: [{ id: "host_artifact_present", status: "blocked", detail: `${STORE_MODULE} is absent` }],
      })}\n`,
    );
    return;
  }

  const entries = result.entries;
  const fields = entries.reduce((total, entry) => total + Object.keys(entry).length, 0);
  process.stdout.write(
    `examined ${entries.length} prompt entries, ${fields} fields across them, ${result.documentKeys.length} ` +
      `document keys, compared over ${result.readings.length} readings\n`,
  );

  const uncovered = uncoveredDocumentedFields(result.fields, FIXTURE_PRESET);
  const findings = result.readings.flatMap((reading) =>
    reading.findings.map((finding) => ({ ...finding, reading: reading.id })),
  );

  for (const field of uncovered) process.stdout.write(`preset_round_trip_documented_field_unexamined:${field}\n`);
  for (const reading of result.readings)
    for (const finding of reading.findings) process.stdout.write(`  ${reading.id}: ${describe(finding)}\n`);

  // An empty population agrees with itself: zero entries is a blocked reading, never a pass.
  const empty = entries.length === 0;
  if (empty) process.stdout.write("preset_round_trip_blocked:fixture_has_no_prompt_entries\n");

  const status = presetRoundTripStatus({
    entries: entries.length,
    findings: findings.length,
    uncovered: uncovered.length,
  });
  process.stdout.write(
    `${JSON.stringify({
      gate: "preset_round_trip",
      status,
      examined: entries.length,
      population: entries.length,
      fields,
      readings: result.readings.map((reading) => ({
        id: reading.id,
        findings: reading.findings.length,
      })),
      checks: [
        {
          id: "fixture_population_nonempty",
          status: empty ? "blocked" : "passed",
          detail: `${entries.length} prompt entries examined`,
        },
        {
          id: "documented_fields_examined",
          status: uncovered.length === 0 ? "passed" : "failed",
          detail:
            uncovered.length === 0
              ? `every field PRESET_PROMPT_FIELDS publishes is on a fixture entry (${result.fields.length} fields)`
              : `absent from the fixture: ${uncovered.join(", ")}`,
        },
        ...result.readings.map((reading) => ({
          id: reading.id,
          status: reading.findings.length === 0 ? "passed" : "failed",
          detail: `${reading.findings.length} finding(s)`,
        })),
      ],
    })}\n`,
  );
  process.exitCode = status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
