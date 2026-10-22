import { dirname, join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveCompanionLocale, type CompanionLocale } from "../settings/player-preference-store.js";
import {
  compilePlanScript,
  legalPlanActionIds,
  planActionsFromRegistrations,
  planProgramId,
  planShape,
  type PlanScriptRequest,
  type PublishedPlanAction,
} from "../body-program-script.js";
import { Type } from "typebox";
import {
  createStableGameRuntimeBindingIdentity,
  createStardewRecoveryBindingContext,
  readStardewRecoveryBindingContext,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { HostNodeAdmissionService, type HostNodeAdmissionResult } from "../action-execution-coordinator.internal.js";
import { materializeAuthenticatedStardewLaunchPorts } from "../stardew-integration-launcher-body-program.internal.js";
import { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import type { LiveSourceAttester } from "../companion-live-source-attestation.js";
import { companionArrivalAlreadySaid } from "../companion-arrival-fact.js";
import type { CompanionInterruption } from "../companion-interruption.js";
import { CompanionLoop, type CompanionTurnVolatileContext } from "../companion-loop.js";
import {
  createFarmhandCompanionPresentationPort,
  createFarmhandPresentationEpochAdmission,
  type FarmhandPresentationBridge,
} from "../farmhand-companion-presentation.js";
import { createGameOperationalGateEvidenceProjection } from "../game-operational-gate-evidence.js";
import type { HostGameLifecycleSnapshot } from "../game-status/game-status.js";
import {
  CompanionHostService,
  createGamePresentationAdmissionProvider,
  GameTurnLineageTracker,
} from "../host-service.js";
import type {
  GameIntegrationAdapter,
  IntegrationActionPolicy,
  IntegrationStateView,
} from "../game-integration-adapter.js";
import type { GameConnection } from "../game-connection.js";
import type { RuntimeSession } from "../runtime.js";
import { formatGameEnvironmentFacts } from "../runtime-core.internal.js";
import { identityProfileMetadata } from "../identity-profile.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import { buildGameSurfaceAuthoredCatalog } from "../tavern/catalog-service.js";
import { createMaterializedGameCompanionRuntime } from "../game-runtime-fixed-tools.internal.js";
import { createRunTrace, writeRunTrace, type RunTrace } from "../run-trace.js";
import {
  validateBodyProgramCandidateRequest,
  validateBodyProgramEventsResult,
  validateBodyProgramStatusResult,
  validateBodyProgramSubmitResult,
  type BodyNodeAdmissionChallenge,
  type BodyNodeAdmissionResult,
  type BodyProgramCandidateRequest,
  type BodyProgramEventsRequest,
  type BodyProgramStatusRequest,
  type ActionRegistration,
  type FarmhandPolicyIdentity,
  type Snapshot,
} from "../protocol.js";
import {
  consumeGameVoicePresentationAttachment,
  type GameVoicePresentationAttachment,
} from "../voice-gateway-client.js";
import { assembleGameRuntimeContext } from "./game-runtime-context-assembly.js";
import { createGameRuntimeAttachment } from "./game-runtime-attachment.js";
import {
  type GameRuntimeMaterializer,
  type MaterializedGameRuntime,
  materializeExactEnter,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

type BodyProgramPort = ReturnType<typeof materializeAuthenticatedStardewLaunchPorts>["bodyProgram"];
type BodyProgramConsumer = object;
type BodyProgramConsumerRecord = { port: BodyProgramPort; available: boolean; active: number; drained?: () => void };
const bodyProgramConsumers = new WeakMap<BodyProgramConsumer, BodyProgramConsumerRecord>();
/** The program's two readers: they answer only for a program a submission recorded. */
const programReaderToolNames = Object.freeze(["stardew_action_program_status", "stardew_action_program_events"]);

/**
 * Companion presentation locale used when no frontend-set language preference
 * has been injected yet. Existing callers predate the Tavern language
 * preference store; production wiring injects the stored preference.
 */

/**
 * Creates the fixed production S4c materializer. This is construction-zone-only:
 * the eventual composer invokes it inside the live S4b one-shot callback after
 * durable prepare. No facade/model/Mod-wire configuration reaches this factory.
 */
function createBodyProgramTools(
  consumer: BodyProgramConsumer,
  connection: GameConnection,
  mountedPolicy: IntegrationActionPolicy,
  retainedPolicyIdentity: FarmhandPolicyIdentity,
  revealReaders: () => void,
  runTrace: RunTrace,
): readonly ToolDefinition[] {
  const invoke = async <TResult>(
    request: Record<string, unknown>,
    validateRequest: (value: Record<string, unknown>) => string | null,
    validateResult: (value: Record<string, unknown>) => string | null,
    call: (port: BodyProgramPort) => Promise<TResult>,
  ) => {
    if (validateRequest(request) !== null) throw new Error("invalid_body_program_tool_arguments");
    const record = bodyProgramConsumers.get(consumer);
    if (record === undefined || !record.available) throw new Error("action_program_runtime_unavailable");
    record.active += 1;
    try {
      const result = await call(record.port);
      if (!isRecord(result) || validateResult(result) !== null) throw new Error("body_program_protocol_invalid");
      const details = Object.freeze(result);
      return Object.freeze({
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      });
    } finally {
      record.active -= 1;
      if (!record.available && record.active === 0) record.drained?.();
    }
  };
  // ONE submission path. The raw program tool and the routine tool both hand their candidate here,
  // so a routine can never reach the Mod by a route a model-authored program cannot.
  const submitProgram = async (request: BodyProgramCandidateRequest) => {
    if (!isBodyProgramCandidateRequest(request)) throw new Error("invalid_body_program_tool_arguments");
    assertFreshBodyProgramPreflight(connection, mountedPolicy, retainedPolicyIdentity, request);
    const result = await invoke(request, validateBodyProgramCandidateRequest, validateBodyProgramSubmitResult, (port) =>
      port.submit(request),
    );
    // Only a recorded program gives the readers anything to answer; a rejected candidate leaves none.
    const details: unknown = result.details;
    const code = isRecord(details) ? details.code : undefined;
    if (code === "accepted" || code === "idempotent") revealReaders();
    return result;
  };
  const submitTool = (): ToolDefinition =>
    Object.freeze(
      defineTool({
        name: "stardew_submit_action_program",
        label: "stardew_submit_action_program",
        // Purpose first, in the voice Pi's own tools use for their snippets: what the tool IS, when to prefer it
        // over the flat per-action tools, and the one example that makes the shape concrete. Measured 2026-10-17/18:
        // the previous description was an error taxonomy - bounded rejection, no journal, no `deadline` field, what
        // `bindings` keys mean - and never said what the tool was FOR. Across every live run the companion submitted
        // no program at all (zero `AGENT_PROGRAM_SUBMIT`), while it used the ~104 flat action tools one at a time.
        // Measured 2026-10-21: discoverability was no longer the problem (one session made 22 accepted submissions),
        // the UNIT was - a session that answered its task step by step paid a full model round-trip per step
        // (settle -> dispatch p50 3.3 s, p90 37 s, none of 28 gaps under 500 ms) against ~10 ms per node inside a
        // plan. So the description states what the tool CARRIES (a whole piece of work, the moves included) and that
        // the Mod advances the nodes itself: leaving the unit implicit is what produced the step-by-step runs.
        description:
          'Submit one whole piece of work in ONE call, not one step: the plan and the moves that carry it out travel together, so the walking, the inspecting and the loading are one submission. The Mod validates the whole plan, then runs each node natively once its predecessors\' receipts are in and advances the successors itself - the companion does not come back between steps, and a whole piece of work costs one turn instead of one turn per step. Sending the same steps one at a time instead means waiting for a decision between every step. Prefer it over separate action calls whenever you already know the work. Node actionIds must be actions currently advertised to you; an unknown one is rejected before anything runs. A refused candidate is bounded and side-effect free (no journal, claim, grant, execution or receipt) and returns diagnostics to fix. Nodes carry no deadline: the Mod derives each action\'s execution budget from its descriptor-owned watchdog at admission time, so never invent or submit a clock value. Every node carries all five fields, each argument is {type, canonicalValue} with type string|integer|boolean, and bindings map a CONSUMER ARGUMENT NAME to {nodeId, factName} of a fact an earlier node declares - keep the bound argument in arguments too, with its observed literal value. A move, an inspection and the load that binds the inspected machine, in the accepted shape; copy it and replace the values: {"programId":"farm_morning","nodes":[{"nodeId":"walk_to_keg","actionId":"move_to_tile","arguments":{"x":{"type":"integer","canonicalValue":"20"},"y":{"type":"integer","canonicalValue":"12"}},"dependsOn":[],"bindings":{}},{"nodeId":"inspect_keg","actionId":"machine_inspect","arguments":{"x":{"type":"integer","canonicalValue":"20"},"y":{"type":"integer","canonicalValue":"12"},"expectedTargetId":{"type":"string","canonicalValue":"machine_keg_20_12"}},"dependsOn":["walk_to_keg"],"bindings":{}},{"nodeId":"load_keg","actionId":"machine_load","arguments":{"x":{"type":"integer","canonicalValue":"20"},"y":{"type":"integer","canonicalValue":"12"},"slot":{"type":"integer","canonicalValue":"3"},"expectedQualifiedItemId":{"type":"string","canonicalValue":"(O)433"},"expectedTargetId":{"type":"string","canonicalValue":"machine_keg_20_12"}},"dependsOn":["inspect_keg"],"bindings":{"expectedTargetId":{"nodeId":"inspect_keg","factName":"machine_target_id"}}}]}',
        parameters: bodyProgramToolParameters("stardew_submit_action_program"),
        execute: async (_toolCallId, params) => {
          if (!isBodyProgramCandidateRequest(params)) throw new Error("invalid_body_program_tool_arguments");
          return submitProgram(params);
        },
      }),
    );
  return Object.freeze([
    submitTool(),
    Object.freeze(
      defineTool({
        name: "stardew_plan_work",
        label: "stardew_plan_work",
        // The unit the 2026-10-21 measurement asked for (see `stardew_submit_action_program`): one model round-trip
        // per PIECE OF WORK, not per step. A plan script is how the companion says "all of it, in this order" without
        // paying a decision between steps; it is compiled here and submitted as ONE program, so the Mod's journal,
        // admission and recovery see exactly what a hand-written program gives them. The script is not a macro action:
        // it names actions the Mod's Body Program catalog accepts and real snapshot targets, so "water the three by
        // the door, leave the far ones" stays expressible, and nothing executes against physics until the Mod runs the
        // admitted nodes.
        description:
          "Write a short script over the current snapshot and the builder, one builder.<actionId> call per step, and the host compiles it into the one plan the Mod executes. The Mod advances that plan itself, so you do not come back between steps. Every action you can take is a builder method, published and live-verified alike, so this tool carries the whole action surface and no per-action tool is mounted beside it. Work that does not fit in one plan is yours to split: stop when builder.isFull() is true, and plan the rest in the next call, in this shape:\n" +
          "for (const crop of snapshot.cropTargets) {\n" +
          "  builder.water_crop({ x: crop.x, y: crop.y, expectedTargetId: crop.targetId });\n" +
          "  if (builder.isFull()) break;\n" +
          "}",
        parameters: planToolParameters(),
        execute: async (_toolCallId, params) => {
          const actions = readPlanActions(connection);
          const compiled = compilePlanScript(readPlanScriptRequest(params), {
            snapshot: readLiveSnapshot(connection),
            actions,
          });
          // The run artifact keeps the script, the snapshot it read and the program it produced, so a plan that
          // failed can be replayed and audited without guessing what the companion asked for.
          const span = runTrace.begin("plan.script", {
            scriptSource: compiled.scriptSource,
            snapshotRevision: compiled.snapshotRevision ?? -1,
            producedProgram: compiled.ok ? JSON.stringify(compiled.program) : "",
          });
          if (!compiled.ok) {
            span.end({ reasonCode: compiled.reasonCode });
            // The compiler's own name for the refusal, unchanged and with no plan behind it: there is no partial plan
            // to run, so the count is zero and the reason is what the companion tells the player. A name the builder
            // does not have also gets the ids it DOES have, so a wrong guess teaches instead of blocking the turn.
            return planDetails({
              accepted: false,
              nodeCount: 0,
              reasonCode: compiled.reasonCode,
              ...(compiled.requirement === undefined
                ? {}
                : {
                    actionId: compiled.requirement.actionId,
                    requiredArguments: compiled.requirement.requiredArguments,
                  }),
              ...(compiled.reasonCode.startsWith("plan_script_unknown_action:")
                ? { legalActionIds: legalPlanActionIds(actions) }
                : {}),
            });
          }
          const nodes = compiled.program.nodes;
          const programId = planProgramId(compiled.snapshotRevision, nodes);
          try {
            const submitted = await submitProgram({ programId, nodes });
            const code = submitted.details.code;
            if (typeof code !== "string") throw new Error("body_program_protocol_invalid");
            span.end({ programId, submitted: code });
            // `submitted` is the Mod's own answer; `accepted` is the same fact in the form the companion asks for.
            return planDetails({
              accepted: code === "accepted" || code === "idempotent",
              nodeCount: nodes.length,
              programId,
              submitted: code,
            });
          } catch (error) {
            span.end({ reasonCode: "plan_submission_failed" });
            throw error;
          }
        },
      }),
    ),
    Object.freeze(
      defineTool({
        name: "stardew_plan_shape",
        label: "stardew_plan_shape",
        // The per-action tools that used to carry a generated schema are gone, so this is where their shapes live now:
        // one read-only answer per action (or per family) instead of ninety-five schemas in every context.
        description:
          "Read what a plan step must supply for one action, or for every plannable action of one family: the argument names with their types and, where the Mod declares a closed set, its values, plus the resource the action claims and the output facts a later step can bind. Read-only, so it changes nothing; ask it when you are unsure what builder.<actionId> takes instead of guessing and being refused.",
        parameters: planShapeParameters(),
        execute: async (_toolCallId, params) => {
          const shape = planShape(readPlanActions(connection), readPlanShapeRequest(params));
          if (!shape.ok)
            return planDetails({
              reasonCode: shape.reasonCode,
              ...(shape.legalActionIds === undefined ? {} : { legalActionIds: shape.legalActionIds }),
              ...(shape.legalFamilies === undefined ? {} : { legalFamilies: shape.legalFamilies }),
            });
          return planDetails({ actions: shape.actions });
        },
      }),
    ),
    Object.freeze(
      defineTool({
        name: "stardew_action_program_status",
        label: "stardew_action_program_status",
        // The siblings described themselves with their own names, which is zero information (measured: an agent
        // reading this list could not tell what any of the three was for).
        description:
          "Read a submitted plan's state: per-node progress and the authoritative outcome so far. Use it after submitting a plan to see which node ran, which is still waiting, and why a plan stopped.",
        // Mounted only once a submission has been recorded (see mountProgramReadersAfterSubmission); until then it can
        // only be read as empty, and two always-empty readers are what an agent polls instead of submitting the plan at
        // all.
        defaultActive: false,
        parameters: bodyProgramToolParameters("stardew_action_program_status"),
        execute: async (_toolCallId, params) => {
          if (!isBodyProgramStatusRequest(params)) throw new Error("invalid_body_program_tool_arguments");
          return invoke(params, validateStatusRequest, validateBodyProgramStatusResult, (port) => port.status(params));
        },
      }),
    ),
    Object.freeze(
      defineTool({
        name: "stardew_action_program_events",
        label: "stardew_action_program_events",
        // Same defect as `_status`, and this one is the plan's own event log.
        description:
          "Read one page of a submitted plan's event log: a bounded record per node transition, so a running plan can be followed without resubmitting or re-planning it. Page with cursor + pageSize; the returned cursor continues the read.",
        // Same disclosure rule as `_status`: no program, no event log.
        defaultActive: false,
        parameters: bodyProgramToolParameters("stardew_action_program_events"),
        execute: async (_toolCallId, params) => {
          if (!isBodyProgramEventsRequest(params)) throw new Error("invalid_body_program_tool_arguments");
          return invoke(params, validateEventsRequest, validateBodyProgramEventsResult, (port) => port.events(params));
        },
      }),
    ),
  ]);
}

/**
 * The action vocabulary the plan builder exposes: the registrations the Mod's Body Program catalog accepts as
 * executable, with the argument names each one declares. `planActionsFromRegistrations` applies the same gates the Mod's Body Program
 * catalog projection does - the lifecycles it admits, the execution kind, and the argument contract - so a generated
 * method cannot name an action a program may not carry, and a generated argument list cannot drift from the
 * surface. There is no hand-written per-action recipe here.
 */
function readPlanActions(connection: GameConnection): readonly PublishedPlanAction[] {
  const state = (connection as { state?: { catalogRegistrations?: readonly ActionRegistration[] } }).state;
  return planActionsFromRegistrations(state?.catalogRegistrations ?? []);
}

/** The current Mod snapshot: a plan script reads the world as the Mod last published it. */
function readLiveSnapshot(connection: GameConnection): Snapshot | null {
  const state = (connection as { state?: { snapshot?: Snapshot | null } }).state;
  return state?.snapshot ?? null;
}

function readPlanScriptRequest(value: unknown): PlanScriptRequest {
  if (!isRecord(value) || typeof value.script !== "string" || value.script.trim().length === 0)
    throw new Error("invalid_body_program_tool_arguments");
  return Object.freeze({ script: value.script });
}

/**
 * The shape selector, bounded to the surface's own id grammar: a selector is echoed in the reason code and lands in the
 * run trace, so it may not carry arbitrary text.
 */
function readPlanShapeRequest(value: unknown): Readonly<{ actionId?: string; family?: string }> {
  if (!isRecord(value)) throw new Error("invalid_body_program_tool_arguments");
  const actionId = value.actionId;
  const family = value.family;
  if (actionId !== undefined && !isPlanSelector(actionId)) throw new Error("invalid_body_program_tool_arguments");
  if (family !== undefined && !isPlanSelector(family)) throw new Error("invalid_body_program_tool_arguments");
  return Object.freeze({
    ...(actionId === undefined ? {} : { actionId }),
    ...(family === undefined ? {} : { family }),
  });
}

function isPlanSelector(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value);
}

function planDetails(details: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details: Object.freeze(details),
  });
}

