import { useEffect, useRef, useState } from "react";
import type {
  StardewInstallationCandidateV1,
  StardewInstallationDiscoveryV1,
  ComposedReferenceGameBrowserApi,
  StardewInstallationMutationV1,
} from "../composed-reference-game-browser-api";
import { observedProblemCode } from "../composed-problem-view";
import {
  companionModLabel,
  installationCandidateLabel,
  installationModLoaderLabel,
  installationDiscoveryFailureState,
  installationDiscoveryState,
  installationHintLabel,
  installationSourceLabel,
  installationStateLabel,
  type InstallationDiscoveryState,
  orderCandidatesByReadiness,
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
  /**
   * Called once an installation is admitted. The panel owns the admission; the surface above it owns the guide that says
   * what to do next, and that guide reads the Host's `prerequisites` - which only changes after this. Without the
   * callback the panel said "confirmed" while the step above it still asked the player to choose a folder, and the only
   * way out was a full reload.
   */
  onAdmitted?: () => void;
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
 *    than only the retryable ones - and a scan does not gate it either. A player who
 *    already knows where their game is must not wait out a search they did not ask
 *    for; the picker only stands down while another *action* (a confirmation, a retry,
 *    another picker) is outstanding, because two admissions must not run at once. A
 *    candidate this panel will not confirm is what used to leave a player with a found
 *    installation and no way to accept it.
 *  - **A wait the panel cannot see is stated as the wait it is.** The folder picker's
 *    dialog may open behind the browser, and the Host publishes no fact while it is up
 *    (`host/src/windows-stardew-folder-picker/index.ts:198-213` - the helper writes
 *    nothing to stdout until it closes), so the panel knows only that its own request is
 *    outstanding. That is what it says: what it is waiting for, and where to look. It
 *    does not say a window is open, which it cannot know; the sentence ends when the
 *    request settles, because that is the moment the dialog is gone.
 */

/**
 * What the panel is waiting on, and therefore what it gates.
 *
 * A *scan* blocks the controls that start another scan or a confirmation. An *action* -
 * every Host mutation this panel performs - blocks every control, because two admissions
 * must never be in flight together. The distinction is the whole point of the picker's
 * rule above: `busy` alone could not tell a scan apart from a confirmation, so a scan
 * gated the one control a player may need most.
 *
 * `picker` is an action of its own because it is the only one whose wait is invisible: the
 * folder dialog can be on screen for minutes, and a scan settling behind it used to clear
 * the pending flag and invite a second dialog over the first.
 */
type Pending = "none" | "scan" | "action" | "picker";

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

/**
 * Where a player gets the mod loader.
 *
 * SMAPI is Pathoschild's own project and is published at smapi.io; the companion Mod runs under it, the product
 * does not ship it, and it is not the Host's to install. So the panel points at the distribution its author
 * publishes and stops there. The surface is a page served over a loopback listener and rendered in a real
 * browser, so an ordinary link IS the mechanism: the browser performs the navigation and no Host seam, contract
 * operation or child process is involved.
 */
const SMAPI_DOWNLOAD_URL = "https://smapi.io";
/**
 * What the registration said about the companion Mod.
 *
 * `not-reported` is the third fact, and the reason this is not simply an optional outcome. A reply that does not
 * mention the Mod may not be rendered as a deployment that worked, and that is the state the shipped wire
 * produces today: `GameDiscoveryMutationResultV1Schema` declares no `companionMod`
 * (`host/src/game-browser-contract/index.ts:322`), so `projectDiscoveryMutationResult`
 * (`host/src/games/stardew/provider.ts:94`) answers `registered` and says nothing about the Mod.
 */
type CompanionModReport = NonNullable<StardewInstallationMutationV1["companionMod"]> | "not-reported";

export function StardewInstallationDiscovery({ api, labels, onAdmitted }: Props) {
  const [state, setState] = useState<InstallationDiscoveryState>("loading");
  /**
   * What happened to the companion Mod in the folder that was just registered, or `null` before one was.
   *
   * The Mod is this product's own, so it is deployed by the Host the moment a folder is registered - the
   * first instant that folder provably holds a mod loader. Reported rather than assumed: a deployment that
   * refused names its refusal instead of the panel implying the companion is ready.
   */
  const [companionMod, setCompanionMod] = useState<CompanionModReport | null>(null);
  const [discovery, setDiscovery] = useState<StardewInstallationDiscoveryV1 | null>(null);
  // What is outstanding, which gates the rendered controls; a ref would not re-render
  // the buttons that must become disabled.
  const [pending, setPending] = useState<Pending>("none");
  /**
   * A registration is the only reply that can report the Mod, so it is the only place the outcome is recorded -
   * and a registration that says nothing about it is recorded as `not-reported` rather than left at the `null`
   * that means "nothing has been registered yet".
   */
  const recordCompanionMod = (result: StardewInstallationMutationV1) =>
    setCompanionMod(result.companionMod ?? "not-reported");
  const busy = pending !== "none";
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
    if (!internal) setPending("scan");
    setState("loading");
    try {
      const result = await api.readStardewInstallationDiscovery();
      if (!mounted.current || epoch !== refreshEpoch.current) return;
      setDiscovery(result);
      setState(installationDiscoveryState(result.candidates.length, result.diagnostics));
    } catch (error) {
      if (!mounted.current || epoch !== refreshEpoch.current) return;
      setState(installationDiscoveryFailureState(observedProblemCode(error)));
    } finally {
      // A read the panel has already retired (by a cancel, or by a picker outcome) must
      // not clear the work that replaced it - and a scan settling behind an open folder
      // dialog must not clear the dialog's own wait, which is what re-enabled the picker
      // button over a window the player had not closed yet.
      if (!internal && epoch === refreshEpoch.current)
        setPending((current) => (current === "picker" ? current : "none"));
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
      // Abandoning the scan is not abandoning the dialog: a picker still outstanding keeps
      // its own wait, or the panel would go back to saying nothing about a window it knows
      // is still up.
      setPending((current) => (current === "picker" ? current : "action"));
      try {
        await api.cancelStardewInstallationDiscovery();
        if (mounted.current) setState("cancelled");
      } catch (error) {
        if (mounted.current) setState(installationDiscoveryFailureState(observedProblemCode(error)));
      } finally {
        setPending((current) => (current === "picker" ? current : "none"));
      }
      return;
    }
    // A scan gates the controls that start another scan or a confirmation. It never gates
    // the folder picker (see the header): that is the other route to the same admission,
    // and the player may already know where their game is. A picker already outstanding
    // does gate it, and so does any other action.
    if (kind === "picker" ? pending === "action" || pending === "picker" : busy) return;
    setPending(kind === "picker" ? "picker" : "action");
    setState(kind === "confirm" ? "confirming" : kind === "retry" ? "retrying" : state);
    try {
      const result =
        kind === "confirm"
          ? await api.confirmStardewInstallation(candidateId!)
          : kind === "retry"
            ? await api.retryStardewInstallationDiscovery()
            : await api.openStardewInstallationPicker();
      if (!mounted.current) return;
      // A settled answer retires a scan still in flight, so that scan cannot answer over
      // what the player just did. A dismissed folder dialog is not an answer: the scan it
      // was shown beside keeps running.
      if ("status" in result && result.status !== "cancelled") refreshEpoch.current += 1;
      // A selection refusal that names its own cause is a state, not a search
      // failure: the search found the player's game, and what is missing is the
      // mod loader. Both controls that lead here - confirm and the folder picker -
      // report it, so a vanilla install never renders as `source-unavailable` or
      // `error`.
      if ("status" in result && result.status === "mod_loader_missing") {
        setState("mod-loader-missing");
        return;
      }
      // The other refusal a player can fix, and for the same reason its own state: the
      // folder holds no Stardew Valley, so there is nothing there to register.
      if ("status" in result && result.status === "not_stardew_installation") {
        setState("not-stardew-installation");
        return;
      }
      // The third, and the one about the path: the folder reaches the game through a
      // shortcut, a junction or a virtual folder, so the fix is to pick the game's real
      // installation folder. Both controls that lead here report it.
      if ("status" in result && result.status === "reparse_point") {
        setState("reparse-point");
        return;
      }
      // A registration that named no cause stays unnamed. `source-unavailable` is
      // reserved for a source the scan could not read, and this was not a scan.
      if ("status" in result && result.status === "unavailable") {
        setState("selection-unavailable");
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
        recordCompanionMod(result);
        await read(true);
        if (mounted.current) setState("confirmed");
        onAdmitted?.();
        return;
      }
      if (kind === "picker" && "status" in result) {
        if (result.status === "accepted" || result.status === "registered") {
          recordCompanionMod(result);
          await read(true);
          if (mounted.current) setState("confirmed");
          onAdmitted?.();
          return;
        }
      }
      if (kind === "retry" && "candidates" in result) {
        setDiscovery(result);
        setState(installationDiscoveryState(result.candidates.length, result.diagnostics));
        return;
      }
      // A folder dialog the player dismissed is not a failure, and says nothing about the
      // search: the scan it interrupted is still running (or has already settled behind the
      // dialog), so the panel keeps the sentence it had.
      if (kind === "picker" && "status" in result && result.status === "cancelled") return;
      setState("error");
    } catch (error) {
      if (mounted.current) setState(installationDiscoveryFailureState(observedProblemCode(error)));
    } finally {
      setPending("none");
    }
  };
  // A settled answer retires a scan still in flight (above), so this is only what the
  // controls read: a scan gates every control, an outstanding action or picker gates the
  // picker as well.
  const scannerDisabled = pending !== "none";
  const pickerPending = pending === "picker";
  const pickerDisabled = pending === "action" || pickerPending;
  // A confirmation is a Host operation with no cancel of its own, so it is the
  // one state in which abandoning the panel is not offered.
  const cancelDisabled = state === "confirming";
  /**
   * The scan's answer is shown in every state except the one the player ends the scan
   * with: a cancel retires the search, so it retires the rows that search was offering
   * as well - the panel used to state "Search cancelled." over three confirmable
   * installations.
   *
   * A refusal is not that. `mod_loader_missing`, `not_stardew_installation`,
   * `reparse_point` and `selection_unavailable` are sentences about the candidate or the
   * folder the player chose, so the list they were chosen from stays: choosing another
   * one is how that state is left.
   */
  const showsCandidates = state !== "cancelled";
  // The Steam launch option's copy handler was here, with an empty `catch`: nothing rendered a control for it,
  // so the swallow belonged to dead code. The clipboard is the browser's, not the Host's, so a control that
  // copies again reports a refusal through this panel's notice rather than through an empty catch.
  return (
    <section className="game-installation-panel" aria-label={labels.gameInstallationAria} data-state={state}>
      {/* The section's own title, at the level of its sibling panels' (`SurfaceModelSettings`,
          `GamePlayerSettings`): while no installation is registered this block leads the surface,
          and an `h4` above the guide's `h3`s would break the outline it leads. */}
      <h3 className="section-subtitle">{labels.gameInstallationTitle}</h3>
      {/* `data-state` above stays the typed state the tests assert; the sentence
          a player reads is always the localized outcome (design/104 §10). This is the panel's one status
          sentence, and it carries its own hook: the companion Mod's outcome below is a second fact, so
          "the panel's sentence" may not be selected by the class the two of them share. */}
      <p className="installation-state" role="status" data-installation-sentence="">
        {installationStateLabel(labels, state)}
      </p>
      {showsCandidates && discovery !== null && discovery.candidates.length > 0 && (
        // The list is the only region that scrolls itself (see
        // `.installation-candidates`), so it is the region that takes focus: a
        // scroll container a keyboard cannot reach is unscrollable for that player
        // (axe: scrollable-region-focusable), and the panel's own box no longer
        // scrolls at all.
        <ul className="installation-candidates" tabIndex={0}>
          {orderCandidatesByReadiness(discovery.candidates).map(
            ({ candidateId, label, source, hint, location, status, modLoader }) => (
              <li className="installation-candidate" key={candidateId} data-label={label} data-location={location}>
                {/* The row's words are the product's: the game's own name from the
                  catalogue (the Host's English `label` used to be the last English
                  text in a Chinese row) and, when the Host publishes one, where this
                  installation is (`D: · SteamLibrary`) - the fact that tells two
                  installations of the same game apart. Both wire facts stay as the
                  row's own attribution (`data-label`/`data-location`). */}
                <span className="installation-candidate-label">{installationCandidateLabel(labels, location)}</span>
                {/* Whether this folder can load the companion Mod. A candidate whose Host did not say renders nothing
                  rather than "missing", so the row never claims a check that did not happen. */}
                {installationModLoaderLabel(labels, modLoader) !== null && (
                  <span className="installation-mod-loader" data-mod-loader={modLoader ?? "unknown"}>
                    {installationModLoaderLabel(labels, modLoader)}
                  </span>
                )}
                {/* Beside the chip that names the gap, and only for the value that means it: a
                  folder that already loads the companion needs no pointer to a download, and a
                  Host that said nothing gets neither chip nor link - the panel does not pretend
                  to know. One outbound link, to the loader's own publisher. */}
                {modLoader === "missing" && (
                  <a
                    className="installation-mod-loader-acquire"
                    href={SMAPI_DOWNLOAD_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {labels.gameInstallationModLoaderAcquire}
                  </a>
                )}
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
                  disabled={scannerDisabled || !isConfirmableCandidate(status)}
                  onClick={() => void action("confirm", candidateId)}
                >
                  {labels.gameInstallationConfirm}
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      {/*
        The refusal above names the one thing missing, and the product does not supply it: SMAPI is installed
        by the player, from its own publisher. So this is a note rather than a button, and the controls below
        ("choose a folder" / "find again") are how the player re-detects once they have done it. Offering a
        button here would be a promise the product cannot keep.
      */}
      {state === "mod-loader-missing" && (
        <div className="game-actions" data-testid="game-mod-loader-guidance">
          <p className="game-subpanel-note">{labels.gameModLoaderInstallRequired}</p>
          <p className="game-subpanel-note">{labels.gameModLoaderInstallThenRetry}</p>
        </div>
      )}
      {/*
        What happened to the Mod itself, after a folder was registered. The Mod is this product's own, so the
        Host deploys it at that moment; reporting it here keeps "the folder is registered" from being mistaken
        for "the companion will load", which are different facts. Three answers, and the third is the one that
        matters: a registration whose reply said nothing about the Mod is stated as unanswered, never as ready.
      */}
      {companionMod !== null && (
        <p className="installation-state" role="status" data-companion-mod-outcome={companionMod}>
          {companionMod === "not-reported"
            ? labels.gameCompanionModNotReported
            : companionModLabel(labels, companionMod)}
        </p>
      )}
      {/*
        The folder picker's wait. The dialog can open behind the browser, and the panel is told
        nothing while it is up - so this says what the request is waiting for and where the window
        may be, and stops the moment the request settles. A second line rather than the panel's own
        status sentence: the scan's answer is a different fact, and it is still true during the wait.
      */}
      {pickerPending && (
        <p className="game-subpanel-note" role="status" data-testid="game-installation-picker-wait">
          {labels.gameInstallationPickerWaiting}
        </p>
      )}
      <div className="game-actions">
        <button type="button" className="game-action" disabled={pickerDisabled} onClick={() => void action("picker")}>
          {labels.gameInstallationChooseFolder}
        </button>
        <button type="button" className="game-action" disabled={scannerDisabled} onClick={() => void action("retry")}>
          {labels.gameInstallationFindAgain}
        </button>
        <button type="button" className="game-action" disabled={cancelDisabled} onClick={() => void action("cancel")}>
          {labels.gameResumeCancel}
        </button>
      </div>
    </section>
  );
}
