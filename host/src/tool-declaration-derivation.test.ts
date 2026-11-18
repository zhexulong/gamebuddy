import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

import { STARDEW_ACTION_ADAPTERS } from "./action-registry.js";
import { buildCandidateToolSchema, createStardewActionTools, type MoveCapableIntegration } from "./game-tools.js";
import type { ActionRegistration, ActionRegistrationDescriptor, Scope, Snapshot } from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { readSourceShape } from "./test-support/source-shape.test-support.js";

/**
 * `a_tool_restates_its_own_declaration` — an action is declared once, in `action-surface.v1.json`, and the Host writes
 * its own copy of that action in two more places: an entry in `STARDEW_ACTION_ADAPTERS` and a `makeGameActionTool`
 * mount block whose parameter schema and forwarded arguments spell the declaration's arguments again.
 *
 * <p>
 * WHAT THE DECLARATION OWNS, measured on this checkout rather than assumed. Every action in the artifact publishes
 * `actionId`, `identityVersion`, `lifecycle`, `kind` and `argumentSchema`, so the action's argument set is the whole of
 * what the two Host surfaces can restate. The adapter table restates almost none of it: `requiredCapability` is the
 * action id and `supportedIdentityVersions` is the frozen `[1]` that `actionAdapter` writes for every action, while
 * `label`, `description` and `targetKinds` are Host presentation the artifact never publishes. The mount block is where
 * the restatement lives: its `parameters` schema and the argument names its `toArgs` forwards are both a second spelling
 * of `argumentSchema`, and `buildCandidateToolSchema`'s explicit arms are a third.
 * </p>
 *
 * <p>
 * THE PROPERTY, one action at a time: its tool schema and its forwarded argument set are DERIVED from the declaration,
 * or the action carries a stated reason why not. The reading is over the SOURCE of `game-tools.ts` rather than over the
 * built schemas, because the authoring act is what distinguishes the two: a mount that calls `buildCandidateToolSchema`
 * produces the derived schema by construction, so comparing the built schema against the same builder would agree with
 * itself no matter what was written in the mount.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE ARTIFACT — every action in `action-surface.v1.json`, read as data, never a list written here.
 * The mounted tool set is the product's own `createStardewActionTools` over registrations built from that same artifact;
 * the adapter entries are the product's own table. The gate prints
 * `actions examined A · derived D · hand-written H · stated S`, asserts `A = D + H + S`, and fails when any `H` is left
 * unstated: a mount that restates its declaration with no entry in `NOT_YET_DERIVABLE` is the finding this gate exists
 * for, and a new action arriving as a hand-written copy is exactly that shape.
 * </p>
 *
 * <p>
 * WHAT IS CONVERTED (2026-11-18): `sleep`. It is the easiest action in the artifact because its `argumentSchema` is the
 * empty object, so the derivation has no member to judge — no enum, no range, no declared description, no optional key,
 * no target family — and its mount already forwarded through `declaredArguments(descriptor, params)`. The one
 * hand-written restatement left was a `buildCandidateToolSchema` arm returning the empty object schema, which the
 * descriptor-derived fallback produces byte for byte; that arm is gone. `ride_bus` is the exact twin that was NOT
 * converted — the same empty declared argument set, the same arm — so the gate has to tell the two apart and does: one
 * derived, one stated `declaration_override`.
 * </p>
 *
 * <p>
 * THE REGISTER IS AN ALLOW-LIST THAT EXPIRES. `NOT_YET_DERIVABLE` names each action that is not derivable today and the
 * exact residue the gate detects for it. An entry that no longer describes its mount (the residue changed, or the action
 * became derived) fails the gate by name, so the register cannot outlive the work it excuses, and an action that leaves
 * the artifact cannot leave a stale entry behind.
 * </p>
 *
 * red-proof: put the `if (actionId === "sleep")` arm back -> `sleep` reads `stated` with `declaration_override` and
 *   `derived` drops 9 -> 8. Measured 2026-11-18 with the arm restored in `host/src/game-tools.ts`.
 * red-proof: delete one `NOT_YET_DERIVABLE` entry -> the gate fails naming that action and the residue it detected.
 * red-proof: give a converted mount a member (`parameters` gained `requestId`) -> the byte-identity test names the
 *   schema the declaration does not imply, and the derived cross-check names the argument the declaration never had.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, found by walking up to the directory that holds the generated action surface. */
