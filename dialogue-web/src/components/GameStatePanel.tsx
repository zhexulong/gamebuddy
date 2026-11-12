import {
  Check,
  ChevronDown,
  Hand,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Settings,
  Sparkles,
  Square,
  Unplug,
  Users,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { gameOperationFailureSentence, type GameOperationFailure } from "../composed-problem-view";
import type { Messages } from "../i18n";
import type { GameBrowserStateV1, StardewCabinChoiceV1 } from "../composed-reference-game-browser-api";
import type { GameSessionControls } from "../game-lifecycle-controls";
import {
  compatibilityLabel,
  connectionLabel,
  deriveCapabilityBoard,
  instanceLabel,
  outcomeLabel,
  type CapabilityBoard,
  type CapabilityBoardCard,
} from "../game-presentation";
import { useArmedConfirmation } from "./armed-confirmation";

/**
 * The create form's id, named once: the control that opens it points at this id with
 * `aria-controls`, and the region takes it. A second spelling of the string is how the two
 * would drift apart without either of them looking wrong.
 */
const GAME_CREATE_FORM_ID = "game-create-form";

/**
 * The Game panel: one presentation component for every state the composed Game
 * surface models, so the shell owns behaviour and this owns reading order.
 *
 * Reading order is deliberate. Each group answers one player question, in the
 * order those questions get answered (design/26 §4.2, design/28 §2,
 * design/104 §2):
 *
 *   Board      - what can my companion do with me?
 *   Next step  - how do we get going (or: resume the actions)?
 *   Session    - what is running now, and how do I stop or disconnect it?
 *   Recovery   - the connection could not be restored; what now?
 *   Facts      - the machine facts, compact and last.
 *
 * The first two swap seats, and the state decides which leads. The board leads
 * as soon as the game publishes a capability: then "what can my companion do
 * with me" really is the first question, and it has an answer. While the board
 * has nothing published it holds only the fact that it has nothing, so leading
 * with it spends the whole first viewport answering a question the session
 * cannot answer yet and pushes the one control a fresh session offers below the
 * fold (measured at 400x800 before: 398 px of empty board, and the enable
 * control 417 px below the board's first sentence). In that state the guide
 * leads, because the first thing the surface owes the player is the step they
 * can take.
 *
 * The board is derived from the capability surface the composed game
 * projection publishes - it is never a hand-written ability list, and while the
 * session has published none it says that in one sentence instead of one card
 * per absent fact.
 *
 * Each step of the guide carries its controls first and the feedback those
 * controls produce directly below them, so a player reads "what is true, what
 * can I do, what happened when I did it" top to bottom, and the button they
 * just pressed never moves out from under the pointer when its own feedback
 * appears (design/26 §6.4: interaction feedback must not shift surrounding
 * layout). A group with nothing to offer renders nothing at all: design/26 §1
 * fixes a control as absent rather than a disabled lookalike.
 *
 * A step states ONE next action, and a step the phase has already moved past is
 * not drawn at all. Which action that is comes from `forwardActions`, the one
 * derivation in `../game-lifecycle-controls`: the guide never re-derives "what
 * can the player do now" from the raw projection, so the control it leads with
 * and the action the state offers cannot disagree. The staging pair (enable
 * companion play, then set up Stardew Valley) is the case that forced this: the
 * Host accepts them in one order only, so drawing them side by side offered a
 * button whose own refusal taught the order after the player had picked it - and
 * drawing both after the attempt was already staged walked the player through a
 * step that no longer applied.
 *
 * Every typed Host value is rendered through `../game-presentation`, which maps
 * the frozen `game_browser_api/v1` union to localized player outcomes. A raw
 * enum, a code, a revision or a handle is never shown (design/104 §10).
 *
 * Presentation contract (frozen by
 * `tests/composed-profile-bootstrap.spec.ts` and
 * `design/architecture/frontend-slot-and-theme-decoupling.md` §5.3):
 * - the panel is the `role="region"` named by `labels.gameState`, and carries
 *   `data-testid="game-state-panel"` + `data-game-state="available" | "null"`;
 * - the cabin confirm button keeps `aria-label={labels.stardewCabinConfirm}` and
 *   the cabin list keeps `data-testid="cabin-choice-list"`;
 * - the lifecycle controls keep the exact accessible names they had, and the
 *   guide presents those same controls (as `game-activate`, `game-setup`,
 *   `game-launch`, `game-reopen`, `game-stop`, `game-disconnect`,
 *   `game-resume`, `game-resume-cancel`, `game-create`) rather than a second
 *   set of them;
 * - the board keeps `data-testid="game-capability-board"` (on the board region,
 *   so its lead and its waiting sentence read with its cards) with
 *   `data-capability-state="published" | "unpublished"`, and the guide keeps
 *   `data-testid="game-start-guide"`;
 * - the guide's step 1 carries `data-guide-action="activate" | "setup"` naming the
 *   one control it leads with (from `forwardActions`), draws that control and no
 *   other as `.primary`, offers the other inside
 *   `data-testid="game-guide-step-one-alternate"`, and is absent entirely when the
 *   phase has no staging action left;
 * - every fact row keeps its `dt`/`dd` text adjacency (a label and its value are
 *   never separated by anything, so the row still reads `ConnectionConnected`);
 * - every status sentence is still the `role="status"` line it was.
 */

export type CabinViewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "choices"; choices: readonly StardewCabinChoiceV1[] }>
  | Readonly<{ kind: "confirming"; choices: readonly StardewCabinChoiceV1[]; choiceHandle: string }>
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "uncertain" }>
  /** The read could not be made, and the panel offers the control that makes it again. */
  | Readonly<{ kind: "unavailable"; reread: boolean }>
  /**
   * No cabin this companion may use in the current host world.
   *
   * Distinct from `unavailable`, and the distinction is the whole point: this state has a CURE the player can act
   * on - have Robin build one - while `unavailable` is "the read could not be made". The Host has always known the
   * difference (`stardew_player_host_cabin_unavailable`); it was flattened to `state_unavailable` on the read route
   * until 2026-10-28, so the panel had one word for two situations and a player reading the wrong one retried
   * forever.
   *
   * `reread` is the shell's answer to "did my click do anything": true once the player asked again and the answer was
   * still this state. Without it the refresh button under it is a control whose result is the screen the player is
   * already looking at. The shell is the only party that knows, so it carries the fact rather than the panel guessing.
   */
  | Readonly<{ kind: "missing"; reread: boolean }>;

