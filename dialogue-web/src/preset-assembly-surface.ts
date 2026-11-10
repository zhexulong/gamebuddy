/**
 * The read-only preset readout: the wire shape the Preset surface shows, the validator that refuses a body which
 * does not describe what it claims, and the one read.
 *
 * Design (`design/architecture/tavern-preset-compatibility.md` §2.1, §2.5, §4): the surface exists so a player can
 * see the assembly's own truth about the preset they imported - the entry switch, the markers with no content
 * source, the macros this product will not evaluate (named with their code), and the depth injection. Presets are
 * imported once and never edited here, so there is no command in this module and no CSRF header on the read.
 *
 * The three cross-field facts a body cannot be trusted to keep for itself are checked here rather than in the
 * panel, because a validator that only checks types would let a body state `entries.total` and `entries.enabled`
 * that cannot both be true, or a depth count that disagrees with the blocks beside it. Those are one fact with two
 * spellings, and this is the one place that compares them.
 *
 * The shape mirrors `host/src/preset-assembly-surface.ts` (`PresetAssemblySurfaceV1`). The mirror is hand-written
 * because the browser bundle may not import the Host's node-side modules, and the spec that mounts this surface
 * feeds it the producer's REAL output - so a drifted mirror fails a journey instead of agreeing with itself.
 *
 * `sampling` is the one member whose drift is a lie rather than an absence (design §5): a row says which layer
 * decided a sampler key, and a `source` this surface did not recognise would have to be guessed - guessed as
 * `preset`, which is exactly the claim that makes a panel show a value the runtime does not send. So an unknown
 * source is a refusal naming the value, never a fallback.
 *
 * `sampling` also has a second shape, and it is the honest one while no composed model exists: the named absence
 * `{ unavailable: "no_composed_model" }`. It is validated as strictly as the rows - never beside them, never with a
 * reason this surface cannot name - because "not measured" and "nothing is sent" are different facts and a panel
 * that rendered one as the other would be telling the player about a request nobody sends.
 *
 * `activePreset` is the fact this surface shows FIRST, because it is the one that decides whether any of the rest is
 * in force: three named states (`none` / `bound` / `missing`), never an absent key standing for "nothing bound". It
 * is OPTIONAL on the body exactly as the Host's contract marks it, so a Host without the addition still reads; a
 * body that omits it makes this surface claim nothing rather than claiming "no preset is in force".
 */

export type PresetAssemblyMacroV1 = Readonly<{
  /** `macro_not_implemented:<name>` or `macro_unknown:<name>`. */
  code: string;
  name: string;
  entries: readonly string[];
}>;

export type PresetAssemblyDepthBlockV1 = Readonly<{ identifier: string; depth: number }>;

/** Which layer decided a sampler key's value. Mirrors the Host's `SamplingSource`. */
export const PRESET_SAMPLING_SOURCES = Object.freeze(["preset", "model", "thinking-level", "unset"] as const);

export type PresetSamplingSourceV1 = (typeof PRESET_SAMPLING_SOURCES)[number];

/**
 * One sampler key's effective value and its layer, on the wire.
 *
 * `value` is `null` exactly when `source` is `unset`; JSON cannot carry `undefined`, and a row that lost its value
 * that way would be an omitted row on the wire, which reads as "there is no such setting".
 */
export type PresetSamplingRowV1 = Readonly<{ key: string; value: number | null; source: PresetSamplingSourceV1 }>;

/**
 * Why no sampler reading could be taken. A closed set, one member per fact, so a reason this surface has no line
 * for cannot be rendered as prose.
 *
 * `no_composed_model` is the whole of it today: the reading is taken against the composed model the adapter will
 * send, and nothing binds a preset to the runtime yet.
 */
export const PRESET_SAMPLING_UNAVAILABLE_REASONS = Object.freeze(["no_composed_model"] as const);