function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "integrations", "stardew", "action-development"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository_root_not_found:${start}`);
    directory = parent;
  }
}

const ROOT = repositoryRoot(HERE);
const SURFACE_PATH = join(
  ROOT,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);
const GAME_TOOLS_PATH = join(ROOT, "host", "src", "game-tools.ts");

type DeclaredArgument = Readonly<{ type: string; enum?: readonly string[] }>;
type SurfaceAction = Readonly<{
  actionId: string;
  identityVersion: number;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, DeclaredArgument>>;
  effect?: "read" | "write";
  postcondition?: Readonly<{ name?: string }>;
  nativeBinding?: string;
}>;

function publishedSurface(): readonly SurfaceAction[] {
  const parsed = JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as Readonly<{
    schema?: unknown;
    actions?: readonly SurfaceAction[];
  }>;
  if (parsed.schema !== "gamebuddy-action-descriptors/v1" || !Array.isArray(parsed.actions))
    throw new Error("stardew_action_surface_artifact_invalid_shape");
  return parsed.actions;
}

/** The descriptor a `hello_ack` publishes for one artifact action: the declaration, in the Mod's own wire shape. */
function publishedDescriptor(action: SurfaceAction): ActionRegistrationDescriptor {
  return {
    arguments: Object.entries(action.argumentSchema ?? {}).map(([name, schema]) => ({
      name,
      type: schema.type,
      ...(schema.enum === undefined ? {} : { enum: schema.enum }),
    })),
    ...(action.effect === undefined ? {} : { effect: action.effect }),
    ...(action.postcondition?.name === undefined ? {} : { postcondition: { name: action.postcondition.name } }),
    ...(action.nativeBinding === undefined ? {} : { nativeBinding: action.nativeBinding }),
  };
}

/** The registrations a live `hello_ack` advertises for the artifact. `familyId` is the one field it does not publish. */
function registrationsFrom(published: readonly SurfaceAction[]): readonly ActionRegistration[] {
  return published.map((action) =>
    Object.freeze({
      actionId: action.actionId,
      familyId: action.actionId,
      identityVersion: action.identityVersion,
      lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
      kind: action.kind as ActionRegistration["kind"],
      descriptor: publishedDescriptor(action),
    }),
  );
}

const SCOPE: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_tool_declaration",
  worldId: "world_tool_declaration",
  playerId: "player_tool_declaration",
  companionId: "companion_tool_declaration",
});

function integrationFor(registrations: readonly ActionRegistration[]): MoveCapableIntegration {
  const capabilities = registrations
    .filter((registration) => registration.kind === "execution")
    .map((registration) => registration.actionId);
  const snapshot: Snapshot = {
    revision: 1,
    location: "Farm",
    tile: { x: 10, y: 15 },
    stamina: 100,
    exhausted: false,
    health: 100,
    actionable: true,
    capabilities,
    catalogRevision: 1,
    enabledActionIds: capabilities,
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    activeExecution: null,
  };
  return {
    scope: SCOPE,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session_tool_declaration",
      capabilities,
      catalogRevision: 1,
      enabledActionIds: capabilities,
      snapshot,
      latestReceipt: null,
      latestReasonCode: null,
      catalogRegistrations: registrations,
    },
    async execute() {
      throw new Error("tool_declaration_gate_never_executes");
    },
    async cancel() {
      throw new Error("tool_declaration_gate_never_cancels");
    },
  } as unknown as MoveCapableIntegration;
}

/** Every Game Action tool the product mounts for the artifact, keyed by the action the tool's own name names. */
function mountedActionTools(published: readonly SurfaceAction[]) {
  const integration = integrationFor(registrationsFrom(published));
  const tools = createStardewActionTools(integration, undefined, () => {
    throw new Error("tool_declaration_gate_never_dispatches");
  });
  const known = new Set(published.map((action) => action.actionId));
  const mounted = new Map<string, (typeof tools)[number]>();
  for (const tool of tools) {
    if (!tool.name.startsWith("stardew_")) continue;
    const actionId = tool.name.slice("stardew_".length);
    if (!known.has(actionId)) continue;
    if (mounted.has(actionId)) throw new Error(`two_mounted_tools_for_one_action:${actionId}`);
    mounted.set(actionId, tool);
  }
  return { tools, mounted };
}

/** How one mount was authored: where its schema came from, and where the argument names it forwards came from. */
type MountAuthoring = Readonly<{
  parameters: "declaration" | "inline" | "unread";
  forwards: "declaration" | "hand" | "unread";
}>;

const MOUNT_CALL = "makeGameActionTool({";
const LOOP_TABLE = /for \(const action of \[([^\]]*)\] as const\)/gu;

/**
 * Read every mount's authoring act out of the source's one-line shape. Two shapes are derived and everything else is a
 * restatement: `parameters: schema`, where `schema` is what `buildCandidateToolSchema` returned, and
 * `toArgs: (params) => declaredArguments(descriptor, params)`. A mount written `action,` inside
 * `for (const action of [...] as const)` serves every id that table names, so its ids come from the table above it.
 *
 * A block whose ids cannot be read, or whose `parameters`/`toArgs` matches neither shape, is kept as `unread` rather
 * than guessed: `unread` is a residue no stated reason covers, so it lands in `hand-written` and names itself.
 */
function authoringFromShape(shape: string): Readonly<{
  authored: ReadonlyMap<string, MountAuthoring>;
  blocks: number;
  unattributable: readonly number[];
}> {
  const authored = new Map<string, MountAuthoring>();
  const unattributable: number[] = [];
  const starts: number[] = [];
  for (let at = shape.indexOf(MOUNT_CALL); at !== -1; at = shape.indexOf(MOUNT_CALL, at + 1)) starts.push(at);
  let previousShorthandStart = -1;
  for (const [position, start] of starts.entries()) {
    const next = starts[position + 1];
    const window = shape.slice(start, next === undefined ? shape.length : next);
    const named = /action: "([a-z_]+)"/u.exec(window)?.at(1);
    let ids: readonly string[] = named === undefined ? [] : [named];
    if (ids.length === 0 && /\baction,/u.test(window)) {
      // The table this block iterates is the last one declared between the previous shorthand mount and this one.
      const between = shape.slice(previousShorthandStart + 1, start);
      const table = [...between.matchAll(LOOP_TABLE)].at(-1)?.[1];
      ids =
        table === undefined
          ? []
          : [...table.matchAll(/"([a-z_]+)"/gu)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
      previousShorthandStart = start;
    }
    if (ids.length === 0) unattributable.push(position);
    const parametersAt = window.indexOf("parameters:");
    const forwardsAt = window.indexOf("toArgs:");
    const authoring = {
      parameters: readParameterAuthoring(parametersAt === -1 ? "" : window.slice(parametersAt, parametersAt + 24)),
      forwards: readForwardsAuthoring(forwardsAt === -1 ? "" : window.slice(forwardsAt, forwardsAt + 90)),
    };
    for (const id of ids) authored.set(id, authoring);
  }
  return { authored, blocks: starts.length, unattributable };
}

/** Where a mount's parameter schema came from, read from the declaration up to the first argument. */
function readParameterAuthoring(text: string): MountAuthoring["parameters"] {
  if (text.startsWith("parameters: schema,")) return "declaration";
  if (text.startsWith("parameters: Type.Object(")) return "inline";
  return "unread";
}

/** Where the names a mount forwards came from: the declaration's own list, or a list written in the mount. */
function readForwardsAuthoring(text: string): MountAuthoring["forwards"] {
  if (text === "") return "unread";
  return /^toArgs: \([^)]*\) => declaredArguments\(/u.test(text) ? "declaration" : "hand";
}

/**
 * The actions `buildCandidateToolSchema` answers with a hand-written arm instead of its descriptor-derived fallback. The
 * boundary is the fallback's own first line: everything the function decides before it is an override.
 */
function overriddenActionIds(shape: string): ReadonlySet<string> {
  const start = shape.indexOf("export function buildCandidateToolSchema(");
  assert.notEqual(start, -1, "the derivation reader must find buildCandidateToolSchema in game-tools.ts");
  const fallback = shape.indexOf("const declaredNames = declaredArgumentNames(descriptor);", start);
  assert.notEqual(fallback, -1, "the derivation reader must find the descriptor-derived fallback it reads up to");
  return new Set(
    [...shape.slice(start, fallback).matchAll(/actionId === "([a-z_]+)"/gu)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
}

/**
 * The reasons an action's tool is not derived yet, each with the fact that makes it so. An authoring shape with no entry
 * here is not stated — it is `hand-written`, which is the finding: a copy nobody has explained.
 */
const RESIDUE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  no_tool:
    "the Host mounts no Game Action tool for it, so there is no tool schema to restate the declaration; the action is " +
    "reached through the observation surface or not at all",
  parameters_inline:
    "the mount writes its parameter schema inline — Host target and request arguments (`x`, `y`, `expectedTargetId`, " +
    "`slot`, `requestId`, `idempotencyKey`) the declaration does not publish, and a bounded schema where the " +
    "declaration publishes a bare type — instead of projecting the declaration's `argumentSchema`, so the tool's " +
    "argument set is a second spelling of the declaration's",
  forwards_by_hand:
    "the mount names the arguments it forwards, in a literal object or in a Host constant such as " +
    "`TILE_TARGET_ARGUMENTS`, instead of `declaredArguments(descriptor, params)`, so the forwarded set is a second " +
    "spelling of the declaration's",
  declaration_override:
    "`buildCandidateToolSchema` carries a hand-written arm for it instead of the descriptor-derived fallback",
});

type Residue = keyof typeof RESIDUE_REASONS | "authoring_unread";

/**
 * THE REGISTER: every action whose tool is not derived from its declaration today, with the exact residue the gate
 * detects for it. It is an allow-list with an expiry — an entry that stops describing its mount fails the gate.
 *
 * WHERE THE 97 STAND (2026-11-18, this checkout): 3 mount no tool at all; 12 keep a hand-written
 * `buildCandidateToolSchema` arm; 82 restate the declaration in the mount itself — 55 of those spell both the parameter
 * schema and the forwarded names, 27 only the forwarded names. None of them is a reason to stop; every one of them is
 * an action nobody has moved yet, and moving one means deleting its line here.
 */
const NOT_YET_DERIVABLE: Readonly<Record<string, Residue | readonly Residue[]>> = Object.freeze({
  accept_daily_quest: "forwards_by_hand",
  accept_special_order: "forwards_by_hand",
  answer_dialogue: "forwards_by_hand",
  bait_crab_pot: ["forwards_by_hand", "parameters_inline"],
  break_container: "forwards_by_hand",
  break_resource_clump: "forwards_by_hand",
  break_rock: ["forwards_by_hand", "parameters_inline"],
  build_farm_building: "forwards_by_hand",
  chest_retrieve: ["forwards_by_hand", "parameters_inline"],
  chest_store: ["forwards_by_hand", "parameters_inline"],
  chop_stump: ["forwards_by_hand", "parameters_inline"],
  chop_tree: ["forwards_by_hand", "parameters_inline"],
  claim_mail_attachment: "forwards_by_hand",
  claim_museum_reward: "forwards_by_hand",
  clear_cask: ["forwards_by_hand", "parameters_inline"],
  clear_debris: ["forwards_by_hand", "parameters_inline"],
  clear_fish_pond: "forwards_by_hand",
  clear_hoedirt: ["forwards_by_hand", "parameters_inline"],
  collect_animal_product: ["forwards_by_hand", "parameters_inline"],
  collect_crab_pot_output: ["forwards_by_hand", "parameters_inline"],
  color_placed_object: "forwards_by_hand",
  cook_recipe: ["forwards_by_hand", "parameters_inline"],
  craft_item: ["forwards_by_hand", "parameters_inline"],
  cut_grass: ["forwards_by_hand", "parameters_inline"],
  cut_weeds: ["forwards_by_hand", "parameters_inline"],
  deposit_silo_hay: ["forwards_by_hand", "parameters_inline"],
  dig_artifact_spot: ["forwards_by_hand", "parameters_inline"],
  dress_mannequin: ["forwards_by_hand", "parameters_inline"],
  dye_clothing_with_item: "forwards_by_hand",
  enter_exit: ["forwards_by_hand", "parameters_inline"],
  enter_mine: ["forwards_by_hand", "parameters_inline"],
  equip_tool: ["forwards_by_hand", "parameters_inline"],
  equip_wearable: "forwards_by_hand",
  express_emote: ["declaration_override", "forwards_by_hand"],
  face_direction: ["declaration_override", "forwards_by_hand"],
  feed_animal: ["forwards_by_hand", "parameters_inline"],
  fertilize_tile: ["forwards_by_hand", "parameters_inline"],
  find_destination: "no_tool",
  fish_here: ["forwards_by_hand", "parameters_inline"],
  harvest_bush: ["forwards_by_hand", "parameters_inline"],
  harvest_crop: ["forwards_by_hand", "parameters_inline"],
  harvest_fruit_tree: ["forwards_by_hand", "parameters_inline"],
  inspect_world_map: "no_tool",
  interact_npc_with_item: ["declaration_override", "forwards_by_hand"],
  machine_collect_output: ["forwards_by_hand", "parameters_inline"],
  machine_inspect: ["forwards_by_hand", "parameters_inline"],
  machine_load: ["forwards_by_hand", "parameters_inline"],
  mount_transport: ["forwards_by_hand", "parameters_inline"],
  move_placed_furniture: "forwards_by_hand",
  move_to_tile: ["forwards_by_hand", "parameters_inline"],
  name_entity: "forwards_by_hand",
  navigate_to_destination: ["forwards_by_hand", "parameters_inline"],
  npc_relationship: ["forwards_by_hand", "parameters_inline"],
  observe_scene: "no_tool",
  open_geode: "forwards_by_hand",
  pan_ore: "forwards_by_hand",
  pet_animal: ["declaration_override", "forwards_by_hand"],
  pet_farm_animal: ["declaration_override", "forwards_by_hand"],
  pickup_forage: ["forwards_by_hand", "parameters_inline"],
  pickup_item: ["forwards_by_hand", "parameters_inline"],
  place_crab_pot: ["forwards_by_hand", "parameters_inline"],
  place_item_on_pedestal: "forwards_by_hand",
  place_owned_object: "forwards_by_hand",
  place_wood_fence: ["forwards_by_hand", "parameters_inline"],
  plant_sapling: ["forwards_by_hand", "parameters_inline"],
  plant_seed: ["forwards_by_hand", "parameters_inline"],
  put_item_in_fish_tank: "forwards_by_hand",
  refill_watering_can: ["forwards_by_hand", "parameters_inline"],
  remove_fence: "forwards_by_hand",
  remove_placed_item: "forwards_by_hand",
  respond_level_up: ["declaration_override", "forwards_by_hand"],
  ride_bus: "declaration_override",
  ride_minecart: ["declaration_override", "forwards_by_hand"],
  rotate_furniture: "forwards_by_hand",
  scythe_crop: ["forwards_by_hand", "parameters_inline"],
  send_multiplayer_chat: "forwards_by_hand",
  set_sign_display: ["forwards_by_hand", "parameters_inline"],
  shake_tree: ["forwards_by_hand", "parameters_inline"],
  ship_item: ["forwards_by_hand", "parameters_inline"],
  tailor_clothing: "forwards_by_hand",
  take_pedestal_item: ["forwards_by_hand", "parameters_inline"],
  talk_to_npc: ["declaration_override", "forwards_by_hand"],
  till_soil: ["forwards_by_hand", "parameters_inline"],
  toggle_animal_door: ["declaration_override", "forwards_by_hand"],
  toggle_fence_gate: ["forwards_by_hand", "parameters_inline"],
  toggle_tool_light: ["forwards_by_hand", "parameters_inline"],
  travel: ["forwards_by_hand", "parameters_inline"],
  unequip_wearable: "forwards_by_hand",
  use_item: ["forwards_by_hand", "parameters_inline"],
  use_mine_ladder: "forwards_by_hand",
  use_obelisk: ["declaration_override", "forwards_by_hand"],
  use_raft: ["forwards_by_hand", "parameters_inline"],
  use_warp_item: "forwards_by_hand",
  water_crop: ["forwards_by_hand", "parameters_inline"],
  water_pet_bowl: ["forwards_by_hand", "parameters_inline"],
  water_slime_hutch_trough: ["forwards_by_hand", "parameters_inline"],
  withdraw_silo_hay: ["declaration_override", "forwards_by_hand"],
});

function declaredResidues(residue: Residue | readonly Residue[] | undefined): readonly Residue[] {
  if (residue === undefined) return [];
  return typeof residue === "string" ? [residue] : [...residue].sort();
}

type Verdict = "derived" | "stated" | "hand-written";

type ActionReading = Readonly<{ actionId: string; verdict: Verdict; residues: readonly Residue[] }>;
type GateReading = Readonly<{
  actions: readonly ActionReading[];
  derived: number;
  stated: number;
  handWritten: number;
  /** Register entries that no longer describe the tree: the action is derived now, or left the artifact. */
  expired: readonly string[];
}>;

/**
 * The judgment, as one function over the readings, so the falsifier can drive it on purpose: the population is the
 * artifact, the authoring acts and the arms are the source's, and the register is the allow-list.
 */
function gateReading(
  published: readonly SurfaceAction[],
  authored: ReadonlyMap<string, MountAuthoring>,
  arms: ReadonlySet<string>,
  register: Readonly<Record<string, Residue | readonly Residue[]>> = NOT_YET_DERIVABLE,
): GateReading {
  const actions: ActionReading[] = [];
  const byId = new Map(published.map((action) => [action.actionId, action]));
  for (const actionId of [...byId.keys()].sort((left, right) => left.localeCompare(right, "en"))) {
    const detected: Residue[] = [];
    const authoring = authored.get(actionId);
    if (authoring === undefined) detected.push("no_tool");
    else {
      if (authoring.parameters === "unread" || authoring.forwards === "unread") detected.push("authoring_unread");
      else {
        if (authoring.parameters !== "declaration") detected.push("parameters_inline");
        if (authoring.forwards !== "declaration") detected.push("forwards_by_hand");
      }
      if (arms.has(actionId)) detected.push("declaration_override");
    }
    const sorted = [...detected].sort();
    const stated = declaredResidues(register[actionId]);
    actions.push({ actionId, verdict: verdictFor(sorted, stated), residues: sorted });
  }
  const expired: string[] = [];
  for (const actionId of Object.keys(register)) {
    const reading = actions.find((entry) => entry.actionId === actionId);
    if (reading === undefined) expired.push(`${actionId}:no longer in the artifact`);
    else if (reading.verdict === "derived") expired.push(`${actionId}:derived now, so its entry is spent`);
  }
  const count = (verdict: Verdict) => actions.filter((entry) => entry.verdict === verdict).length;
  return { actions, derived: count("derived"), stated: count("stated"), handWritten: count("hand-written"), expired };
}

/**
 * One action's verdict: derived when it restates nothing; stated when the register names exactly the residues detected
 * and every one of them has a sentence; hand-written otherwise, which is the finding.
 */
function verdictFor(residues: readonly Residue[], stated: readonly Residue[]): Verdict {
  if (residues.length === 0) return "derived";
  if (residues.some((residue) => RESIDUE_REASONS[residue] === undefined)) return "hand-written";
  return stated.join("+") === residues.join("+") ? "stated" : "hand-written";
}

function summaryLine(examined: number, reading: GateReading): string {
  return (
    `actions examined ${String(examined)} · derived ${String(reading.derived)} · ` +
    `hand-written ${String(reading.handWritten)} · stated ${String(reading.stated)}`
  );
}

/** The actions a verdict names, so a count that moved says which member moved it. */
function membersWith(reading: GateReading, verdict: Verdict): readonly string[] {
  return reading.actions.filter((entry) => entry.verdict === verdict).map((entry) => entry.actionId);
}

function verdictOf(reading: GateReading, actionId: string): ActionReading | undefined {
  return reading.actions.find((entry) => entry.actionId === actionId);
}

test("a_tool_restates_its_own_declaration: every action's tool is derived or states why it is not", (t) => {
  const published = publishedSurface();
  const { tools, mounted } = mountedActionTools(published);
  const shape = readSourceShape(GAME_TOOLS_PATH).shape;
  const { authored, blocks, unattributable } = authoringFromShape(shape);
  const reading = gateReading(published, authored, overriddenActionIds(shape));

  t.diagnostic(summaryLine(published.length, reading));

  // The reader's own population: every mount block is accounted for, or the count below measures a subset of the file.
  assert.deepEqual(
    unattributable,
    [],
    `mount block(s) ${unattributable.join(", ")} name no action this reader can read, so the reading below is partial`,
  );
  assert.ok(blocks > 50, `blocked: the reader found only ${String(blocks)} mount blocks in game-tools.ts`);

  // Zero population and a self-agreeing count are both blocked rather than green.
  assert.ok(published.length > 50, `blocked: the artifact published only ${String(published.length)} actions`);
  assert.ok(tools.length > 50, `blocked: the product mounted only ${String(tools.length)} tools`);
  assert.equal(
    published.length,
    reading.derived + reading.stated + reading.handWritten,
    `${summaryLine(published.length, reading)}: every action must be exactly one of the three, and those counts do ` +
      `not add up to the population`,
  );
  assert.ok(
    reading.derived > 0,
    `${summaryLine(published.length, reading)}: not one action's tool is derived from its declaration, so this gate ` +
      `has no converted member holding the reading to account and is measuring nothing`,
  );

  // The finding: a mount that restates its declaration with no entry in the register.
  const unexplained = reading.actions.filter((entry) => entry.verdict === "hand-written");
  assert.deepEqual(
    unexplained.map((entry) => `${entry.actionId}:${entry.residues.join("+")}`),
    [],
    `a tool that restates its own declaration with no stated reason:\n${unexplained
      .map((entry) => `  ${entry.actionId} [${entry.residues.join(", ")}]`)
      .join("\n")}\nstated reasons this gate knows: ${Object.keys(RESIDUE_REASONS).join(", ")}`,
  );

  // The register expires: an entry that no longer describes the tree is a statement nobody renewed.
  assert.deepEqual(
    reading.expired,
    [],
    `register entries that no longer describe this tree: ${reading.expired.join("; ")}`,
  );

  // Every stated action names a fact, and every fact it names has a sentence: a bucket of silence is not a reason.
  for (const entry of reading.actions) {
    if (entry.verdict !== "stated") continue;
    assert.ok(entry.residues.length > 0, `${entry.actionId}: stated with no reason at all`);
    for (const residue of entry.residues)
      assert.ok(
        RESIDUE_REASONS[residue] !== undefined,
        `${entry.actionId}: residue ${residue} has no sentence, so nothing says what would have to change`,
      );
  }

  // The conversion, and the twin it did not convert: the gate must tell them apart or it is not reading the arms.
  assert.deepEqual(verdictOf(reading, "sleep"), { actionId: "sleep", verdict: "derived", residues: [] });
  assert.deepEqual(verdictOf(reading, "ride_bus"), {
    actionId: "ride_bus",
    verdict: "stated",
    residues: ["declaration_override"],
  });

  t.diagnostic(
    `derived: ${membersWith(reading, "derived").join(", ")}\n` +
      `stated with a hand-written arm: ${reading.actions
        .filter((entry) => entry.residues.includes("declaration_override"))
        .map((entry) => entry.actionId)
        .join(", ")}\n` +
      `stated with no tool: ${membersWith(reading, "stated")
        .filter((actionId) => verdictOf(reading, actionId)?.residues.join("+") === "no_tool")
        .join(", ")}\n` +
      `mounted tools ${String(mounted.size)} of ${String(published.length)} declared actions`,
  );
});

