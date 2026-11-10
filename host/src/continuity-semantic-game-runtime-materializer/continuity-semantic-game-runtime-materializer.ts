import { dirname, join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveCompanionLocale, type CompanionLocale } from "../settings/player-preference-store.js";
import {
  compilePlanScript,
  legalPlanActionIds,
  PLAN_FORM_ACTION_IDS,
  PLAN_TOOL_SLOT_MEANING,
  planActionsFromRegistrations,
  planProgramId,
  planSettlementNote,
  planShape,
  planWorkDescription,
  type CompiledPlan,
  type PlanScriptRequest,
  type PublishedPlanAction,
} from "../body-program-script.js";
import { planFormExecutionUnavailableReason } from "../body-program-for-each.js";
import {
  type BodyProgramNodeCatalogue,
  bodyProgramNodeAdmissionRefusal,
  bodyProgramPreflightRefusal,
} from "../body-program-preflight.js";
import { Type } from "typebox";
import {
  createStableGameRuntimeBindingIdentity,
  createStardewRecoveryBindingContext,
  readStardewRecoveryBindingContext,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import {
  type HostNodeAdmissionResult,
  type HostNodeAdmissionValidator,
  HostNodeAdmissionService,
} from "../action-execution-coordinator.internal.js";
import { materializeAuthenticatedStardewLaunchPorts } from "../stardew-integration-launcher-body-program.internal.js";
import { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import type { LiveSourceAttester } from "../companion-live-source-attestation.js";
import { companionArrivalAlreadySaid } from "../companion-arrival-fact.js";
import type { CompanionInterruption } from "../companion-interruption.js";
import { CompanionLoop, type CompanionTurnVolatileContext } from "../companion-loop.js";
import {
  createFarmhandCompanionPresentationPort,
  createFarmhandPresentationEpochAdmission,
  createFarmhandSystemNoticePresenter,
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
  IntegrationActionRegistration,
  IntegrationStateView,
} from "../game-integration-adapter.js";
import type { GameConnection } from "../game-connection.js";
import type { RuntimeSession } from "../runtime.js";
import { formatGameEnvironmentFacts } from "../game-world-vocabulary.js";
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
  type BodyProgramStatusResult,
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
import {
  isTerminalProgramStatus,
  MAX_PROGRAM_STATUS_WAIT_MS,
  planBatchAnswer,
  programStatusProgress,
  waitForTerminalProgramStatus,
  type PlanAnswerNode,
  type PlanBatchAnswer,
  type ProgramStatusProgress,
} from "../program-status-wait.js";
import {
  createProgramSettlementReporter,
  type SettledProgramAnswer,
  watchProgramSettlement,
} from "../program-settlement-digest.js";
import { createProgramEventDeliveryLedger, type ProgramSnapshotStaleness } from "../program-event-delivery.js";
import type { WorldFact } from "../event-pump.js";
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

/**
 * What a STOP needs to name and cancel the program the companion is running: the mounted port, and the identity the Mod
 * accepted most recently.
 *
 * Held here because the two facts live in different closures - the port is mounted inside the tool factory, and the STOP
 * hook is built where the Host service is constructed - and neither can see the other. Both are per-process facts (one
 * Game runtime per process), so this is not shared mutable state between runtimes.
 */
let mountedBodyProgramPort: BodyProgramPort | undefined;
let lastAcceptedProgramId: string | null = null;
/** The program's two readers: they answer only for a program a submission recorded. */
const programReaderToolNames = Object.freeze(["stardew_action_program_status", "stardew_action_program_events"]);

/** The wire's own maximum page size, so the settled-stamp read reaches a program's tail in the fewest pages. */
const SETTLED_DIGEST_EVENT_PAGE_SIZE = 32;

/**
 * How many event pages the settled-stamp read may walk.
 *
 * Four pages is 128 events: a 16-node plan writes one `accepted` plus a challenge, an admission, a dispatch and a
 * terminal per node - about 65 - so the tail of every plan `plan_work` can produce is reachable. The bound exists so a
 * journal that answers pages forever cannot hold the digest's composition open.
 */
const MAX_SETTLED_DIGEST_EVENT_PAGES = 4;

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
  announceSettledFact: (fact: WorldFact) => void,
): readonly ToolDefinition[] {
  const withPort = async <TResult>(
    request: Record<string, unknown>,
    validateRequest: (value: Record<string, unknown>) => string | null,
    validateResult: (value: Record<string, unknown>) => string | null,
    call: (port: BodyProgramPort) => Promise<TResult>,
  ): Promise<TResult> => {
    if (validateRequest(request) !== null) throw new Error("invalid_body_program_tool_arguments");
    const record = bodyProgramConsumers.get(consumer);
    if (record === undefined || !record.available) throw new Error("action_program_runtime_unavailable");
    record.active += 1;
    try {
      const result = await call(record.port);
      if (!isRecord(result) || validateResult(result) !== null) throw new Error("body_program_protocol_invalid");
      return Object.freeze(result) as TResult;
    } finally {
      record.active -= 1;
      if (!record.available && record.active === 0) record.drained?.();
    }
  };
  const invoke = async <TResult>(
    request: Record<string, unknown>,
    validateRequest: (value: Record<string, unknown>) => string | null,
    validateResult: (value: Record<string, unknown>) => string | null,
    call: (port: BodyProgramPort) => Promise<TResult>,
  ) => toolResult(await withPort(request, validateRequest, validateResult, call), null);
  /**
   * The settled-plan ledger. One per runtime, never global: the exactly-once claim is about what THIS session did
   * (`createProgramSettlementReporter`).
   */
  const settlement = createProgramSettlementReporter(announceSettledFact);
  /**
   * What this runtime's connection has already been delivered, per program (`program-event-delivery.ts`). One per
   * runtime, beside the settlement ledger: the cursors belong to THIS session's journal, and program ids repeat.
   */
  const eventDelivery = createProgramEventDeliveryLedger();

  /**
   * The Mod's own stamp of the moment it closed this program's journal, or `null` when it cannot be read.
   *
   * The Mod stamps every journal event with `atMs` (`BodyProgramJournalEvent.AtMs`: the moment it appended the event,
   * on its own monotonic clock), and the LAST event it appended for a program is the one that settled it - there is no
   * program-level settlement event, only `node_completed`/`node_skipped`/`node_settled`/`stopped`/`abandoned`. The
   * reader is a cursor page, so reaching the tail means walking it; the walk is bounded because a 16-node plan writes
   * about 65 events. Past the bound the stamp is `null` rather than the newest one seen: "the newest I could read" is
   * not when the program settled, and a Host clock would measure the bridge instead of the game.
   */
  const readProgramSettledAtMs = async (programId: string): Promise<number | null> => {
    let cursor = 0;
    for (let page = 0; page < MAX_SETTLED_DIGEST_EVENT_PAGES; page += 1) {
      const request = { programId, cursor, pageSize: SETTLED_DIGEST_EVENT_PAGE_SIZE };
      const read = await withPort(request, validateEventsRequest, validateBodyProgramEventsResult, (port) =>
        port.events(request),
      );
      if (read.code !== "found" || read.events.length === 0) return null;
      const last = read.events[read.events.length - 1];
      if (last === undefined) return null;
      if (read.events.length < SETTLED_DIGEST_EVENT_PAGE_SIZE) return last.atMs;
      cursor = read.nextCursor;
    }
    return null;
  };

  /**
   * Follow one submitted program to its terminal state, so the digest arrives without the companion asking.
   *
   * NOT awaited: `plan_work` must return as soon as the Mod accepts, because the control points that make a body
   * program interruptible (`program_stop`, steering) live in the turn such a wait would hold. This watch is the
   * background half - the Mod's later terminal states become ONE fact on the pump, and a session whose port drained
   * ends it (`stillWatching`), so nothing polls a runtime that is gone.
   */
  const startSettlementWatch = (programId: string, nodes: readonly PlanAnswerNode[]): void => {
    void watchProgramSettlement({
      read: async () => {
        const record = bodyProgramConsumers.get(consumer);
        if (record === undefined || !record.available) throw new Error("action_program_runtime_unavailable");
        const result = await record.port.status({ programId });
        programStatusProgress.observe(result);
        eventDelivery.observeStatus(result);
        return result;
      },
      onSettled: async (status) => {
        const settledAtMs = await readProgramSettledAtMs(programId).catch(() => null);
        settlement.report({ programId, settledAtMs, compiled: nodes, status, nowMs: Date.now() });
      },
      stillWatching: () => bodyProgramConsumers.get(consumer)?.available === true,
    }).catch(() => undefined);
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
    if (code === "accepted" || code === "idempotent") {
      revealReaders();
      startSettlementWatch(request.programId, request.nodes);
    }
    return result;
  };
  /**
   * Whether this tool should still exist, recorded while the evidence is fresh.
   *
   * <p>
   * MEASURED 2026-11-01, four independent lines:
   * </p>
   * <ol>
   *   <li>`stardew_plan_work` compiles its script into the SAME program this tool submits - its own comment says the script is
   *       "submitted as ONE program, so the Mod's journal, admission and recovery see exactly what a hand-written program
   *       gives them".</li>
   *   <li>Across every recorded session there are 16 calls to this tool, and <b>zero</b> of them used a node with more than one
   *       dependency. All 16 were linear chains.</li>
   *   <li>After the two descriptions stopped advertising the same scenario (`b01c91dd`), a live run went 34 submissions with
   *       <b>0</b> to this tool - against 16-vs-82 before the change.</li>
   *   <li>It costs 4,267 bytes with the old description and 2,796 with the shortened one, on every request.</li>
   * </ol>
   *
   * <p>
   * SO WHY IS IT STILL HERE: `plan_work` emits exactly one dependency edge per node - "one dependency edge per call, nothing
   * more" - while this tool accepts an arbitrary DAG. Deleting it removes the only way to express a node that depends on two
   * predecessors. Physics makes that equivalent for one farmer today, and no recorded call needed it, but "no call needed it"
   * and "nothing can need it" are different claims and the second is the one a deletion rests on. The binding contract on the
   * Mod side is what decides, not this file.
   * </p>
   *
   * <p>
   * WHEN TO DELETE: after several more runs keep this at zero AND someone confirms no action's `bindings` can legitimately
   * require two predecessors. Until then the honest state is "kept, unused, and cheaper than it was".
   * </p>
   */
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
          "Submit a pre-compiled action program: explicit 'nodes', each with 'actionId', 'arguments', 'dependsOn' and 'bindings'.\\nUse it when you already know the exact low-level steps and their arguments in the Mod's '{type, canonicalValue}' form.\\nFor anything you would rather express as a sequence of 'builder.<actionId>({...})' calls, or as a loop over a snapshot\\nfamily, use 'stardew_plan_work' instead - it compiles to the same program and costs less to write.\\n\\nA node's actionId must be currently advertised; an unknown one is refused before anything runs, with diagnostics, and a\\nrefused candidate has no side effects. Nodes carry no deadline - the Mod derives each action's budget from its own\\nwatchdog, so never invent a clock value. 'bindings' maps a CONSUMER ARGUMENT NAME to {nodeId, factName} of a fact an\\nearlier node declares; keep that argument in 'arguments' too, with its observed literal value.",
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
        description: planWorkDescription(readPlanActions(connection)),
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
                    resourceClaims: compiled.requirement.resourceClaims,
                  }),
              // A script that threw is the one refusal no builder call explains, so the engine's own words and the
              // line they name travel with the refusal: `plan_script_threw:SyntaxError` alone leaves the companion
              // holding eight kilobytes of its own text with nowhere to look.
              ...(compiled.threw === undefined ? {} : { threw: compiled.threw }),
              ...(compiled.reasonCode.startsWith("plan_script_unknown_action:")
                ? { legalActionIds: legalPlanActionIds(actions) }
                : {}),
              // WHAT BECAME OF EVERY CALL SHE WROTE. A refusal that only says "no plan" leaves her guessing which of her
              // steps was the one that broke it; `dropped` names the calls that will not run and `acceptedSteps` the ones
              // that compiled, so the correction is one edit and one resubmission. `rejected` is the same refusals with
              // the action each call named and every argument it omitted - the detail a correction is written from.
              dropped: compiled.dropped,
              droppedCount: compiled.droppedCount,
              droppedTruncated: compiled.droppedCount > compiled.dropped.length,
              acceptedSteps: compiled.acceptedSteps,
              acceptedStepsCount: compiled.acceptedStepsCount,
              ...(compiled.mergedCount === 0 ? {} : { merged: compiled.merged, mergedCount: compiled.mergedCount }),
              ...(compiled.noStepNeededCount === 0
                ? {}
                : { noStepNeeded: compiled.noStepNeeded, noStepNeededCount: compiled.noStepNeededCount }),
              rejected: compiled.rejected,
            });
          }
          const nodes = compiled.program.nodes;
          const programId = planProgramId(compiled.snapshotRevision, nodes);
          // A HOST PLAN FORM THE ATTACHED MOD DOES NOT PUBLISH CANNOT BE EXECUTED, and naming that is the difference between
          // an answer and a silent success. Submitted anyway, the program is refused whole by the preflight, so every step
          // the caller wrote beside the loop is lost and the reason names a policy refusal instead of the one thing that has
          // to change. Answered HERE, the caller is told which nodes cannot run, in which order, and that nothing was sent.
          const unavailable = planFormNodesOutsideCatalogue(nodes, actions);
          if (unavailable.length > 0) {
            span.end({ reasonCode: unavailable[0]!.reasonCode, programId });
            return planDetails({
              accepted: false,
              nodeCount: nodes.length,
              reasonCode: unavailable[0]!.reasonCode,
              programId,
              submitted: NOT_SUBMITTED,
              unavailable,
            });
          }
          try {
            const submitted = await submitProgram({ programId, nodes });
            const code = submitted.details.code;
            if (typeof code !== "string") throw new Error("body_program_protocol_invalid");
            span.end({ programId, submitted: code, layoutFactsAbsent: compiled.layoutFactsAbsentCount });
            const accepted = code === "accepted" || code === "idempotent";
            // The Mod refused the candidate outright: nothing of this plan is in the world, so there is no program
            // identity to record and no settlement to read. Its own code is the reason, and the compiler's account of
            // every call she wrote travels beside it.
            if (!accepted)
              return planDetails({
                accepted,
                nodeCount: nodes.length,
                programId,
                submitted: code,
                // WHY, in the Mod's own words. Without it the answer is one word - `rejected` - and the node, the rule
                // and the detail that would let her fix the plan are all on the other side of the bridge.
                ...planRefusalAnswer(submitted.details.verification, code),
                ...layoutFactsNote(compiled),
              });
            // AWAITED, because the original design says so and the shape drifted away from it.
            //
            // `design/architecture/game-runtime-hierarchical-proposal.md` writes the intended surface as
            // `await game.act("till_soil", tile, …)` and says a short dynamic wait belongs to the LOCAL controller,
            // "not worth waking the model for". What shipped instead returns `accepted` immediately, so the model's only
            // way to learn the outcome is `program_status` - and a blocking wait there costs a whole model round trip.
            //
            // Measured 2026-11-03 (`round29`): 25 plans, 48 `program_status` calls, `waitMs` median 30,000 (the cap),
            // 29 of 48 asking >= 25 s, 248 s blocked = 28% of wall time. The physical work really takes those seconds;
            // what is waste is re-entering the model between the submit and the outcome.
            //
            // The wait is NOT a new mechanism: it is the same reader, the same cap and the same progress ledger the
            // status tool uses, so a plan that outlives the bound returns exactly what a status call would have.
            //
            // And the cap is deliberately NOT lowered: `program-status-wait.ts` records that answering instantly put the
            // model in an 84-call loop (round4, 459 s) because "it did not finish" is not something a caller can act on.
            // Recorded the moment the Mod accepts it: this is the identity a STOP has to name, and nothing else in the
            // Host knows which program is currently in the world.
            lastAcceptedProgramId = programId;
            /**
             * One answer shape for both branches: the batch's own settlement, its remaining count, and one row per node
             * the caller wrote, at the index it wrote it. A caller never has to match an `executionId` to know what
             * became of step 3.
             */
            const answerOf = (answer: PlanBatchAnswer, beside: Readonly<Record<string, unknown>> = {}) =>
              planDetails({
                accepted,
                nodeCount: nodes.length,
                programId,
                submitted: code,
                settled: answer.settled,
                remaining: answer.remaining,
                nodes: answer.nodes,
                // WHAT ARRIVES NEXT, IN THE ONE ANSWER SHE RE-READS WHILE DECIDING WHETHER TO WAIT. Measured `round43`:
                // 29 of 96 turns were `stardew_action_program_status` calls. The settlement is already pushed, so what
                // was missing was not a signal but the answer saying so - with the population it is waiting on.
                settlementNote: planSettlementNote(nodes.length),
                // What the plan assumed that the snapshot it was compiled against could not answer. Beside the plan rather
                // than in front of it: the warning is a fact the companion learns from, and a plan that blocked on it would
                // leave her no way to say "water them anyway".
                ...layoutFactsNote(compiled),
                ...stepAccountNote(compiled),
                ...beside,
              });
            /**
             * The clock for the read that produced this answer. `observe` is the ledger `stardew_action_program_status`
             * reports from, so a node cannot have one elapsed time in this answer and another in that one; a second
             * observation of the same payload returns the same anchor.
             */
            const readStatus = async () => {
              const result = await withPort(
                { programId },
                validateStatusRequest,
                validateBodyProgramStatusResult,
                (port) => port.status({ programId }),
              );
              programStatusProgress.observe(result);
              return result;
            };
            // WAITING IS OPT-IN, AND THE DEFAULT IS NOT TO.
            //
            // The first version blocked until the program settled, to save one model round trip. It does save that -
            // measured, polling fell from 48 calls to 4 - and it takes away the control points that make a body program
            // usable: while the call is held the model cannot stop, append or redirect, so `program_stop` is unreachable
            // exactly when it is needed, and a player's steering message waits behind the call for up to
            // MAX_PROGRAM_STATUS_WAIT_MS. A companion you cannot interrupt mid-swing is not this product.
            //
            // So the call returns as soon as the Mod accepts. A caller that genuinely wants to block passes `waitMs`, and
            // the capability survives without being imposed on everyone.
            const { waitMs } = params as { waitMs?: number };
            if (typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs <= 0) {
              // The submit already carries the Mod's journal as the Mod recorded it, so the non-waiting answer needs no
              // second call and no invented state: a program accepted as `idempotent` reports the state its nodes are in
              // NOW, which is how an identical resubmission comes back saying "step 3 was refused" instead of
              // "accepted" - the answer that made a measured companion submit the same `sleep({})` three times.
              const recorded = submitted.details.snapshot;
              const reading: BodyProgramStatusResult = Object.freeze({
                code: recorded === null ? "not_found" : "found",
                snapshot: recorded,
                // Not a journal page: this is the submit's own echo, so there is nothing to list and nothing counted.
                programs: null,
                programCount: 0,
              });
              return answerOf(planBatchAnswer(nodes, recorded, programStatusProgress.observe(reading)?.nodes ?? []));
            }
            const bounded = Math.min(waitMs, MAX_PROGRAM_STATUS_WAIT_MS);
            const first = await readStatus();
            const settled = isTerminalProgramStatus(first)
              ? Object.freeze({
                  result: first,
                  waited: Object.freeze({ reachedTerminal: true, snapshotChanged: false }),
                })
              : await waitForTerminalProgramStatus(readStatus, first, bounded);
            return answerOf(
              planBatchAnswer(
                nodes,
                settled.result.snapshot,
                programStatusProgress.observe(settled.result)?.nodes ?? [],
              ),
              {
                // The same fields a status call carries, so a plan that outlived the bound needs no second call to learn
                // what is left and whether anything moved while this one held the turn.
                status: settled.result,
                ...(settled.waited.snapshotChanged ? {} : { unchangedWhileWaiting: true }),
              },
            );
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
          "Read what a plan step must supply for one action, or for every plannable action of one family: the argument names with their types and, where the Mod declares a closed set, its values, plus the resource the action claims and the output facts a later step can bind. Read-only, so it changes nothing; ask it when you are unsure what builder.<actionId> takes instead of guessing and being refused. It also answers equipment: `toolRequirement` is the tool the surface declares the action needs (`category`, the surface's own `upgradeRequirement` word and the upgrade-level range that satisfies it) or `tool_requirement_undeclared` when the surface says nothing about a tool for it, and `toolSlotMeaning` says what a `slot` argument holds. A tool step is `builder.equipFor(<actionId>, <target>)` - pass the target you are about to act on and it writes the equip step and answers the slot to name, or refuses by name when only the Mod's handler knows the tool.",
        parameters: planShapeParameters(),
        execute: async (_toolCallId, params) => {
          const request = readPlanShapeRequest(params);
          const shape = planShape(readPlanActions(connection), request);
          if (!shape.ok)
            return planDetails({
              reasonCode: shape.reasonCode,
              // What the caller actually sent, so a wrong parameter name is one turn to fix instead of nine guesses.
              received: request.received,
              ...(shape.legalActionIds === undefined ? {} : { legalActionIds: shape.legalActionIds }),
              ...(shape.legalFamilies === undefined ? {} : { legalFamilies: shape.legalFamilies }),
            });
          // `toolSlotMeaning` stays as the FALLBACK for an argument the surface describes nothing about. The
          // authoritative word for any particular action is that action's own `arguments[].description`, carried from
          // the Mod's declaration through the wire - so this field shrinking to a fallback is the point, not a loss.
          return planDetails({ actions: shape.actions, toolSlotMeaning: PLAN_TOOL_SLOT_MEANING });
        },
      }),
    ),
    Object.freeze(
      defineTool({
        name: "stardew_action_program_status",
        label: "stardew_action_program_status",
        // The siblings described themselves with their own names, which is zero information (measured: an agent
        // reading this list could not tell what any of the three was for).
        //
        // `progress` is what a caller reads when it wants to know whether the plan is still moving: it exists because
        // the result used to give it nothing to size a decision with - measured 2026-11-02, 65 status calls spent 281 s
        // of a 24-minute run.
        //
        // And it is a DIAGNOSTIC, which the text has to say or the tool gets used as a progress bar: `plan_work` returns
        // as soon as the plan is accepted, so the settlement arrives as an execution receipt on the pump
        // (`host-service.ts` `acceptIntegrationFact`) rather than by asking here. Measured 2026-11-03 (`round29`): 48
        // calls, `waitMs` median 30,000 (the cap), 248 s blocked - the description advertised waiting, so it waited.
        description:
          "One submitted plan's journal state and its `progress`: `total`, `settled`, `remaining`, `running` (dispatched, receipt owed), `queued`, and `current` with `observedInStateMs` - how long this Host has watched that node in its state, so `0` means it has just appeared. This is a DIAGNOSTIC, not a progress bar: a plan's progress reaches you as receipts, so read this when a settlement you expected never arrived, or when a step looks stuck - not after every submission. `waitMs` is a rare opt-in that holds your turn until the plan settles or the bound expires (`waited.reachedTerminal` says which, `waited.snapshotChanged: false` that nothing moved); while it holds the turn you cannot stop, append or steer, so leave it out unless this turn genuinely needs the settled answer. `staleSnapshotReplaced` means the journal answered once from a state it had already moved past (`stale_snapshot:eventHighWater=N;delivered=M`) and this answer is the current re-read, so you are reading the plan's real state; `staleSnapshot` means the answer in front of you IS that older snapshot because the re-read did not catch up, so `state` describes where the plan was at N and must not be read as its current state.",
        // Mounted only once a submission has been recorded (see mountProgramReadersAfterSubmission); until then it can
        // only be read as empty, and two always-empty readers are what an agent polls instead of submitting the plan at
        // all.
        defaultActive: false,
        parameters: bodyProgramToolParameters("stardew_action_program_status"),
        execute: async (_toolCallId, params) => {
          if (!isBodyProgramStatusRequest(params)) throw new Error("invalid_body_program_tool_arguments");
          const { waitMs } = params as { waitMs?: number };
          const request = { programId: params.programId };
          // Every read passes through the observation ledger, every poll the wait makes included, so a node's clock
          // runs from when this Host first watched it in that state - not from when this particular call started.
          const read = async () => {
            const result = await withPort(request, validateStatusRequest, validateBodyProgramStatusResult, (port) =>
              port.status(request),
            );
            programStatusProgress.observe(result);
            return result;
          };
          /**
           * One read, plus the question a single read cannot answer: is this snapshot older than what this
           * connection has ALREADY been delivered for the program?
           *
           * `program-event-delivery.ts` holds the watermark and says why the two can disagree. The read that is
           * behind is not shown: the Mod composes its answer from the journal state it publishes, and the next read
           * is usually current again, so one re-read is the difference between reporting a finished plan as running
           * and answering it.
           */
          const readTracked = async () => {
            const result = await read();
            return Object.freeze({ result, staleness: eventDelivery.observeStatus(result) });
          };
          const first = await readTracked();
          const tracked = first.staleness === null ? first : await readTracked();
          // A lagging answer is kept as a FACT even when the re-read replaced it: the whole point is that the Mod's
          // journal can answer from a state it has already moved past, and a repair nobody can see is how that went
          // unnoticed (`stale_snapshot:eventHighWater=626;delivered=633` on a plan that had already settled).
          const staleness = Object.freeze({
            current: tracked.staleness,
            replaced: tracked.staleness === null ? first.staleness : null,
          });
          // Omitted or zero keeps the old behaviour exactly: one read, return. Only a caller that asked to wait
          // pays for the loop, so no existing path gets slower or starts blocking.
          if (waitMs === undefined || waitMs === 0 || isTerminalProgramStatus(tracked.result))
            return toolResult(
              tracked.result,
              null,
              planAnswerReading(
                tracked.result,
                programStatusProgress.observe(tracked.result),
                settlement.settled(params.programId),
              ),
              staleness,
            );
          const waited = await waitForTerminalProgramStatus(read, tracked.result, waitMs);
          return toolResult(
            waited.result,
            waited.waited,
            planAnswerReading(
              waited.result,
              programStatusProgress.observe(waited.result),
              settlement.settled(params.programId),
            ),
            Object.freeze({ current: eventDelivery.observeStatus(waited.result), replaced: null }),
          );
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
          const page = await invoke(params, validateEventsRequest, validateBodyProgramEventsResult, (port) =>
            port.events(params),
          );
          // A page states how far into the journal the Mod had already gone when it answered, which is a delivery
          // this Host now holds. `program-event-delivery.ts` compares later status snapshots against it.
          eventDelivery.observeEvents(params.programId, page.details);
          return page;
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

/**
 * The word the plan answer uses when a compiled program was never sent to the Mod.
 *
 * `accepted: false` alone cannot tell "the Mod refused it" from "the Host did not send it", and those two need different
 * corrections - one is about the world, the other about a form this Host can compile but the attached Mod cannot run.
 */
const NOT_SUBMITTED = "not_submitted";

/**
 * The nodes of a compiled plan whose action id is a Host plan FORM the attached Mod does not publish, in node order.
 *
 * Derived from `PLAN_FORM_ACTION_IDS` and the Mod's OWN catalogue, never from a list of "things that do not work yet":
 * the day the Mod publishes `for_each`, this answers empty and the loop is submitted like any other node. The reason code
 * is derived from the action id too (`for_each` -> `for_each_execution_unavailable`), so a second form needs no edit here.
 */
function planFormNodesOutsideCatalogue(
  nodes: readonly Readonly<{ actionId: string }>[],
  actions: readonly PublishedPlanAction[],
): readonly Readonly<{ index: number; actionId: string; reasonCode: string }>[] {
  const published = new Set(actions.map((action) => action.actionId));
  const unavailable: Readonly<{ index: number; actionId: string; reasonCode: string }>[] = [];
  for (const [index, node] of nodes.entries())
    if (PLAN_FORM_ACTION_IDS.includes(node.actionId) && !published.has(node.actionId))
      unavailable.push(
        Object.freeze({
          index,
          actionId: node.actionId,
          reasonCode: planFormExecutionUnavailableReason(node.actionId),
        }),
      );
  return Object.freeze(unavailable);
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
function readPlanShapeRequest(
  value: unknown,
): Readonly<{ actionIds?: readonly string[]; family?: string; received: readonly string[] }> {
  if (!isRecord(value)) throw new Error("invalid_body_program_tool_arguments");
  const received = Object.freeze(Object.keys(value));
  // A caller that names one action writes `actionId`; the tool's own schema says `actionIds`. Measured on a live run:
  // nine calls sent `{actionId: "sleep"}` and every one was refused with a bare `plan_shape_selector_invalid`, because
  // this reader and `PlanShapeRequest` disagreed by a plural and TypeScript could not see it (every field optional, so
  // `{actionId}` is assignable to `{actionIds?}`). Accept both spellings; the answer keeps one shape.
  const named = value.actionIds === undefined ? value.actionId : value.actionIds;
  const list = named === undefined ? undefined : Object.freeze(Array.isArray(named) ? [...named] : [named]);
  const family = value.family;
  if (list !== undefined && (list.length === 0 || !list.every(isPlanSelector)))
    throw new Error(`invalid_body_program_tool_arguments:received=${received.join("+") || "none"}`);
  if (family !== undefined && !isPlanSelector(family)) throw new Error("invalid_body_program_tool_arguments");
  return Object.freeze({
    ...(list === undefined ? {} : { actionIds: list }),
    ...(family === undefined ? {} : { family }),
    received,
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

/** How many of the Mod's diagnostics a refusal repeats; its wire bound allows 64, a plan answer is re-read every turn. */
export const MAX_PLAN_VERIFICATION_DIAGNOSTICS = 8;

/** How much of one diagnostic's own text a refusal repeats before the cut is marked. */
export const MAX_PLAN_VERIFICATION_TEXT_CHARS = 240;

/** One of the Mod's own diagnostic messages, verbatim, cut at the bound with the cut marked rather than silent. */
function boundedPlanDiagnosticText(value: string): string {
  return value.length > MAX_PLAN_VERIFICATION_TEXT_CHARS
    ? `${value.slice(0, MAX_PLAN_VERIFICATION_TEXT_CHARS)}\u2026`
    : value;
}

/**
 * The Mod's own account of WHY it refused a plan: the node that broke a rule, the rule's code, and its own text.
 *
 * <p>
 * MEASURED at `516e2559`: the Mod answers `submitted: "rejected"` with `details.verification` - the rejected node ids and
 * one diagnostic per violation - and the plan answer carried only `submitted: rejected`. She was handed a refusal with no
 * node, no rule and no detail, so the only correction available to her was to guess.
 * </p>
 *
 * <p>
 * EVERY STRING HERE IS THE MOD'S OWN. This projects, it never rephrases: `code`, `path` and `message` are what the other
 * side wrote. The single change is LENGTH - one message is cut at `MAX_PLAN_VERIFICATION_TEXT_CHARS` with the cut marked,
 * and the list is cut at `MAX_PLAN_VERIFICATION_DIAGNOSTICS` with the population beside it - because a plan answer is
 * tool-result text the model re-reads every turn, and 64 full diagnostics would crowd out the plan itself.
 * </p>
 *
 * <p>
 * WHEN THE FIELD IS ABSENT the answer SAYS SO with the code the Mod answered: `verification_absent:<submitted>` is a
 * statement about THIS answer (a reason exists on the other side and did not arrive here), never a silence that reads as
 * "the Mod gave no reason".
 * </p>
 */
export function planRefusalAnswer(verification: unknown, submitted: string): Readonly<Record<string, unknown>> {
  const record = isRecord(verification) ? verification : undefined;
  const listed = Array.isArray(record?.diagnostics) ? record.diagnostics : [];
  const diagnostics = listed
    .filter(isRecord)
    .map((row) =>
      Object.freeze({
        severity: typeof row.severity === "string" ? row.severity : "",
        code: typeof row.code === "string" ? row.code : "",
        nodeId: typeof row.nodeId === "string" ? row.nodeId : null,
        path: typeof row.path === "string" ? row.path : "",
        message: boundedPlanDiagnosticText(typeof row.message === "string" ? row.message : ""),
      }),
    )
    // A row carrying no code carries no reason, so it is not a diagnostic this answer may present as one.
    .filter((row) => row.code !== "");
  if (diagnostics.length === 0) return Object.freeze({ verificationAbsent: `verification_absent:${submitted}` });
  const shown = Object.freeze(diagnostics.slice(0, MAX_PLAN_VERIFICATION_DIAGNOSTICS));
  return Object.freeze({
    verification: Object.freeze({
      catalogRevision: Number.isSafeInteger(record?.catalogRevision) ? (record?.catalogRevision as number) : null,
      // The ids she has to look at, in the Mod's order and without repeats. An empty list is the true answer for a
      // refusal the Mod did not scope to a node, and it sits beside diagnostics that still name the rule.
      rejectedNodeIds: Object.freeze([
        ...new Set(diagnostics.map((row) => row.nodeId).filter((nodeId): nodeId is string => nodeId !== null)),
      ]),
      diagnostics: shown,
      diagnosticsCount: diagnostics.length,
      diagnosticsTruncated: diagnostics.length > shown.length,
    }),
  });
}

/**
 * The difference between the plan she wrote and the program that runs, on an ACCEPTED plan.
 *
 * <p>
 * Empty when there is none, for the same reason `layoutFactsNote` is: an ordinary plan should not spend payload saying
 * nothing. Present with a count and a `truncated` flag the moment the compiler wrote a step she did not (`inserted`),
 * folded two loops into one pass (`merged`) or found a step already true (`noStepNeeded`).
 * </p>
 * <p>
 * `dropped` cannot appear here, and that is the invariant rather than a coincidence: a plan with a refused call is refused
 * whole by the compiler, so an accepted answer always carries every step she wrote. Measured at `3d249ff1`:
 * `builder.talk_to_npc(...); builder.shop_purchase(...)` came back `ok: true` with ONE node, and the answer said the plan
 * was accepted - which is the shape this answer may never be able to produce again.
 * </p>
 */
function stepAccountNote(compiled: CompiledPlan): Readonly<Record<string, unknown>> {
  if (!compiled.ok) return {};
  return Object.freeze({
    ...(compiled.insertedCount === 0
      ? {}
      : {
          inserted: compiled.inserted,
          insertedCount: compiled.insertedCount,
          insertedTruncated: compiled.insertedCount > compiled.inserted.length,
          // WHICH NODES ARE THE COMPILER'S, exactly. The words beside it say what was written; this says where, so a
          // reading over the run's node outcomes can join on it without matching a node-id prefix.
          insertedNodeIds: compiled.insertedNodeIds,
        }),
    ...(compiled.mergedCount === 0 ? {} : { merged: compiled.merged, mergedCount: compiled.mergedCount }),
    ...(compiled.noStepNeededCount === 0
      ? {}
      : { noStepNeeded: compiled.noStepNeeded, noStepNeededCount: compiled.noStepNeededCount }),
  });
}

/**
 * The plan's own account of what it could not know: bounded warnings plus the population they were cut from.
 *
 * <p>
 * Absent when the plan asked nothing the snapshot could not answer - a block saying "nothing was missing" spends payload
 * on every ordinary plan to say nothing. `layoutFactsAbsentTruncated` is present for the same reason `droppedTruncated`
 * is: a reader must not have to compare two lengths to learn that the list is a window.
 * </p>
 */
function layoutFactsNote(compiled: CompiledPlan): Readonly<Record<string, unknown>> {
  if (!compiled.ok || compiled.layoutFactsAbsentCount === 0) return {};
  return Object.freeze({
    layoutFactsAbsent: compiled.layoutFactsAbsent,
    layoutFactsAbsentCount: compiled.layoutFactsAbsentCount,
    layoutFactsAbsentTruncated: compiled.layoutFactsAbsentCount > compiled.layoutFactsAbsent.length,
  });
}

/**
 * Every target family the Mod's snapshot declares, in the order `Snapshot` declares them (host/src/protocol.ts:212):
 * a script that cannot see which arrays exist cannot write a loop over one. The plan test reads the type and fails
 * when the two drift, so this list cannot quietly become a half-truth.
 */
const PLAN_TARGET_FAMILIES: readonly string[] = Object.freeze(
  `doorTargets forageTargets itemTargets refillWateringCanTargets fixedInteractionPoints cropTargets petBowlTargets slimeHutchTroughTargets bushTargets fruitTreeTargets shakeTreeTargets pedestalTargets fenceGateTargets harvestTargets seedTargets fertilizerTargets woodFenceTargets woodFenceResultTargets crabPotTargets crabPotResultTargets crabPotCollectTargets baitCrabPotTargets baitCrabPotResultTargets debrisTargets rockSourceTargets clearHoeDirtTargets artifactSpotTargets artifactSpotResultTargets treeChopSourceTargets treeChopResultTargets treeStumpTargets treeSaplingTargets weedTargets grassTargets caskTargets mannequinTargets signTargets siloTargets scytheCropTargets machineTargets npcRelationshipTargets petTargets animalProductTargets feedTroughTargets chests foodTargets shippingBinTargets craftingRecipeTargets cookingRecipeTargets cookingStationTargets shopTargets mineElevatorFloorTargets minecartTargets raftTargets horseTargets mineEntranceTargets animalDoorTargets fishPondTargets worldObjectTargets farmBuildingTargets dailyQuestTargets specialOrderTargets museumRewardTargets colorTargets tailoringTargets wearableTargets warpItemTargets mailboxTargets buildingChestTargets obeliskTargets farmAnimalPetTargets`.split(
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

/**
 * The families whose rows carry no `x`/`y`, so a script reading `row.x` here gets `undefined`.
 *
 * The parameter text is the only place a script learns a family's row shape, and it used to say "every entry carries
 * `targetId`, `x` and `y`" with four named exceptions. Measured 2026-11-01 against `protocol/bridge-v1.schema.json`,
 * the wire's own authority: 13 of the 69 families carry no tile, the text named 4 of them, and one of the four it
 * named (`chests`) does carry `x`/`y`. A plan over `minecartTargets` or `shopTargets` that believed the text read a
 * coordinate the row never had. The gate in `continuity-semantic-game-runtime-materializer.test.ts` derives this set
 * from the schema, so a family that gains or loses a tile fails there by name instead of shipping a wrong shape.
 */
const PLAN_TILELESS_FAMILIES: readonly string[] = Object.freeze([
  "craftingRecipeTargets",
  "cookingRecipeTargets",
  "dailyQuestTargets",
  "doorTargets",
  "foodTargets",
  "mineElevatorFloorTargets",
  "minecartTargets",
  "museumRewardTargets",
  "shopTargets",
  "specialOrderTargets",
  "tailoringTargets",
  "warpItemTargets",
  "wearableTargets",
]);

/**
 * The families whose rows carry no `targetId`: an action addressed by a tile, a slot or a coordinate cannot be named
 * through one, so these are the four whose row shape the parameters state in their own fields instead.
 *
 * Derived from the same schema read as `PLAN_TILELESS_FAMILIES`, and gated the same way: `chests` names its container
 * by `chestId`, which is what `chest_store` copies, so it belongs to this set rather than to a hand-written list.
 */
const PLAN_UNIDENTIFIED_FAMILIES: readonly string[] = Object.freeze([
  "chests",
  "doorTargets",
  "fixedInteractionPoints",
  "foodTargets",
  "warpItemTargets",
]);

function planToolParameters() {
  return Type.Object(
    {
      script: Type.String({
        minLength: 1,
        maxLength: 8192,
        description: `One synchronous script body, called once with \`snapshot\` (the frozen live observation) and \`builder\`; call builder.<actionId>({...}) with exactly the argument names that action declares, or builder.equipFor(<actionId>, <target>) to write an equip step. \`snapshot.tile\` is your own \`{ x, y }\` and one array exists per target family: ${PLAN_TARGET_FAMILIES.join(", ")}; every entry carries \`targetId\` except these, which carry only their own fields: ${PLAN_UNIDENTIFIED_FAMILIES.join(", ")}; and every entry carries \`x\` and \`y\` except ${PLAN_TILELESS_FAMILIES.join(", ")}. doorTargets names its source tile as \`sourceX\`/\`sourceY\` and its arrival map as \`targetLocation\`; chests carries \`chestId\`, \`displayName\`, \`isFridge\` and its own \`items\` array of \`{ slot, qualifiedItemId, displayName, stack }\` - every item the container holds, which is never truncated. \`snapshot.currentTool\` is the qualified id of the tool the farmer holds, \`snapshot.currentToolSlot\` is the slot it is in, and \`snapshot.toolSlots\` lists \`{ slot, label, upgradeLevel }\` for every tool in the pack. Before writing a tool action, ask \`stardew_plan_shape\` for that action: it names the tool category, any minimum upgrade level and what a \`slot\` argument holds, so no slot has to be guessed from tool order. Write the equip step with \`builder.equipFor(<actionId>, <target>)\`: it writes \`equip_tool\` before the action unless that tool is already the held one, and returns the slot to pass to the action. builder.nodeCount and builder.isFull() are live and 16 nodes is the whole plan; await, require, import, fetch and timers do not exist here and are refused by name.`,
      }),
      /**
       * Declared here because the tool already reads it: a parameter the implementation honours but the schema hides is
       * a capability nothing can reach - and a caller who wants the SETTLED per-node answer has no other one call to
       * make. The default is still not to wait (`a plan does not hold the turn unless the caller asks it to`), the cap
       * is the same `MAX_PROGRAM_STATUS_WAIT_MS` the status tool obeys, and the text says what the wait costs.
       */
      waitMs: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: MAX_PROGRAM_STATUS_WAIT_MS,
          description:
            "A rare opt-in: hold this turn until every node of the plan has stopped, or this many milliseconds pass, so `nodes` comes back terminal. While it holds the turn you cannot stop, append or steer - the plan runs either way and each step's receipt still arrives on its own, so leave it out unless this turn genuinely needs the settled answer.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

function isBodyProgramCandidateRequest(value: unknown): value is BodyProgramCandidateRequest {
  return isRecord(value) && validateBodyProgramCandidateRequest(value) === null;
}

function isBodyProgramStatusRequest(value: unknown): value is BodyProgramStatusRequest & { waitMs?: number } {
  return isRecord(value) && validateStatusRequest(value) === null;
}

function isBodyProgramEventsRequest(value: unknown): value is BodyProgramEventsRequest {
  return isRecord(value) && validateEventsRequest(value) === null;
}

/**
 * Cancel the program the companion is running, through the port that is actually mounted.
 *
 * The tools reach the port through `bodyProgramConsumers`; the STOP path needs the same port from outside that closure,
 * so it asks the same map rather than holding a second reference. At most one consumer is mounted per runtime, and a
 * caller that finds none has nothing to cancel.
 */
async function stopMountedBodyProgram(programId: string, stopEpoch: number): Promise<void> {
  if (mountedBodyProgramPort === undefined) return;
  await mountedBodyProgramPort.stop({ programId, stopEpoch });
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
    return Type.Object(
      {
        programId: opaque,
        waitMs: Type.Optional(
          Type.Integer({
            minimum: 0,
            maximum: 30_000,
            description:
              "Wait up to this many milliseconds for the plan to settle instead of returning at once; 0 or omitted returns immediately, which is what you want unless this turn needs the settled answer - while the call holds your turn you cannot stop, append or steer. waited.reachedTerminal says whether it settled or the bound expired, waited.snapshotChanged whether the plan moved at all meanwhile.",
          }),
        ),
      },
      { additionalProperties: false },
    );
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
  // Asked in ONE place (`body-program-preflight.ts`), because what may appear in a node is answered by four layers - the
  // preflight, the plan compiler's builder vocabulary, node admission and the Mod's own verifier - and a decision that
  // lives inline in the layer that also reads the connection cannot be tested, so it drifts. Admission asks the same
  // decision on the same catalogue and is measured to do so (`body-node-admission.test.ts`).
  const catalogue = readBodyProgramCatalogue(
    connection,
    mountedPolicy,
    state.registrations,
    state.enabledActionIds ?? [],
  );
  const refusal = bodyProgramPreflightRefusal(request.nodes, catalogue);
  if (refusal !== null) throw new Error(refusal);
}

/**
 * What the one node decision is asked of, projected ONCE: the ids this connection offers now, and every id the attached
 * Mod publishes at all.
 *
 * The projection is the adapter's own (`actionCatalog.visibleActions`, never a clause-by-clause recomputation - an earlier
 * message that recomputed it reported every clause passing for `cut_weeds` while `visible` refused it), and both gates
 * that ask the decision read it from here, so neither can hand the decision a catalogue the other would not.
 */
function readBodyProgramCatalogue(
  connection: GameConnection,
  mountedPolicy: IntegrationActionPolicy,
  registrations: readonly IntegrationActionRegistration[],
  enabledActionIds: readonly string[],
): BodyProgramNodeCatalogue {
  const visible = connection.module.actionCatalog.visibleActions(registrations, enabledActionIds, mountedPolicy);
  return Object.freeze({
    visibleActionIds: Object.freeze(visible.map((registration) => registration.actionId)),
    registeredActionIds: Object.freeze(registrations.map((registration) => registration.actionId)),
  });
}

/**
 * The Host's answer to one node's admission challenge, against the connection as it is NOW.
 *
 * THREE DIFFERENT FAILURES SHARED ONE CODE, so the Mod could only answer "unavailable" and the model could only retry:
 * measured 2026-10-26, every program that reached admission came back unavailable in the same second it was sent, and the
 * cause was unreadable from either end. Each cause is named apart.
 *
 * WHAT THE NODE MAY BE IS NOT DECIDED HERE. Whether the challenge's action id is a legal member of a program - a form
 * admitted as a form, its rows answering to the live policy - is `bodyProgramNodeAdmissionRefusal`, the same decision the
 * submission preflight asks, on the same projection of this connection. Measured 2026-11-10: admission tested the action id
 * against the action catalogue itself, so the run's only `for_each` was answered `policy_denied` after the preflight had
 * admitted it. What IS decided here is whether this node may START now: the gate, a readable attachment, and the identity
 * the preflight also saw.
 */
export function createStardewBodyNodeAdmissionValidator(
  connection: GameConnection,
  mountedPolicy: IntegrationActionPolicy,
  retainedPolicyIdentity: FarmhandPolicyIdentity,
): HostNodeAdmissionValidator {
  return (challenge) => {
    if (connection.executionGate?.executable !== true)
      return { result: "unavailable", code: "admission_unavailable:gate_not_executable" };
    let state: IntegrationStateView;
    try {
      state = connection.module.readState(connection);
    } catch {
      return { result: "unavailable", code: "admission_unavailable:read_state_threw" };
    }
    if (!isStateView(state)) return { result: "unavailable", code: "admission_unavailable:state_malformed" };
    if (!state.connected) return { result: "unavailable", code: "admission_unavailable:not_connected" };
    if (state.registrations === undefined)
      return { result: "unavailable", code: "admission_unavailable:no_registrations" };
    assertCurrentBodyProgramPolicyIdentity(state, retainedPolicyIdentity);
    const refusal = bodyProgramNodeAdmissionRefusal(
      challenge,
      readBodyProgramCatalogue(connection, mountedPolicy, state.registrations, state.enabledActionIds ?? []),
    );
    if (refusal !== null) return { result: "rejected", code: refusal };
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
  };
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
  const allowed = Object.hasOwn(value, "waitMs") ? ["programId", "waitMs"] : ["programId"];
  if (!hasExactKeys(value, allowed) || !isOpaque(value.programId)) return "invalid_body_program_request";
  if (!Object.hasOwn(value, "waitMs")) return null;
  const waitMs = value.waitMs;
  return typeof waitMs === "number" && Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 30_000
    ? null
    : "invalid_body_program_request";
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

/**
 * What a status read answers BESIDE the journal snapshot: the final ledger of a stopped plan, or the live progress of one
 * that still owes a publication.
 *
 * <p>
 * EXACTLY ONE, never both. They spell the same nodes: `progress.nodes` carries each node's state and the clock this Host
 * has watched it there, and the settled ledger carries each node's state with the Mod's own terminal code. On a stopped
 * plan the clocks are meaningless (`remaining` is `0` by definition) and the codes are the whole of what a reader needs,
 * so publishing both would state every node twice and leave a reader joining two lists. Measured `round43`: 29 of 96
 * turns were status polls - an answer that needs a second question produces exactly that.
 * </p>
 * <p>
 * WHEN THERE IS NO LEDGER: a program this runtime never settled - a rejected candidate, an id from another session, a
 * watch that expired - answers with the live progress, which is what this tool always did. The poll never RE-DERIVES a
 * settlement (an events walk, a second read) to fill the gap: the fact will arrive on the pump, and answering with a
 * rendering the settlement did not produce is what would make the two disagree.
 * </p>
 */
const planAnswerReading = (
  result: unknown,
  progress: ProgramStatusProgress | null,
  ledger: SettledProgramAnswer | null,
): Readonly<{ progress: ProgramStatusProgress | null } | { settled: SettledProgramAnswer }> =>
  ledger !== null && isTerminalProgramStatus(result) ? Object.freeze({ settled: ledger }) : Object.freeze({ progress });

/**
 * One tool result, with the wait's own outcome BESIDE the payload, not inside it.
 *
 * `waited` is `null` for a plain read, so a caller can tell "I did not wait" from "I waited and it was still
 * running" - the distinction the poll loop existed to express and a fixed `running` reply hides. `reading` rides
 * beside them both, because a read that did not wait still has to say how much work is left for the next decision to
 * be an informed one; it is absent only for the tools that have no plan to report on. It is `progress` OR `settled`,
 * never both (`planAnswerReading`).
 *
 * `staleSnapshot` and `staleSnapshotReplaced` are the same kind of fact, published for the same reason: a snapshot
 * older than what this connection already delivered is not a statement about the plan, and it must not be read as one
 * (`program-event-delivery.ts`). `staleSnapshot` means the answer being returned IS that snapshot - the journal did not
 * catch up when it was re-read - and `staleSnapshotReplaced` means one was received and the answer reports the current
 * read instead. Both are absent on every answer that never met a lagging snapshot.
 */
function toolResult<TDetails>(
  details: TDetails,
  waited: Readonly<{ reachedTerminal: boolean; snapshotChanged: boolean }> | null,
  reading?: Readonly<{ progress?: ProgramStatusProgress | null; settled?: SettledProgramAnswer | null }> | null,
  staleness?: Readonly<{ current: ProgramSnapshotStaleness | null; replaced: ProgramSnapshotStaleness | null }>,
) {
  const published = {
    ...(details as Record<string, unknown>),
    ...(waited === null ? {} : { waited }),
    ...(reading?.progress === undefined ? {} : { progress: reading.progress }),
    ...(reading?.settled === undefined || reading.settled === null ? {} : { settled: reading.settled }),
    ...(staleness?.current === undefined || staleness.current === null
      ? {}
      : { staleSnapshot: staleness.current.code }),
    ...(staleness?.replaced === undefined || staleness.replaced === null
      ? {}
      : { staleSnapshotReplaced: staleness.replaced.code }),
  } as TDetails;
  return Object.freeze({
    content: [{ type: "text" as const, text: JSON.stringify(published) }],
    details: published,
  });
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
        const bodyProgramAdmission = new HostNodeAdmissionService(
          recoveryJournal,
          createStardewBodyNodeAdmissionValidator(execution.connection, mountedPolicy, retainedPolicyIdentity),
        );
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
        mountedBodyProgramPort = ports.bodyProgram;
        const closeFixedTools = bodyProgramMounted ? createBodyProgramToolCloser(bodyProgramConsumer) : async () => {};
        // Resolve exactly once for this construction; closures and adapter tools
        // share this same object while live state remains freshly read per call.
        let revealProgramReaders = (): void => {};
        // The settled digest's route onto the pump. Assigned the moment the Host service exists - the tools are built
        // first and cannot see it - and a fact that arrives before then (it cannot: nothing has been submitted) is
        // dropped by the no-op rather than queued somewhere else.
        let announceHostFact: (fact: WorldFact) => void = () => {};
        const fixedTools = bodyProgramMounted
          ? createBodyProgramTools(
              bodyProgramConsumer,
              execution.connection,
              mountedPolicy,
              retainedPolicyIdentity,
              () => revealProgramReaders(),
              runTrace,
              (fact) => announceHostFact(fact),
            )
          : Object.freeze([]);
        const recovery = readStardewRecoveryBindingContext(recoveryContext);
        // Resolved once, because two things need the SAME answer: the runtime's presentation profile and the locale of
        // the Host's own status lines. Two reads could disagree after a Settings change between them.
        const companionLocale = options.companionLocale ?? (await resolveCompanionLocale(execution.runtimeRoot));
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
            companionLocale,
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
          // The last mile of "the player speaks and the work stops". The Mod has been able to cancel a program since
          // the journal was written, but nothing on this side ever asked: a STOP sealed the model and left the body
          // walking, because a submitted program is immutable and the Mod only refuses NEW intents.
          //
          // `stopEpoch` is the STOP epoch this interruption just opened, which is exactly the monotonic fence the Mod
          // checks against its own journal. A bridge that is already gone cannot cancel anything, so a refusal there is
          // reported rather than thrown - the STOP itself has already succeeded by this point and must not be undone by
          // a transport that no longer exists.
          (stopEpoch: number) =>
            lastAcceptedProgramId === null
              ? Promise.resolve()
              : stopMountedBodyProgram(lastAcceptedProgramId, stopEpoch).catch((error: unknown) => {
                  throw new Error(
                    `body_program_stop_refused:${String(error instanceof Error ? error.message : error)}`,
                  );
                }),
        );
        // The settled digest rides the pump from here on. `host` is the only layer that owns it, which is why the
        // tools' sink was left unbound until this line.
        announceHostFact = (fact) => host.acceptHostMintedFact(fact);
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
        // The player-facing STATUS lane. A Game run's only other outward line is her own voice
        // (`presentNativeAssistantContent`), which needs a turn that exists and says something she means - so a run
        // waiting on the provider had no way to say anything at all. This is the same narrow notice capability Preview
        // mounts, addressed to the same authenticated presentation bridge, and it is a different request on the wire
        // (`system_notice_request`), never a `companion_text` piece.
        host.attachSystemNoticePresenter(createFarmhandSystemNoticePresenter(ports.presentation), companionLocale);
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
    ...(companionLocale === undefined ? {} : { locale: companionLocale }),
  });
  const assembledProfile = context.profile;
  const assembledWorldBook = context.worldBook;
  const assembledScenario = context.scenario;
  const assembledWorldInfo = context.worldInfo;
  // The generation preset's tail entry, when this runtime cwd was provisioned with a preset that places one at the
  // tail. It is published as the catalog's `postHistoryInstructions`; the card's own closing direction is not, and
  // that pair is the R-2 decision `buildGameSurfaceAuthoredCatalog` records.
  const assembledPresetPostHistory = context.preset?.postHistory;
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
    assembledWorldBook === undefined &&
    assembledScenario === undefined &&
    assembledWorldInfo === undefined &&
    assembledPresetPostHistory === undefined
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
            assembledPresetPostHistory,
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
