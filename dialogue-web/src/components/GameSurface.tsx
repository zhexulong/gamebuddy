import { Gamepad2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Messages } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import {
  ComposedReferenceGameProblemError,
  type ComposedReferenceGameBrowserApi,
  type GameBrowserStateV1,
  type GameCreateRequestV1,
  type GameCreateResultV1,
  type GameFactPatchV1,
  type GameResumeResultV1,
  type StardewCabinChoiceV1,
} from "../composed-reference-game-browser-api";
import {
  deriveGameLifecycleControlAvailability,
  deriveGameSessionControls,
  setupStagedNothing,
  type CabinLaunchWaitState,
  type GameSessionPhase,
} from "../game-lifecycle-controls";
import {
  composedProblemView,
  gameOperationFailure,
  observedProblemCode,
  type GameOperationFailure,
} from "../composed-problem-view";
import {
  type GameAttachmentEvent,
  type GameAttachmentOperation,
  type GameAttachmentState,
  GAME_ATTACHMENT_ATTACHED,
  gameAttachmentRows,
  reduceGameAttachment,
} from "./game-app-state";
import { CompanionAvatar } from "./CompanionAvatar";
import { GameDiagnosticsDisclosure } from "./GameDiagnosticsDisclosure";
import { GamePlayerSettings } from "./GamePlayerSettings";
import { GameStatePanel, type CabinViewState } from "./GameStatePanel";
import { StardewInstallationDiscovery } from "./StardewInstallationDiscovery";
import { SurfaceModelSettings } from "./SurfaceModelSettings";
import { SurfaceView } from "./SurfaceView";
import {
  CABIN_REREAD_INTERVAL_MS,
  CABIN_REREAD_MAX_ATTEMPTS,
  delay,
  GAME_STREAM_RESYNC_LIMIT,
  newIdempotencyKey,
  RESUMABLE_CONNECTION_STATUSES,
  RESUME_REREAD_INTERVAL_MS,
  RESUME_REREAD_MAX_ATTEMPTS,
  STARDEW_GAME_INTEGRATION_ID,
  type ViewState,
} from "./composed-reference-game-view";

/**
 * Who asked for the cabin read, which decides how the panel reports it.
 *
 * `launch_wait` is the one origin that is not a player's act and must not rewrite the screen to
 * `loading` on every attempt: it states its own progress instead. `refresh_pressed` is the one
 * origin whose answer the panel acknowledges ("just read again: this is still the answer"), because
 * it is the press whose result the player would otherwise read as an identical screen.
 * `stale_choice` is the game having refused the choice the player pressed as stale, and it is the
 * one origin whose answer carries that refusal: the list it brings back is the answer to it, and the
 * panel names the refusal above that list so a press the game declined is not silence.
 */
type CabinReadOrigin = "surface_ready" | "refresh_pressed" | "stale_choice" | "launch_wait";

/**
 * What a cabin read found.
 *
 * Returned as well as published because the launch wait's stop condition is this fact: re-deriving
 * "a cabin arrived" from the state the read just set would be one fact spelled twice.
 */
type CabinHandoffAnswer = "choices" | "missing" | "unavailable";

/**
 * The Game peer surface.
 *
 * It owns the Game lifecycle wiring the shell used to hold: cabin discovery, the
 * first-run activation/setup/launch controls, the session stop/disconnect/
 * resume/reopen/create commands, the bounded authoritative rereads that decide
 * shell supplies only the session seam it cannot own - the live view, the commit that publishes a
 * new Game projection, the cancellation flag, the two clients and the labels. Nothing here writes the
 * conversation: the projection of the Game, and the fact that its own command finished, is the whole
 * of what a Game operation may publish.
 *
 * It is mounted for the whole ready lifetime once the player has opened it, and the shell parks it
 * rather than unmounting it while another peer holds the region (`ComposedReferenceGameApp`'s Game
 * slot), because the panels inside it hold drafts. That is also why its state survives a surface
 * switch exactly as it did inside the shell (a peer surface that resets its in-flight attempt on
 * every AppBar click would forget a resume the player is watching). The one thing an arrival does add
 * is the shell's own re-read of the projection it renders, taken in the shell's arrival effect rather
 * than here, so it cannot touch this surface's in-flight attempt. When it fails, the shell hands this
 * surface the refusal's sentence as `arrivalNotice`.
 */
