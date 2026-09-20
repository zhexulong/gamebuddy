import { useEffect, useRef, useState } from "react";
import type { StardewInstallationCandidateV1, StardewInstallationDiscoveryV1, ComposedReferenceGameBrowserApi } from "../composed-reference-game-browser-api";

export type InstallationDiscoveryState = "not_configured" | "loading" | "candidates" | "confirming" | "retrying" | "cancelled" | "source-unavailable" | "no-candidates" | "expired" | "error";
type Props = { api: Pick<ComposedReferenceGameBrowserApi, "readStardewInstallationDiscovery" | "confirmStardewInstallation" | "retryStardewInstallationDiscovery" | "cancelStardewInstallationDiscovery" | "openStardewInstallationPicker"> };

export function StardewInstallationDiscovery({ api }: Props) {
  const [state, setState] = useState<InstallationDiscoveryState>("loading");
  const [discovery, setDiscovery] = useState<StardewInstallationDiscoveryV1 | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const busy = useRef(false);
  const refreshEpoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const read = async (internal = false) => {
    if (busy.current && !internal) return;
    const epoch = ++refreshEpoch.current;
    if (!internal) busy.current = true;
    setState("loading");
    try { const result = await api.readStardewInstallationDiscovery(); if (!mounted.current || epoch !== refreshEpoch.current) return; setDiscovery(result); setSelectedCandidateId(null); setState(result.candidates.length ? "candidates" : "no-candidates"); }
    catch (error) { if (!mounted.current || epoch !== refreshEpoch.current) return; const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""; setState(code === "game_unavailable" || code === "source_unavailable" ? "source-unavailable" : "error"); }
    finally { if (!internal) busy.current = false; }
  };
  useEffect(() => { void read(); }, []);
  const action = async (kind: "confirm" | "retry" | "cancel" | "picker", candidateId?: string) => {
    if (busy.current) return; busy.current = true; setState(kind === "confirm" ? "confirming" : kind === "retry" ? "retrying" : state);
    try {
      const result = kind === "confirm" ? await api.confirmStardewInstallation(candidateId!) : kind === "retry" ? await api.retryStardewInstallationDiscovery() : kind === "cancel" ? await api.cancelStardewInstallationDiscovery() : await api.openStardewInstallationPicker();
      if (!mounted.current) return;
      if (kind === "cancel") { setState("cancelled"); return; }
      if (kind === "confirm" && "status" in result && (result.status === "registered" || result.status === "accepted")) { await read(true); return; }
      if (kind === "picker" && "status" in result) { if (result.status === "accepted" || result.status === "registered") { await read(true); return; } if (result.status === "unavailable") { setState("source-unavailable"); return; } }
      if (kind === "retry" && "candidates" in result) { setDiscovery(result); setState(result.candidates.length ? "candidates" : "no-candidates"); return; }
      setState("error");
    } catch (error) { if (mounted.current) { const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""; setState(code === "game_unavailable" || code === "source_unavailable" ? "source-unavailable" : "error"); } }
    finally { busy.current = false; }
  };
  const disabled = busy.current || state === "loading" || state === "confirming" || state === "retrying";
  return <section aria-label="Game installation setup" data-state={state}>
    <h3>Game installation</h3><p role="status">{state}</p>
    {discovery?.candidates.map(({ candidateId, label, source, hint, status }) => <div key={candidateId}><strong>{label}</strong><span>{source}</span>{hint && <small>{hint}</small>}<button disabled={disabled || status !== "candidate"} onClick={() => { setSelectedCandidateId(candidateId); void action("confirm", candidateId); }}>Confirm</button></div>)}
    {selectedCandidateId !== null && state === "confirming" && <p role="status">Confirming installation</p>}
    {(state === "no-candidates" || state === "source-unavailable" || state === "error" || state === "expired") && <button disabled={disabled} onClick={() => void action("picker")}>Choose manually</button>}
    <button disabled={disabled} onClick={() => void action("retry")}>Retry</button><button disabled={disabled} onClick={() => void action("cancel")}>Cancel</button>
  </section>;
}