/**
 * Every target family the Mod's snapshot declares, in the order `Snapshot` declares them (host/src/protocol.ts:212):
 * a script that cannot see which arrays exist cannot write a loop over one. The plan test reads the type and fails
 * when the two drift, so this list cannot quietly become a half-truth.
 */
const PLAN_TARGET_FAMILIES: readonly string[] = Object.freeze(
  `doorTargets forageTargets itemTargets refillWateringCanTargets cropTargets petBowlTargets slimeHutchTroughTargets bushTargets fruitTreeTargets shakeTreeTargets pedestalTargets fenceGateTargets harvestTargets seedTargets fertilizerTargets woodFenceTargets woodFenceResultTargets crabPotTargets crabPotResultTargets crabPotCollectTargets baitCrabPotTargets baitCrabPotResultTargets debrisTargets rockSourceTargets clearHoeDirtTargets artifactSpotTargets artifactSpotResultTargets treeChopSourceTargets treeChopResultTargets treeStumpTargets treeSaplingTargets weedTargets grassTargets caskTargets mannequinTargets signTargets siloTargets scytheCropTargets machineTargets npcRelationshipTargets petTargets animalProductTargets feedTroughTargets chestStoreTargets chestRetrieveTargets foodTargets shippingBinTargets craftingRecipeTargets cookingRecipeTargets cookingStationTargets shopTargets mineElevatorFloorTargets minecartTargets raftTargets horseTargets mineEntranceTargets animalDoorTargets fishPondTargets worldObjectTargets farmBuildingTargets dailyQuestTargets specialOrderTargets museumRewardTargets colorTargets tailoringTargets wearableTargets warpItemTargets mailboxTargets buildingChestTargets obeliskTargets`.split(
    " ",
  ),
);

