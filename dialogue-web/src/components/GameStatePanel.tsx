import {
  Check,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Settings,
  Square,
  Unplug,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import type { GameBrowserStateV1, StardewCabinChoiceV1 } from "../composed-reference-game-browser-api";
import {
  authorityLabel,
  capabilitiesLabel,
  compatibilityLabel,
  connectionLabel,
  instanceLabel,
  outcomeLabel,
} from "../game-presentation";
import type { Messages } from "../i18n";

/**
 * The Game panel: one presentation component for every state the composed Game
 * surface models, so the shell owns behaviour and this owns reading order.
 *
 * Reading order is deliberate and identical in every state: four groups, each
 * one player question (design/26 §4.2, design/28 §2, design/104 §2):
 *
 *   Connection - what is true about the connection to my game?
 *   Next step  - what can I do next, and what happened when I did it?
 *   Session    - what is running now, and how do I stop or disconnect it?
 *   Recovery   - the connection could not be restored; what now?
 *
 * Each group renders its controls first and the feedback those controls produce
 * directly below them, so a player reads "what is true, what can I do, what
 * happened when I did it" top to bottom, and the button they just pressed never
 * moves out from under the pointer when its own feedback appears (design/26
 * §6.4: interaction feedback must not shift surrounding layout). A group with
 * nothing to offer renders nothing at all: design/26 §1 fixes a control as
 * absent rather than a disabled lookalike.
 *
 * Every typed Host value is rendered through `../game-presentation`, which maps
 * the frozen `game_browser_api/v1` union to localized player outcomes. A raw
 * enum, a code, a revision or a handle is never shown (design/104 §10).
 *
 * Presentation contract (frozen by
 * `tests/composed-reference-game-browser.spec.ts` and
 * `design/architecture/frontend-slot-and-theme-decoupling.md` §5.3):
 * - the panel is the `role="region"` named by `labels.gameState`, and carries
 *   `data-testid="game-state-panel"` + `data-game-state="available" | "null"`;
 * - the cabin confirm button keeps `aria-label={labels.stardewCabinConfirm}` and
 *   the cabin list keeps `data-testid="cabin-choice-list"`;
 * - every fact row keeps its `dt`/`dd` text adjacency (a label and its value are
 *   never separated by anything, so the row still reads `ConnectionConnected`);
 * - every control keeps the exact accessible name it had, and every status
 *   sentence is still the `role="status"` line it was.
 */

export type CabinViewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "choices"; choices: readonly StardewCabinChoiceV1[] }>
  | Readonly<{ kind: "confirming"; choices: readonly StardewCabinChoiceV1[]; choiceHandle: string }>
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "uncertain" }>
  | Readonly<{ kind: "unavailable" }>;

type StatusDotTone = "progress" | "warning" | "danger" | "neutral";