test("a_tool_restates_its_own_declaration: a derived tool carries exactly the declaration's arguments", (t) => {
  // The other half of the derived claim, read from the RESULT: a mount that projects the descriptor can only ever
  // publish the declaration's argument names, so a derived action whose tool schema carries a name the artifact never
  // declared is not derived — the reading above mistook the authoring shape.
  const published = publishedSurface();
  const { mounted } = mountedActionTools(published);
  const shape = readSourceShape(GAME_TOOLS_PATH).shape;
  const reading = gateReading(published, authoringFromShape(shape).authored, overriddenActionIds(shape));
  const findings: string[] = [];
  let checked = 0;
  for (const entry of reading.actions) {
    if (entry.verdict !== "derived") continue;
    const tool = mounted.get(entry.actionId);
    if (tool === undefined) {
      findings.push(`${entry.actionId}: read as derived but no tool is mounted, so nothing carries the derivation`);
      continue;
    }
    const declaration = published.find((action) => action.actionId === entry.actionId);
    const declared = Object.keys(declaration?.argumentSchema ?? {}).sort();
    const parameters = tool.parameters as Readonly<{ properties?: Readonly<Record<string, unknown>> }>;
    const publishedNames = Object.keys(parameters.properties ?? {}).sort();
    checked += 1;
    if (declared.join(",") !== publishedNames.join(","))
      findings.push(
        `${entry.actionId}: declaration declares [${declared.join(", ")}] but the mounted tool carries ` +
          `[${publishedNames.join(", ")}]`,
      );
  }
  assert.deepEqual(findings, [], findings.join("\n"));
  assert.ok(checked > 0, `blocked: no derived action had a mounted tool to check (checked ${String(checked)})`);
  t.diagnostic(`derived tools checked against the declaration's argument names: ${String(checked)}`);
});

