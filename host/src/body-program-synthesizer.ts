import type { BodyProgramCandidateRequest, Snapshot } from "./protocol.js";
import { isNonNegativeSafeInteger, isOpaqueId, isTileCoordinate } from "./protocol-target-facts.js";

/**
 * Host-side Body Program synthesizer (CARD-BODY-PROGRAM-SYNTHESIZER-BOUNDARY).
 *
 * The model names a set-level macro intent; this module compiles that intent plus the current
 * snapshot into standard Body Programs. It decides WHICH instances of a kind to touch and in what
 * order - never the path between them, which is the Mod's router - and it emits nothing the existing
 * execution path does not already accept:
 *
 * - node shape and per-program node count are the ones `protocol.ts` validates
 *   (`{ nodeId, actionId, arguments, dependsOn, bindings }`, at most 16 nodes), and
 *   `FarmhandBodyProgramController` runs the result unchanged;
 * - a node may only name an action that is BOTH in the Mod's Body Program catalog
 *   (`FarmhandBodyProgramCatalogProjection.TryProject` keeps `lifecycle: published` only) and enabled
 *   on this snapshot (`Snapshot.enabledActionIds`, which is policy, not surface);
 * - every argument value comes from the snapshot's own target entry, and a value the snapshot does
 *   not publish is refused by name instead of guessed.
 *
 * Order is deterministic: nearest-first by Chebyshev tile distance from the actor, then target id,
 * then action id.
 */

/** The closed set of set-level verbs a caller may ask for. */
export type MacroIntentId = "tend_crops" | "clear_obstacles" | "gather_forage" | "store_produce";

type SynthesizedBodyProgramNode = BodyProgramCandidateRequest["nodes"][number];
type BodyProgramArgument = SynthesizedBodyProgramNode["arguments"][string];
type BodyProgramArguments = SynthesizedBodyProgramNode["arguments"];

/** One program as the caller submits it: `{ nodes }` only, the caller names the `programId`. */
type SynthesizedBodyProgram = Readonly<{ nodes: readonly SynthesizedBodyProgramNode[] }>;

/** Why one instance family of the intent is absent from this turn's programs. */
type UncompilableReason = "lifecycle_not_published" | "capability_not_enabled" | `target_unresolved:${string}`;

type UncompilableFamily = Readonly<{
  family: string;
  actionId: string;
  reason: UncompilableReason;
}>;

export type SynthesizeOptions = Readonly<{
  /**
   * Action ids the Mod's Body Program catalog will accept: `lifecycle: published` and
   * `kind: execution`, exactly as `FarmhandBodyProgramCatalogProjection` projects them.
   */
  programActionIds: readonly string[];
  /** Programs the caller allows this turn. */
  maxPrograms: number;
  /** The snapshot revision the caller last promised; anything older is refused rather than compiled. */
  minimumRevision?: number;
}>;

export type SynthesizedPrograms = Readonly<{
  ok: true;
  intentId: MacroIntentId;
  programs: readonly SynthesizedBodyProgram[];
  /** Compilable instances the emitted programs do not carry. */
  remaining: number;
  /** Instances that compiled, whether or not this turn's programs carry them. */
  instanceCount: number;
  uncompilable: readonly UncompilableFamily[];
}>;

type SynthesizeRefusal = Readonly<{ ok: false; reasonCode: string }>;

export type SynthesizeResult = SynthesizedPrograms | SynthesizeRefusal;

/** Frozen maximum node count per program; mirrors the private `MAX_BODY_PROGRAM_NODES` in `protocol.ts` and the C# `BodyProgramValidation.MaximumNodes`. */
export const MAX_SYNTHESIZED_PROGRAM_NODES = 16;

/** The published arguments of one snapshot target family, resolved from the snapshot entry only. */
type InstanceTarget = Readonly<{
  targetId: string;
  x: number;
  y: number;
  /** The inventory slot the action must hold, when the family's target publishes one. */
  slot: number | undefined;
  /** The qualified item id the action must match, when the family publishes one. */
  qualifiedItemId: string | undefined;
}>;

type IntentFamily = Readonly<{
  family: string;
  actionId: string;
  /** Published argument names, exactly as the Mod's action surface declares them. */
  arguments: readonly string[];
  /** Whether the instance walks to its tile first (`move_to_tile`) before it acts. */
  moveFirst: boolean;
  targets(snapshot: Snapshot): readonly InstanceTarget[];
}>;

type MacroIntent = Readonly<{
  /** Named reason when the snapshot holds no instance of any family at all. */
  emptyReason: string;
  families: readonly IntentFamily[];
}>;