export type GameStatePanelProps = Readonly<{
  game: GameBrowserStateV1 | null;
  labels: Messages;
  /** The published integration id the create form names, owned by the shell. */
  integrationId: string;
  syncing: boolean;
  lifecycle: Readonly<{
    activation: Readonly<{ available: boolean; active: boolean; failed: boolean; unavailable: boolean }>;
    setup: Readonly<{ available: boolean; active: boolean; failed: boolean; notStaged: boolean }>;
    launch: Readonly<{ available: boolean; active: boolean; failed: boolean; notStaged: boolean }>;
  }>;
  session: Readonly<{
    stop: Readonly<{ available: boolean; active: boolean; failed: boolean }>;
    disconnect: Readonly<{ available: boolean; active: boolean; failed: boolean }>;
  }>;
  resume: Readonly<{
    available: boolean;
    active: boolean;
    failed: boolean;
    unavailable: boolean;
    cancelActive: boolean;
    cancelFailed: boolean;
    failureSurface: boolean;
  }>;
  reopen: Readonly<{ available: boolean; active: boolean; failed: boolean; unavailable: boolean }>;
  create: Readonly<{
    active: boolean;
    failed: boolean;
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
    resume(): void;
    resumeCancel(): void;
    reopen(): void;
    create(): void;
    toggleCreateForm(): void;
    setContinuityIdentity(value: string): void;
    confirmCabin(choice: StardewCabinChoiceV1): void;
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
function PanelGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const headingId = `${id}-heading`;
  return (
    <section className="game-group" id={id} aria-labelledby={headingId}>
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
  return (
    // The panel scrolls once the projection is longer than the space the drawer
    // gives it. A scrollable region that cannot take focus is unreachable for a
    // keyboard-only player (axe: scrollable-region-focusable, serious); the
    // region's own accessible name announces where focus landed.
    <section
      className="composed-game-drawer"
      role="region"
      aria-label={labels.gameState}
      data-testid="game-state-panel"
      data-game-state={game === null ? "null" : "available"}
      tabIndex={0}
    >
      {game === null ? (
        <p className="game-panel-empty">{labels.gameStateUnavailable}</p>
      ) : (
        <>
          <PanelGroup id="game-group-connection" title={labels.gameGroupConnection}>
            <ConnectionFacts game={game} labels={labels} />
          </PanelGroup>

          {/* The first-run chain into play. The controls are ordered by the
              documented chain, not by weight: the required staging step
              (`Enable companion play`) leads, the optional prerequisite repair
              (SMAPI/Mod setup through the Host's own picker) follows as a real
              but secondary action, and `Play with companion` is the single
              primary action once the Host publishes the staged shape
              (design/104 §7: the player sees one primary action). */}
          <PanelGroup id="game-group-next-step" title={labels.gameGroupNextStep}>
            <div className="game-actions">
              {lifecycle.activation.available && (
                <button
                  type="button"
                  className="game-action primary"
                  disabled={lifecycle.activation.active}
                  aria-label={labels.gameActivation}
                  onClick={handlers.activate}
                >
                  <Power size={16} aria-hidden="true" />
                  {labels.gameActivation}
                </button>
              )}
              {lifecycle.setup.available && (
                <button
                  type="button"
                  className="game-action"
                  disabled={lifecycle.setup.active}
                  onClick={handlers.setup}
                >
                  <Settings size={16} aria-hidden="true" />
                  {labels.gameSetup}
                </button>
              )}
              {lifecycle.launch.available && (
                <button
                  type="button"
                  className="game-action primary"
                  disabled={lifecycle.launch.active}
                  aria-label={labels.gameLaunch}
                  onClick={handlers.launch}
                >
                  <Play size={16} aria-hidden="true" />
                  {labels.gameLaunch}
                </button>
              )}
              {reopen.available && (
                <button
                  type="button"
                  className="game-action primary"
                  disabled={reopen.active}
                  onClick={handlers.reopen}
                >
                  <RotateCcw size={16} aria-hidden="true" />
                  {labels.gameReopen}
                </button>
              )}
            </div>
            {reopen.available && (
              <p className="game-status" data-tone="warning" role="status">
                {labels.gameActionsPaused}
              </p>
            )}
            {syncing && (
              <p className="game-status" data-tone="progress" role="status">
                {labels.gameSyncing}
              </p>
            )}
            {lifecycle.activation.active && (
              <p className="game-status" data-tone="progress" role="status">
                {labels.gameActivationInProgress}
              </p>
            )}
            {lifecycle.activation.failed && (
              <p className="game-status" data-tone="danger" role="status">
                {labels.gameActivationFailed}
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
              lifecycle.setup.failed && (
                <p className="game-status" data-tone="danger" role="status">
                  {labels.gameSetupFailed}
                </p>
              )
            )}
            {lifecycle.launch.notStaged ? (
              <p className="game-status" data-tone="info" role="status">
                {labels.gameActivationRequired}
              </p>
            ) : (
              lifecycle.launch.failed && (
                <p className="game-status" data-tone="warning" role="status">
                  {labels.gameLaunchFailed}
                </p>
              )
            )}
            {reopen.active && (
              <p className="game-status" data-tone="progress" role="status">
                {labels.gameReopenInProgress}
              </p>
            )}
            {reopen.failed && (
              <p className="game-status" data-tone="danger" role="status">
                {labels.gameReopenFailed}
              </p>
            )}
            {reopen.unavailable && (
              <p className="game-status" data-tone="warning" role="status">
                {labels.gameReopenUnavailable}
              </p>
            )}
          </PanelGroup>

          {/* What is running now, and the controls that settle it. Offering zero
              of these on a projection that admits none leaves the group as the
              two facts alone. */}
          <PanelGroup id="game-group-session" title={labels.gameGroupSession}>
            <dl className="game-facts">
              <GameFact label={labels.gameFactExecution}>
                {authorityLabel(labels, game.game.actionAuthority)}
              </GameFact>
              <GameFact label={labels.gameFactOutcome}>
                {outcomeLabel(labels, game.game.latestOutcome)}
              </GameFact>
            </dl>
            <div className="game-actions">
              {session.stop.available && (
                <button type="button" className="game-action" disabled={session.stop.active} onClick={handlers.stop}>
                  <Square size={16} aria-hidden="true" />
                  {labels.gameStop}
                </button>
              )}
              {session.disconnect.available && (
                <button
                  type="button"
                  className="game-action"
                  disabled={session.disconnect.active}
                  onClick={handlers.disconnect}
                >
                  <Unplug size={16} aria-hidden="true" />
                  {labels.gameDisconnect}
                </button>
              )}
            </div>
            {session.stop.failed && (
              <p className="game-status" data-tone="warning" role="status">
                {labels.gameStopFailed}
              </p>
            )}
            {session.disconnect.failed && (
              <p className="game-status" data-tone="danger" role="status">
                {labels.gameDisconnectFailed}
              </p>
            )}
          </PanelGroup>

          {/* Recovery. `resume.available` and `resume.failureSurface` are
              mutually exclusive (the shell applies that rule), so this group
              offers the connection-restore action exactly once under exactly one
              honest name: `Resume game` before an attempt has failed, and the
              failure rollup `Retry`/`Cancel`/`Start new game` after one has
              (design/26 §4.1, design/104 §7). */}
          {(resume.available || resume.failureSurface) && (
            <PanelGroup id="game-group-recovery" title={labels.gameGroupRecovery}>
              <div className="game-actions">
                {resume.available && (
                  <button
                    type="button"
                    className="game-action primary"
                    disabled={resume.active}
                    onClick={handlers.resume}
                  >
                    <Plug size={16} aria-hidden="true" />
                    {labels.gameResume}
                  </button>
                )}
                {resume.failureSurface && (
                  <>
                    <button
                      type="button"
                      className="game-action primary"
                      disabled={resume.active}
                      onClick={handlers.resume}
                    >
                      <RefreshCw size={16} aria-hidden="true" />
                      {labels.gameRetry}
                    </button>
                    <button
                      type="button"
                      className="game-action"
                      disabled={resume.cancelActive}
                      onClick={handlers.resumeCancel}
                    >
                      <X size={16} aria-hidden="true" />
                      {labels.gameResumeCancel}
                    </button>
                    <button
                      type="button"
                      className="game-action"
                      disabled={create.active}
                      onClick={handlers.toggleCreateForm}
                    >
                      <Plus size={16} aria-hidden="true" />
                      {labels.gameCreate}
                    </button>
                  </>
                )}
              </div>
              {resume.active && (
                <p className="game-status" data-tone="progress" role="status">
                  {labels.gameResumeInProgress}
                </p>
              )}
              {resume.failed && (
                <p className="game-status" data-tone="danger" role="status">
                  {labels.gameResumeFailed}
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
              {resume.cancelFailed && (
                <p className="game-status" data-tone="danger" role="status">
                  {labels.gameResumeCancelFailed}
                </p>
              )}
            </PanelGroup>
          )}

          {create.formOpen && (
            <form
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
              {create.failed && (
                <p className="game-status" data-tone="danger" role="status">
                  {labels.gameCreateFailed}
                </p>
              )}
              {create.unavailable && (
                <p className="game-status" data-tone="warning" role="status">
                  {labels.gameCreateUnavailable}
                </p>
              )}
            </form>
          )}

          <CabinHandoff state={cabin} labels={labels} onConfirm={handlers.confirmCabin} />
        </>
      )}
    </section>
  );
}

/**
 * The typed connection/surface facts, the published capability summary and the
 * current execution included (design/26 §4.2). Each row is one label plus its
 * value, with the value's own status dot as decoration inside the value.
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
      <GameFact label={labels.gameFactCompatibility}>
        {compatibilityLabel(labels, projection.compatibility)}
      </GameFact>
      <GameFact label={labels.gameFactCapabilities}>
        {capabilitiesLabel(labels, projection.capabilitySummary)}
      </GameFact>
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
 */
function CabinHandoff({
  state,
  labels,
  onConfirm,
}: {
  state: CabinViewState;
  labels: Messages;
  onConfirm(choice: StardewCabinChoiceV1): void;
}) {
  return (
    <section className="stardew-cabin-handoff game-subpanel" aria-label={labels.stardewCabinSelection}>
      <h4 className="section-subtitle">{labels.stardewCabinSelection}</h4>
      {state.kind === "loading" && <p className="game-subpanel-note">{labels.stardewCabinsLoading}</p>}
      {state.kind === "unavailable" && (
        <p className="game-status" data-tone="warning" role="status">
          {labels.stardewCabinsUnavailable}
        </p>
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
      {(state.kind === "choices" || state.kind === "confirming") &&
        (state.choices.length === 0 ? (
          <p className="game-subpanel-note">{labels.stardewCabinsEmpty}</p>
        ) : (
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
        ))}
    </section>
  );
}