export type PresetSamplingUnavailableReasonV1 = (typeof PRESET_SAMPLING_UNAVAILABLE_REASONS)[number];

/** The named absence: no rows exist, and this says why. Never accompanied by rows. */
export type PresetSamplingUnavailableV1 = Readonly<{ unavailable: PresetSamplingUnavailableReasonV1 }>;

export type PresetAssemblySurfaceV1 = Readonly<{
  presetId: string;
  name: string | null;
  revision: number;
  entries: Readonly<{ total: number; enabled: number; disabled: number }>;
  disabledEntries: readonly string[];
  unfilledMarkers: readonly string[];
  macros: readonly PresetAssemblyMacroV1[];
  depth: Readonly<{ count: number; depths: readonly number[]; blocks: readonly PresetAssemblyDepthBlockV1[] }>;
  /**
   * Rows, or the reason there are none: one shape or the other, never both and never neither. A body carrying both
   * states two things about one fact, and one carrying neither leaves the player unable to tell "nothing is sent"
   * from "nobody looked".
   */
  sampling: readonly PresetSamplingRowV1[] | PresetSamplingUnavailableV1;
}>;

export type PresetActiveBindingV1 =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "bound"; presetId: string }>
  | Readonly<{ state: "missing"; presetId: string }>;

export type PresetAssemblyReadV1 = Readonly<{
  apiVersion: 1;
  presets: readonly PresetAssemblySurfaceV1[];
  /** Absent only for a Host that predates the fact; the panel then says nothing about what is in force. */
  activePreset?: PresetActiveBindingV1;
}>;

/** The route the readout is served on. One path, named once, so the surface and its journey cannot drift apart. */
export const PRESET_ASSEMBLY_ROUTE = "/api/tavern/v1/presets";

/** A body that is not the readout this surface can show. The message names the field that drifted. */
export class PresetAssemblyProtocolError extends Error {}

const PREREQUISITE = "is not the preset readout this surface reads";
const MAX_PRESETS = 100;
const MACRO_CODE = /^macro_(?:not_implemented|unknown):(.+)$/u;

/**
 * The one read. A refusal is not a body: a response that is not `200` with the readout throws, and the surface
 * reports that it could not read the assembly rather than showing an empty one that looks like "no preset".
 */