export function GameSurface({
  selected,
  ready,
  game,
  csrfToken,
  labels,
  companionHandle,
  companionName,
  companionDigest,
  readView,
  commit,
  isCancelled,
  composedApi,
  managementApi,
  arrivalNotice,
  restoreFocusTo,
}: {
  selected: boolean;
  ready: boolean;
  game: GameBrowserStateV1 | null;
  csrfToken: string;
  labels: Messages;
  /**
   * The mounted companion the situation card draws - the same handle the AppBar and the
   * transcript draw her with.
   *
   * Her picture is a Chat-side fact: the Game projection publishes `companionName` and nothing
   * else, and that field is `null` on every Host that has answered
   * (`stardew-production-lifecycle-coordinator.internal.ts`), so a card that read only the
   * projection could never draw her at all. The shell already holds the mounted companion's
   * handle, name and picture digest, which is what makes this the one companion drawn in three
   * places rather than a letter in one of them. `null` is a mount with no companion.
   */
  companionHandle: string | null;
  companionName: string;
  /** The digest of the picture the player last gave her, when the shell knows one. */
  companionDigest?: string;
  readView: () => ViewState;
  commit: (next: ViewState) => void;
  isCancelled: () => boolean;
  composedApi: ComposedReferenceGameBrowserApi;
  managementApi: ManagementPipelineApi;
  /**
   * The shell's own arrival refresh for this surface failed, in the refusal's own sentence.
   *
   * The panel keeps the projection the shell already holds - a refresh that failed did not make it
   * wrong - so this line is what keeps the surface honest about a read that never happened. The
   * shell owns the sentence because the shell owns the read; this surface owns where the player
   * reads it.
   */
  arrivalNotice: string | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  const [cabinView, setCabinView] = useState<CabinViewState>({ kind: "loading" });
  /**
   * What this surface's own post-launch cabin reads are doing (`CabinLaunchWaitState`).
   *
   * `not_launching` is every ordinary screen, so the panel's launch copy can never be reached from a
   * state where nobody is asking anything.
   */
  const [cabinLaunchWait, setCabinLaunchWait] = useState<CabinLaunchWaitState>({ kind: "not_launching" });
  const cabinLaunchWaitActiveRef = useRef(false);
  const cabinConfirmationActiveRef = useRef(false);
  const gameActivationActiveRef = useRef(false);
  const [gameActivationActive, setGameActivationActive] = useState(false);
  const [gameActivationFailure, setGameActivationFailure] = useState<GameOperationFailure | null>(null);
  const [gameActivationNotConfigured, setGameActivationNotConfigured] = useState(false);
  const [gameActivationUnavailable, setGameActivationUnavailable] = useState(false);
  const gameSetupActiveRef = useRef(false);
  const gameSetupKeyRef = useRef<string | undefined>(undefined);
  const [gameSetupActive, setGameSetupActive] = useState(false);
  const [gameSetupFailure, setGameSetupFailure] = useState<GameOperationFailure | null>(null);
  const [gameSetupNotStaged, setGameSetupNotStaged] = useState(false);
  const gameStopKeysRef = useRef(new Map<number, string>());
  const gameLaunchKeysRef = useRef(new Map<number, string>());
  const disconnectKeysRef = useRef(new Map<number, string>());
  /**
   * The attachment's own state - launch, stop and disconnect - in one value (`./game-app-state`).
   *
   * These three operations used to be three cells each, so Stop and Disconnect (both offered on an
   * attached, connected-idle session, each disabled only by its own flag) could be admitted together
   * against one attachment generation, and a refusal stayed on screen after the next attempt had
   * superseded the session it described. One value makes a second admission impossible rather than
   * merely unlikely.
   *
   * The ref holds the same value for the one question a render cannot answer: whether THIS press is
   * admitted, read synchronously before the command is issued.
   */
  const [attachment, setAttachmentState] = useState<GameAttachmentState>(GAME_ATTACHMENT_ATTACHED);
  const attachmentRef = useRef<GameAttachmentState>(GAME_ATTACHMENT_ATTACHED);
  /** True when this operation was admitted, false while another attachment operation is in flight. */
  const admitAttachment = (operation: GameAttachmentOperation): boolean => {
    const next = reduceGameAttachment(attachmentRef.current, { type: "started", operation });
    if (next === attachmentRef.current) return false;
    attachmentRef.current = next;
    setAttachmentState(next);
    return true;
  };
  const setAttachment = (event: GameAttachmentEvent): void => {
    const next = reduceGameAttachment(attachmentRef.current, event);
    attachmentRef.current = next;
    setAttachmentState(next);
  };
  const gameResumeActiveRef = useRef(false);
  const gameResumeKeysRef = useRef(new Map<number, string>());
  const [gameResumeActive, setGameResumeActive] = useState(false);
  const [gameResumeFailure, setGameResumeFailure] = useState<GameOperationFailure | null>(null);
  const [gameResumeUnavailable, setGameResumeUnavailable] = useState(false);
  const gameReopenActiveRef = useRef(false);
  const gameReopenKeysRef = useRef(new Map<number, string>());
  const [gameReopenActive, setGameReopenActive] = useState(false);
  const [gameReopenFailure, setGameReopenFailure] = useState<GameOperationFailure | null>(null);
  const [gameReopenUnavailable, setGameReopenUnavailable] = useState(false);
  const gameResumeCancelActiveRef = useRef(false);
  const gameResumeCancelKeysRef = useRef(new Map<number, string>());
  const [gameResumeCancelActive, setGameResumeCancelActive] = useState(false);
  const [gameResumeCancelFailure, setGameResumeCancelFailure] = useState<GameOperationFailure | null>(null);
  const gameCreateActiveRef = useRef(false);
  const [gameCreateActive, setGameCreateActive] = useState(false);
  const [gameCreateFailure, setGameCreateFailure] = useState<GameOperationFailure | null>(null);
  const [gameCreateUnavailable, setGameCreateUnavailable] = useState(false);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [continuityIdentityInput, setContinuityIdentityInput] = useState("");
  const gameEndgameActiveRef = useRef(false);
  const gameEndgameKeysRef = useRef(new Map<number, string>());
  const [gameEndgameActive, setGameEndgameActive] = useState(false);
  const [gameEndgameFailure, setGameEndgameFailure] = useState<GameOperationFailure | null>(null);
  /**
   * The read this surface's own step could not make, in the words the refusal catalogue gives it.
   *
   * A press is not a command: it has no group to land in, and `rereadGame` throws on purpose - every
   * command awaits it inside its own `try`, so a read that failed after a command is stated as THAT
   * operation's failure, and swallowing it there would make a command look confirmed by a read that
   * never landed. Measured 2026-11-24: without this, a route that answered HTML left the rejection to
   * the browser (an unhandled `non_json_response`), and the panel redrew exactly the screen it was
   * already on, saying nothing about the read that never happened.
   *
   * `code` is the bounded code the failure carried (`observedProblemCode`), kept as an attribute on
   * the line for a report or a gate. A code is never part of a sentence a player reads.
   */
  const [gameReadFailure, setGameReadFailure] = useState<Readonly<{
    sentence: string;
    code: string | null;
  }> | null>(null);
  /**
   * The UI-level confirm step for the terminal endgame operation: the first
   * click only arms this, and the POST happens on the confirm button alone
   * (design/28 §5.2). It is disarmed whenever the session it was armed against
   * stops being endgame-available, so a stale confirm never lingers.
   */
  const [endgameConfirmArmed, setEndgameConfirmArmed] = useState(false);
  const cabinIdempotencyKeysRef = useRef(new Map<string, string>());
  /**
   * The latest render's own seams, for the push channel.
   *
   * A ref rather than an effect dependency: re-subscribing because a closure identity changed would drop a live
   * connection for a fact that did not change, and the effect's own lifetime has to be the epoch's and the cursor's.
   */
  const readViewRef = useRef(readView);
  const commitRef = useRef(commit);
  const rereadGameRef = useRef<() => Promise<void>>(async () => undefined);
  /** The waits below, woken by every fact the channel applies. Bounded by the operations that can be in flight. */
  const gameFactWaitersRef = useRef(new Set<() => void>());

  /**
   * Which cabin state an error stands for.
   *
   * Only one message is distinguishable to the player, and it is the one with a cure: the Host answers
   * `stardew_player_host_cabin_missing` when this world cannot host the companion YET, and the product's own
   * guidance is to have Robin build a cabin. Every other failure is a read that could not be made.
   *
   * `reread` rides along so the panel can say the player's own click was read, instead of re-rendering the identical
   * screen with no sign anything happened.
   */
  const cabinViewFor = (error: unknown, reread: boolean): CabinViewState => {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "stardew_player_host_cabin_missing" ? { kind: "missing", reread } : { kind: "unavailable", reread };
  };

  /**
   * Reads the cabin handoff.
   *
   * `origin` says who asked, because the panel owes each of them a different answer: the surface's
   * first read, the player's own press and a choice the game refused as stale all show the read in
   * flight - and only the press is acknowledged as a `reread`, the evidence their click did
   * something - while the post-launch wait states its own progress and must not rewrite the screen
   * to `loading` once a second.
   *
   * An empty candidate list is the same fact as the Host's `stardew_player_host_cabin_missing`
   * refusal - this world has no cabin the companion may use - so both land on `missing`, which is the
   * one state that offers the cure and the control that asks again. Rendering the empty list as its
   * own "nothing to confirm" note was the dead end: no control, and copy that sent the player to
   * reload the page, which drops the Host connection and this surface's attachment with it.
   */
  /**
   * Reads the handoff and mints the press's idempotency keys, WITHOUT writing the panel's state.
   *
   * The panel's own reads wrap this (they have a view to set and an origin to name); the confirm press
   * uses it alone, because a press has to renew the offer before it asks the game to take it.
   */
  const readCabinOffers = useCallback(async (): Promise<readonly StardewCabinChoiceV1[]> => {
    const result = await composedApi.readStardewCabins();
    cabinIdempotencyKeysRef.current = new Map(
      result.choices.map((choice) => [choice.choiceHandle, newIdempotencyKey()]),
    );
    return result.choices;
  }, [composedApi]);

  const readCabins = useCallback(
    async (origin: CabinReadOrigin): Promise<CabinHandoffAnswer> => {
      if (origin !== "launch_wait") setCabinView({ kind: "loading" });
      try {
        const choices = await readCabinOffers();
        if (choices.length === 0) {
          setCabinView({ kind: "missing", reread: origin === "refresh_pressed" });
          return "missing";
        }
        setCabinView({ kind: "choices", choices, staleRefusal: origin === "stale_choice" });
        return "choices";
      } catch (error) {
        // Two different situations, two different answers. `stardew_player_host_cabin_missing` means this world has no
        // cabin for her YET and Robin can build one; everything else is a read that could not be made. Flattening them
        // was why a player with no cabin retried the same read instead of building one.
        const view = cabinViewFor(error, origin === "refresh_pressed");
        setCabinView(view);
        return view.kind === "missing" ? "missing" : "unavailable";
      }
    },
    [readCabinOffers],
  );

  /**
   * The surface's first read of the cabin handoff, taken the first time the panel is SHOWN.
   *
   * It used to be gated on `ready` alone, and `<GameSurface />` is mounted for the whole ready
   * lifetime (`ComposedReferenceGameApp`: it renders the surface, which returns null when another one
   * is selected), so the read fired while the player was still reading the conversation. That is a
   * cross-process cabin discovery - the Host asks the game which cabins it can hand her - for a panel
   * nobody had opened: measured on a fresh mount sitting on the Chat tab, one `game/stardew/cabins`
   * request before the Game surface was ever selected.
   *
   * The ONE read stays one read: the ref keeps the arrival from paying for it again, so a player who
   * opens the panel twice does not cost two scans of the game. Arrival freshness is not this read's
   * job - the shell's own arrival refresh re-reads the Game projection the panel renders, and the
   * panel's "Read cabins again" re-reads the handoff the player is actually looking at. What the read
   * has to guarantee is that the panel is never a stale projection on arrival, and a read taken at the
   * moment the panel is first shown is exactly that.
   */
  const cabinsReadRef = useRef(false);
  useEffect(() => {
    if (!ready || !selected || cabinsReadRef.current) return;
    cabinsReadRef.current = true;
    void readCabins("surface_ready");
  }, [ready, selected, readCabins]);

  /**
   * Whether the admitted launch can still be the reason no cabin has appeared.
   *
   * `launching` is the projection's word for the Player Host slot, but it is not the only ending this
   * wait has to honour: the Host publishes `crashed`/`stopped` and `latestOutcome: "failed"` for a
   * launch it could not attest, and an attachment means the companion is in the farm and the handoff
   * is over. Any of them ends the wait, instead of spending the budget asking a game that is gone.
   */
  const launchCanStillAnswer = (): boolean => {
    const current = readView();
    if (current.kind !== "ready" || current.root.game == null) return false;
    const { attachment, instance, latestOutcome } = current.root.game.game;
    return (
      attachment.status !== "attached" &&
      latestOutcome !== "failed" &&
      instance.status !== "crashed" &&
      instance.status !== "stopped"
    );
  };

  /**
   * The panel's own post-launch cabin reads.
   *
   * A launch's only forward path is this handoff: confirming a cabin is what launches the AI client
   * and publishes the attachment, so a launch nobody reads the cabin for sits in `launching` until the
   * player happens to press "Read cabins again". Measured in a live run (2026-11-15, the real game):
   * the driver pressed that control and the Host answered `Cabin 1` in 45 ms - the fact was one
   * request away the whole time.
   *
   * So the admitted launch starts this wait, and every attempt is a fact rather than a pause: the game
   * projection is re-read first (a launch can end as a failure or as an attachment, and either ends
   * the wait), then the cabins are asked for, and a cabin in hand is the answer. The budget
   * (`CABIN_REREAD_MAX_ATTEMPTS` reads `CABIN_REREAD_INTERVAL_MS` apart) is the only ending that is
   * not a fact about the game, and the panel says so and leaves the player the refresh control.
   */
  const cabinAwaitAnswer = async (
    attempts: number,
  ): Promise<"answered" | "launch_ended" | "budget_spent" | "cancelled"> => {
    if (isCancelled()) return "cancelled";
    if (attempts > CABIN_REREAD_MAX_ATTEMPTS) return "budget_spent";
    setCabinLaunchWait({ kind: "reading", attempt: attempts, attempts: CABIN_REREAD_MAX_ATTEMPTS });
    try {
      await rereadGame();
    } catch {
      // An inconclusive read of the game answers nothing about the launch, so it ends neither the wait
      // nor the launch: the cabins below are still the fact the player is waiting for.
    }
    if (!launchCanStillAnswer()) return "launch_ended";
    if ((await readCabins("launch_wait")) === "choices") return "answered";
    await delay(CABIN_REREAD_INTERVAL_MS);
    return cabinAwaitAnswer(attempts + 1);
  };

  /** Runs the post-launch wait once, and publishes what ended it. */
  const keepAskingForCabin = async (): Promise<void> => {
    if (cabinLaunchWaitActiveRef.current) return;
    cabinLaunchWaitActiveRef.current = true;
    try {
      const outcome = await cabinAwaitAnswer(1);
      if (outcome === "cancelled") return;
      setCabinLaunchWait(
        outcome === "budget_spent"
          ? { kind: "expired", attempts: CABIN_REREAD_MAX_ATTEMPTS }
          : { kind: "not_launching" },
      );
    } finally {
      cabinLaunchWaitActiveRef.current = false;
    }
  };

  /**
   * Authoritative reread for a Game-owned operation, published into the slice it owns.
   *
   * Two things make this the right read rather than the convenient one.
   *
   * It commits the Game projection and NOTHING else. The composed root carries a Chat half beside the
   * Game one, and a Game command has no business deciding what the conversation holds: the Chat channel
   * already reads it on its own schedule (the shell's `rereadChat` on arrival, `reconcile` and `recover`
   * under the stream, the fallback poll while a turn is pending), and a Game read is not one of its
   * writers. Applying `root.chat` here also made every Game command a Chat refresh, which is why the
   * Chat draft revision used to be able to fail one.
   *
   * It reads the view AFTER its round trip. A read is a round trip, and a commit that lands inside it - a
   * send's own pending record, a refusal's settle, a problem view - is newer than the photograph this
   * read took before leaving; committing that photograph erased them, and the erased pending record is
   * the one that keeps the fallback poll alive and the send gate shut, so the player's just-sent line
   * left the screen and the composer unlocked mid-turn (`game-read-leaves-the-conversation-alone.spec.ts`,
   * and the same rule `rereadChat` states at its own site).
   *
   * What a Game operation needs to know about its own command - did the thing I acted on change - is the
   * Game projection's own attachment generation, which each handler compares against the generation it
   * acted on.
   *
   * And it reads the game's OWN route, not the aggregate root. The panel re-reads after every Game command
   * and once a second through both bounded waits (the cabin handoff, the reopen/resume convergence), and
   * `/state` answers the whole conversation beside the game's few hundred bytes: measured on a 200-message
   * Chat, 35 135 B per poll of which 34 303 B was the Chat half and 683 B the game's - and, on the Host,
   * one durable transcript re-projection per poll (`facade.read()` -> `threads.resumeThread`) for a
   * transcript this surface renders no field of. `/game` is that same Game projection from the same Host
   * seam, so the slice cannot drift between the two routes.
   */
  const rereadGame = async (): Promise<void> => {
    const game = await composedApi.readGameState();
    const current = readView();
    if (current.kind !== "ready") return;
    commit({ ...current, root: { ...current.root, game } });
  };

  useEffect(() => {
    readViewRef.current = readView;
    commitRef.current = commit;
    rereadGameRef.current = rereadGame;
  });

  /**
   * The read the player's own step takes, and the one place a press's failed read is published.
   *
   * The sentence is the catalogue's, not a second vocabulary: `composedProblemView` words every
   * failure on this shell, and the answer it gives this one names the read taken again - which is the
   * control the state keeps drawing beside this line. The failure is spent by the next read that
   * succeeds, exactly as the shell's arrival notice is.
   */
  const readGameAgain = async (): Promise<void> => {
    try {
      await rereadGame();
      setGameReadFailure(null);
    } catch (error) {
      setGameReadFailure({ sentence: composedProblemView(error, labels).detail, code: observedProblemCode(error) });
    }
  };

  /**
   * Applies one fact group to the projection this surface renders.
   *
   * A frame carries only the fields its own fact owns, so it is merged rather than assigned: `/game` stays the
   * authority for everything else it published, and a frame can never become a second, partial projection.
   */
  const applyGameFact = (patch: GameFactPatchV1): void => {
    const current = readViewRef.current();
    if (current.kind !== "ready" || current.root.game == null) return;
    const projection = current.root.game;
    commitRef.current({
      ...current,
      root: { ...current.root, game: { ...projection, game: { ...projection.game, ...patch.game } } },
    });
  };

  /**
   * The Game surface's own push channel, and the one place a fact ends a wait.
   *
   * The panel used to learn that a resume had landed by re-reading `/game` twice a second for up to thirty seconds,
   * and measured on the real Host 19 of those 20 reads were byte-identical: a fact arrives at a coordinator
   * transition, never on a cadence. This subscribes to the Game's own stream - its own epoch and cursor, carrying no
   * Chat selection generation, so a Chat switch cannot move it and a Chat failure cannot close it.
   *
   * A resync is not an error, and the snapshot is not a fallback: the channel keeps a bounded replay window, so a
   * position it can no longer serve HAS to be replaced by the authoritative read. That is why `/game` stays - it is
   * the recovery path, and its reply carries the cursor to continue from. `GAME_STREAM_RESYNC_LIMIT` is the promise
   * that this loop ends even against a Host that can only ever answer resync.
   */
  useEffect(() => {
    const checkpoint = game?.eventStream;
    if (!ready || checkpoint === undefined) return;
    let closed = false;
    let lastSequence = 0;
    let resyncs = 0;
    let connection: Readonly<{ close(): void }> | undefined;
    const stop = (): void => {
      closed = true;
      connection?.close();
    };
    const recover = (): void => {
      if (closed) return;
      if (resyncs >= GAME_STREAM_RESYNC_LIMIT) {
        // Nothing is being hidden: the projection on screen IS the last authoritative answer, and the next Game
        // command's own confirmation read is the way forward.
        stop();
        return;
      }
      resyncs += 1;
      stop();
      void rereadGameRef.current().catch(() => undefined);
    };
    connection = composedApi.openGameEvents({
      cursor: checkpoint.cursor,
      onEvent(event) {
        if (closed) return;
        // A replayed or late frame never moves the projection backwards.
        if (event.sequence <= lastSequence) return;
        lastSequence = event.sequence;
        if (event.eventType === "game.stream_resync_required") {
          recover();
          return;
        }
        resyncs = 0;
        applyGameFact(event.payload);
        for (const wake of [...gameFactWaitersRef.current]) wake();
      },
      onError() {
        recover();
      },
    });
    return stop;
  }, [ready, composedApi, game?.eventStream?.epoch, game?.eventStream?.cursor]);

  /**
   * Waits for the Game projection to answer `decide`, ended by a frame rather than by a clock.
   *
   * `decide` is asked once before the wait begins, so a fact that arrived while the command was still settling costs
   * no wait at all. When the Host holds no stream (a mount that only answers the snapshot) the wait falls back to the
   * reads it always made: the panel's behaviour is a property of what the Host publishes, never of a client switch.
   *
   * The budget is the ceiling for the case where nothing ever arrives - a transition that never happened - and it is
   * the same ceiling these waits always had, no longer their cadence.
   */
  const awaitGameProjection = async <T,>(decide: () => T | undefined, budgetMs: number): Promise<T | undefined> => {
    const answered = decide();
    if (answered !== undefined) return answered;
    if (game?.eventStream === undefined) return await pollGameProjection(decide, budgetMs);
    return await new Promise<T | undefined>((resolve) => {
      let settled = false;
      const finish = (value: T | undefined): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        gameFactWaitersRef.current.delete(wake);
        resolve(value);
      };
      const wake = (): void => {
        finish(decide());
      };
      const timer = window.setTimeout(() => finish(undefined), budgetMs);
      gameFactWaitersRef.current.add(wake);
    });
  };

  /**
   * The same wait for a Host that publishes no stream: authoritative reads, bounded by the same budget.
   *
   * It is what every wait in this file used to be. It stays because the composed shell is served by the Host, and a
   * Game surface whose Host answers no stream is still a surface whose commands have to converge - the alternative
   * would be spending the whole budget waiting for an event nobody promised.
   */
  const pollGameProjection = async <T,>(decide: () => T | undefined, budgetMs: number): Promise<T | undefined> => {
    const attempts = Math.ceil(budgetMs / RESUME_REREAD_INTERVAL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (isCancelled()) return undefined;
      try {
        await rereadGame();
      } catch {
        // An inconclusive authoritative read never completes a wait; the budget is what ends it.
      }
      const answered = decide();
      if (answered !== undefined) return answered;
      await delay(RESUME_REREAD_INTERVAL_MS);
    }
    return undefined;
  };

  /**
   * The cabin confirm: the press renews the offer it was drawn with, then asks the game to take it.
   *
   * This handler used to open with `if (choice.expiresAtMs <= Date.now()) { void readCabins("stale_choice");
   * return; }`, and that guard WILL look reasonable to the next reader: the Host advertises a deadline
   * on every offer, so why send a command that must be refused? Measured in a live run (2026-11-17, the
   * real game): it meant the confirmation was never sent at all. Three presses produced three
   * `game/stardew/cabins` reads and **zero** `game/stardew/cabins/confirm` requests, so the first run
   * could not pass step 3 - the player pressed a button whose only effect was to re-read the screen it
   * was already on. That guard is gone (lane CABINCONFIRM), and with it the page's clock stopped being
   * a decision.
   *
   * What is left is the lease, and it is renewed HERE rather than shown to the player. The advertisement
   * is republished every second with a 3 s expiry (`HostFarmhandProvisioner.cs`), and every
   * `game/stardew/cabins` read mints a fresh `choiceHandle` and a fresh deadline
   * (`stardew-production-lifecycle-coordinator.internal.ts`, `readCabinChoices`), so an offer can be
   * renewed at the moment the player presses: read the cabins, take the offer with the same label from
   * that read, and send ITS handle. A press that re-sent the drawn handle instead would be sending a
   * handle the Host has already replaced - which is what made the old panel warn the player that the
   * offer "may already have gone stale" and turn a 2 s window into a race (`stardewCabinsOfferLapsed`,
   * now gone with the warning).
   *
   * The Host remains the party that decides: a refusal named `stardew_cabin_choice_stale` still means the
   * offer went over between this read and the command, and it is answered the same way - read again, and
   * say what the game said.
   */
  const handleCabinConfirmation = async (choice: StardewCabinChoiceV1): Promise<void> => {
    if (cabinConfirmationActiveRef.current || cabinView.kind !== "choices") return;
    cabinConfirmationActiveRef.current = true;
    try {
      let offers: readonly StardewCabinChoiceV1[];
      try {
        offers = await readCabinOffers();
      } catch (error) {
        // The renewal read is a read like any other: a world that cannot be read is the state the panel
        // already knows how to state, and nothing was confirmed.
        setCabinView(cabinViewFor(error, false));
        return;
      }
      const renewed = offers.find((offer) => offer.displayLabel === choice.displayLabel);
      if (renewed === undefined) {
        // The list moved under the row: the fresh list IS the answer, and the player's next act is the
        // one that list offers. Confirming a cabin this world no longer offers would be the opposite.
        setCabinView(
          offers.length === 0
            ? { kind: "missing", reread: false }
            : { kind: "choices", choices: offers, staleRefusal: false },
        );
        return;
      }
      const idempotencyKey = cabinIdempotencyKeysRef.current.get(renewed.choiceHandle);
      if (idempotencyKey === undefined) {
        setCabinView({ kind: "unavailable", reread: false });
        return;
      }
      setCabinView({ kind: "confirming", choices: offers, choiceHandle: renewed.choiceHandle });
      try {
        await composedApi.confirmStardewCabin({
          apiVersion: 1,
          idempotencyKey,
          choiceHandle: renewed.choiceHandle,
          confirmed: true,
        });
        setCabinView({ kind: "admitted", cabinLabel: renewed.displayLabel });
      } catch (error) {
        if (error instanceof ComposedReferenceGameProblemError && error.code === "stardew_cabin_choice_stale") {
          cabinConfirmationActiveRef.current = false;
          await readCabins("stale_choice");
          return;
        }
        // An explicit uncertain outcome or a missing/malformed response may have
        // followed successful publication. Never refetch or replay this command.
        setCabinView({ kind: "uncertain" });
      }
    } finally {
      // Released on every path, not only the stale one. This flag is a re-entrancy guard for the
      // click, not a record of what the Host decided: the outcome lives in `cabinView`. Holding it
      // after an `admitted` or an `uncertain` outcome left every later cabin choice answered by the
      // `if` at the top of this function and nothing else - the buttons stayed visible and did
      // nothing, which is the one shape a player cannot diagnose.
      cabinConfirmationActiveRef.current = false;
    }
  };

  /**
   * The coordinator refuses a first-run command whose lifecycle is not staged
   * yet with `stardew_player_host_launch_not_staged`. On exactly the
   * `game/prerequisites/setup` and `game/launch` routes that error is the only
   * one mapped to the wire code `game_prerequisites_missing`, so on those routes
   * the code IS the not-staged reason and must never be rendered as a generic
   * failure.
   */
  const isNotStagedRefusal = (error: unknown): boolean =>
    error instanceof ComposedReferenceGameProblemError && error.code === "game_prerequisites_missing";

  /**
   * The one activation refusal that is a prerequisite rather than a fault: the
   * lifecycle reserves and stages its owned Player Host against the registered
   * Stardew installation, so with no installation bound to this session the
   * coordinator answers `state_unavailable` naming
   * `stardew_bootstrap_registration_unavailable`. The player has not set the game
   * up yet, and the installation panel on this same surface is where they do it - a
   * state, not a failure, and it says so (the cabin handoff renders the same way).
   */
  const isInstallationNotConfiguredRefusal = (error: unknown): boolean =>
    error instanceof ComposedReferenceGameProblemError &&
    error.causeCode === "stardew_bootstrap_registration_unavailable";

  /**
   * First-run lifecycle activation. The composed Game projection carries no
   * activation field of its own: the coordinator's `staged` state reaches the
   * browser only as the launch-readiness shape (`prerequisites` met, `instance`
   * none, exact expected generation >= 1). This control is offered in exactly
   * that shape's pre-image and the coordinator's own refusal is the only other
   * signal the client has. It sends no body; the route refuses one with 409.
   */
  const handleLifecycleActivate = async (): Promise<void> => {
    const current = readView();
    if (gameActivationActiveRef.current || current.kind !== "ready") return;
    // The click-time re-check is the same derivation the control is offered
    // from, so a control can never be offered in a state its own handler refuses.
    if (!deriveGameLifecycleControlAvailability({ ready: true, game: current.root.game ?? null }).activationAvailable)
      return;
    gameActivationActiveRef.current = true;
    setGameActivationActive(true);
    setGameActivationFailure(null);
    setGameActivationNotConfigured(false);
    setGameActivationUnavailable(false);
    try {
      await composedApi.activateLifecycle();
      await rereadGame();
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      // A conflict only means something already activated this lifecycle: the
      // authoritative projection decides, so it is a failure only when staging
      // is still not visible after the reread.
      const staged =
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game != null &&
        fresh.root.game.game.instance.generation >= 1;
      if (!staged) {
        if (error instanceof ComposedReferenceGameProblemError && error.code === "not_found")
          setGameActivationUnavailable(true);
        else if (isInstallationNotConfiguredRefusal(error)) setGameActivationNotConfigured(true);
        else setGameActivationFailure(gameOperationFailure(error, labels));
      }
    } finally {
      gameActivationActiveRef.current = false;
      setGameActivationActive(false);
    }
  };

  const handleGameSetup = async (): Promise<void> => {
    const current = readView();
    if (gameSetupActiveRef.current || current.kind !== "ready") return;
    if (!deriveGameLifecycleControlAvailability({ ready: true, game: current.root.game ?? null }).setupAvailable)
      return;
    const idempotencyKey = gameSetupKeyRef.current ?? newIdempotencyKey();
    gameSetupKeyRef.current = idempotencyKey;
    gameSetupActiveRef.current = true;
    setGameSetupActive(true);
    setGameSetupFailure(null);
    setGameSetupNotStaged(false);
    try {
      await composedApi.setupGame({ apiVersion: 1, idempotencyKey });
      await rereadGame();
      const afterSetup = readView();
      if (afterSetup.kind === "ready" && afterSetup.root.game?.game.prerequisites.status === "unknown")
        gameSetupKeyRef.current = undefined;
    } catch (error) {
      const notStaged = isNotStagedRefusal(error);
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        // Preserve the original key while the command outcome is uncertain.
      }
      setGameSetupNotStaged(notStaged);
      setGameSetupFailure(notStaged ? null : gameOperationFailure(error, labels));
      const latest = readView();
      // A retry may use a fresh key exactly when the authoritative reading proves this attempt staged
      // nothing; a reading that staged something keeps the key, because the command may already have
      // been admitted (see `setupStagedNothing`).
      if (
        !notStaged &&
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_unavailable" &&
        rereadSucceeded &&
        setupStagedNothing(latest.kind === "ready" ? (latest.root.game ?? null) : null)
      )
        gameSetupKeyRef.current = undefined;
    } finally {
      gameSetupActiveRef.current = false;
      setGameSetupActive(false);
    }
  };

  const handleGameStop = async (): Promise<void> => {
    const current = readView();
    const gameProjection = current.kind === "ready" ? (current.root.game ?? null) : null;
    if (
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1 ||
      gameProjection.game.connectionStatus !== "connected_idle" ||
      !admitAttachment("stop")
    )
      return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameStopKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameStopKeysRef.current.set(generation, idempotencyKey);
    try {
      await composedApi.stopGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      await rereadGame();
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      if (!staleGenerationReconciled)
        setAttachment({ type: "refused", operation: "stop", failure: gameOperationFailure(error, labels) });
    } finally {
      setAttachment({ type: "finished" });
    }
  };

  const handleGameLaunch = async (): Promise<void> => {
    const current = readView();
    if (current.kind !== "ready") return;
    const controls = deriveGameLifecycleControlAvailability({ ready: true, game: current.root.game ?? null });
    if (!controls.launchAvailable || controls.launchGeneration === null || !admitAttachment("launch")) return;
    const generation = controls.launchGeneration;
    const existingKey = gameLaunchKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameLaunchKeysRef.current.set(generation, idempotencyKey);
    let launched = false;
    try {
      await composedApi.launchGame({
        apiVersion: 1,
        idempotencyKey,
        expectedInstanceGeneration: generation,
      });
      launched = true;
      await rereadGame();
    } catch (error) {
      const notStaged = isNotStagedRefusal(error);
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      if (
        !notStaged &&
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_unavailable" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game != null &&
        (fresh.root.game.game.prerequisites.status !== "met" || fresh.root.game.game.instance.generation < 1)
      ) {
        gameLaunchKeysRef.current.delete(generation);
        gameSetupKeyRef.current = undefined;
      }
      if (notStaged) setAttachment({ type: "not_staged" });
      else setAttachment({ type: "refused", operation: "launch", failure: gameOperationFailure(error, labels) });
    } finally {
      setAttachment({ type: "finished" });
    }
    // The admitted launch's next step is a READ of the game, not another command: `launching` has no
    // forward path except the cabin handoff below step 2. So this surface keeps asking for it while
    // the answer is still on the other side, instead of waiting for the player to find the refresh.
    if (launched) await keepAskingForCabin();
  };

  const handleDisconnect = async (): Promise<void> => {
    const current = readView();
    const gameProjection = current.kind === "ready" ? (current.root.game ?? null) : null;
    if (
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      !current.root.game?.game ||
      gameProjection.game.attachment.generation < 1 ||
      !admitAttachment("disconnect")
    )
      return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = disconnectKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    disconnectKeysRef.current.set(generation, idempotencyKey);
    try {
      await composedApi.disconnectGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      await rereadGame();
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      if (
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.status === "attached" &&
        fresh.root.game.game.attachment.generation === generation &&
        fresh.root.game.game.connectionStatus === "failed"
      )
        disconnectKeysRef.current.delete(generation);
      setAttachment({ type: "refused", operation: "disconnect", failure: gameOperationFailure(error, labels) });
    } finally {
      setAttachment({ type: "finished" });
    }
  };

  /**
   * One admitted `game.resume`, waiting for the fact that ends it rather than re-reading on a cadence.
   *
   * A transport `accepted`/`attached` result is never treated as runtime success; the attempt stays visibly in
   * flight until the composed Game projection converges at the same attachment generation (connected), a
   * newer/conflicting generation supersedes the attempt, or the budget expires (unavailable; the exact generation key
   * is preserved for replay). What changed is only how the panel learns it: the coordinator's attachment transition
   * arrives on the stream, so the wait is woken by the fact instead of spending thirty seconds on identical reads.
   */
  const resumeAwaitAuthoritative = async (generation: number): Promise<"connected" | "superseded" | "unavailable"> => {
    const answer = await awaitGameProjection(() => {
      const fresh = readView();
      if (fresh.kind !== "ready" || fresh.root.game == null) return "superseded" as const;
      const projection = fresh.root.game.game;
      if (projection.attachment.generation !== generation) return "superseded" as const;
      if (
        projection.attachment.status === "attached" &&
        (projection.connectionStatus === "connected_idle" || projection.connectionStatus === "active")
      )
        return "connected" as const;
      return undefined;
    }, RESUME_REREAD_MAX_ATTEMPTS * RESUME_REREAD_INTERVAL_MS);
    return answer ?? "unavailable";
  };

  const handleGameResume = async (): Promise<void> => {
    const current = readView();
    const gameProjection = current.kind === "ready" ? (current.root.game ?? null) : null;
    if (
      gameResumeActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1 ||
      !RESUMABLE_CONNECTION_STATUSES.has(gameProjection.game.connectionStatus)
    )
      return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameResumeKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameResumeKeysRef.current.set(generation, idempotencyKey);
    gameResumeActiveRef.current = true;
    setGameResumeActive(true);
    setGameResumeFailure(null);
    setGameResumeUnavailable(false);
    let outcome: GameResumeResultV1 | undefined;
    try {
      outcome = await composedApi.resumeGame({
        apiVersion: 1,
        idempotencyKey,
        // The reconnect ESTABLISHES the next attachment generation, so the
        // command names the one it will establish, not the one it is leaving.
        // Measured: this call used to send the generation on screen (1) while the
        // lifecycle arms `max(generation + 1, 2)`, so every resume was refused as
        // a stale controller, the panel silently re-read, and the player saw
        // nothing happen. The floor of 2 is unreachable here: the guard above
        // requires an observed generation of at least 1.
        expectedAttachmentGeneration: generation + 1,
      });
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      setGameResumeFailure(staleGenerationReconciled ? null : gameOperationFailure(error, labels));
      gameResumeActiveRef.current = false;
      setGameResumeActive(false);
      return;
    }
    if (outcome === undefined) {
      gameResumeActiveRef.current = false;
      setGameResumeActive(false);
      return;
    }
    if (outcome.status === "unavailable") {
      // No side effect is known from this attempt; a single authoritative
      // reread cannot confirm completion. The exact generation key stays so a
      // player retry replays the same idempotent command.
      try {
        await rereadGame();
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      if (
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.status === "attached" &&
        fresh.root.game.game.attachment.generation === generation
      )
        setGameResumeUnavailable(true);
      gameResumeActiveRef.current = false;
      setGameResumeActive(false);
      return;
    }
    // `accepted`/`attached` are transport admissions only and never runtime
    // success. Keep the resume visibly in flight while bounded authoritative
    // rereads converge, a newer/conflicting generation supersedes the attempt,
    // or the bounded budget runs out (rendered as unavailable with the exact
    // generation key preserved).
    let convergence: "connected" | "superseded" | "unavailable";
    try {
      convergence = await resumeAwaitAuthoritative(generation);
    } catch {
      convergence = "unavailable";
    }
    if (convergence === "unavailable") setGameResumeUnavailable(true);
    gameResumeActiveRef.current = false;
    setGameResumeActive(false);
  };

  /**
   * One admitted `game.reopen`, waiting for the fact that ends it.
   *
   * The strict `reopened` result only exists on the exact same attachment generation; the attempt stays visibly in
   * flight until the composed projection shows the paused action authority reopened to `active` at that generation, a
   * newer/conflicting generation supersedes it, or the budget expires. Reopen never touches old task/facade/lease or
   * attachment machinery, so only the action-authority flip is awaited - and that flip is a command-driven fact, so
   * this wait is ended by the generation's own attachment frame or not at all: the budget is the ceiling.
   */
  const reopenAwaitAuthoritative = async (generation: number): Promise<"active" | "superseded" | "unavailable"> => {
    const answer = await awaitGameProjection(() => {
      const fresh = readView();
      if (fresh.kind !== "ready" || fresh.root.game == null) return "superseded" as const;
      const projection = fresh.root.game.game;
      if (projection.attachment.generation !== generation) return "superseded" as const;
      if (projection.attachment.status === "attached" && projection.actionAuthority === "active")
        return "active" as const;
      return undefined;
    }, RESUME_REREAD_MAX_ATTEMPTS * RESUME_REREAD_INTERVAL_MS);
    return answer ?? "unavailable";
  };

  const handleGameReopen = async (): Promise<void> => {
    const current = readView();
    const gameProjection = current.kind === "ready" ? (current.root.game ?? null) : null;
    // ready-actions-paused is the exact precondition: connected_idle equals a
    // live observation surface, actionAuthority "paused" means only a new
    // explicit Game instruction may reopen action admission. Never approximate
    // it with the connection status alone.
    if (
      gameReopenActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.actionAuthority !== "paused" ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1 ||
      gameProjection.game.connectionStatus !== "connected_idle"
    )
      return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameReopenKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameReopenKeysRef.current.set(generation, idempotencyKey);
    gameReopenActiveRef.current = true;
    setGameReopenActive(true);
    setGameReopenFailure(null);
    setGameReopenUnavailable(false);
    try {
      await composedApi.reopenGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      setGameReopenFailure(staleGenerationReconciled ? null : gameOperationFailure(error, labels));
      gameReopenActiveRef.current = false;
      setGameReopenActive(false);
      return;
    }
    // The strict `reopened` result is still not runtime success on its own: the
    // composed authoritative Game projection at the exact same attachment
    // generation must show the action authority reopened to `active`. Keep the
    // attempt visibly in flight while bounded rereads converge, a newer
    // generation supersedes the attempt, or the bounded budget expires
    // (unavailable; the exact generation key stays for an idempotent replay).
    let convergence: "active" | "superseded" | "unavailable";
    try {
      convergence = await reopenAwaitAuthoritative(generation);
    } catch {
      convergence = "unavailable";
    }
    if (convergence === "unavailable") setGameReopenUnavailable(true);
    gameReopenActiveRef.current = false;
    setGameReopenActive(false);
  };

  /**
   * `game.resume.cancel` for the failed/unavailable resume surface. The cancel
   * pins the exact in-flight reconnect epoch by armed attachment generation; a
   * successful `cancelled` result settles the epoch server-side before it
   * returns, so one authoritative reread shows the disconnected projection
   * (the session stays resumable, the generation keeps its armed value). A
   * stale generation reconciles silently; any other failure is presented
   * fail-closed. The Player world and durable session state are never touched.
   */
  const handleGameResumeCancel = async (): Promise<void> => {
    const current = readView();
    const gameProjection = current.kind === "ready" ? (current.root.game ?? null) : null;
    if (
      gameResumeCancelActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1 ||
      !RESUMABLE_CONNECTION_STATUSES.has(gameProjection.game.connectionStatus) ||
      (gameResumeFailure === null && !gameResumeUnavailable)
    )
      return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameResumeCancelKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameResumeCancelKeysRef.current.set(generation, idempotencyKey);
    gameResumeCancelActiveRef.current = true;
    setGameResumeCancelActive(true);
    setGameResumeCancelFailure(null);
    try {
      await composedApi.cancelResume({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      try {
        await rereadGame();
      } catch {
        /* retain the current authoritative projection */
      }
      setGameResumeFailure(null);
      setGameResumeUnavailable(false);
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      if (staleGenerationReconciled) {
        // The reconnect epoch already ended under a newer attachment: there is
        // nothing to cancel, so the stale failure surface is cleared.
        setGameResumeFailure(null);
        setGameResumeUnavailable(false);
      } else {
        setGameResumeCancelFailure(gameOperationFailure(error, labels));
      }
    } finally {
      gameResumeCancelActiveRef.current = false;
      setGameResumeCancelActive(false);
    }
  };

  /**
   * Bounded authoritative rereads for one admitted `game.create`. Transport
   * `accepted`/`attached` are never runtime success; the attempt stays visibly
   * in flight until the composed authoritative Game projection converges on
   * the new attachment generation at ready-actions-paused (attached +
   * connected_idle + paused — a shape the pre-create failed/disconnected
   * surface can never produce), or the bounded budget expires (fail-closed
   * unavailable; the next form submit mints a fresh attempt identity).
   */
  const createAwaitAuthoritative = async (): Promise<"converged" | "unavailable"> => {
    const answer = await awaitGameProjection(() => {
      const fresh = readView();
      if (fresh.kind !== "ready" || fresh.root.game == null) return undefined;
      const projection = fresh.root.game.game;
      if (
        projection.attachment.status === "attached" &&
        projection.connectionStatus === "connected_idle" &&
        projection.actionAuthority === "paused"
      )
        return "converged" as const;
      return undefined;
    }, RESUME_REREAD_MAX_ATTEMPTS * RESUME_REREAD_INTERVAL_MS);
    return answer ?? "unavailable";
  };

  /**
   * Start-new-game submission (single-flight, one fresh idempotency key per
   * attempt). The command carries only the published integration id and the
   * player's explicit continuity binding choice (empty = null = no binding);
   * the Host store mints the durable session. `unavailable` and rejected
   * commands fail closed with the form kept retryable; a converged create
   * hands the drawer over to the authoritative ready-actions-paused
   * projection.
   */
  const handleGameCreate = async (): Promise<void> => {
    const current = readView();
    if (
      gameCreateActiveRef.current ||
      current.kind !== "ready" ||
      current.root.game == null ||
      (gameResumeFailure === null && !gameResumeUnavailable)
    )
      return;
    const continuityText = continuityIdentityInput.trim();
    const idempotencyKey = newIdempotencyKey();
    const request: GameCreateRequestV1 = {
      apiVersion: 1,
      idempotencyKey,
      integrationId: STARDEW_GAME_INTEGRATION_ID,
      continuityIdentityId: continuityText.length === 0 ? null : continuityText,
    };
    gameCreateActiveRef.current = true;
    setGameCreateActive(true);
    setGameCreateFailure(null);
    setGameCreateUnavailable(false);
    let outcome: GameCreateResultV1 | undefined;
    try {
      outcome = await composedApi.createGameSession(request);
    } catch (error) {
      try {
        await rereadGame();
      } catch {
        /* retain the current authoritative projection */
      }
      setGameCreateFailure(gameOperationFailure(error, labels));
      gameCreateActiveRef.current = false;
      setGameCreateActive(false);
      return;
    }
    if (outcome === undefined) {
      gameCreateActiveRef.current = false;
      setGameCreateActive(false);
      return;
    }
    if (outcome.status === "unavailable") {
      // The create failed closed with no resumable half-record; never project
      // a session or a ready surface from the null handle.
      try {
        await rereadGame();
      } catch {
        /* retain the current authoritative projection */
      }
      setGameCreateUnavailable(true);
      gameCreateActiveRef.current = false;
      setGameCreateActive(false);
      return;
    }
    // `accepted`/`attached` are transport admissions only and never runtime
    // success: keep the create visibly in flight while bounded authoritative
    // rereads converge on ready-actions-paused, or the budget expires.
    let convergence: "converged" | "unavailable";
    try {
      convergence = await createAwaitAuthoritative();
    } catch {
      convergence = "unavailable";
    }
    if (convergence === "unavailable") {
      setGameCreateUnavailable(true);
    } else {
      // The new session is authoritative at ready-actions-paused; the stale
      // resume failure surface is cleared and the form is done.
      setGameResumeFailure(null);
      setGameResumeUnavailable(false);
      setCreateFormOpen(false);
      setContinuityIdentityInput("");
    }
    gameCreateActiveRef.current = false;
    setGameCreateActive(false);
  };

  /**
   * The one terminal operation. It is offered only from a live attached session
   * and is generation-bound exactly like stop/disconnect. The UI confirm step is
   * the caller's: this is the method behind the confirm button, so it never runs
   * on the ordinary click. `unavailable` is a refusal, never a completion, and
   * a stale generation reconciles silently against the authoritative reread.
   */
  const handleGameEndgame = async (): Promise<void> => {
    const current = readView();
    const gameProjection = current.kind === "ready" ? (current.root.game ?? null) : null;
    if (
      gameEndgameActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1
    )
      return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameEndgameKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameEndgameKeysRef.current.set(generation, idempotencyKey);
    gameEndgameActiveRef.current = true;
    setGameEndgameActive(true);
    setGameEndgameFailure(null);
    setEndgameConfirmArmed(false);
    try {
      const outcome = await composedApi.endgameGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
        confirm: true,
      });
      if (outcome.status === "unavailable") {
        // The world was not terminated and nothing was torn down: this is a
        // refusal the player sees, with the exact key preserved for a retry.
        setGameEndgameFailure({ kind: "unsettled" });
        return;
      }
      await rereadGame();
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        /* retain the current authoritative projection */
      }
      const fresh = readView();
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      setGameEndgameFailure(staleGenerationReconciled ? null : gameOperationFailure(error, labels));
    } finally {
      gameEndgameActiveRef.current = false;
      setGameEndgameActive(false);
    }
  };

  const {
    activationAvailable: gameActivationAvailable,
    setupAvailable: gameSetupAvailable,
    launchAvailable: gameLaunchAvailable,
  } = deriveGameLifecycleControlAvailability({
    ready,
    game,
  });
  // The one derivation of what this state offers (`game-lifecycle-controls.ts`),
  // which is also the population the zero-forward-path gate drives in
  // `tests/game-lifecycle-launch-gate.test.mjs`. Every session and recovery
  // control below reads its availability from here instead of repeating the
  // predicate, so the control the player is offered and the state the gate checks
  // cannot drift apart.
  //
  // A confirm step armed against one live attachment must not survive into a
  // different one: whenever the endgame target generation or its availability
  // changes, the UI confirm resets to unarmed and the ordinary click is needed
  // again. Only the confirm button ever sends the command.
  const sessionControls = deriveGameSessionControls({
    ready,
    game,
    // The client's half of the failed-restore rule: the attempt's own failure, the
    // unavailable outcome, or the Host's last outcome. Which of those makes the
    // failure rollup appear is the derivation's decision, not this line's.
    resumeFailureSurface: gameResumeFailure !== null || gameResumeUnavailable || game?.game.latestOutcome === "failed",
    // The narrower fact: there is an attempt of this surface's own to settle, so
    // Retry/Cancel/Start new game are controls that will actually act.
    resumeAttemptFailed: gameResumeFailure !== null || gameResumeUnavailable,
  });
  const endgameGeneration =
    game !== null && game.game.attachment.status === "attached" ? game.game.attachment.generation : 0;
  useEffect(() => {
    setEndgameConfirmArmed(false);
  }, [endgameGeneration, sessionControls.endgameAvailable]);
  const gameSyncing = ready && game !== null && game.game.connectionStatus === "syncing";
  /** The three attachment rows, all read from the one state (`./game-app-state`). */
  const attachmentRows = gameAttachmentRows(attachment);
  /**
   * Whether the Host holds a registered Stardew installation for this session.
   *
   * `prerequisites.status` turns `met` the moment such a registration exists - before any
   * activation (`../game-lifecycle-controls`) - so it is the one published fact that says
   * whether the game's folder is known yet.
   */
  const installationRegistered = game !== null && game.game.prerequisites.status === "met";
  const gameStatePanel = (
    <GameStatePanel
      key="game-state-panel"
      game={game}
      labels={labels}
      integrationId={STARDEW_GAME_INTEGRATION_ID}
      syncing={gameSyncing}
      lifecycle={{
        activation: {
          available: gameActivationAvailable,
          active: gameActivationActive,
          failure: gameActivationFailure,
          notConfigured: gameActivationNotConfigured,
          unavailable: gameActivationUnavailable,
        },
        setup: {
          available: gameSetupAvailable,
          active: gameSetupActive,
          failure: gameSetupFailure,
          notStaged: gameSetupNotStaged,
        },
        launch: { available: gameLaunchAvailable, ...attachmentRows.launch },
      }}
      session={{
        controls: sessionControls,
        stop: attachmentRows.stop,
        disconnect: attachmentRows.disconnect,
        endgame: {
          active: gameEndgameActive,
          failure: gameEndgameFailure,
          confirmArmed: endgameConfirmArmed,
        },
      }}
      resume={{
        active: gameResumeActive,
        failure: gameResumeFailure,
        unavailable: gameResumeUnavailable,
        cancelActive: gameResumeCancelActive,
        cancelFailure: gameResumeCancelFailure,
      }}
      reopen={{
        active: gameReopenActive,
        failure: gameReopenFailure,
        unavailable: gameReopenUnavailable,
      }}
      create={{
        active: gameCreateActive,
        failure: gameCreateFailure,
        unavailable: gameCreateUnavailable,
        formOpen: createFormOpen,
        continuityIdentity: continuityIdentityInput,
      }}
      cabin={cabinView}
      cabinLaunchWait={cabinLaunchWait}
      handlers={{
        activate: () => void handleLifecycleActivate(),
        setup: () => void handleGameSetup(),
        launch: () => void handleGameLaunch(),
        stop: () => void handleGameStop(),
        disconnect: () => void handleDisconnect(),
        endgame: () => void handleGameEndgame(),
        armEndgame: () => setEndgameConfirmArmed(true),
        cancelEndgame: () => setEndgameConfirmArmed(false),
        resume: () => void handleGameResume(),
        resumeCancel: () => void handleGameResumeCancel(),
        reopen: () => void handleGameReopen(),
        create: () => void handleGameCreate(),
        toggleCreateForm: () => setCreateFormOpen((open) => !open),
        setContinuityIdentity: setContinuityIdentityInput,
        confirmCabin: (choice) => void handleCabinConfirmation(choice),
        refreshCabins: () => void readCabins("refresh_pressed"),
        reread: () => void readGameAgain(),
      }}
    />
  );
  /**
   * Whether the player has opened this surface yet.
   *
   * The surface is not rendered before its first open, and after one it is parked rather than
   * unmounted (the shell keeps its slot in the region - `ComposedReferenceGameApp` says why). The
   * two halves are one decision: the panels below hold drafts (`GamePlayerSettings` writes the Host
   * only when the player presses Save), so an unmount threw them away; and the installation panel's
   * mount IS a scan of the machine (the Host reads the registry, the Steam libraries and every known
   * location), so a player who never opens the Game surface must not pay for that scan at launch.
   * Measured on the mounted shell before parking, phases mount | chat-idle | game-1 | chat-2 | game-2,
   * `game/installation/discovery` per phase: 0 | 0 | 1 | 0 | 1 - each arrival after the first paid the
   * whole sweep again for an answer that had not changed.
   */
  const [opened, setOpened] = useState(selected);
  useEffect(() => {
    if (selected && !opened) setOpened(true);
  }, [selected, opened]);
  const installationDiscovery = (
    <StardewInstallationDiscovery
      key="installation-discovery"
      api={composedApi}
      labels={labels}
      // The guide above reads the Host's `prerequisites`, which only changes once an installation is admitted. The
      // panel owns that admission, so it is the one that says so; without this the step kept asking for a folder after
      // the folder had been accepted, and only a reload cleared it.
      onAdmitted={() => void readGameAgain()}
    />
  );
  /**
   * The surface's getting-going flow, in the order this state reads in.
   *
   * With no installation registered, every control the guide's first step offers is one the Host
   * can only refuse: activation reserves and stages the owned Player Host *against that
   * registration* and answers `stardew_bootstrap_registration_unavailable` without one, and setup
   * reports the same prerequisite. The one step that can succeed in that state is choosing the
   * game folder, which is this panel's - so the panel leads and the guide follows it. Once a
   * registration exists the guide leads and the panel is the setting it was.
   *
   * Measured at 400x800 with no installation before this: the guide's "Enable companion play" sat
   * at y=270..314 inside the 800 px window and refused, while the panel's "Choose game folder" - the
   * only control that could act - sat at y=1522, 722 px below the fold. The first viewport held two
   * controls that could only fail and none that could work.
   */
  const gettingGoing = installationRegistered
    ? [gameStatePanel, installationDiscovery]
    : [installationDiscovery, gameStatePanel];
  /**
   * The companion situation card, or `null` when the Host published no Game projection.
   *
   * It is derived here rather than inside the state panel because it states the whole surface's
   * situation: with no installation registered the installation panel leads the page, so a card
   * mounted inside the state panel would sit below it - the one place a card about her must not be.
   */
  const gameSituation = deriveGameSituation({
    phase: sessionControls.phase,
    installationRequired: sessionControls.installationRequired,
    cabinAdmitted: cabinView.kind === "admitted",
  });
  if (!opened) return null;

  return (
    <SurfaceView
      title={labels.gamePanel}
      testId="game-surface"
      icon={Gamepad2}
      selected={selected}
      // The Game surface lays its own content out (a two-column panel grid at a
      // desktop width), so it names itself for the stylesheet the way the
      // conversation does with `surface-conversation`.
      className="surface-game"
      restoreFocusTo={restoreFocusTo}
    >
      {/* Who is waiting, where she is, and the one next thing to do. It leads the surface: every
          group below answers a question about the machinery, and this answers the question a player
          opens the page with. It is absent only when the Host published no projection at all. */}
      {gameSituation !== null && (
        <GameSituationCard
          situation={gameSituation}
          labels={labels}
          companion={{ handle: companionHandle, name: companionName, digest: companionDigest }}
        />
      )}
      {/* The shell's arrival refresh could not be made, so the panel below is the projection it
          already held and this says so. It sits above the panel rather than inside it: the fact is
          about the read, not about any group's contents, and a status line inside the region would
          move when a group renders. */}
      {arrivalNotice !== null && (
        <p className="game-status" data-tone="danger" role="status" data-testid="game-arrival-notice">
          {arrivalNotice}
        </p>
      )}
      {/* The read this surface's own step could not make, in the same line shape and the same place
          as the arrival notice: the fact is about the read, not about any group's contents, and a
          status line inside the region would move when a group renders. `data-problem-code` is the
          bounded code the failure carried - the record's half of it, never a sentence's. */}
      {gameReadFailure !== null && (
        <p
          className="game-status"
          data-tone="danger"
          role="status"
          data-testid="game-read-notice"
          data-problem-code={gameReadFailure.code ?? undefined}
        >
          {gameReadFailure.sentence}
        </p>
      )}
      {/* Installation discovery is a sibling of the Game state region, never inside it, so the
          region's scope stays exactly its own controls (its Retry/Cancel would otherwise make
          the region's strict-mode queries ambiguous). Which of the two leads is this state's
          reading order, not a fixed one: see `gettingGoing` above. */}
      {gettingGoing}
      {/* The Game Agent's own model settings, on the Game surface (design/
          architecture/product-surfaces.md); the Host stores this half of
          settings/profiles separately from Chat's. */}
      <SurfaceModelSettings surface="game" api={managementApi} csrfToken={csrfToken} labels={labels} />
      {/* The player's own mod settings: what the companion may do, and the co-op
          night floor. This is the only place a player learns these exist, so it is a
          section of the Game surface itself rather than something behind a
          disclosure. */}
      <GamePlayerSettings api={composedApi} labels={labels} />
      {/* Read-only Host data at the bottom of the Game surface: the
          instance and session projection the composed state route
          publishes, and the honest fact that this Host mounts no
          diagnostics route. Collapsed by default; see the component
          for the reachability evidence. */}
      <GameDiagnosticsDisclosure game={game} labels={labels} />
    </SurfaceView>
  );
}