/** One action id or one family id, never both: a selector that names nothing gets the vocabulary that does exist. */
function planShapeParameters() {
  const selector = (description: string) => Type.Optional(Type.String({ minLength: 1, maxLength: 128, description }));
  return Type.Object(
    {
      actionId: selector("One plannable action id, as it appears as a builder method (for example cut_weeds)."),
      family: selector("One plannable family id (for example movement_navigation), answered with every action in it."),
    },
    { additionalProperties: false },
  );
}

function planToolParameters() {
  return Type.Object(
    {
      script: Type.String({
        minLength: 1,
        maxLength: 8192,
        description: `One synchronous script body, called once with \`snapshot\` (the frozen live observation) and \`builder\`; call builder.<actionId>({...}) with exactly the argument names that action declares. \`snapshot.tile\` is your own \`{ x, y }\` and one array exists per target family: ${PLAN_TARGET_FAMILIES.join(", ")}; every entry carries \`targetId\`, \`x\` and \`y\` except doorTargets (sourceX, sourceY, targetX, targetY), foodTargets (slot, qualifiedItemId) and warpItemTargets (slot, qualifiedItemId, destination). \`snapshot.currentTool\` is the qualified id of the tool the farmer holds and \`snapshot.toolSlots\` lists \`{ slot, label }\` for every tool in the pack, so a slot an action asks for is the entry whose label matches the held tool - equipment cannot be judged statically and must be read here. builder.nodeCount and builder.isFull() are live and 16 nodes is the whole plan; await, require, import, fetch and timers do not exist here and are refused by name.`,
      }),
    },
    { additionalProperties: false },
  );
}