type StatusDotTone = "progress" | "warning" | "danger" | "neutral";

export type GameStatePanelProps = Readonly<{
  game: GameBrowserStateV1 | null;
  labels: Messages;
  /** The published integration id the create form names, owned by the shell. */
  integrationId: string;
  syncing: boolean;
  lifecycle: Readonly<{
    activation: Readonly<{
      available: boolean;
      active: boolean;
      failure: GameOperationFailure | null;
      notConfigured: boolean;
      unavailable: boolean;
    }>;
    setup: Readonly<{ available: boolean; active: boolean; failure: GameOperationFailure | null; notStaged: boolean }>;
    launch: Readonly<{
      available: boolean;
      active: boolean;
      failure: GameOperationFailure | null;
      notStaged: boolean;
      /** Another attachment operation is in flight, so this control must not be offered. */
      blocked: boolean;
    }>;
  }>;
  session: Readonly<{
    /**
     * What this state offers, from the one derivation the zero-forward-path gate
     * drives (`../game-lifecycle-controls`). The panel renders exactly these and
     * nothing else, so the offer the player sees and the offer the gate checks
     * cannot disagree.
     */
    controls: GameSessionControls;
    stop: Readonly<{ active: boolean; failure: GameOperationFailure | null; blocked: boolean }>;
    disconnect: Readonly<{ active: boolean; failure: GameOperationFailure | null; blocked: boolean }>;
    /**
     * The deliberate terminal operation (`game.endgame`). `confirmArmed` is the
     * UI-level confirm step: the first click arms, only the confirm button sends.
     */
    endgame: Readonly<{ active: boolean; failure: GameOperationFailure | null; confirmArmed: boolean }>;
  }>;
  resume: Readonly<{
    active: boolean;
    failure: GameOperationFailure | null;
    unavailable: boolean;
    cancelActive: boolean;
    cancelFailure: GameOperationFailure | null;
  }>;
  reopen: Readonly<{
    active: boolean;
    failure: GameOperationFailure | null;
    unavailable: boolean;
  }>;
  create: Readonly<{
    active: boolean;
    failure: GameOperationFailure | null;
    unavailable: boolean;
    formOpen: boolean;
    continuityIdentity: string;
  }>;
  cabin: CabinViewState;
  handlers: Readonly<{
    activate(): void;
    setup(): void;
    launch(): void;
    stop(): void;
    disconnect(): void;
    endgame(): void;
    armEndgame(): void;
    cancelEndgame(): void;
    resume(): void;
    resumeCancel(): void;
    reopen(): void;
    create(): void;
    toggleCreateForm(): void;
    setContinuityIdentity(value: string): void;
    confirmCabin(choice: StardewCabinChoiceV1): void;
    refreshCabins(): void;
    /** The panel's own re-read of the composed state, which is the step in `game_not_read`. */
    reread(): void;
  }>;
}>;

/**
 * `connected` keeps the shared green `.status-dot`; the tones only ever add
 * information the row's own status word already carries.
 */
function connectionDotTone(status: string): StatusDotTone | undefined {
  if (status === "connected_idle" || status === "active") return undefined;
  if (status === "syncing" || status === "reconnecting") return "warning";
  if (status === "failed") return "danger";
  return "neutral";
}