export async function readPresetAssemblySurface(transport: typeof fetch = fetch): Promise<PresetAssemblyReadV1> {
  const response = await transport(PRESET_ASSEMBLY_ROUTE, { method: "GET", credentials: "same-origin" });
  if (!response.ok) throw new PresetAssemblyProtocolError(`${PRESET_ASSEMBLY_ROUTE} answered ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PresetAssemblyProtocolError(`${PRESET_ASSEMBLY_ROUTE} answered no JSON body`);
  }
  return validatePresetAssemblyRead(body);
}

/**
 * The readout, or the refusal naming the member that drifted.
 *
 * Every field is checked against the others where they are one fact: `total` is `enabled + disabled`, `count` is
 * the number of blocks, `depths` is the blocks' own distinct depths in their own order, and a macro's `code` is
 * built from its `name`. A body that states any of those twice and disagrees with itself is refused by the name of
 * the field, never rendered.
 */
export function validatePresetAssemblyRead(value: unknown): PresetAssemblyReadV1 {
  expectRecord(value, "the body");
  expectKeys(value, "the body", ["apiVersion", "presets"], ["activePreset"]);
  if (value.apiVersion !== 1) refuse("apiVersion", `is ${String(value.apiVersion)}, not 1`);
  if (!Array.isArray(value.presets)) refuse("presets", "is not a list");
  if (value.presets.length > MAX_PRESETS) refuse("presets", `holds ${value.presets.length} entries`);
  const activePreset = value.activePreset === undefined ? undefined : activeBindingOf(value.activePreset);
  return Object.freeze({
    apiVersion: 1 as const,
    presets: Object.freeze(value.presets.map((preset, index) => presetOf(preset, `presets[${index}]`))),
    ...(activePreset === undefined ? {} : { activePreset }),
  });
}

/**
 * Which preset is in force, as one of the three states the Host's contract declares.
 *
 * An unknown state is refused by name rather than drawn as "no preset": the two readings lead a player in opposite
 * directions (import a preset versus do nothing), so guessing is the one thing this validator may not do.
 */
function activeBindingOf(value: unknown): PresetActiveBindingV1 {
  expectRecord(value, "activePreset");
  if (value.state === "none") {
    expectExactKeys(value, "activePreset", ["state"]);
    return Object.freeze({ state: "none" as const });
  }
  if (value.state === "bound" || value.state === "missing") {
    expectExactKeys(value, "activePreset", ["state", "presetId"]);
    if (typeof value.presetId !== "string" || value.presetId.length === 0)
      refuse("activePreset.presetId", `is ${String(value.presetId)}, not a preset id`);
    return Object.freeze({ state: value.state, presetId: value.presetId });
  }
  return refuse("activePreset.state", `is ${String(value.state)}, which this surface cannot name`);
}

function presetOf(value: unknown, path: string): PresetAssemblySurfaceV1 {
  expectRecord(value, path);
  expectExactKeys(value, path, [
    "presetId",
    "name",
    "revision",
    "entries",
    "disabledEntries",
    "unfilledMarkers",
    "macros",
    "depth",
    "sampling",
  ]);
  if (typeof value.presetId !== "string" || value.presetId.length === 0) refuse(`${path}.presetId`, "is not a name");
  if (value.name !== null && typeof value.name !== "string") refuse(`${path}.name`, "is neither a string nor null");
  const revision = expectCount(value.revision, `${path}.revision`);
  expectRecord(value.entries, `${path}.entries`);
  expectExactKeys(value.entries, `${path}.entries`, ["total", "enabled", "disabled"]);
  const total = expectCount(value.entries.total, `${path}.entries.total`);
  const enabled = expectCount(value.entries.enabled, `${path}.entries.enabled`);
  const disabled = expectCount(value.entries.disabled, `${path}.entries.disabled`);
  if (total !== enabled + disabled)
    refuse(
      `${path}.entries.total`,
      `is ${total}, but enabled ${enabled} + disabled ${disabled} is ${enabled + disabled}`,
    );

  const disabledEntries = identifierList(value.disabledEntries, `${path}.disabledEntries`);
  if (disabledEntries.length !== disabled)
    refuse(`${path}.disabledEntries`, `names ${disabledEntries.length} of ${disabled} disabled entries`);
  const unfilledMarkers = identifierList(value.unfilledMarkers, `${path}.unfilledMarkers`);

  if (!Array.isArray(value.macros)) refuse(`${path}.macros`, "is not a list");
  const macros = value.macros.map((macro, index) => macroOf(macro, `${path}.macros[${index}]`));

  expectRecord(value.depth, `${path}.depth`);
  expectExactKeys(value.depth, `${path}.depth`, ["count", "depths", "blocks"]);
  const count = expectCount(value.depth.count, `${path}.depth.count`);
  if (!Array.isArray(value.depth.depths)) refuse(`${path}.depth.depths`, "is not a list");
  const depths = value.depth.depths.map((depth, index) => expectCount(depth, `${path}.depth.depths[${index}]`));
  if (!Array.isArray(value.depth.blocks)) refuse(`${path}.depth.blocks`, "is not a list");
  const blocks = value.depth.blocks.map((block, index) => blockOf(block, `${path}.depth.blocks[${index}]`));
  if (count !== blocks.length)
    refuse(`${path}.depth.count`, `is ${count}, but there are ${blocks.length} blocks beside it`);
  const distinct = [...new Set(blocks.map((block) => block.depth))];
  if (distinct.length !== depths.length || distinct.some((depth, index) => depth !== depths[index]))
    refuse(`${path}.depth.depths`, `is [${depths.join(", ")}], but the blocks land at [${distinct.join(", ")}]`);

  if (!Array.isArray(value.sampling) && (typeof value.sampling !== "object" || value.sampling === null))
    refuse(`${path}.sampling`, "is neither rows nor the reason there are none");
  const sampling = samplingReadingOf(value.sampling, `${path}.sampling`);

  return Object.freeze({
    presetId: value.presetId,
    name: value.name,
    revision,
    entries: Object.freeze({ total, enabled, disabled }),
    disabledEntries,
    unfilledMarkers,
    macros: Object.freeze(macros),
    depth: Object.freeze({ count, depths: Object.freeze(depths), blocks: Object.freeze(blocks) }),
    sampling: Object.freeze(sampling),
  });
}

/**
 * One sampling row, or the refusal naming the member that drifted.
 *
 * The two cross-field facts are checked here for the same reason the depth count is: `source` and `value` are one
 * fact with two spellings. An `unset` row carries `null` because nothing is sent, and a settable layer carries a finite
 * number because something is - a body that says otherwise is refused rather than rendered.
 */
function samplingRowOf(value: unknown, path: string): PresetSamplingRowV1 {
  expectRecord(value, path);
  expectExactKeys(value, path, ["key", "value", "source"]);
  if (typeof value.key !== "string" || value.key.length === 0) refuse(`${path}.key`, "is not a sampling key");
  const key = value.key;
  const declared = value.source;
  if (typeof declared !== "string") refuse(`${path}.source`, `is ${String(declared)}, which is not a sampling source`);
  const source = PRESET_SAMPLING_SOURCES.find((candidate) => candidate === declared);
  if (source === undefined)
    refuse(
      `${path}.source`,
      `is "${declared}", which is none of ${PRESET_SAMPLING_SOURCES.join(", ")} - an unrecognised layer cannot be ` +
        "reported as the preset's",
    );
  if (source === "unset") {
    if (value.value !== null)
      refuse(`${path}.value`, `is ${String(value.value)}, but a key no layer sets carries null`);
    return Object.freeze({ key, value: null, source });
  }
  const sampled = value.value;
  if (typeof sampled !== "number" || !Number.isFinite(sampled))
    refuse(`${path}.value`, `is ${String(sampled)}, but ${source} sets it, so a finite number is what is sent`);
  return Object.freeze({ key, value: sampled, source });
}

/**
 * The sampler reading: the rows in force, or the named reason there are none.
 *
 * The two shapes are exclusive by construction, and each way a body can try to have it both ways is refused by its
 * own name: rows and a reason together, a reason with rows still attached beside it, a reason this surface has no
 * line for, and an object that states neither. A generic "invalid sampling" would tell a reader nothing about which
 * of those four the Host sent.
 */
function samplingReadingOf(value: unknown, path: string): readonly PresetSamplingRowV1[] | PresetSamplingUnavailableV1 {
  if (Array.isArray(value)) {
    const rows = value.map((row, index) => samplingRowOf(row, `${path}[${index}]`));
    const repeated = rows.map((row) => row.key).filter((key, index, keys) => keys.indexOf(key) !== index);
    if (repeated.length > 0)
      refuse(path, `carries ${[...new Set(repeated)].join(", ")} twice, so one row is not the one in force`);
    return Object.freeze(rows);
  }
  expectRecord(value, path);
  const present = Object.keys(value);
  if (!present.includes("unavailable")) {
    refuse(
      path,
      present.length === 0
        ? "carries neither the rows nor the reason there are none"
        : `carries ${present.join(", ")} and no reason, so it states neither rows nor an absence`,
    );
  }
  const beside = present.filter((key) => key !== "unavailable");
  if (beside.includes("rows"))
    refuse(path, `carries both the reason and the rows (${beside.join(", ")}), so one fact has two answers`);
  if (beside.length > 0)
    refuse(path, `carries ${beside.join(", ")} beside the reason, so rows are still attached to an absence`);
  const declared = value.unavailable;
  if (typeof declared !== "string") refuse(`${path}.unavailable`, `is ${String(declared)}, which is not a reason`);
  const reason = PRESET_SAMPLING_UNAVAILABLE_REASONS.find((candidate) => candidate === declared);
  if (reason === undefined)
    refuse(
      `${path}.unavailable`,
      `is "${declared}", which is none of ${PRESET_SAMPLING_UNAVAILABLE_REASONS.join(", ")} - this surface has no ` +
        "line for an absence it cannot name",
    );
  return Object.freeze({ unavailable: reason });
}

function macroOf(value: unknown, path: string): PresetAssemblyMacroV1 {
  expectRecord(value, path);
  expectExactKeys(value, path, ["code", "name", "entries"]);
  if (typeof value.name !== "string" || value.name.length === 0) refuse(`${path}.name`, "is not a macro name");
  const name = value.name;
  if (typeof value.code !== "string") refuse(`${path}.code`, "is not a string");
  const code = value.code;
  const named = MACRO_CODE.exec(code);
  if (named === null) refuse(`${path}.code`, `is "${code}", which is neither macro code`);
  if (named[1] !== name) refuse(`${path}.code`, `is "${code}", but the macro it stands beside is "${name}"`);
  const entries = identifierList(value.entries, `${path}.entries`);
  if (entries.length === 0) refuse(`${path}.entries`, "names no entry, so nothing tells the player where it is");
  return Object.freeze({ code, name, entries });
}

function blockOf(value: unknown, path: string): PresetAssemblyDepthBlockV1 {
  expectRecord(value, path);
  expectExactKeys(value, path, ["identifier", "depth"]);
  if (typeof value.identifier !== "string" || value.identifier.length === 0)
    refuse(`${path}.identifier`, "is not an entry identifier");
  return Object.freeze({ identifier: value.identifier, depth: expectCount(value.depth, `${path}.depth`) });
}

function identifierList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) refuse(path, "is not a list");
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== "string" || entry.length === 0) refuse(`${path}[${index}]`, "is not an identifier");
      return entry;
    }),
  );
}

/** A non-negative integer, which is the only form every count in this readout takes. */
function expectCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    refuse(path, `is ${String(value)}, not a whole number of at least zero`);
  return value;
}

function expectRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(path, "is not an object");
}

/**
 * The exact member set, split into what the body MUST carry and what the contract declares optional.
 *
 * The split is the Host contract's (`PresetAssemblyReadV1Schema` marks `activePreset` `Type.Optional`), not a list
 * invented here: a member added on the Host side is a refusal until this surface can show it, and a member the
 * contract makes optional stays readable when it is absent.
 */
function expectKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[],
): void {
  const present = Object.keys(value);
  const extra = present.filter((key) => !required.includes(key) && !optional.includes(key));
  const missing = required.filter((key) => !present.includes(key));
  if (missing.length > 0) refuse(path, `does not carry ${missing.join(", ")}`);
  if (extra.length > 0) refuse(path, `carries ${extra.join(", ")}, which this surface cannot show`);
}

/**
 * The exact member set, so a field the Host added is a refusal rather than a value this surface silently ignores.
 * `presets[]` is the one place a reader is meant to see the whole readout, and an unknown key there is a fact the
 * player is not being shown.
 */
function expectExactKeys(value: Record<string, unknown>, path: string, keys: readonly string[]): void {
  const present = Object.keys(value);
  const extra = present.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !present.includes(key));
  if (missing.length > 0) refuse(path, `does not carry ${missing.join(", ")}`);
  if (extra.length > 0) refuse(path, `carries ${extra.join(", ")}, which this surface cannot show`);
}

function refuse(path: string, finding: string): never {
  throw new PresetAssemblyProtocolError(`${path} ${finding} - ${PREREQUISITE}`);
}
