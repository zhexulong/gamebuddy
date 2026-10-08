import {
  Check,
  Gamepad2,
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
import type { Messages } from "../i18n";

/**
 * The Game panel: one presentation component for every state the composed Game
 * surface models, so the shell owns behaviour and this owns reading order.
 *
 * Reading order is deliberate and identical in every state: the panel title,
 * the connection facts, then one group per intent - first run, reconnect, the
 * session itself, recovery - each group rendered as its controls followed by
 * the feedback those controls produce. A player reads "what is true, what can I
 * do, what happened when I did it" top to bottom instead of walking a flat list
 * of buttons, and the button they just pressed never moves out from under the
 * pointer when its own feedback appears (design/26 §6.4: interaction feedback
 * must not shift surrounding layout).
 *
 * Presentation contract (frozen by
 * `tests/composed-reference-game-browser.spec.ts` and
 * `design/architecture/frontend-slot-and-theme-decoupling.md` §5.3):
 * - the panel is the `role="region"` named by `labels.gameState`, and carries
 *   `data-testid="game-state-panel"` + `data-game-state="available" | "null"`;
 * - the cabin confirm button keeps `aria-label={labels.stardewCabinConfirm}` and
 *   the cabin list keeps `data-testid="cabin-choice-list"`;
 * - every fact row keeps its `dt`/`dd` text adjacency (the spec asserts
 *   `Connectionnone`, `Compatibilityunchecked`, `InstanceStardew Valley` by
 *   text, so nothing may be inserted between a label and its value);
 * - every control keeps the exact accessible name it had, and every status
 *   sentence is still the `role="status"` line it was.
 *
 * No new user-visible copy is introduced: the panel's own vocabulary
 * ("Game", the fact labels) is the same literal set the surface already
 * published, and every other string comes from the `Messages` catalog.
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
    // The panel scrolls once the projection is longer than the space left
    // between the transcript and the composer, so the conversation above it
    // keeps priority. A scrollable region that cannot take focus is unreachable
    // for a keyboard-only player (axe: scrollable-region-focusable, serious);
    // the region's own accessible name announces where focus landed.
    <section
      className="composed-game-drawer"
      role="region"
      aria-label={labels.gameState}
      data-testid="game-state-panel"
      data-game-state={game === null ? "null" : "available"}
      tabIndex={0}
    >
      <div className="game-panel-header">
        <span className="game-panel-mark" aria-hidden="true">
          <Gamepad2 size={14} aria-hidden="true" />
        </span>
        <h2>Game</h2>
      </div>

      {game === null ? (
        <p className="game-panel-empty">Game state is unavailable for this profile.</p>
      ) : (
        <ConnectionFacts game={game} />
      )}

      {/* First run, then the one action that starts play. The two first-run
          paths are offered at equal weight because the projection gives neither
          precedence over the other. */}
      <div className="game-actions">
        {lifecycle.activation.available && (
          <button
            type="button"
            className="game-action"
            disabled={lifecycle.activation.active}
            aria-label={labels.gameActivation}
            onClick={handlers.activate}
          >
            <Power size={16} aria-hidden="true" />
            {labels.gameActivation}
          </button>
        )}
        {lifecycle.setup.available && (
          <button type="button" className="game-action" disabled={lifecycle.setup.active} onClick={handlers.setup}>
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
      </div>
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

      {/* The action that moves a degraded projection forward again, and the one
          that reopens paused action authority. */}
      <div className="game-actions">
        {resume.available && (
          <button type="button" className="game-action primary" disabled={resume.active} onClick={handlers.resume}>
            <Plug size={16} aria-hidden="true" />
            {labels.gameResume}
          </button>
        )}
        {reopen.available && (
          <button type="button" className="game-action primary" disabled={reopen.active} onClick={handlers.reopen}>
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

      {/* Session controls: offered only by the projections that admit them. */}
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

      {/* Recovery, only on the exact resume-failure surface. */}
      {resume.failureSurface && (
        <>
          <div className="game-actions resume-failure-actions">
            <button type="button" className="game-action primary" disabled={resume.active} onClick={handlers.resume}>
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
            <button type="button" className="game-action" disabled={create.active} onClick={handlers.toggleCreateForm}>
              <Plus size={16} aria-hidden="true" />
              {labels.gameCreate}
            </button>
          </div>
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
        </>
      )}

      {create.formOpen && (
        <form
          className="game-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            handlers.create();
          }}
        >
          <h3>{labels.gameCreateFormTitle}</h3>
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
    </section>
  );
}

/**
 * The typed connection/surface facts, their capability summary included. Each
 * row is one label plus its value, with the value's own status dot as
 * decoration inside the value.
 */
function ConnectionFacts({ game }: { game: GameBrowserStateV1 }) {
  const projection = game.game;
  return (
    <dl className="game-facts">
      <GameFact label="Connection" dotTone={connectionDotTone(projection.connectionStatus)}>
        {projection.connectionStatus}
      </GameFact>
      <GameFact label="Instance">{projection.instance.gameTitle ?? projection.instance.status}</GameFact>
      <GameFact label="World">{projection.selectedWorld ?? "—"}</GameFact>
      <GameFact label="Save">{projection.selectedSave ?? "—"}</GameFact>
      <GameFact label="Compatibility">{projection.compatibility.message ?? projection.compatibility.status}</GameFact>
      <GameFact label="Capabilities">
        {projection.capabilitySummary.available ? projection.capabilitySummary.count : "unavailable"}
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
      <h3 className="section-subtitle">{labels.stardewCabinSelection}</h3>
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