/** One labelled group of the panel. The heading is the group's accessible name. */
function PanelGroup({
  id,
  title,
  className,
  children,
}: {
  id: string;
  title: string;
  /** Extra class for a group that is deliberately not a peer of the others. */
  className?: string;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      className={className === undefined ? "game-group" : `game-group ${className}`}
      id={id}
      aria-labelledby={headingId}
    >
      <h3 className="game-group-title" id={headingId}>
        {title}
      </h3>
      {children}
    </section>
  );
}

export function GameStatePanel({
  game,
  labels,
  integrationId,
  syncing,
  lifecycle,
  session,
  resume,
  reopen,
  create,
  cabin,
  handlers,
}: GameStatePanelProps) {
  // The companion is in the farm once the Host publishes an attachment for it.
  // While it is not, the surface's job is "here is how we get going": the same
  // lifecycle controls, presented inside the three-step guide's affordances
  // (never a second set of them).
  const companionInFarm = game !== null && game.game.attachment.status === "attached";
  /**
   * The one staging action this phase names, or `null` when the staging step is
   * behind the player.
   *
   * `forwardActions` is the phase's own ordered step list (`../game-lifecycle-controls`),
   * so this reads the same declaration the zero-forward-path gate drives instead of
   * repeating the projection's predicates here. `activate` leads while the Host has
   * staged nothing; `setup` leads once activation is established (the Host refuses it
   * before that with `gameActivationRequired`); at `activated_not_launched` neither is
   * offered, which is what makes step 1 disappear rather than ask for work already done.
   */
  const stagingAction: "activate" | "setup" | null =
    session.controls.forwardActions[0] === "activate"
      ? "activate"
      : session.controls.forwardActions[0] === "setup"
        ? "setup"
        : null;
  // The terminal operation's confirm step is the same arm-and-close pair the Chats rows take
  // (`./armed-confirmation`): arming replaces the trigger with the confirmation, so without it the
  // page drops focus onto `<body>` at both ends, and Escape reaches the shell's window handler -
  // which leaves the Game surface instead of answering the confirmation.
  const endgamePair = useArmedConfirmation(session.endgame.confirmArmed, handlers.cancelEndgame);
  // The board's own named state, derived by `deriveCapabilityBoard`:
  // `waiting` is present exactly while the session has published no capability
  // at all. That one fact decides both the board's shape and its place in the
  // reading order, so the two can never disagree.
  const board = game === null ? null : deriveCapabilityBoard(labels, game.game);
  const capabilitiesUnpublished = board !== null && board.waiting !== null;
  // One mount site per state, never two: the board leads while it has a published
  // fact to state, and sits below the next step while it has none.
  const capabilityBoard = board === null ? null : <CapabilityBoardView board={board} />;
  // One mount site per state, never two: the cabin handoff is the third step's
  // affordance while the companion is on its way in, and stays the sibling
  // block below the groups once it is in the farm.
  const cabinHandoff = (
    <CabinHandoff
      state={cabin}
      labels={labels}
      // The Host serves cabin choices only while a Player Host instance it
      // launched is awaiting attestation; with no instance the read fails with
      // `stardew_cabin_handoff_unavailable`. That is the first-run state - the
      // player has not started a game - so the handoff reads it as the step it
      // is waiting for, and reserves the read-failure sentence for a read that
      // really failed.
      awaitsSession={game !== null && game.game.instance.status === "none"}
      onConfirm={handlers.confirmCabin}
      onRefresh={handlers.refreshCabins}
    />
  );
  return (
    // The panel scrolls once the projection is longer than the space the drawer
    // gives it. A scrollable region that cannot take focus is unreachable for a
    // keyboard-only player (axe: scrollable-region-focusable, serious); the
    // region's own accessible name announces where focus landed.
    <section
      className="composed-game-drawer"
      aria-label={labels.gameState}
      data-testid="game-state-panel"
      data-game-state={game === null ? "null" : "available"}
      tabIndex={0}
    >
      {game === null ? (
        <p className="game-panel-empty">{labels.gameStateUnavailable}</p>
      ) : (
        <>
          {/* What the companion can do with the player, derived from the
              capability surface the composed game projection publishes: the
              published summary, the embodied role and the action authority.
              Nothing here is a hand-written ability list. It comes first whenever
              it has a fact to state; while it has none it follows the next step,
              so a fresh session opens on the step the player can take rather than
              on a board that only has three ways of saying nothing. */}
          {capabilitiesUnpublished ? null : capabilityBoard}

          {/* Getting going. The three steps are the reading order of the first
              run (start Stardew, load the farm, the companion moves in), and
              each step carries the affordance that belongs to it: one staging
              action in step 1, the launch in step 2, the cabin choice in
              step 3. A step whose premise the current phase has already
              established is not drawn at all. Once the companion is in the farm
              the same group holds the actions-resume affordance it held before. */}
          <PanelGroup id="game-group-next-step" title={labels.gameGroupNextStep}>
            {/* The two states whose step is not a control on this page, stated where the
                guide would have been so the player is never left reading a panel of
                withdrawn controls with nothing saying why. `launch_failed` also holds
                the guide back: every control in it is refused for the life of this Host
                process, so showing it would be exactly the trap design/26 §1 rules out. */}
            {session.controls.restartRequired && (
              <p className="game-status" data-tone="danger" role="status" data-testid="game-launch-quarantined">
                {labels.gameLaunchQuarantined}
              </p>
            )}
            {session.controls.waitingForGame && (
              <p className="game-status" data-tone="progress" role="status" data-testid="game-waiting-for-game">
                {labels.gameWaitingForGame}
              </p>
            )}
            {/* The Host has not read the player's game. Every control in the guide below acts
                on a premise that read would establish, so the guide is held back and the
                step that belongs to this state - the read itself - is the only one drawn. */}
            {session.controls.rereadAvailable && (
              <p className="game-status" data-tone="progress" role="status" data-testid="game-not-read">
                {labels.gameNotRead}
              </p>
            )}
            {session.controls.rereadAvailable && (
              <div className="game-actions">
                <button
                  type="button"
                  className="game-action primary"
                  data-testid="game-reread"
                  onClick={handlers.reread}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  {labels.gameReadAgain}
                </button>
              </div>
            )}
            {session.controls.restartRequired || session.controls.rereadAvailable ? null : companionInFarm ? (
              <div className="game-actions">
                {session.controls.reopenAvailable && (
                  <button
                    type="button"
                    className="game-action primary"
                    data-testid="game-reopen"
                    disabled={reopen.active}
                    onClick={handlers.reopen}
                  >
                    <RotateCcw size={16} aria-hidden="true" />
                    {labels.gameReopen}
                  </button>
                )}
              </div>
            ) : (
              <ol className="game-guide-steps" data-testid="game-start-guide" aria-label={labels.gameStartGuide}>
                {/* Step 1 is drawn only while the phase names a staging action. Once the Host
                    reports the attempt staged and the prerequisites met, the phase is
                    `activated_not_launched` and this step is behind the player: presenting it
                    again would ask for work they have already done. */}
                {stagingAction !== null && (
                  <li className="game-guide-step" data-guide-step="1" data-guide-action={stagingAction}>
                    <h4 className="game-guide-step-title">{labels.gameGuideStepOneTitle}</h4>
                    <p className="game-guide-step-detail">{labels.gameGuideStepOneDetail}</p>
                    {/* One step, one control. `forwardActions[0]` is the action this phase can
                        actually take, so it is the only one drawn at full weight; setup answers
                        `gameActivationRequired` until activation has staged the attempt, which is
                        why it is offered to the player who says companion play is already enabled
                        instead of standing beside the button that precedes it. */}
                    <div className="game-actions">
                      {stagingAction === "activate" ? (
                        <button
                          type="button"
                          className="game-action primary"
                          data-testid="game-activate"
                          disabled={lifecycle.activation.active}
                          aria-label={labels.gameActivation}
                          onClick={handlers.activate}
                        >
                          <Power size={16} aria-hidden="true" />
                          {labels.gameActivation}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="game-action primary"
                          data-testid="game-setup"
                          disabled={lifecycle.setup.active}
                          onClick={handlers.setup}
                        >
                          <Settings size={16} aria-hidden="true" />
                          {labels.gameSetup}
                        </button>
                      )}
                    </div>
                    <p className="game-subpanel-note">
                      {stagingAction === "activate" ? labels.gameActivationHint : labels.gameSetupHint}
                    </p>
                    {stagingAction === "activate" && lifecycle.setup.available && (
                      <details className="custom-disclosure" data-testid="game-guide-step-one-alternate">
                        <summary>
                          <ChevronDown size={16} aria-hidden="true" />
                          {labels.gameGuideStepOneAlternate}
                        </summary>
                        <button
                          type="button"
                          className="game-action"
                          data-testid="game-setup"
                          disabled={lifecycle.setup.active}
                          onClick={handlers.setup}
                        >
                          <Settings size={16} aria-hidden="true" />
                          {labels.gameSetup}
                        </button>
                        <p className="game-subpanel-note">{labels.gameSetupHint}</p>
                      </details>
                    )}
                    {lifecycle.activation.active && (
                      <p className="game-status" data-tone="progress" role="status">
                        {labels.gameActivationInProgress}
                      </p>
                    )}
                    {lifecycle.activation.failure !== null && (
                      <p className="game-status" data-tone="danger" role="status">
                        {gameOperationFailureSentence(lifecycle.activation.failure, labels.gameActivationFailed)}
                      </p>
                    )}
                    {lifecycle.activation.notConfigured && (
                      <p className="game-status" data-tone="info" role="status">
                        {labels.gameActivationNotConfigured}
                      </p>
                    )}
                    {lifecycle.activation.unavailable && (
                      <p className="game-status" data-tone="info" role="status">
                        {labels.gameActivationUnavailable}
                      </p>
                    )}
                    {lifecycle.setup.notStaged ? (
                      <p className="game-status" data-tone="info" role="status">
                        {labels.gameActivationRequired}
                      </p>
                    ) : (
                      lifecycle.setup.failure !== null && (
                        <p className="game-status" data-tone="danger" role="status">
                          {gameOperationFailureSentence(lifecycle.setup.failure, labels.gameSetupFailed)}
                        </p>
                      )
                    )}
                  </li>
                )}

                <li className="game-guide-step" data-guide-step="2">
                  <h4 className="game-guide-step-title">{labels.gameGuideStepTwoTitle}</h4>
                  <p className="game-guide-step-detail">{labels.gameGuideStepTwoDetail}</p>
                  <div className="game-actions">
                    {lifecycle.launch.available && (
                      <button
                        type="button"
                        className="game-action primary"
                        data-testid="game-launch"
                        disabled={lifecycle.launch.active}
                        aria-label={labels.gameLaunch}
                        onClick={handlers.launch}
                      >
                        <Play size={16} aria-hidden="true" />
                        {labels.gameLaunch}
                      </button>
                    )}
                  </div>
                  {lifecycle.launch.notStaged ? (
                    <p className="game-status" data-tone="info" role="status">
                      {labels.gameActivationRequired}
                    </p>
                  ) : (
                    lifecycle.launch.failure !== null && (
                      <p className="game-status" data-tone="warning" role="status">
                        {gameOperationFailureSentence(lifecycle.launch.failure, labels.gameLaunchFailed)}
                      </p>
                    )
                  )}
                </li>

                <li className="game-guide-step" data-guide-step="3">
                  <h4 className="game-guide-step-title">{labels.gameGuideStepThreeTitle}</h4>
                  <p className="game-guide-step-detail">{labels.gameGuideStepThreeDetail}</p>
                  {cabinHandoff}
                </li>
              </ol>
            )}
            {session.controls.reopenAvailable && (
              <p className="game-status" data-tone="warning" role="status">
                {labels.gameActionsPaused}
              </p>
            )}
            {syncing && (
              <p className="game-status" data-tone="progress" role="status">
                {labels.gameSyncing}
              </p>
            )}
            {reopen.active && (
              <p className="game-status" data-tone="progress" role="status">
                {labels.gameReopenInProgress}
              </p>
            )}
            {reopen.failure !== null && (
              <p className="game-status" data-tone="danger" role="status">
                {gameOperationFailureSentence(reopen.failure, labels.gameReopenFailed)}
              </p>
            )}
            {reopen.unavailable && (
              <p className="game-status" data-tone="warning" role="status">
                {labels.gameReopenUnavailable}
              </p>
            )}
          </PanelGroup>

          {/* The board when it has nothing to publish: it follows the step the
              player can take, and states the whole absence in one sentence rather
              than three cards that each state one third of it. */}
          {capabilitiesUnpublished ? capabilityBoard : null}

          {/* What is running now, and the controls that settle it. Offering zero
              of these on a projection that admits none leaves the group as its
              latest outcome alone: the acting authority is the board's card. */}
          <PanelGroup id="game-group-session" title={labels.gameGroupSession}>
            <dl className="game-facts">
              <GameFact label={labels.gameFactOutcome}>{outcomeLabel(labels, game.game.latestOutcome)}</GameFact>
            </dl>
            <div className="game-actions">
              {session.controls.stopAvailable && (
                <button
                  type="button"
                  className="game-action"
                  data-testid="game-stop"
                  disabled={session.stop.active || session.stop.blocked}
                  onClick={handlers.stop}
                >
                  <Square size={16} aria-hidden="true" />
                  {labels.gameStop}
                </button>
              )}
              {session.controls.disconnectAvailable && (
                <button
                  type="button"
                  className="game-action"
                  data-testid="game-disconnect"
                  disabled={session.disconnect.active || session.disconnect.blocked}
                  onClick={handlers.disconnect}
                >
                  <Unplug size={16} aria-hidden="true" />
                  {labels.gameDisconnect}
                </button>
              )}
            </div>
            {session.stop.failure !== null && (
              <p className="game-status" data-tone="warning" role="status">
                {gameOperationFailureSentence(session.stop.failure, labels.gameStopFailed)}
              </p>
            )}
            {session.disconnect.failure !== null && (
              <p className="game-status" data-tone="danger" role="status">
                {gameOperationFailureSentence(session.disconnect.failure, labels.gameDisconnectFailed)}
              </p>
            )}
            {/* The one terminal operation, deliberately set apart from the
                session's routine stop/disconnect row: it reads as its own block
                with a confirm step (design/28 §5.2; design 102). Unavailable
                means absent, never a disabled lookalike. */}
            {session.controls.endgameAvailable && (
              <div className="game-endgame" data-testid="game-endgame">
                {!session.endgame.confirmArmed ? (
                  <button
                    ref={endgamePair.triggerRef}
                    type="button"
                    className="game-action danger"
                    data-testid="game-endgame-open"
                    onClick={handlers.armEndgame}
                  >
                    <Power size={16} aria-hidden="true" />
                    {labels.gameEndgame}
                  </button>
                ) : (
                  <div
                    className="game-endgame-confirm"
                    data-testid="game-endgame-confirm"
                    onKeyDown={endgamePair.onConfirmKeyDown}
                  >
                    <p className="game-status" data-tone="danger" role="status">
                      {labels.gameEndgameConfirm}
                    </p>
                    <div className="game-actions">
                      <button
                        type="button"
                        className="game-action danger"
                        data-testid="game-endgame-confirm-yes"
                        disabled={session.endgame.active}
                        onClick={handlers.endgame}
                      >
                        <Power size={16} aria-hidden="true" />
                        {labels.gameEndgameConfirmYes}
                      </button>
                      <button
                        ref={endgamePair.cancelRef}
                        type="button"
                        className="game-action"
                        data-testid="game-endgame-confirm-no"
                        disabled={session.endgame.active}
                        onClick={endgamePair.cancel}
                      >
                        <X size={16} aria-hidden="true" />
                        {labels.gameEndgameConfirmNo}
                      </button>
                    </div>
                  </div>
                )}
                {session.endgame.active && (
                  <p className="game-status" data-tone="progress" role="status">
                    {labels.gameEndgameInProgress}
                  </p>
                )}
                {session.endgame.failure !== null && (
                  <p className="game-status" data-tone="danger" role="status">
                    {gameOperationFailureSentence(session.endgame.failure, labels.gameEndgameFailed)}
                  </p>
                )}
              </div>
            )}
          </PanelGroup>

          {/* Recovery. `controls.resumeAvailable` and `controls.retryResumeAvailable`
              are mutually exclusive (the derivation applies that rule), so this group
              offers the connection-restore action exactly once under exactly one
              honest name: `Resume game` before an attempt has failed, and the
              failure rollup `Retry`/`Cancel`/`Start new game` after one has
              (design/26 §4.1, design/104 §7). */}
          {(session.controls.resumeAvailable || session.controls.retryResumeAvailable) && (
            <PanelGroup id="game-group-recovery" title={labels.gameGroupRecovery}>
              <div className="game-actions">
                {session.controls.resumeAvailable && (
                  <button
                    type="button"
                    className="game-action primary"
                    data-testid="game-resume"
                    disabled={resume.active}
                    onClick={handlers.resume}
                  >
                    <Plug size={16} aria-hidden="true" />
                    {labels.gameResume}
                  </button>
                )}
                {session.controls.retryResumeAvailable && (
                  <button
                    type="button"
                    className="game-action primary"
                    data-testid="game-resume"
                    disabled={resume.active}
                    onClick={handlers.resume}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    {labels.gameRetry}
                  </button>
                )}
                {/* Cancel and Start new game act on an attempt - its reconnect epoch,
                    its replacement - so they are offered exactly while there is one.
                    On a session the Host already reports as failed with no attempt of
                    this surface's own, both handlers refuse, so drawing them would be
                    two controls that do nothing when pressed. */}
                {session.controls.cancelResumeAvailable && (
                  <button
                    type="button"
                    className="game-action"
                    data-testid="game-resume-cancel"
                    disabled={resume.cancelActive}
                    onClick={handlers.resumeCancel}
                  >
                    <X size={16} aria-hidden="true" />
                    {labels.gameResumeCancel}
                  </button>
                )}
                {session.controls.createAvailable && (
                  <button
                    type="button"
                    className="game-action"
                    data-testid="game-create"
                    disabled={create.active}
                    // The form below is a region this control shows and hides, so the control
                    // carries the disclosure: which region it owns, and whether that region is
                    // open. Both read the state that renders the region, so neither can describe
                    // an openness the form does not have.
                    aria-expanded={create.formOpen}
                    aria-controls={GAME_CREATE_FORM_ID}
                    onClick={handlers.toggleCreateForm}
                  >
                    <Plus size={16} aria-hidden="true" />
                    {labels.gameCreate}
                  </button>
                )}
              </div>
              {resume.active && (
                <p className="game-status" data-tone="progress" role="status">
                  {labels.gameResumeInProgress}
                </p>
              )}
              {resume.failure !== null && (
                <p className="game-status" data-tone="danger" role="status">
                  {gameOperationFailureSentence(resume.failure, labels.gameResumeFailed)}
                </p>
              )}
              {resume.unavailable && (
                <p className="game-status" data-tone="warning" role="status">
                  {labels.gameResumeUnavailable}
                </p>
              )}
              {resume.cancelActive && (
                <p className="game-status" data-tone="progress" role="status">
                  {labels.gameResumeCancelInProgress}
                </p>
              )}
              {resume.cancelFailure !== null && (
                <p className="game-status" data-tone="danger" role="status">
                  {gameOperationFailureSentence(resume.cancelFailure, labels.gameResumeCancelFailed)}
                </p>
              )}
            </PanelGroup>
          )}

          {create.formOpen && (
            <form
              id={GAME_CREATE_FORM_ID}
              className="game-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                handlers.create();
              }}
            >
              <h4>{labels.gameCreateFormTitle}</h4>
              <label>
                <span>{labels.gameCreateIntegration}</span>
                <span className="game-create-integration">{integrationId}</span>
              </label>
              <label>
                <span>{labels.gameCreateContinuityBinding}</span>
                <input
                  type="text"
                  value={create.continuityIdentity}
                  onChange={(event) => handlers.setContinuityIdentity(event.target.value)}
                  placeholder={labels.gameCreateContinuityBindingHint}
                />
              </label>
              <button type="submit" className="game-action primary" disabled={create.active}>
                <Check size={16} aria-hidden="true" />
                {labels.create}
              </button>
              {create.active && (
                <p className="game-status" data-tone="progress" role="status">
                  {labels.gameCreateInProgress}
                </p>
              )}
              {create.failure !== null && (
                <p className="game-status" data-tone="danger" role="status">
                  {gameOperationFailureSentence(create.failure, labels.gameCreateFailed)}
                </p>
              )}
              {create.unavailable && (
                <p className="game-status" data-tone="warning" role="status">
                  {labels.gameCreateUnavailable}
                </p>
              )}
            </form>
          )}

          {companionInFarm && cabinHandoff}

          {/* The machine facts, demoted below the board: true and useful, but
              not what the surface is about. The capability summary is not here
              - the board above is its presentation. */}
          <PanelGroup id="game-group-connection" title={labels.gameGroupConnection} className="game-group-secondary">
            <ConnectionFacts game={game} labels={labels} />
          </PanelGroup>
        </>
      )}
    </section>
  );
}