function isBodyProgramCandidateRequest(value: unknown): value is BodyProgramCandidateRequest {
  return isRecord(value) && validateBodyProgramCandidateRequest(value) === null;
}

function isBodyProgramStatusRequest(value: unknown): value is BodyProgramStatusRequest {
  return isRecord(value) && validateStatusRequest(value) === null;
}

function isBodyProgramEventsRequest(value: unknown): value is BodyProgramEventsRequest {
  return isRecord(value) && validateEventsRequest(value) === null;
}

function bodyProgramToolParameters(name: string) {
  const opaque = Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" });
  const runtimeValue = Type.Object(
    {
      type: Type.String({
        minLength: 1,
        maxLength: 64,
        description:
          "Canonical value kind from the action descriptor, normally string, integer, boolean, or number. Do not use json_pointer; dependencies are expressed through bindings.",
      }),
      canonicalValue: Type.String({
        maxLength: 512,
        description:
          "Literal canonical value. Even when an argument is bound to a producer fact, keep this argument present with its observed literal value; bindings provide the fresh runtime replacement.",
      }),
    },
    { additionalProperties: false },
  );
  const factReference = Type.Object(
    {
      nodeId: Type.String({
        pattern: "^[A-Za-z0-9_-]{1,128}$",
        description: "Producer node ID that declares the fact.",
      }),
      factName: Type.String({
        pattern: "^[A-Za-z0-9_-]{1,128}$",
        description: "Exact declared output fact name, such as machine_target_id.",
      }),
    },
    { additionalProperties: false },
  );
  const node = Type.Object(
    {
      nodeId: opaque,
      actionId: opaque,
      arguments: Type.Record(opaque, runtimeValue, { maxProperties: 32 }),
      dependsOn: Type.Array(opaque, { maxItems: 8 }),
      bindings: Type.Record(opaque, factReference, {
        maxProperties: 32,
        description:
          "Map consumer argument name → producer fact reference. Example: {expectedTargetId:{nodeId:inspect_keg,factName:machine_target_id}}. The key is not the fact name.",
      }),
    },
    { additionalProperties: false },
  );
  if (name === "stardew_submit_action_program")
    return Type.Object(
      { programId: opaque, nodes: Type.Array(node, { minItems: 1, maxItems: 16 }) },
      { additionalProperties: false },
    );
  if (name === "stardew_action_program_status")
    return Type.Object({ programId: opaque }, { additionalProperties: false });
  return Type.Object(
    {
      programId: opaque,
      cursor: Type.Integer({ minimum: 0, description: "Position to continue from; the start of the log is 0." }),
      pageSize: Type.Integer({
        minimum: 1,
        maximum: 32,
        description: "How many event records to return in this page (1-32).",
      }),
    },
    { additionalProperties: false },
  );
}

function createBodyProgramToolCloser(consumer: BodyProgramConsumer): () => Promise<void> {
  return async () => {
    const record = bodyProgramConsumers.get(consumer);
    if (record === undefined) return;
    record.available = false;
    if (record.active > 0)
      await new Promise<void>((resolve) => {
        record.drained = resolve;
      });
    bodyProgramConsumers.delete(consumer);
  };
}

/**
 * The mounting decision for the two program readers, in one place: `defaultActive: false` keeps them out of the
 * mounted set until a submission is recorded, and this is the only way in. Progressive disclosure may only reduce
 * the current context and never grants or revokes a permission (design/architecture/game-action-model.md,
 * 发布和可见性), so the readers are added to whatever is already mounted and never mount an action or a capability.
 */
function mountProgramReadersAfterSubmission(session: RuntimeSession["session"]): () => void {
  let revealed = false;
  return () => {
    if (revealed) return;
    revealed = true;
    session.setActiveToolsByName([...session.getActiveToolNames(), ...programReaderToolNames]);
  };
}

function assertFreshBodyProgramPreflight(
  connection: GameConnection,
  mountedPolicy: IntegrationActionPolicy,
  retainedPolicyIdentity: FarmhandPolicyIdentity,
  request: Record<string, unknown>,
): void {
  if (connection.executionGate?.executable !== true) throw new Error("integration_not_ready");
  let state: IntegrationStateView;
  try {
    state = connection.module.readState(connection);
  } catch {
    throw new Error("integration_not_ready");
  }
  if (!isStateView(state) || !state.connected || state.registrations === undefined)
    throw new Error("integration_not_ready");
  assertCurrentBodyProgramPolicyIdentity(state, retainedPolicyIdentity);
  const visible = connection.module.actionCatalog.visibleActions(
    state.registrations,
    state.enabledActionIds ?? [],
    mountedPolicy,
  );
  const allowed = new Set(visible.map((registration) => registration.actionId));
  if (
    Array.isArray(request.nodes) &&
    request.nodes.some((node) => !isRecord(node) || typeof node.actionId !== "string" || !allowed.has(node.actionId))
  )
    throw new Error("body_program_preflight_rejected");
}

function readBodyProgramPolicyIdentity(connection: GameConnection): FarmhandPolicyIdentity {
  let state: IntegrationStateView;
  try {
    state = connection.module.readState(connection);
  } catch {
    throw new Error("integration_not_ready");
  }
  if (
    !isStateView(state) ||
    !state.connected ||
    !isFarmhandPolicyIdentity(state.policyIdentity) ||
    state.capabilityRevision !== state.policyIdentity.capabilityRevision
  ) {
    throw new Error("integration_not_ready");
  }
  return Object.freeze({
    value: state.policyIdentity.value,
    capabilityRevision: state.policyIdentity.capabilityRevision,
  });
}

function assertCurrentBodyProgramPolicyIdentity(
  state: IntegrationStateView,
  retainedPolicyIdentity: FarmhandPolicyIdentity,
): void {
  if (
    !isFarmhandPolicyIdentity(state.policyIdentity) ||
    state.capabilityRevision !== state.policyIdentity.capabilityRevision
  ) {
    throw new Error("integration_not_ready");
  }
  if (
    state.policyIdentity.value !== retainedPolicyIdentity.value ||
    state.policyIdentity.capabilityRevision !== retainedPolicyIdentity.capabilityRevision
  )
    throw new Error("body_program_preflight_rejected");
}