/**
 * Where the card says she is, as one of the facts the projection publishes.
 *
 * Each member is a different published fact, not a different tone: `in_farm` is
 * `attachment.status: "attached"`, `arriving` is `instance.status: "launching"`, `game_running` is
 * a Player Host that is up while this browser holds no attachment, `not_in_farm` is
 * `instance.status: "none"` (nothing is staged or running), `game_gone` is the Host's
 * `crashed`/`stopped` row, and `not_read` is `instance.status: "unread"` - the Host holds no read
 * of the player's game at all.
 */
type GameSituationWhere = "in_farm" | "arriving" | "game_running" | "not_in_farm" | "game_gone" | "not_read";

/**
 * The connection fact worth adding to the sentence, or `null` when the published facts add nothing.
 *
 * `paused` is `actionAuthority: "paused"` (the companion is in the farm and will not act until the
 * player resumes her), `connecting` is `connectionStatus: "syncing" | "reconnecting"`, and `dropped`
 * is `"failed" | "disconnected"` - the three shapes of a live attachment whose line is not carrying.
 */
type GameSituationCondition = "paused" | "connecting" | "dropped";

/**
 * What the situation card says, per session phase.
 *
 * The record's key is `GameSessionPhase`, so a phase the product adds is a missing entry and the
 * compiler refuses it - the card cannot silently go quiet on a state. `next` is either the label of
 * the control this surface really draws for that step (`action`, read from the same catalogue the
 * control reads, so the card and the button can never name the step differently) or a sentence for
 * the steps that are not a control on this page (`text`).
 *
 * `where: null` is `no_projection`, which renders no card at all: with no projection there is no
 * companion fact on this surface to state.
 */