test("a_tool_restates_its_own_declaration: the adapter table agrees with the declaration's identity facts", (t) => {
  // The adapter entry's declaration-owned members are the id, the capability it needs and the identity versions it
  // understands; all three are written once by `actionAdapter`. Everything else on it - label, description,
  // targetKinds - is Host presentation the artifact never publishes, which is why the table cannot be derived and is
  // checked against the artifact instead.
  const published = publishedSurface();
  const { mounted } = mountedActionTools(published);
  const adapters = new Map<string, (typeof STARDEW_ACTION_ADAPTERS)[number]>(
    STARDEW_ACTION_ADAPTERS.map((entry) => [entry.actionId, entry]),
  );
  const findings: string[] = [];
  for (const action of published) {
    const adapter = adapters.get(action.actionId);
    if (adapter === undefined) {
      if (mounted.has(action.actionId))
        findings.push(`adapter_missing:${action.actionId}: the Host mounts a tool for an action it has no adapter for`);
      continue;
    }
    if (adapter.requiredCapability !== action.actionId)
      findings.push(
        `adapter_names_a_different_capability:${action.actionId}:${adapter.requiredCapability}: the declaration's ` +
          `capability is the action id`,
      );
    if (!adapter.supportedIdentityVersions.includes(action.identityVersion))
      findings.push(
        `adapter_refuses_a_published_identity_version:${action.actionId}:${String(action.identityVersion)}: reads ` +
          `[${adapter.supportedIdentityVersions.join(", ")}]`,
      );
  }
  for (const actionId of adapters.keys())
    if (!published.some((action) => action.actionId === actionId))
      findings.push(`adapter_for_an_unpublished_action:${actionId}: the artifact no longer declares it`);
  assert.deepEqual(findings, [], findings.join("\n"));
  t.diagnostic(
    `adapters examined ${String(STARDEW_ACTION_ADAPTERS.length)} · published actions ${String(published.length)} · ` +
      `mounted tools ${String(mounted.size)}`,
  );
});