function isFarmhandPolicyIdentity(value: unknown): value is FarmhandPolicyIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["value", "capabilityRevision"])) return false;
  const capabilityRevision = value.capabilityRevision;
  if (
    typeof value.value !== "string" ||
    !/^[0-9a-f]{32}$/iu.test(value.value) ||
    typeof capabilityRevision !== "number"
  )
    return false;
  return Number.isSafeInteger(capabilityRevision) && capabilityRevision > 0;
}

function validateStatusRequest(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["programId"]) && isOpaque(value.programId) ? null : "invalid_body_program_request";
}
function validateEventsRequest(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["programId", "cursor", "pageSize"]) &&
    isOpaque(value.programId) &&
    Number.isSafeInteger(value.cursor) &&
    (value.cursor as number) >= 0 &&
    Number.isSafeInteger(value.pageSize) &&
    (value.pageSize as number) >= 1 &&
    (value.pageSize as number) <= 32
    ? null
    : "invalid_body_program_request";
}
function projectBodyNodeAdmissionResult(
  challenge: BodyNodeAdmissionChallenge,
  result: HostNodeAdmissionResult,
): BodyNodeAdmissionResult {
  switch (result.result) {
    case "granted":
      return Object.freeze({ ...result.grant, result: "granted" });
    case "rejected":
      return Object.freeze({ ...challenge, result: "rejected", code: result.code });
    case "unavailable":
      return Object.freeze({ ...challenge, result: "unavailable", code: result.code });
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export type HostGameRuntimeMaterializerOptions = Readonly<{
  gameOperationalGateNonceSha256?: string;
  /**
   * Opaque capability minted only by the healthy local Voice Gateway client.
   * The materializer alone supplies the receipt-backed session id and Host
   * interruption admission; absent means no presentation tools.
   */
  gameVoicePresentation?: GameVoicePresentationAttachment;
  /** Preview-only parent IPC attestation; absent for every ordinary production launch. */
  liveSourceAttester?: LiveSourceAttester;
  /**
   * Companion presentation locale from the single frontend-set language
   * preference (Tavern settings). Subsumes every presentation/Agent-session
   * locale so Host and Mod stay aligned; default zh-CN kept for existing
   * callers that predate the preference store.
   *
   * The value is the player's own BCP-47 tag (bounded by the preference store's
   * COMPANION_LOCALE_PATTERN), not a closed pair: an operator or fixture may hand in
   * any tag the runtime can speak, and the prompt layer names what it knows.
   */
  companionLocale?: CompanionLocale;
  /**
   * Optional fire-and-forget companion-language listener invoked after a
   * companion text successfully presented to the Game (e.g. to stream the
   * same line to TTS). A throwing listener never fails the presentation.
   */
  onCompanionTextPresented?: (text: string, locale: string) => void;
  /**
   * Cross-surface BaseIdentityProfile plus reviewed persona, assembled by the
   * Host from the same canonical identity-profile source the Chat surface
   * consumes. Absent keeps the default companion profile; the system never
   * fabricates a persona for a Game call.
   */
  identityProfile?: import("../identity-profile.js").IdentityProfile;
  /**
   * Host-owned reviewed WorldBook binding. Absent keeps Game without a world
   * book; the system never invents world lore for the Game surface.
   */
  worldBook?: import("../worldbook.js").WorldBookBinding;
}>;

export function createHostGameRuntimeMaterializer(
  options: HostGameRuntimeMaterializerOptions = {},
): GameRuntimeMaterializer {
  return Object.freeze({
    async materializeEnter(reservation, permit): Promise<MaterializedGameRuntime> {
      return await materializeExactEnter(reservation, permit, async (execution, admission) => {
        // One recorder per Game runtime: the run id is the game session this runtime is bound to.
        const runTrace = createRunTrace(permit.gameSessionId);
        const mountedPolicy = execution.connection.module.parsePolicy(execution.connection.module.defaultPolicy);
        const retainedPolicyIdentity = readBodyProgramPolicyIdentity(execution.connection);
        const recoveryIdentity = createStableGameRuntimeBindingIdentity(execution);
        const recoveryJournal = await StardewLogicalActionRecoveryJournal.open(
          Object.freeze({
            directory: join(
              execution.runtimeRoot,
              "stardew-recovery",
              recoveryIdentity.continuityId,
              recoveryIdentity.saveId,
              recoveryIdentity.worldId,
            ),
            scope: recoveryIdentity,
          }),
        );
        const bodyProgramAdmission = new HostNodeAdmissionService(recoveryJournal, (challenge) => {
          if (execution.connection.executionGate?.executable !== true)
            return { result: "unavailable", code: "admission_unavailable" };
          let state: IntegrationStateView;
          try {
            state = execution.connection.module.readState(execution.connection);
          } catch {
            return { result: "unavailable", code: "admission_unavailable" };
          }
          if (!isStateView(state) || !state.connected || state.registrations === undefined)
            return { result: "unavailable", code: "admission_unavailable" };
          assertCurrentBodyProgramPolicyIdentity(state, retainedPolicyIdentity);
          const visible = execution.connection.module.actionCatalog.visibleActions(
            state.registrations,
            state.enabledActionIds ?? [],
            mountedPolicy,
          );
          const action = visible.find((registration) => registration.actionId === challenge.actionId);
          if (action === undefined) return { result: "rejected", code: "policy_denied" };
          if (challenge.catalogRevision !== state.catalogRevision) return { result: "rejected", code: "catalog_stale" };
          if (
            challenge.policyIdentity.value !== retainedPolicyIdentity.value ||
            challenge.policyIdentity.capabilityRevision !== retainedPolicyIdentity.capabilityRevision
          )
            return { result: "rejected", code: "policy_identity_mismatch" };
          return {
            result: "granted",
            attachmentGeneration: state.sessionId ?? "",
            policyRevision: retainedPolicyIdentity.value,
          };
        });
        const ports = materializeAuthenticatedStardewLaunchPorts(
          execution,
          admission,
          async (challenge: BodyNodeAdmissionChallenge): Promise<BodyNodeAdmissionResult> =>
            projectBodyNodeAdmissionResult(challenge, await bodyProgramAdmission.admit(challenge)),
        );
        const recoveryContext = createStardewRecoveryBindingContext(execution, recoveryJournal);
        const bodyProgramConsumer = Object.freeze(Object.create(null)) as BodyProgramConsumer;
        // The Mod owns the capability surface (architecture #635), so when it says it cannot honour a program the Host
        // must not mount one. Measured 2026-10-18: the companion submitted real programs and every submission came
        // back `body_program_journal_unavailable`, because the journal opened only as far as `RecoveryRequired` and
        // composed no controller - an advertised capability that could not be honoured, which reads to the model as a
        // broken tool rather than an absent one.
        const bodyProgramUnavailableReason =
          (execution.connection as { state?: { bodyProgramUnavailableReason?: string | null } }).state
            ?.bodyProgramUnavailableReason ?? null;
        const bodyProgramMounted = bodyProgramUnavailableReason === null;
        // The decision is REPORTED, not just applied: whether the companion can batch a day's work at all hinges on it,
        // and when the tools went missing between two runs the artifacts said nothing about why (measured 2026-10-18:
        // manifests from 10:41-11:15 carry the three program tools, every manifest from 13:06 on carries none, and the
        // Mod's own log for the later runs says the routes are live). The marker lands in the run log next to the
        // harness's own, so "the companion did not batch" can be told apart from "it was never offered the tool".
        // The two readers are deferred, so the marker also says how far the offer went.
        process.stderr.write(
          `BODY_PROGRAM_MOUNT ${JSON.stringify({
            unavailableReason: bodyProgramUnavailableReason,
            mounted: bodyProgramMounted,
            readers: bodyProgramMounted ? "after_first_submission" : null,
          })}\n`,
        );
        if (bodyProgramMounted)
          bodyProgramConsumers.set(bodyProgramConsumer, { port: ports.bodyProgram, available: true, active: 0 });
        const closeFixedTools = bodyProgramMounted ? createBodyProgramToolCloser(bodyProgramConsumer) : async () => {};
        // Resolve exactly once for this construction; closures and adapter tools
        // share this same object while live state remains freshly read per call.
        let revealProgramReaders = (): void => {};
        const fixedTools = bodyProgramMounted
          ? createBodyProgramTools(
              bodyProgramConsumer,
              execution.connection,
              mountedPolicy,
              retainedPolicyIdentity,
              () => revealProgramReaders(),
              runTrace,
            )
          : Object.freeze([]);
        const recovery = readStardewRecoveryBindingContext(recoveryContext);
        let constructed: Readonly<{
          runtime: RuntimeSession;
          turnTracker: GameTurnLineageTracker;
          clearAuthoredContext?: () => Promise<void>;
          volatileAuthoredContext?: CompanionTurnVolatileContext;
        }>;
        try {
          constructed = await createMaterializedGameRuntime(
            execution.principal,
            execution.world,
            execution.runtimeRoot,
            execution.connection,
            ports.presentation,
            permit.gameSessionId,
            options.gameOperationalGateNonceSha256,
            options.gameVoicePresentation,
            options.companionLocale ?? (await resolveCompanionLocale(execution.runtimeRoot)),
            options.onCompanionTextPresented,
            fixedTools,
            Object.freeze({
              resolvedPolicy: mountedPolicy,
              recoveryJournal,
              recoveryBinding: Object.freeze({ scope: recovery.identity, bindingIdentity: recovery.identity }),
              recoveryPort: Object.freeze({
                scope: recovery.identity,
                bindingIdentity: recovery.identity,
                queryExecutionReceipt: recovery.queryExecutionReceipt,
              }),
            }),
            options.identityProfile,
            options.worldBook,
            runTrace,
          );
        } catch (error) {
          await closeFixedTools();
          await recoveryJournal.close();
          throw error;
        }
        const runtime = constructed.runtime;
        if (bodyProgramMounted) revealProgramReaders = mountProgramReadersAfterSubmission(runtime.session);
        await runtime.recoverStardewExecutionReceipts?.(
          Object.freeze({
            scope: recovery.identity,
            bindingIdentity: recovery.identity,
            queryExecutionReceipt: recovery.queryExecutionReceipt,
          }),
        );
        const liveSourceAttester = options.liveSourceAttester;
        const gameVoicePayload =
          options.gameVoicePresentation === undefined
            ? undefined
            : consumeGameVoicePresentationAttachment(options.gameVoicePresentation);
        const loop = new CompanionLoop(
          runtime.session,
          undefined,
          liveSourceAttester,
          gameVoicePayload?.streamingSink,
          constructed.volatileAuthoredContext,
        );
        const lifecycle = new IntegrationLifecycleSnapshot(execution.connection.module, execution.connection);
        const host = new CompanionHostService(
          loop,
          execution.launch.events,
          (reasonCode) => {
            lifecycle.markConnectionUnavailable();
            // Loss containment must retain cancellation rejection: seal adapter
            // authority first, then contain every remaining async teardown path.
            execution.launch.revoke(reasonCode);
            void (async () => {
              try {
                await runtime.interruptIntegrationExecutions?.(`integration_${reasonCode}`);
              } catch {
                // The revoked runtime cannot reopen. The rejected cancellation
                // has been observed and contained rather than discarded.
              }
              try {
                runtime.gameplaySubagent?.cancel(`integration_${reasonCode}`);
              } catch {
                // Cancellation is best-effort only after authority revocation.
              }
            })();
          },
          runtime.interruption,
          async (epoch, reasonCode) => {
            if (runtime.cancelIntegrationEpoch === undefined) throw new Error("stop_ledger_cancellation_unavailable");
            await runtime.cancelIntegrationEpoch(epoch, reasonCode);
          },
          async (reasonCode) => {
            if (runtime.gameplaySubagent === undefined) return;
            await runtime.gameplaySubagent.cancel(reasonCode);
          },
          constructed.turnTracker,
          runtime.bindIntegrationReceipt,
          liveSourceAttester,
          // The durable half of "she greets once": this Game session's own Pi transcript already holds
          // the batch that carried the arrival fact if a previous mount delivered it.
          Object.freeze({
            alreadySaid: () => companionArrivalAlreadySaid(runtime.sessionManager),
          }),
        );
        const operationalGateEvidence =
          options.gameOperationalGateNonceSha256 === undefined
            ? undefined
            : createGameOperationalGateEvidenceProjection(
                execution.connection.module,
                execution.connection,
                execution.launch.events,
                host,
              );
        // Pass an explicit narrow observer adapter. Do not rely on the Host
        // service object being structurally compatible across mixed emitted
        // generations; this is the exact Pi turn lifecycle surface.
        loop.attachTurnObserver(
          Object.freeze({
            beginPlayerBatch: (sourceEventId: string, batchId: string | undefined) =>
              host.beginPlayerBatch(sourceEventId, batchId),
            endBatch: (batchId: string | undefined) => host.endBatch(batchId),
          }),
        );
        if (
          runtime.presentation?.surface === "game" &&
          runtime.presentation.textPort !== undefined &&
          runtime.presentation.admissionProvider !== undefined
        ) {
          loop.attachNativeGameContentPresenter(
            host.createNativeAssistantContentPresenter({
              sessionId: runtime.presentation.sessionId,
              locale: runtime.presentation.profile.locale,
              admissionProvider: runtime.presentation.admissionProvider,
              textPort: runtime.presentation.textPort,
            }),
          );
        }
        if (gameVoicePayload !== undefined) host.attachVoiceStopper(gameVoicePayload.stopVoice);
        let ingressActivated = false;
        const activateIngress = (): void => {
          if (ingressActivated) return;
          ingressActivated = true;
          // These launch-owned facts are intentionally withheld until the
          // semantic enter receipt commits. Their first Pi turn therefore
          // cannot speak before both durable admission and STOP authority.
          host.acceptInitialFacts(execution.launch.initialFacts);
        };
        return Object.freeze({
          session: runtime.session,
          piSessionId: runtime.piSessionId,
          ...(runtime.gameplaySubagent === undefined ? {} : { gameplaySubagent: runtime.gameplaySubagent }),
          ...(runtime.clearGameOperationalGateMarker === undefined
            ? {}
            : {
                clearGameOperationalGateMarker: runtime.clearGameOperationalGateMarker,
              }),
          ...(operationalGateEvidence === undefined ? {} : { operationalGateEvidence }),
          closeRecoveryJournal: () => recoveryJournal.close(),
          // Written last on purpose: the export is the run's own evidence, so it must include every span that settled
          // before teardown. Perfetto and chrome://tracing open it directly.
          flushRunTrace: () =>
            writeRunTrace(join(dirname(runtime.paths.runManifestPath), "run-trace.json"), runTrace.spans()),
          closeFixedTools,
          ...(constructed.clearAuthoredContext === undefined
            ? {}
            : { clearAuthoredContext: constructed.clearAuthoredContext }),
          connected: Object.freeze({
            host,
            lifecycleSnapshot: () => lifecycle.snapshot(),
            ...(operationalGateEvidence === undefined
              ? {}
              : { nextOperationalGateEvidence: operationalGateEvidence.next }),
            markClosing: () => lifecycle.markClosing(),
            activateIngress,
          }),
        });
      });
    },
  });
}

/**
 * Private, read-only reduction of the live integration connection for the Host
 * game-status projection. It owns no lifecycle authority and reads no Chat or
 * origin data.
 */
class IntegrationLifecycleSnapshot {
  #connectionAvailable = true;
  #closing = false;

  public constructor(
    private readonly module: GameIntegrationAdapter,
    private readonly connection: GameConnection,
    private readonly policy?: IntegrationActionPolicy,
  ) {}

  public markConnectionUnavailable(): void {
    this.#connectionAvailable = false;
  }

  public markClosing(): void {
    this.#closing = true;
  }

  public snapshot(): HostGameLifecycleSnapshot {
    const surface = this.#closing ? "returning" : "active";
    if (!this.#connectionAvailable) return unavailable(surface, "absent");
    let state: IntegrationStateView;
    try {
      state = this.module.readState(this.connection);
    } catch {
      return unavailable(surface, "mismatch");
    }
    if (!isStateView(state)) return unavailable(surface, "mismatch");
    if (!state.connected || state.sessionId === null || state.snapshotRevision === null)
      return unavailable(surface, "absent");
    if (this.#closing) return unavailable(surface, "current");

    let count: number;
    try {
      count = this.module.actionCatalog.visibleActions(
        state.registrations ?? [],
        state.capabilities,
        this.policy,
      ).length;
    } catch {
      return unavailable("active", "mismatch");
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > 512) return unavailable("active", "mismatch");
    return Object.freeze({
      availability: "available",
      surface: "active",
      freshness: "current",
      availableCapabilities: Object.freeze({
        category: count === 0 ? "none" : "available",
        count,
      }),
      activeExecution: state.activeExecution === null ? "none" : "active",
      latestAuthoritativeReceipt:
        state.latestReceipt === null
          ? "none"
          : state.latestReceipt.state === "succeeded"
            ? "succeeded"
            : "not_succeeded",
    });
  }
}

function unavailable(
  surface: HostGameLifecycleSnapshot["surface"],
  freshness: HostGameLifecycleSnapshot["freshness"],
): HostGameLifecycleSnapshot {
  return Object.freeze({
    availability: "unavailable",
    surface,
    freshness,
    availableCapabilities: Object.freeze({ category: "none", count: 0 }),
    activeExecution: "none",
    latestAuthoritativeReceipt: "none",
  });
}

function isStateView(value: unknown): value is IntegrationStateView {
  return (
    isRecord(value) &&
    typeof value.connected === "boolean" &&
    (value.sessionId === null || isOpaque(value.sessionId)) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 512 &&
    value.capabilities.every(isOpaque) &&
    (value.snapshotRevision === null ||
      (typeof value.snapshotRevision === "number" &&
        Number.isSafeInteger(value.snapshotRevision) &&
        value.snapshotRevision >= 0)) &&
    (value.activeExecution === null || isRecord(value.activeExecution)) &&
    (value.latestReceipt === null || isRecord(value.latestReceipt))
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

type MaterializedGameRuntimeInput = Readonly<{
  principal: Readonly<{
    continuityId: string;
    companionId: string;
    playerId: string;
  }>;
  world: Readonly<{ saveId: string; worldId: string }>;
  runtimeRoot: string;
  connection: GameConnection;
  gameSessionId: string;
}>;

/**
 * The only named Game runtime constructor lives in the construction-zone
 * materializer. It has no public export: an actual runtime becomes durable
 * Game authority only after this module validates an S4b execution and S4c
 * permit, then the later composer terminalizes an exact receipt.
 */
async function createMaterializedGameRuntime(
  principal: MaterializedGameRuntimeInput["principal"],
  world: MaterializedGameRuntimeInput["world"],
  runtimeRoot: string,
  connection: GameConnection,
  presentation: FarmhandPresentationBridge,
  gameSessionId: string,
  gameOperationalGateNonceSha256: string | undefined,
  _gameVoicePresentation: GameVoicePresentationAttachment | undefined,
  companionLocale: CompanionLocale,
  onCompanionTextPresented: ((text: string, locale: string) => void) | undefined,
  fixedTools: readonly ToolDefinition[],
  recoveryAttachment?: Pick<
    import("../runtime.js").GameCompanionRuntimeAttachment,
    "recoveryJournal" | "recoveryBinding" | "recoveryPort"
  > &
    Readonly<{ resolvedPolicy: IntegrationActionPolicy }>,
  identityProfile?: import("./../identity-profile.js").IdentityProfile,
  worldBook?: import("./../worldbook.js").WorldBookBinding,
  runTrace?: RunTrace,
): Promise<
  Readonly<{
    runtime: RuntimeSession;
    turnTracker: GameTurnLineageTracker;
    clearAuthoredContext?: () => Promise<void>;
    volatileAuthoredContext?: CompanionTurnVolatileContext;
  }>
> {
  const identity = Object.freeze({
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    playerId: principal.playerId,
    saveId: world.saveId,
    worldId: world.worldId,
  });
  // Game-surface persona/world-book assembly is Host-owned and reads the same
  // canonical identity-profile and world-book files the Chat surface consumes,
  // so an imported character card is present in Game without any caller (or
  // live-run script) supplying it. Missing files keep the default profile and
  // an empty Book; system assembly never fabricates content and never writes
  // (only the runtime core creates the default profile when absent).
  const context = await assembleGameRuntimeContext({
    identity,
    runtimeRoot,
    ...(identityProfile === undefined ? {} : { identityProfile }),
    ...(worldBook === undefined ? {} : { worldBook }),
  });
  const assembledProfile = context.profile;
  const assembledWorldBook = context.worldBook;
  const assembledScenario = context.scenario;
  const assembledWorldInfo = context.worldInfo;
  const turnTracker = new GameTurnLineageTracker();
  const presentationLocale = companionLocale;
  const hostBindingFactory = (handle: Readonly<{ interruption: CompanionInterruption }>) => {
    if (!isFarmhandPresentationBridge(presentation)) throw new Error("game_presentation_bridge_unavailable");
    return Object.freeze({
      surface: "game" as const,
      profile: Object.freeze({ locale: presentationLocale, text: true, speech: null }),
      sessionId: gameSessionId,
      textPort: createFarmhandCompanionPresentationPort(
        presentation,
        createFarmhandPresentationEpochAdmission(handle.interruption),
        onCompanionTextPresented,
        runTrace,
      ),
      admissionProvider: createGamePresentationAdmissionProvider(turnTracker, handle.interruption),
    });
  };
  // The player's own model configuration is a precondition of the surface, and
  // the operational gate nonce decides only whether the gameplay worker is
  // armed. A model-less Game session is not a degraded session but a dead one,
  // so the attachment builder fails closed before any runtime exists.
  const gameplayWorkerEnabled = gameOperationalGateNonceSha256 !== undefined;
  // The player's connections live in the identity-scoped runtime directory, so the
  // attachment reads the same record `runtime-core` resolves this runtime's provider
  // entry and credential from - the one the Chat surface reads too.
  const runtimeAttachment = await createGameRuntimeAttachment({
    runtimeRoot,
    agentDir: resolveRuntimePaths(identity, runtimeRoot).agentDir,
    gameplayWorkerEnabled,
    hostBindingFactory,
    ...(recoveryAttachment === undefined ? {} : { recoveryAttachment }),
  });
  const runtime = await createMaterializedGameCompanionRuntime(
    identity,
    runtimeRoot,
    connection,
    gameSessionId,
    gameOperationalGateNonceSha256 === undefined
      ? undefined
      : Object.freeze({ nonceSha256: gameOperationalGateNonceSha256 }),
    undefined,
    runtimeAttachment,
    Object.freeze({
      fixedTools,
      // The live Game surface's action vocabulary is the plan builder's, so its runtime never mounts the adapter's
      // per-action tools: they are the same 92 executable actions (host/src/body-program-script.ts), and a one-step
      // tool beside the plan tool only invites one-step runs. It is not a flat surface's fallback either - when the Mod
      // reports no Body Program surface this runtime has none, and the materializer's own `BODY_PROGRAM_MOUNT` marker
      // names that state instead of re-mounting ninety-five single-step tools.
      planActionSurface: true as const,
      resolvedPolicy:
        recoveryAttachment?.resolvedPolicy ?? connection.module.parsePolicy(connection.module.defaultPolicy),
      ...(assembledProfile === undefined ? {} : { initialProfile: assembledProfile }),
      ...(assembledWorldBook === undefined ? {} : { worldBook: assembledWorldBook }),
      ...(runTrace === undefined ? {} : { runTrace }),
    }),
  );
  // The Game surface carries the same reviewed companion the Chat surface
  // does. Its reviewed always-on WorldBook is a Tier 2 m[0] stable source
  // (typed `lorebook_constant`), and the companion's own scenario rides the
  // same tier (typed `scenario`): neither is a system-prompt blob or a lookup
  // the model must remember, and both share the prefix cache with the rest of
  // m[0]. Publication is process-local and keyed by the exact Pi session; the
  // returned clear is registered with the runtime disposal so a closed Game
  // session leaves no authored materialization behind.
  //
  // The capability itself is retained, not just its clear: the SAME catalog now
  // also carries the card's keyword-gated entries as per-turn volatile candidates,
  // and binding one turn's selection to its exact delivered batch is what makes
  // them reach this surface at all. Without the retained capability the published
  // volatile candidates would sit in the registry with no one to select them.
  const authoredContext =
    assembledWorldBook === undefined && assembledScenario === undefined && assembledWorldInfo === undefined
      ? undefined
      : await (async (): Promise<
          import("@cortexkit/pi-magic-context/tavern").TavernAuthoredContextRuntimeCapability
        > => {
          const profileMetadata = identityProfileMetadata(runtime.profile);
          const scope = Object.freeze({
            continuityId: identity.continuityId,
            sessionId: runtime.piSessionId,
            surface: "game" as const,
            threadId: /^[A-Za-z0-9._-]{1,128}$/u.test(gameSessionId) ? gameSessionId : identity.companionId,
            profile: Object.freeze({
              profileId: profileMetadata.profileId,
              revision: profileMetadata.revision,
              canonicalHash: profileMetadata.canonicalHash,
            }),
          });
          const catalog = buildGameSurfaceAuthoredCatalog(
            scope,
            assembledWorldBook,
            {
              char: runtime.profile.identity.name,
            },
            assembledScenario,
            assembledWorldInfo,
          );
          const { publishGameBuddyAuthoredStableCatalog } = await import("@cortexkit/pi-magic-context/tavern");
          try {
            return publishGameBuddyAuthoredStableCatalog(catalog.scope, catalog);
          } catch (error) {
            // A failed publication must not leave a live runtime behind: the
            // caller only receives a runtime from a successful mount.
            runtime.session.dispose();
            throw error;
          }
        })();
  return Object.freeze({
    runtime,
    turnTracker,
    ...(authoredContext === undefined
      ? {}
      : {
          clearAuthoredContext: async (): Promise<void> => {
            await authoredContext.clear();
          },
          volatileAuthoredContext: Object.freeze({
            bind: (turnId: string, deliveredBatch: string): void => {
              authoredContext.materializeVolatileForTurn(turnId, deliveredBatch, gameTurnWorldStateText(connection));
            },
            clear: (turnId: string): void => {
              authoredContext.clearVolatileForTurn(turnId);
            },
          }),
        }),
  });
}

/**
 * The live world-state line the companion is handed each turn.
 *
 * This is the exact text Magic Context injects for the same turn: the runtime registers
 * `formatGameEnvironmentFacts` over the authenticated Mod snapshot as its environment-facts
 * provider (`runtime-core.internal.ts:1010-1017`), and the vendored transform pass writes what
 * that provider returns as `<runtime-environment>`. Selecting the companion's own world-book
 * entries against it therefore keys them on what is happening now - the weather, the clock,
 * the season, her actor's stamina, where they are - AND on text the model demonstrably reads,
 * rather than on a state the browser or a caller supplied. An absent snapshot renders nothing
 * instead of inventing state, exactly as the provider does.
 *
 * Exported so the Game channel's corpus is verifiable by name rather than only through a
 * mounted runtime.
 */
export function gameTurnWorldStateText(connection: GameConnection): string {
  const snapshot = (connection as { state?: { snapshot?: Snapshot | null } }).state?.snapshot;
  if (snapshot === null || snapshot === undefined) return "";
  return formatGameEnvironmentFacts(snapshot, (snapshot.presentationLocale ?? "").toLowerCase().startsWith("zh"));
}

function isFarmhandPresentationBridge(value: unknown): value is FarmhandPresentationBridge {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FarmhandPresentationBridge).presentCompanionText === "function" &&
    typeof (value as FarmhandPresentationBridge).presentSystemNotice === "function" &&
    typeof (value as FarmhandPresentationBridge).state?.snapshot === "object"
  );
}