const GAME_SITUATION_FACTS: Readonly<
  Record<
    GameSessionPhase,
    Readonly<{
      where: GameSituationWhere | null;
      condition: GameSituationCondition | null;
      next: Readonly<{ action: keyof Messages }> | Readonly<{ text: keyof Messages }>;
    }>
  >
> = Object.freeze({
  no_projection: { where: null, condition: null, next: { text: "gameSituationNextSeeBelow" } },
  pre_activation: { where: "not_in_farm", condition: null, next: { action: "gameActivation" } },
  activated_not_launched: { where: "not_in_farm", condition: null, next: { action: "gameLaunch" } },
  launching: { where: "arriving", condition: null, next: { text: "gameSituationNextWaitGame" } },
  running_without_attachment: { where: "game_running", condition: null, next: { text: "gameSituationNextWaitGame" } },
  // The player let go of a world that kept running: she is not in the farm, and the line really did drop
  // (`connectionStatus: "disconnected"`), so the card names that instead of a wait nobody is on.
  disconnected_world_running: { where: "game_running", condition: "dropped", next: { action: "gameReadAgain" } },
  launch_failed: { where: "game_gone", condition: null, next: { text: "gameSituationNextSeeBelow" } },
  ended_attempt_ready: { where: "game_gone", condition: null, next: { action: "gameActivation" } },
  game_not_read: { where: "not_read", condition: null, next: { action: "gameReadAgain" } },
  attached_connected: { where: "in_farm", condition: null, next: { text: "gameSituationNextReturnToGame" } },
  attached_actions_paused: { where: "in_farm", condition: "paused", next: { action: "gameReopen" } },
  attached_stopping: { where: "in_farm", condition: null, next: { text: "gameSituationNextSeeBelow" } },
  attached_stopped: { where: "in_farm", condition: null, next: { text: "gameSituationNextSeeBelow" } },
  attached_syncing: { where: "in_farm", condition: "connecting", next: { text: "gameSituationNextWaitConnection" } },
  attached_reconnecting: {
    where: "in_farm",
    condition: "connecting",
    next: { text: "gameSituationNextWaitConnection" },
  },
  attached_unconnected: { where: "in_farm", condition: null, next: { text: "gameSituationNextWaitConnection" } },
  attached_resumable: { where: "in_farm", condition: "dropped", next: { action: "gameResume" } },
  attached_unsettled: { where: "in_farm", condition: "dropped", next: { action: "gameResume" } },
  attached_resume_failed: { where: "in_farm", condition: "dropped", next: { action: "gameRetry" } },
});