/**
 * The typed connection and surface facts, demoted below the board: true and
 * useful, but not what the surface is about (design/26 §4.2). Each row is one
 * label plus its value, with the value's own status dot as decoration inside
 * the value. The capability summary is not a row here - the board is its
 * presentation - and the acting authority is the board's own card.
 */
function ConnectionFacts({ game, labels }: { game: GameBrowserStateV1; labels: Messages }) {
  const projection = game.game;
  return (
    <dl className="game-facts">
      <GameFact label={labels.gameFactConnection} dotTone={connectionDotTone(projection.connectionStatus)}>
        {connectionLabel(labels, projection.connectionStatus)}
      </GameFact>
      <GameFact label={labels.gameFactInstance}>{instanceLabel(labels, projection.instance)}</GameFact>
      <GameFact label={labels.gameFactWorld}>{projection.selectedWorld ?? labels.gameValueNone}</GameFact>
      <GameFact label={labels.gameFactSave}>{projection.selectedSave ?? labels.gameValueNone}</GameFact>
      <GameFact label={labels.gameFactCompatibility}>{compatibilityLabel(labels, projection.compatibility)}</GameFact>
    </dl>
  );
}

function GameFact({ label, dotTone, children }: { label: string; dotTone?: StatusDotTone; children: ReactNode }) {
  return (
    <div className="game-fact">
      <dt>{label}</dt>
      <dd>
        {dotTone !== undefined && <span className="status-dot" data-tone={dotTone} aria-hidden="true" />}
        {children}
      </dd>
    </div>
  );
}

