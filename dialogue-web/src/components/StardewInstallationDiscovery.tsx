import { useEffect, useRef, useState } from "react";
import type {
  StardewInstallationDiscoveryV1,
  ComposedReferenceGameBrowserApi,
} from "../composed-reference-game-browser-api";
import { observedProblemCode } from "../composed-problem-view";
import {
  installationDiscoveryFailureState,
  installationDiscoveryState,
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
 * scan on a cold machine is the slowest thing the surface does. Two rules follow
 * from that, and both are the panel's own:
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
 *  - **A scan that does not settle must not lock the panel.** The controls that
 *    *start* work are off while work is outstanding, but the one that abandons it
 *    is not, and abandoning it retires the read it interrupts - otherwise a slow
 *    or stuck scan leaves the surface asserting a search the player cannot stop,
 *    and a late answer can contradict the cancel they already made.
 */
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
      if (
        kind === "confirm" &&
        "status" in result &&
        (result.status === "registered" || result.status === "accepted")
      ) {
        await read(true);
        return;
      }
      if (kind === "picker" && "status" in result) {
        if (result.status === "accepted" || result.status === "registered") {
          await read(true);
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
  const retryable =
    state === "no-candidates" ||
    state === "source-unavailable" ||
    state === "result-unavailable" ||
    state === "error" ||
    state === "expired";
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
          {discovery.candidates.map(({ candidateId, label, source, hint, status }) => (
            <li className="installation-candidate" key={candidateId}>
              <span className="installation-candidate-label">{label}</span>
              <span className="installation-source">{source}</span>
              {hint && <small className="installation-hint">{hint}</small>}
              <button
                type="button"
                className="game-action"
                disabled={disabled || status !== "candidate"}
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
        {retryable && (
          <button type="button" className="game-action" disabled={disabled} onClick={() => void action("picker")}>
            {labels.gameInstallationChooseFolder}
          </button>
        )}
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