/** The situation card's whole content, derived once for the render. */
type GameSituation = Readonly<{
  phase: GameSessionPhase;
  where: GameSituationWhere;
  condition: GameSituationCondition | null;
  /** This surface's own cabin confirmation, stated only while she is on her way in. */
  movedIn: boolean;
  next: Readonly<{ kind: "action" | "text"; message: keyof Messages }>;
}>;

/**
 * The card's facts, or `null` when there is nothing to state.
 *
 * Two of the clauses are this surface's own state rather than the projection's: `cabinAdmitted` is
 * the cabin confirmation this page watched land (`cabinView.kind === "admitted"`), and it is folded
 * in only while she is not yet attached - once `attachment.status` is `attached` the handoff is
 * over, and repeating "moving in now" beside "I'm on your farm" would be the card narrating a
 * moment that has passed. `installationRequired` is the session derivation's own fact that the
 * Host holds no ready installation registration, and it replaces the activation label with the step
 * that can actually succeed (the installation panel on this page).
 */
function deriveGameSituation(
  view: Readonly<{
    phase: GameSessionPhase;
    installationRequired: boolean;
    cabinAdmitted: boolean;
  }>,
): GameSituation | null {
  const facts = GAME_SITUATION_FACTS[view.phase];
  if (facts.where === null) return null;
  let next: GameSituation["next"];
  if (view.phase === "pre_activation" && view.installationRequired)
    next = { kind: "text", message: "gameSituationNextInstall" };
  else if ("action" in facts.next) next = { kind: "action", message: facts.next.action };
  else next = { kind: "text", message: facts.next.text };
  return Object.freeze({
    phase: view.phase,
    where: facts.where,
    condition: facts.condition,
    movedIn: view.cabinAdmitted && facts.where !== "in_farm",
    next,
  });
}