type CompiledInstance = Readonly<{
  family: IntentFamily;
  target: InstanceTarget;
  arguments: BodyProgramArguments;
  /** `move_to_tile`'s published arguments, built from the same validated tile. */
  moveArguments: BodyProgramArguments;
}>;

const MACRO_INTENTS: ReadonlyMap<string, MacroIntent> = new Map<string, MacroIntent>([
  [
    "tend_crops",
    {
      emptyReason: "nothing_to_water",
      families: [
        {
          family: "crop",
          actionId: "water_crop",
          arguments: ["x", "y", "expectedTargetId"],
          moveFirst: true,
          targets: (snapshot) =>
            (snapshot.cropTargets ?? []).map((target) => ({
              targetId: target.targetId,
              x: target.x,
              y: target.y,
              slot: undefined,
              qualifiedItemId: undefined,
            })),
        },
        {
          family: "harvest",
          actionId: "harvest_crop",
          arguments: ["x", "y", "expectedQualifiedItemId", "expectedTargetId"],
          moveFirst: true,
          targets: (snapshot) =>
            (snapshot.harvestTargets ?? []).map((target) => ({
              targetId: target.targetId,
              x: target.x,
              y: target.y,
              slot: undefined,
              qualifiedItemId: target.qualifiedHarvestItemId,
            })),
        },
      ],
    },
  ],
  [
    "clear_obstacles",
    {
      emptyReason: "nothing_to_clear",
      families: [
        {
          family: "weed",
          actionId: "cut_weeds",
          arguments: ["x", "y", "slot", "expectedTargetId"],
          moveFirst: false,
          // `BridgeWeedTarget` publishes no tool slot while `cut_weeds` requires the equipped
          // scythe's one, so this family stays uncompilable until the snapshot carries it.
          targets: (snapshot) =>
            (snapshot.weedTargets ?? []).map((target) => ({
              targetId: target.targetId,
              x: target.x,
              y: target.y,
              slot: undefined,
              qualifiedItemId: undefined,
            })),
        },
        {
          family: "rock_source",
          actionId: "break_rock_source",
          arguments: ["x", "y", "slot", "expectedTargetId"],
          moveFirst: false,
          // Same gap as weeds: `BridgeRockSourceTarget` publishes no slot and
          // `break_rock_source` requires the equipped pickaxe's.
          targets: (snapshot) =>
            (snapshot.rockSourceTargets ?? []).map((target) => ({
              targetId: target.targetId,
              x: target.x,
              y: target.y,
              slot: undefined,
              qualifiedItemId: undefined,
            })),
        },
        {
          family: "debris",
          actionId: "clear_debris",
          arguments: ["x", "y", "slot", "expectedTargetId"],
          moveFirst: false,
          targets: (snapshot) =>
            (snapshot.debrisTargets ?? []).map((target) => ({
              targetId: target.targetId,
              x: target.x,
              y: target.y,
              slot: target.slot,
              qualifiedItemId: undefined,
            })),
        },
      ],
    },
  ],
  [
    "gather_forage",
    {
      emptyReason: "nothing_to_forage",
      families: [
        {
          family: "forage",
          actionId: "pickup_forage",
          arguments: ["x", "y", "expectedQualifiedItemId", "expectedTargetId"],
          moveFirst: false,
          targets: (snapshot) =>
            (snapshot.forageTargets ?? []).map((target) => ({
              targetId: target.targetId,
              x: target.x,
              y: target.y,
              slot: undefined,
              qualifiedItemId: target.qualifiedItemId,
            })),
        },
      ],
    },
  ],
  [
    "store_produce",
    {
      emptyReason: "nothing_to_ship",
      families: [
        {
          family: "shipping_bin",
          actionId: "ship_item",
          arguments: ["x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId"],
          moveFirst: true,
          targets: (snapshot) =>
            (snapshot.shippingBinTargets ?? []).map((target) => ({
              targetId: target.targetId,
              x: target.x,
              y: target.y,
              slot: target.slot,
              qualifiedItemId: target.qualifiedItemId,
            })),
        },
      ],
    },
  ],
]);

/**
 * Compiles one macro intent plus the current snapshot into standard Body Programs.
 *
 * Returns at most `options.maxPrograms` programs and names, per family, what could not be compiled:
 * an action outside the Mod's program catalog or the snapshot's enabled set, or a target whose tile
 * (or required inventory slot) the snapshot does not publish.
 */
