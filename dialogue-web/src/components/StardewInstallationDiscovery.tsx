import { useEffect, useRef, useState } from "react";
import type {
  StardewInstallationCandidateV1,
  StardewInstallationDiscoveryV1,
  ComposedReferenceGameBrowserApi,
} from "../composed-reference-game-browser-api";
import { observedProblemCode } from "../composed-problem-view";
import {
  installationCandidateLabel,
  installationDiscoveryFailureState,
  installationDiscoveryState,
  installationHintLabel,
  installationSourceLabel,
  installationStateLabel,
  type InstallationDiscoveryState,
} from "../game-presentation";
import type { Messages } from "../i18n";

type Props = {
  api: Pick<
    ComposedReferenceGameBrowserApi,
    | "readStardewInstallationDiscovery"
    | "confirmStardewInstallation"
    | "retryStardewInstallationDiscovery"
    | "cancelStardewInstallationDiscovery"
    | "openStardewInstallationPicker"
  >;
  labels: Messages;
};

/**
 * Installation discovery.
 *
 * The read behind this panel is a *scan* rather than a projection: the Host runs
 * the discovery provider on `discovery_read`, so every mount starts one, and a
 * scan on a cold machine is the slowest thing the surface does. The panel's own
 * rules follow from that:
 *
 *  - **One sentence per moment.** The panel's status line is exactly one of the
 *    typed states, so the surface never reads "still searching" and "nothing
 *    found" at once: searching while a scan is outstanding, the answer once it
 *    settles, and nothing else in between.
 *  - **The answer decides the sentence, not the candidate count.** The Host's
 *    reply carries the diagnostics its own scan produced, and an empty scan only
 *    means "nothing was found" when none of them names a source it could not read
 *    (`game-presentation.ts`). Deriving the sentence from `candidates.length`
 *    alone told a player whose game IS installed that no installation exists.
 *  - **A selection refusal is not a search failure.** Confirming a candidate and
 *    choosing a folder both end in the Host's registration. A refusal that names
 *    its own cause (`mod_loader_missing`) is rendered as that cause, because
 *    "the search failed" is a statement about a search that had just found the
 *    player's game.
 *  - **A confirmation is an outcome.** Confirming a candidate and choosing a folder
 *    both end in the Host's registration, and the scan that follows a registration
 *    finds nothing left to offer. The panel states that outcome itself, so a
 *    successful confirmation never reads as the empty scan it causes.
 *  - **A scan that does not settle must not lock the panel.** The controls that
 *    *start* work are off while work is outstanding, but the one that abandons it
 *    is not, and abandoning it retires the read it interrupts - otherwise a slow
 *    or stuck scan leaves the surface asserting a search the player cannot stop,
 *    and a late answer can contradict the cancel they already made.
 *  - **A player who cannot confirm is still not stuck.** The folder picker reaches
 *    the same admission as a candidate does, so it is offered in every state rather
 *    than only the retryable ones. A candidate this panel will not confirm is what
 *    used to leave a player with a found installation and no way to accept it.
 */

/**
 * Which candidates the panel offers to confirm.
 *
 * The wire vocabulary is `candidate | invalid | admission_required`
 * (`host/src/game-browser-contract/index.ts`, `GameCandidateV1Schema`). The Host's
 * discovery session stamps every installation it found `admission_required`
 * (`windows-stardew-installation-discovery/internal.ts`, `StardewDiscoverySession.issue`):
 * the candidate awaits exactly the admission this panel's confirm performs, so
 * `admission_required` IS the confirmable status - reading the literal `"candidate"`
 * as the confirmable one refused every candidate a real machine reports. Only
 * `invalid` names one the Host has already rejected.
 */
const isConfirmableCandidate = (status: StardewInstallationCandidateV1["status"]): boolean =>
  status === "candidate" || status === "admission_required";