test("a_tool_restates_its_own_declaration: sleep's schema is its declaration's, byte for byte", (t) => {
  const published = publishedSurface();
  const action = published.find((candidate) => candidate.actionId === "sleep");
  assert.ok(action !== undefined, "the artifact must publish the action this lane converted");
  const { mounted } = mountedActionTools(published);
  const tool = mounted.get("sleep");
  assert.ok(tool !== undefined, "sleep must still mount: the conversion removes a restatement, not a capability");

  // The declaration is the premise, asserted rather than assumed: an action that publishes no argument admits no
  // parameter beyond the empty object, so the schema below is the declaration's and not a shape picked here.
  assert.deepEqual(Object.keys(action.argumentSchema ?? {}), [], "sleep's declaration must carry no argument");
  const handWrittenArmAnswer = JSON.parse(JSON.stringify(Type.Object({}, { additionalProperties: false })));
  assert.deepEqual(
    JSON.parse(JSON.stringify(tool.parameters)),
    handWrittenArmAnswer,
    "the mounted schema must be exactly what the hand-written arm returned, and what a declaration with no argument " +
      "implies: the removal of the arm is a byte-identical de-duplication, not a schema change",
  );

  // The comparison has power: one declared argument and the two answers differ, so the equality above is not vacuous.
  const withOneArgument = JSON.parse(
    JSON.stringify(buildCandidateToolSchema("sleep", { arguments: [{ name: "requestId", type: "string" }] })),
  );
  assert.notDeepEqual(withOneArgument, handWrittenArmAnswer, "a member the arm never had must break the comparison");

  // Both descriptor shapes the wire can carry must derive one schema, which is what made the fallback safe to reach.
  assert.equal(
    JSON.stringify(buildCandidateToolSchema("sleep", { arguments: [] })),
    JSON.stringify(buildCandidateToolSchema("sleep", { argumentSchema: {} })),
    "the two declaration shapes must not derive different schemas for one action",
  );
  t.diagnostic(`sleep · declared arguments 0 · mounted parameters ${JSON.stringify(tool.parameters)}`);
});