export function synthesizePrograms(
  snapshot: Snapshot | null | undefined,
  intentId: MacroIntentId,
  options: SynthesizeOptions,
): SynthesizeResult {
  const intent = MACRO_INTENTS.get(intentId);
  if (intent === undefined) return refuse(`synthesizer_unknown_intent:${intentId}`);
  if (!isUsableSnapshot(snapshot)) return refuse("synthesizer_no_snapshot");
  if (options.minimumRevision !== undefined && snapshot.revision < options.minimumRevision)
    return refuse("synthesizer_stale_snapshot");

  const programActionIds = new Set(options.programActionIds);
  const enabledActionIds = new Set(snapshot.enabledActionIds);
  const uncompilable: UncompilableFamily[] = [];
  const candidates: Readonly<{ family: IntentFamily; target: InstanceTarget }>[] = [];
  let targetCount = 0;

  for (const family of intent.families) {
    const targets = family.targets(snapshot);
    targetCount += targets.length;
    if (targets.length === 0) continue;
    const blocked = surfaceBlock(family, programActionIds, enabledActionIds);
    if (blocked !== undefined) {
      uncompilable.push(blocked);
      continue;
    }
    for (const target of targets) candidates.push({ family, target });
  }

  if (targetCount === 0) return refuse(intent.emptyReason);

  const instances: CompiledInstance[] = [];
  const unresolvedFamilies = new Set<string>();
  for (const { family, target } of candidates) {
    const compiled = compileInstance(family, target);
    if (compiled !== undefined) {
      instances.push(compiled);
      continue;
    }
    if (unresolvedFamilies.has(family.family)) continue;
    unresolvedFamilies.add(family.family);
    uncompilable.push({
      family: family.family,
      actionId: family.actionId,
      reason: `target_unresolved:${target.targetId}`,
    });
  }

  // Report gaps in the intent's own family order, so the caller reads them as the card lists them.
  const familyOrder = new Map(intent.families.map((family, index) => [family.family, index] as const));
  uncompilable.sort((left, right) => (familyOrder.get(left.family) ?? 0) - (familyOrder.get(right.family) ?? 0));

  if (instances.length === 0) return refuse(nothingCompiledCode(uncompilable, intent));

  // A caller that allows no programs, or a cap that cannot hold even one instance, cannot be served
  // by any split of this instance set.
  if (
    !Number.isSafeInteger(options.maxPrograms) ||
    options.maxPrograms < 1 ||
    instances.some((instance) => instanceNodeCount(instance) > MAX_SYNTHESIZED_PROGRAM_NODES)
  )
    return refuse(`synthesizer_cap_unsatisfiable:${instances.length}`);

  const ordered = [...instances].sort(
    (left, right) =>
      tileDistance(snapshot.tile, left.target) - tileDistance(snapshot.tile, right.target) ||
      compareText(left.target.targetId, right.target.targetId) ||
      compareText(left.family.actionId, right.family.actionId),
  );

  const programs: SynthesizedBodyProgram[] = [];
  let delivered = 0;
  while (programs.length < options.maxPrograms && delivered < ordered.length) {
    const nodes: SynthesizedBodyProgramNode[] = [];
    while (delivered < ordered.length) {
      const instance = ordered[delivered];
      if (instance === undefined) break;
      if (nodes.length + instanceNodeCount(instance) > MAX_SYNTHESIZED_PROGRAM_NODES) break;
      nodes.push(...instanceNodes(instance, nodes.length + 1));
      delivered++;
    }
    programs.push(Object.freeze({ nodes: Object.freeze(nodes) }));
  }

  return Object.freeze({
    ok: true as const,
    intentId,
    programs: Object.freeze(programs),
    remaining: ordered.length - delivered,
    instanceCount: instances.length,
    uncompilable: Object.freeze(uncompilable),
  });
}

function refuse(reasonCode: string): SynthesizeRefusal {
  return Object.freeze({ ok: false as const, reasonCode });
}

function isUsableSnapshot(snapshot: Snapshot | null | undefined): snapshot is Snapshot {
  return (
    snapshot !== null &&
    snapshot !== undefined &&
    isNonNegativeSafeInteger(snapshot.revision) &&
    isTileCoordinate(snapshot.tile.x) &&
    isTileCoordinate(snapshot.tile.y) &&
    Array.isArray(snapshot.enabledActionIds)
  );
}