export function StardewInstallationDiscovery({ api, labels }: Props) {
  const [state, setState] = useState<InstallationDiscoveryState>("loading");
  const [discovery, setDiscovery] = useState<StardewInstallationDiscoveryV1 | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  // `busy` guards re-entrant reads/actions AND drives the rendered disabled
  // state; a ref would not re-render the buttons that must become disabled.
  const [busy, setBusy] = useState(false);
  const refreshEpoch = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const read = async (internal = false) => {
    if (busy && !internal) return;
    const epoch = ++refreshEpoch.current;
    if (!internal) setBusy(true);
    setState("loading");
    try {
      const result = await api.readStardewInstallationDiscovery();
      if (!mounted.current || epoch !== refreshEpoch.current) return;
      setDiscovery(result);
      setSelectedCandidateId(null);
      setState(installationDiscoveryState(result.candidates.length, result.diagnostics));
    } catch (error) {
      if (!mounted.current || epoch !== refreshEpoch.current) return;
      setState(installationDiscoveryFailureState(observedProblemCode(error)));
    } finally {
      if (!internal) setBusy(false);
    }
  };
  useEffect(() => {
    void read();
  }, []);
  const action = async (kind: "confirm" | "retry" | "cancel" | "picker", candidateId?: string) => {
    // The one control that stays reachable while a read is outstanding: it is what
    // turns a scan that does not settle into an answer the player can act on. It
    // retires the read it interrupts, so that read cannot answer over the cancel.
    if (kind === "cancel") {
      refreshEpoch.current += 1;
      setBusy(true);
      try {
        await api.cancelStardewInstallationDiscovery();
        if (mounted.current) setState("cancelled");
      } catch (error) {
        if (mounted.current) setState(installationDiscoveryFailureState(observedProblemCode(error)));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (busy) return;
    setBusy(true);
    setState(kind === "confirm" ? "confirming" : kind === "retry" ? "retrying" : state);
    try {
      const result =
        kind === "confirm"
          ? await api.confirmStardewInstallation(candidateId!)
          : kind === "retry"
            ? await api.retryStardewInstallationDiscovery()
            : await api.openStardewInstallationPicker();
      if (!mounted.current) return;
      // A selection refusal that names its own cause is a state, not a search
      // failure: the search found the player's game, and what is missing is the
      // mod loader. Both controls that lead here - confirm and the folder picker -
      // report it, so a vanilla install never renders as `source-unavailable` or
      // `error`.
      if ("status" in result && result.status === "mod_loader_missing") {
        setState("mod-loader-missing");
        return;
      }
      if (
        kind === "confirm" &&
        "status" in result &&
        (result.status === "registered" || result.status === "accepted")
      ) {
        // The registration is the answer, and the scan that follows it has nothing
        // left to offer - so the outcome is stated after the refresh rather than
        // letting an empty scan stand in for it ("no installation was found" after
        // the player's installation had just been accepted).
        await read(true);
        if (mounted.current) setState("confirmed");
        return;
      }
      if (kind === "picker" && "status" in result) {
        if (result.status === "accepted" || result.status === "registered") {
          await read(true);
          if (mounted.current) setState("confirmed");
          return;
        }
        if (result.status === "unavailable") {
          setState("source-unavailable");
          return;
        }
      }
      if (kind === "retry" && "candidates" in result) {
        setDiscovery(result);
        setState(installationDiscoveryState(result.candidates.length, result.diagnostics));
        return;
      }
      setState("error");
    } catch (error) {
      if (mounted.current) setState(installationDiscoveryFailureState(observedProblemCode(error)));
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || state === "loading" || state === "confirming" || state === "retrying";
  // A confirmation is a Host operation with no cancel of its own, so it is the
  // one state in which abandoning the panel is not offered.
  const cancelDisabled = state === "confirming";
  return (
    <section
      className="game-installation-panel"
      aria-label={labels.gameInstallationAria}
      data-state={state}
      // The panel scrolls when a machine reports many candidates; a scrollable
      // region that cannot take focus is unreachable for a keyboard player
      // (axe: scrollable-region-focusable).
      tabIndex={0}
    >
      <h4 className="section-subtitle">{labels.gameInstallationTitle}</h4>
      {/* `data-state` above stays the typed state the tests assert; the sentence
          a player reads is always the localized outcome (design/104 §10). */}
      <p className="installation-state" role="status">
        {installationStateLabel(labels, state)}
      </p>
      {discovery !== null && discovery.candidates.length > 0 && (
        <ul className="installation-candidates">
          {discovery.candidates.map(({ candidateId, label, source, hint, location, status }) => (
            <li className="installation-candidate" key={candidateId} data-label={label} data-location={location}>
              {/* The row's words are the product's: the game's own name from the
                  catalogue (the Host's English `label` used to be the last English
                  text in a Chinese row) and, when the Host publishes one, where this
                  installation is (`D: · SteamLibrary`) - the fact that tells two
                  installations of the same game apart. Both wire facts stay as the
                  row's own attribution (`data-label`/`data-location`). */}
              <span className="installation-candidate-label">{installationCandidateLabel(labels, location)}</span>
              {/* The wire member stays as the row's own attribution (`data-source`),
                  and the words beside the name are the player's language: a source
                  the panel has no sentence for reads as "found on this computer"
                  rather than as the member the Host minted. */}
              <span className="installation-source" data-source={source}>
                {installationSourceLabel(labels, source)}
              </span>
              {hint !== null && <small className="installation-hint">{installationHintLabel(labels, hint)}</small>}
              <button
                type="button"
                className="game-action"
                disabled={disabled || !isConfirmableCandidate(status)}
                onClick={() => {
                  setSelectedCandidateId(candidateId);
                  void action("confirm", candidateId);
                }}
              >
                {labels.gameInstallationConfirm}
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedCandidateId !== null && state === "confirming" && (
        <p className="installation-state" role="status">
          {labels.gameInstallationConfirming}
        </p>
      )}
      <div className="game-actions">
        <button type="button" className="game-action" disabled={disabled} onClick={() => void action("picker")}>
          {labels.gameInstallationChooseFolder}
        </button>
        <button type="button" className="game-action" disabled={disabled} onClick={() => void action("retry")}>
          {labels.gameInstallationFindAgain}
        </button>
        <button type="button" className="game-action" disabled={cancelDisabled} onClick={() => void action("cancel")}>
          {labels.gameResumeCancel}
        </button>
      </div>
    </section>
  );
}