/** The one sentence each where-fact is, and each condition: one declaration, no ternary chain. */
const GAME_SITUATION_WHERE_MESSAGE: Readonly<Record<GameSituationWhere, keyof Messages>> = Object.freeze({
  in_farm: "gameSituationFarm",
  arriving: "gameSituationArriving",
  game_running: "gameSituationGameRunning",
  not_in_farm: "gameSituationNotInFarm",
  game_gone: "gameSituationGameGone",
  not_read: "gameSituationNotRead",
});

const GAME_SITUATION_CONDITION_MESSAGE: Readonly<Record<GameSituationCondition, keyof Messages>> = Object.freeze({
  paused: "gameSituationPaused",
  connecting: "gameSituationConnecting",
  dropped: "gameSituationDropped",
});

/**
 * The companion situation card: her picture, where she is, and the one next thing to do.
 *
 * It sits at the top of the Game surface, above every panel, because it is the only part of this
 * page that is about *her* rather than about the machinery: before it, the first thing a player
 * read on this surface was an installation panel and a three-step runbook.
 *
 * Every sentence is a published fact (see `GAME_SITUATION_FACTS` and `deriveGameSituation`); a
 * fact the projection does not publish has no sentence here, so a companion the Host has not named
 * has no monogram rather than an invented one, and a game that has not published a connection
 * status says nothing about the connection. `data-situation` carries the where-fact so a journey
 * can ask which situation the card is in without reading the copy.
 */