/**
 * The cabin handoff. Its outcomes are the panel's own status vocabulary, so an
 * admitted handoff reads as a positive result, a stale one as something to
 * retry, and an uncertain one as the one thing a player must not repeat. The
 * outcomes render above the list, exactly where the confirm button does not
 * move when one appears.
 *
 * `awaitsSession` splits the one outcome the Host cannot type for itself: a
 * cabin read that failed because no game session exists yet is the guide's own
 * next step ("here is what has to happen first"), while a read that failed with
 * a session in hand is a real failure and says so.
 */
function CabinHandoff({
  state,
  labels,
  awaitsSession,
  onConfirm,
  onRefresh,
}: {
  state: CabinViewState;
  labels: Messages;
  awaitsSession: boolean;
  onConfirm(choice: StardewCabinChoiceV1): void;
  /**
   * Re-read the cabin projection.
   *
   * Without this the panel could only ever show what was true at mount. Measured 2026-10-28: `readCabins()`
   * runs from one `useEffect` keyed on `ready` (`GameSurface.tsx:146-150`), so a player who started the game
   * and loaded the farm SAW `stardewCabinsUnavailable` forever - there is no poll, no game event stream, and
   * there was no control here to ask again. The only recovery was reloading the browser, which loses the
   * Game surface's own attachment.
   */
  onRefresh?(): void;
}) {
  return (
    <section className="stardew-cabin-handoff game-subpanel" aria-label={labels.stardewCabinSelection}>
      <h4 className="section-subtitle">{labels.stardewCabinSelection}</h4>
      {state.kind === "loading" && <p className="game-subpanel-note">{labels.stardewCabinsLoading}</p>}
      {state.kind === "missing" && (
        <p className="game-status" data-tone="action" role="status">
          {labels.stardewCabinsMissing}
        </p>
      )}
      {state.kind === "unavailable" &&
        (awaitsSession ? (
          <p className="game-status" data-tone="info" role="status">
            {labels.stardewCabinsAwaitingSession}
          </p>
        ) : (
          <p className="game-status" data-tone="info" role="status">
            {labels.stardewCabinsUnavailable}
          </p>
        ))}
      {/* What the refresh just found, stated where the control is: a player who has built
          a cabin and pressed again needs to know the click was read, and that the answer
          had not changed yet. It sits between the sentence and the control, so neither of
          them moves when it appears. Both states the control is offered in report it - one
          control that acknowledges the click in one state and silently repeats itself in
          the other is the defect this button was added to fix. */}
      {(state.kind === "missing" || state.kind === "unavailable") && state.reread && (
        <p className="game-subpanel-note" role="status">
          {labels.stardewCabinsReread}
        </p>
      )}
      {/*
        Offered for BOTH unavailable shapes, and it is the only thing on this panel that can change the answer.
        The failing state and the not-yet state look identical to a player and have the same cure, so one
        control covers both rather than making the player work out which silence they are reading. It is also
        mounted for `missing`, which is where a farm with no cabin lands: reloading the page instead would drop
        the Host connection and this surface's own session attachment, so the instruction to reload destroyed the
        setup it belonged to.
      */}
      {(state.kind === "unavailable" || state.kind === "missing") && onRefresh !== undefined && (
        <button type="button" className="game-secondary-action" onClick={onRefresh}>
          {labels.stardewCabinsRefresh}
        </button>
      )}
      {state.kind === "uncertain" && (
        <p className="game-status" data-tone="warning" role="status">
          {labels.stardewCabinConfirmationUncertain}
        </p>
      )}
      {state.kind === "admitted" && (
        <p className="game-status" data-tone="success" role="status">
          {labels.stardewManifestAdmitted}
        </p>
      )}
      {(state.kind === "choices" || state.kind === "confirming") && (
        <ul className="game-choice-list" data-testid="cabin-choice-list">
          {state.choices.map((choice) => (
            <li className="game-choice" key={choice.choiceHandle}>
              <span className="game-choice-label">{choice.displayLabel}</span>
              <button
                type="button"
                className="game-action"
                disabled={state.kind === "confirming"}
                aria-label={labels.stardewCabinConfirm}
                onClick={() => onConfirm(choice)}
              >
                <Check size={16} aria-hidden="true" />
                {labels.stardewCabinConfirm}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The icon that decorates a board card. One declared icon family (lucide). */
function capabilityCardIcon(icon: CapabilityBoardCard["icon"]) {
  if (icon === "companion") return <Users size={16} aria-hidden="true" />;
  if (icon === "abilities") return <Sparkles size={16} aria-hidden="true" />;
  return <Hand size={16} aria-hidden="true" />;
}

/**
 * The companion capability board: what the companion can do with the player,
 * derived from the capability surface the composed game projection publishes.
 *
 * With a published summary it renders exactly the cards `deriveCapabilityBoard`
 * produced from that projection, and nothing else.
 *
 * With none, it renders one sentence instead of one card per absent fact. The
 * three cards are the same absence told three times - "no companion", "nothing
 * published", "no acting authority" - and each one costs the fold a card's worth
 * of height to say that the session has nothing to say. `board.waiting !== null`
 * is the state that names this (the same `data-capability-state="unpublished"`
 * the region already carried), and the sentence is still the board's own: the
 * abilities come from the game, and they appear once it reports them for the farm
 * being played (design/26 §1: absent beats a disabled lookalike, and an invented
 * list is worse than either).
 */
function CapabilityBoardView({ board }: { board: CapabilityBoard }) {
  const unpublished = board.waiting !== null;
  return (
    <section
      className="game-capability-board"
      aria-labelledby="game-capability-board-heading"
      data-testid="game-capability-board"
      data-capability-state={unpublished ? "unpublished" : "published"}
    >
      <h3 className="game-group-title" id="game-capability-board-heading">
        {board.title}
      </h3>
      {unpublished ? (
        <p className="game-capability-waiting">
          {board.lead} {board.waiting}
        </p>
      ) : (
        <>
          <p className="game-capability-lead">{board.lead}</p>
          <ul className="game-capability-cards">
            {board.cards.map((card) => (
              <li className="game-capability-card" data-capability-card={card.key} key={card.key}>
                <span className="game-capability-card-icon" aria-hidden="true">
                  {capabilityCardIcon(card.icon)}
                </span>
                <h4 className="game-capability-card-title">{card.title}</h4>
                <p className="game-capability-card-detail">{card.detail}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