test("a_tool_restates_its_own_declaration: falsifier — an unstated copy, an expired entry, an unreadable mount", () => {
  const published = publishedSurface();
  const shape = readSourceShape(GAME_TOOLS_PATH).shape;
  const authored = authoringFromShape(shape).authored;
  const arms = overriddenActionIds(shape);

  // Control: the real tree explains every member, so each red below is the injection and not the tree.
  const control = gateReading(published, authored, arms);
  assert.equal(control.handWritten, 0, summaryLine(published.length, control));

  // One action's register entry deleted: the gate names it and the residue it detected.
  const withoutSleepEntry = { ...NOT_YET_DERIVABLE };
  const firstStated = control.actions.find((entry) => entry.verdict === "stated");
  assert.ok(firstStated !== undefined, "the control must have a stated action to delete");
  delete withoutSleepEntry[firstStated.actionId];
  const unregistered = gateReading(published, authored, arms, withoutSleepEntry);
  assert.deepEqual(membersWith(unregistered, "hand-written"), [firstStated.actionId]);
  assert.equal(unregistered.derived + unregistered.stated + unregistered.handWritten, published.length);

  // One action's mount changed to a shape nobody stated: an inline schema where the register says declaration-only.
  const inline = new Map(authored);
  inline.set("sleep", { parameters: "inline", forwards: "hand" });
  const drifted = gateReading(published, inline, arms);
  assert.deepEqual(verdictOf(drifted, "sleep"), {
    actionId: "sleep",
    verdict: "hand-written",
    residues: ["forwards_by_hand", "parameters_inline"],
  });

  // An authoring act this reader cannot attribute is never guessed into a stated bucket.
  const unreadable = new Map(authored);
  unreadable.set("ride_bus", { parameters: "unread", forwards: "unread" });
  assert.deepEqual(verdictOf(gateReading(published, unreadable, arms), "ride_bus"), {
    actionId: "ride_bus",
    verdict: "hand-written",
    residues: ["authoring_unread", "declaration_override"],
  });

  // An entry that outlives its excuse: the converted action cannot keep a register entry, and neither can an action
  // the artifact dropped.
  const spent = { ...NOT_YET_DERIVABLE, sleep: "declaration_override" as const };
  assert.deepEqual(gateReading(published, authored, arms, spent).expired, ["sleep:derived now, so its entry is spent"]);
  const dropped = { ...NOT_YET_DERIVABLE, action_that_left_the_artifact: "no_tool" as const };
  assert.deepEqual(gateReading(published, authored, arms, dropped).expired, [
    "action_that_left_the_artifact:no longer in the artifact",
  ]);
});