function GameSituationCard({
  situation,
  labels,
  companion,
}: {
  situation: GameSituation;
  labels: Messages;
  companion: Readonly<{ handle: string | null; name: string; digest?: string }>;
}) {
  let condition: keyof Messages | null = null;
  if (situation.movedIn) condition = "gameSituationMovedIn";
  else if (situation.condition !== null) condition = GAME_SITUATION_CONDITION_MESSAGE[situation.condition];
  return (
    <section
      className="game-situation"
      data-testid="game-situation"
      data-situation={situation.where}
      aria-label={labels.gameSituationAria}
    >
      <CompanionAvatar
        handle={companion.handle}
        name={companion.name}
        className="game-situation-avatar"
        digest={companion.digest}
      />
      <div className="game-situation-body">
        <p className="game-situation-line" data-testid="game-situation-line">
          {labels[GAME_SITUATION_WHERE_MESSAGE[situation.where]]}
        </p>
        {condition !== null && <p className="game-situation-line">{labels[condition]}</p>}
        <p className="game-situation-next" data-testid="game-situation-next">
          {situation.next.kind === "action"
            ? labels.gameSituationNextAction.replace("{{action}}", labels[situation.next.message])
            : labels[situation.next.message]}
        </p>
      </div>
    </section>
  );
}
