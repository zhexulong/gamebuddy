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
 */

export type PresetAssemblyMacroV1 = Readonly<{
  /** `macro_not_implemented:<name>` or `macro_unknown:<name>`. */
  code: string;
  name: string;
  entries: readonly string[];
}>;

export type PresetAssemblyDepthBlockV1 = Readonly<{ identifier: string; depth: number }>;

export type PresetAssemblySurfaceV1 = Readonly<{
  presetId: string;
  name: string | null;
  revision: number;
  entries: Readonly<{ total: number; enabled: number; disabled: number }>;
  disabledEntries: readonly string[];
  unfilledMarkers: readonly string[];
  macros: readonly PresetAssemblyMacroV1[];
  depth: Readonly<{ count: number; depths: readonly number[]; blocks: readonly PresetAssemblyDepthBlockV1[] }>;
}>;

export type PresetAssemblyReadV1 = Readonly<{ apiVersion: 1; presets: readonly PresetAssemblySurfaceV1[] }>;

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
  expectExactKeys(value, "the body", ["apiVersion", "presets"]);
  if (value.apiVersion !== 1) refuse("apiVersion", `is ${String(value.apiVersion)}, not 1`);
  if (!Array.isArray(value.presets)) refuse("presets", "is not a list");
  if (value.presets.length > MAX_PRESETS) refuse("presets", `holds ${value.presets.length} entries`);
  return Object.freeze({
    apiVersion: 1 as const,
    presets: Object.freeze(value.presets.map((preset, index) => presetOf(preset, `presets[${index}]`))),
  });
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

  return Object.freeze({
    presetId: value.presetId,
    name: value.name,
    revision,
    entries: Object.freeze({ total, enabled, disabled }),
    disabledEntries,
    unfilledMarkers,
    macros: Object.freeze(macros),
    depth: Object.freeze({ count, depths: Object.freeze(depths), blocks: Object.freeze(blocks) }),
  });
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