/** The first action of this family that may not be named, with the reason the caller can act on. */
function surfaceBlock(
  family: IntentFamily,
  programActionIds: ReadonlySet<string>,
  enabledActionIds: ReadonlySet<string>,
): UncompilableFamily | undefined {
  const required = family.moveFirst ? [family.actionId, "move_to_tile"] : [family.actionId];
  for (const actionId of required) {
    if (!programActionIds.has(actionId)) return { family: family.family, actionId, reason: "lifecycle_not_published" };
    if (!enabledActionIds.has(actionId)) return { family: family.family, actionId, reason: "capability_not_enabled" };
  }
  return undefined;
}

/**
 * The refusal for an intent whose whole instance set stayed uncompilable. A surface gap is named
 * with the card's action code; a target the snapshot does not publish is named with its own id.
 */
function nothingCompiledCode(uncompilable: readonly UncompilableFamily[], intent: MacroIntent): string {
  const surface = uncompilable.find(
    (entry) => entry.reason === "lifecycle_not_published" || entry.reason === "capability_not_enabled",
  );
  if (surface !== undefined) return `synthesizer_action_not_published:${surface.actionId}`;
  const unresolved = uncompilable.find((entry) => entry.reason.startsWith("target_unresolved:"));
  if (unresolved !== undefined)
    return `synthesizer_target_unresolved:${unresolved.reason.slice("target_unresolved:".length)}`;
  return intent.emptyReason;
}

function compileInstance(family: IntentFamily, target: InstanceTarget): CompiledInstance | undefined {
  const tileX = integerArgument(target.x);
  const tileY = integerArgument(target.y);
  if (tileX === undefined || tileY === undefined || !isOpaqueId(target.targetId)) return undefined;
  const arguments_: Record<string, BodyProgramArgument> = {};
  for (const name of family.arguments) {
    const value = argumentFor(name, target, tileX, tileY);
    if (value === undefined) return undefined;
    arguments_[name] = value;
  }
  return Object.freeze({
    family,
    target,
    arguments: Object.freeze(arguments_),
    moveArguments: Object.freeze({ x: tileX, y: tileY }),
  });
}

function argumentFor(
  name: string,
  target: InstanceTarget,
  tileX: BodyProgramArgument,
  tileY: BodyProgramArgument,
): BodyProgramArgument | undefined {
  switch (name) {
    case "x":
      return tileX;
    case "y":
      return tileY;
    case "slot":
      return integerArgument(target.slot);
    case "expectedTargetId":
      return textArgument(target.targetId);
    case "expectedQualifiedItemId":
      return textArgument(target.qualifiedItemId);
    default:
      return undefined;
  }
}

/** The published integer form; a value the snapshot does not publish stays absent. */
function integerArgument(value: number | undefined): BodyProgramArgument | undefined {
  if (!isNonNegativeSafeInteger(value)) return undefined;
  return { type: "integer", canonicalValue: String(value) };
}

/** The published string form; the canonical bound is the one `protocol.ts` validates. */
function textArgument(value: string | undefined): BodyProgramArgument | undefined {
  if (value === undefined || value.length === 0 || value.length > 512) return undefined;
  return { type: "string", canonicalValue: value };
}

function instanceNodeCount(instance: CompiledInstance): number {
  return instance.family.moveFirst ? 2 : 1;
}

/** Node ids are positional inside one program, so a program is reproducible byte for byte. */
function instanceNodes(instance: CompiledInstance, firstNodeNumber: number): SynthesizedBodyProgramNode[] {
  if (!instance.family.moveFirst)
    return [bodyProgramNode(nodeId(firstNodeNumber), instance.family.actionId, instance.arguments, [])];
  const moveNodeId = nodeId(firstNodeNumber);
  return [
    bodyProgramNode(moveNodeId, "move_to_tile", instance.moveArguments, []),
    bodyProgramNode(nodeId(firstNodeNumber + 1), instance.family.actionId, instance.arguments, [moveNodeId]),
  ];
}

function nodeId(number: number): string {
  return `n${String(number).padStart(2, "0")}`;
}

function bodyProgramNode(
  nodeId_: string,
  actionId: string,
  arguments_: BodyProgramArguments,
  dependsOn: readonly string[],
): SynthesizedBodyProgramNode {
  return Object.freeze({ nodeId: nodeId_, actionId, arguments: arguments_, dependsOn, bindings: {} });
}

/** Chebyshev: the radius the Mod's own target discovery bounds every family with. */
function tileDistance(origin: Readonly<{ x: number; y: number }>, target: Readonly<{ x: number; y: number }>): number {
  return Math.max(Math.abs(target.x - origin.x), Math.abs(target.y - origin.y));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
