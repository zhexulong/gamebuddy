import { useEffect, useRef, useState } from "react";
import type {
  StardewInstallationDiscoveryV1,
  ComposedReferenceGameBrowserApi,
} from "../composed-reference-game-browser-api";

export type InstallationDiscoveryState =
  | "not_configured"
  | "loading"
  | "candidates"
  | "confirming"
  | "retrying"
  | "cancelled"
  | "source-unavailable"
  | "no-candidates"
  | "expired"
  | "error";
type Props = {
  api: Pick<
    ComposedReferenceGameBrowserApi,
    | "readStardewInstallationDiscovery"
    | "confirmStardewInstallation"
    | "retryStardewInstallationDiscovery"
    | "cancelStardewInstallationDiscovery"
    | "openStardewInstallationPicker"
  >;
};

export function StardewInstallationDiscovery({ api }: Props) {
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
      setState(result.candidates.length ? "candidates" : "no-candidates");
    } catch (error) {
      if (!mounted.current || epoch !== refreshEpoch.current) return;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      setState(code === "game_unavailable" || code === "source_unavailable" ? "source-unavailable" : "error");
    } finally {
      if (!internal) setBusy(false);
    }
  };
  useEffect(() => {
    void read();
  }, []);
  const action = async (kind: "confirm" | "retry" | "cancel" | "picker", candidateId?: string) => {
    if (busy) return;
    setBusy(true);
    setState(kind === "confirm" ? "confirming" : kind === "retry" ? "retrying" : state);
    try {
      const result =
        kind === "confirm"
          ? await api.confirmStardewInstallation(candidateId!)
          : kind === "retry"
            ? await api.retryStardewInstallationDiscovery()
            : kind === "cancel"
              ? await api.cancelStardewInstallationDiscovery()
              : await api.openStardewInstallationPicker();
      if (!mounted.current) return;
      if (kind === "cancel") {
        setState("cancelled");
        return;
      }
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
        setState(result.candidates.length ? "candidates" : "no-candidates");
        return;
      }
      setState("error");
    } catch (error) {
      if (mounted.current) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        setState(code === "game_unavailable" || code === "source_unavailable" ? "source-unavailable" : "error");
      }
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || state === "loading" || state === "confirming" || state === "retrying";
  const retryable =
    state === "no-candidates" || state === "source-unavailable" || state === "error" || state === "expired";
  return (
    <section
      className="game-installation-panel"
      aria-label="Game installation setup"
      data-state={state}
      // The panel scrolls when a machine reports many candidates; a scrollable
      // region that cannot take focus is unreachable for a keyboard player
      // (axe: scrollable-region-focusable).
      tabIndex={0}
    >
      <h3 className="section-subtitle">Game installation</h3>
      <p className="installation-state" role="status">
        {state}
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
                Confirm
              </button>
            </li>
          ))}
        </ul>
      )}
      {selectedCandidateId !== null && state === "confirming" && (
        <p className="installation-state" role="status">
          Confirming installation
        </p>
      )}
      <div className="game-actions">
        {retryable && (
          <button type="button" className="game-action" disabled={disabled} onClick={() => void action("picker")}>
            Choose manually
          </button>
        )}
        <button type="button" className="game-action" disabled={disabled} onClick={() => void action("retry")}>
          Retry
        </button>
        <button type="button" className="game-action" disabled={disabled} onClick={() => void action("cancel")}>
          Cancel
        </button>
      </div>
    </section>
  );
}
