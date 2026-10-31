import { type ReactElement, useEffect, useRef, useState } from "react";
import { type Locale, type Messages, messages } from "../i18n";
import {
  type CompanionActivationV1,
  type CompanionListV1,
  type CompanionVoiceV1,
  type GreetingV1,
  type ManagementPipelineApi,
  type PersonaV1,
  type ScenarioV1,
} from "../management-pipeline-api";
import { problemTextWithCode } from "../composed-problem-view";
import { TavernProblemError } from "../management-pipeline-api";
import { deriveCompanionActivationControls } from "../companion-activation-controls";
import { CharacterCardImport } from "./CharacterCardImport";
import { CompanionAvatar } from "./CompanionAvatar";
import { CompanionInspectorDrawer, type InspectedCompanion } from "./CompanionInspectorDrawer";
import { characterLabels, type CharacterLabels } from "./character-domain-labels";
import { useDraft, useOpenDraft, useRowsDraft } from "./surface-drafts";

/** A save's outcome: `saved`, or the refusal's own bounded reason, or none. */
type SaveNotice = "saved" | Readonly<{ failure: string }> | null;

/** The companion directive's own save outcome, which also has a cleared state. */
type VoiceNotice = "saved" | "cleared" | Readonly<{ failure: string }> | null;

/**
 * The companion directive's view state. `ready` carries the durable read-back;
 * `absent` is a mounted companion with no directive (nothing renders), and
 * `unavailable` is a failed read (the section is omitted rather than faked).
 */
type VoiceView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; value: CompanionVoiceV1 }>;

function saveFailure(error: unknown, saveFailed: string, labels: Messages): Readonly<{ failure: string }> {
  return { failure: problemTextWithCode(saveFailed, error, labels) };
}

/** What a refused choice meant, so the roster can also react to WHICH refusal it was. */
const ACTIVATION_REFUSALS = {
  alreadyInPlay: "companion_switch_already_in_play",
  requiresNoSession: "companion_switch_requires_no_session",
  requestStale: "companion_switch_request_stale",
  recordUnreadable: "companion_switch_record_unreadable",
  unavailable: "companion_switch_unavailable",
  routeAbsent: "profile_operation_unavailable",
} as const;

/**
 * The player's sentence for one refused choice, and what the roster must do about it.
 *
 * Every way `companion.activate` refuses is a different fact with a different next step: she is
 * already the one in play, a Game session owns the companion it started with, the recorded choice
 * went stale before a later start, the record could not be read, or her authority root could not
 * be set aside. One "the choice could not be recorded" would send the player looking for a fault
 * that is not there. `routeAbsent` is the one refusal that is not about this press at all: the
 * build serves no such route, so the roster withdraws the control instead of offering it again.
 * A code this table does not know keeps the base sentence, so an unexpected refusal is still named.
 */
function companionActivationRefusal(
  labels: CharacterLabels,
  error: unknown,
  problemLabels: Messages,
): Readonly<{ text: string; routeAbsent: boolean; sessionBlocked: boolean }> {
  const code = error instanceof TavernProblemError ? error.code : null;
  switch (code) {
    case ACTIVATION_REFUSALS.alreadyInPlay:
      return { text: labels.companionSwitchAlreadyInPlay, routeAbsent: false, sessionBlocked: false };
    case ACTIVATION_REFUSALS.requiresNoSession:
      return { text: labels.companionSwitchRequiresNoSession, routeAbsent: false, sessionBlocked: true };
    case ACTIVATION_REFUSALS.requestStale:
      return { text: labels.companionSwitchRequestStale, routeAbsent: false, sessionBlocked: false };
    case ACTIVATION_REFUSALS.recordUnreadable:
      return { text: labels.companionSwitchRecordUnreadable, routeAbsent: false, sessionBlocked: false };
    case ACTIVATION_REFUSALS.unavailable:
      return { text: labels.companionSwitchUnavailable, routeAbsent: false, sessionBlocked: false };
    case ACTIVATION_REFUSALS.routeAbsent:
      return { text: labels.companionActivateUnsupported, routeAbsent: true, sessionBlocked: false };
    default:
      return {
        text: problemTextWithCode(labels.companionActivateFailed, error, problemLabels),
        routeAbsent: false,
        sessionBlocked: false,
      };
  }
}

/**
 * Characters surface (design/28 §2): the companion library and the companion's
 * own authored content.
 *
 * The functional side is the authority for what a character *is*: a character
 * card contributes a persona, a scenario, dialogue examples, lorebook entries
 * and an opening. The surface therefore talks in exactly those names, and the
 * opening (the chat's first message - the card's `first_mes`) belongs to the
 * character and is chosen when a chat starts, not a standalone record.
 *
 * Every control reflects a durable read-back: a save succeeds only when the
 * Host store re-reads the written artifact and validates it (revision CAS), so
 * the UI never shows a local value the store did not accept. Reads that fail
 * render the section as unavailable instead of fabricating a capability.
 *
 * `labels` is retained only for the standalone management mount that is being
 * retired; this panel renders the character domain's own vocabulary.
 */
export function CharactersPanel({
  api,
  csrfToken,
  locale = "en",
  avatarDigests: ownedDigests,
  onAvatarUpdated,
  inspected,
  onInspect,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels?: Messages;
  locale?: Locale;
  /**
   * The picture digest each companion was last handed, keyed by handle, and the upload that teaches
   * a new one. The shell owns the map because the bar and the transcript draw the same companion and
   * must re-key their image with it too; a caller that passes neither gets this panel's own state,
   * which is what a spec mounting the panel alone needs.
   */
  avatarDigests?: Readonly<Record<string, string>>;
  onAvatarUpdated?: (handle: string, digest: string) => void;
  /**
   * The companion the player is looking at, owned by the surface above: the roster row whose
   * inspector was opened. The surface owns it because the card export below this panel
   * follows the same selection, and a drawer's own state would be gone by the time the
   * player can reach that control.
   */
  inspected: InspectedCompanion | null;
  /** Her row was pressed: this companion is what the player is looking at now. */
  onInspect: (companion: InspectedCompanion) => void;
}): ReactElement {
  const labels = characterLabels(locale);
  // The sentence for a refusal comes from the product catalogue the Chat view words refusals
  // with, so a stale save reads the same in this panel as in the transcript.
  const problemLabels = messages(locale);
  const [companionList, setCompanionList] = useState<CompanionListV1 | "loading" | "unavailable">("loading");
  // Whether the inspector is on screen. The selection above outlives it: the drawer is
  // modal, so the player reads a companion here and acts on her once it is closed.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // The picture digest each roster row was last told about, keyed by handle. The panel owns
  // it because the row this panel draws is what needs the reload key, and it must outlive the
  // drawer that learned it: an upload leaves `companion.list` untouched, so re-reading the
  // roster carries no digest to replace this one with (only the upload's own reply does).
  const [ownDigests, setOwnDigests] = useState<Readonly<Record<string, string>>>({});
  // The shell's map wins when it has one: it is the owner, and the bar and the transcript read it too.
  const avatarDigests = ownedDigests ?? ownDigests;
  // The roster row that opened the inspector; the drawer gives focus back to it on
  // close (the shell's own focus-restoration idiom).
  const inspectorOpener = useRef<HTMLElement | null>(null);
  const [createNameField, setCreateNameField] = useState("");
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState<SaveNotice>(null);
  // The roster-level announcement a completed removal leaves: her name, and nothing else on
  // the row that held it. It is its own state because a removal is not a save, and folding
  // the two into one notice type would make every other editor's message a union member.
  const [removedName, setRemovedName] = useState<string | null>(null);

  const [persona, setPersona] = useState<PersonaV1 | "loading" | "unavailable">("loading");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaNotice, setPersonaNotice] = useState<SaveNotice>(null);

  const [voice, setVoice] = useState<VoiceView>({ kind: "loading" });
  const [voiceHandle, setVoiceHandle] = useState<string | null>(null);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceClearing, setVoiceClearing] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<VoiceNotice>(null);

  const [scenario, setScenario] = useState<ScenarioV1 | "loading" | "unavailable">("loading");
  const [scenarioSaving, setScenarioSaving] = useState(false);
  const [scenarioNotice, setScenarioNotice] = useState<SaveNotice>(null);

  const [opening, setOpening] = useState<GreetingV1 | "loading" | "unavailable">("loading");
  const [openingSaving, setOpeningSaving] = useState(false);
  const [openingNotice, setOpeningNotice] = useState<SaveNotice>(null);

  /*
   * The text the player is editing, which is NOT the record.
   *
   * These two are different facts and the panel needs both. `persona`/`scenario`/`opening` are the
   * record's IDENTITY - its revision, and whether it is present - and a conflict re-read replaces
   * them so the next save CASes on the revision the Host holds. The TEXT is what the player sees in
   * the field, and a conflict re-read must leave it alone: adopting the other writer's words would
   * silently republish them as the player's, which is why these baselines move only on the mount's
   * own read and on a save the Host accepted.
   */
  const [personaText, setPersonaText] = useState({ name: "", description: "" });
  const [scenarioText, setScenarioText] = useState({ name: "", description: "" });
  const [openingText, setOpeningText] = useState<{
    label: string;
    variants: readonly { label: string; text: string }[];
  }>({ label: "", variants: [{ label: "", text: "" }] });

  /*
   * Every field the player types into is a DRAFT held by the shell, not by this panel.
   *
   * The shell renders this surface only while it is the selected one, so leaving it unmounts
   * everything below - and a `useState` here dies with it, which is how a typed persona, scenario,
   * opening or directive was silently emptied by a trip to Settings. Each field is handed the
   * baseline above as its seed on every render; the store answers with the player's text whenever
   * there is any, so a read-back still seeds a field they have not touched and can never replace
   * one they have.
   */
  const createName = useDraft("characters.new-companion-name", "");
  const personaName = useDraft("characters.persona-name", personaText.name);
  const personaDescription = useDraft("characters.persona-description", personaText.description);
  const voiceText = useDraft(
    "characters.voice-text",
    voice.kind === "ready" && voice.value.characterVoice !== null ? voice.value.characterVoice.text : "",
  );
  // The directive's editor is a disclosure: absent reads as absent, so the player asks for one.
  // The fact that they asked belongs with the text it is for - a form that reopened collapsed put
  // the words out of reach, which costs them the same work as losing them.
  const voiceAdding = useOpenDraft("characters.voice-editor-open", false);
  const scenarioName = useDraft("characters.scenario-name", scenarioText.name);
  const scenarioDescription = useDraft("characters.scenario-description", scenarioText.description);
  const openingLabel = useDraft("characters.opening-label", openingText.label);
  // The variants are a LIST the player adds to and removes from, so they are held whole: a row's
  // text keyed by its position lands on a different row once the list is reordered or shortened.
  const openingVariants = useRowsDraft<{ label: string; text: string }>(
    "characters.opening-variants",
    openingText.variants,
  );

  const activeRef = useRef(true);
  /*
   * The companion whose choice this surface recorded, and the two facts a refused press leaves.
   *
   * `chosenHandle` is the surface's own fact about THIS session: `companion.activate` answers
   * `status: "recorded"` and nothing else, and no read anywhere projects a pending choice back
   * (`CompanionActivationV1Schema` carries no revision and `companion.list` carries no
   * pending flag), so a reload honestly forgets it rather than asking the player to trust a mark
   * the Host does not hold. `choosingHandle` is the row in flight, so a second press anywhere on
   * the roster is refused by this panel rather than by the Host.
   */
  const [chosenHandle, setChosenHandle] = useState<string | null>(null);
  const [choosingHandle, setChoosingHandle] = useState<string | null>(null);
  // A refusal about the whole installation rather than one row: the route is not served, so the
  // control is withdrawn everywhere, or a game session owns the companion so every unmarked row
  // says to stop it first.
  const [activationUnsupported, setActivationUnsupported] = useState(false);
  const [activationSessionBlocked, setActivationSessionBlocked] = useState(false);
  // The one refusal line the roster reports: the sentence for whichever press was last refused.
  const [activationNotice, setActivationNotice] = useState<string | null>(null);
  useEffect(() => {
    activeRef.current = true;
    void (async () => {
      try {
        const list = await api.listCompanions();
        if (!activeRef.current) return;
        setCompanionList(list);
      } catch {
        if (!activeRef.current) return;
        setCompanionList("unavailable");
      }
    })();
    void (async () => {
      try {
        const value = await api.readPersona();
        if (!activeRef.current) return;
        setPersona(value);
        setPersonaText({
          name: value.present ? (value.name ?? "") : "",
          description: value.present ? (value.description ?? "") : "",
        });
      } catch {
        if (!activeRef.current) return;
        setPersona("unavailable");
      }
    })();
    void (async () => {
      try {
        const value = await api.readScenario();
        if (!activeRef.current) return;
        setScenario(value);
        setScenarioText({
          name: value.present ? (value.name ?? "") : "",
          description: value.present ? (value.description ?? "") : "",
        });
      } catch {
        if (!activeRef.current) return;
        setScenario("unavailable");
      }
    })();
    void (async () => {
      try {
        const value = await api.readGreeting();
        if (!activeRef.current) return;
        setOpening(value);
        setOpeningText({
          label: value.present ? (value.label ?? "") : "",
          variants:
            value.present && value.variants.length > 0
              ? value.variants.map((variant) => ({ label: variant.label ?? "", text: variant.text }))
              : [{ label: "", text: "" }],
        });
      } catch {
        if (!activeRef.current) return;
        setOpening("unavailable");
      }
    })();
    return () => {
      activeRef.current = false;
    };
  }, [api]);

  useEffect(() => {
    if (companionList === "loading" || companionList === "unavailable") return;
    const current = companionList.companions.find((entry) => entry.isCurrent);
    if (current === undefined) {
      setVoice({ kind: "absent" });
      setVoiceHandle(null);
      return;
    }
    let active = true;
    setVoiceHandle(current.handle);
    void (async () => {
      try {
        const value = await api.readCompanionVoice(current.handle);
        if (!active) return;
        setVoice({ kind: "ready", value });
      } catch {
        if (active) setVoice({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
  }, [api, companionList]);

  const handleSaveVoice = async (): Promise<void> => {
    if (voice.kind !== "ready" || voiceHandle === null || voiceSaving || voiceClearing) return;
    const text = voiceText.value.trim();
    if (text.length === 0) return;
    setVoiceSaving(true);
    setVoiceNotice(null);
    try {
      const saved = await api.updateCompanionVoice(
        voiceHandle,
        { apiVersion: 1, expectedProfileRevision: voice.value.profileRevision, text },
        csrfToken,
      );
      if (activeRef.current) {
        setVoice({ kind: "ready", value: saved });
        // Released only if the field still holds what this save sent: text typed during the
        // request is the player's, and clearing it would be the same defect pointing the other way.
        voiceText.release(voiceText.value);
        voiceAdding.clear();
        setVoiceNotice("saved");
      }
    } catch (error) {
      if (activeRef.current) setVoiceNotice(saveFailure(error, labels.voiceSaveFailed, problemLabels));
    } finally {
      if (activeRef.current) setVoiceSaving(false);
    }
  };

  const handleClearVoice = async (): Promise<void> => {
    if (voice.kind !== "ready" || voiceHandle === null || voiceSaving || voiceClearing) return;
    setVoiceClearing(true);
    setVoiceNotice(null);
    try {
      const cleared = await api.updateCompanionVoice(
        voiceHandle,
        { apiVersion: 1, expectedProfileRevision: voice.value.profileRevision, clear: true },
        csrfToken,
      );
      if (activeRef.current) {
        // The cleared directive reads as absent, so the entry point collapses
        // back to its add control; the status line acknowledges the one action.
        setVoice({ kind: "ready", value: cleared });
        voiceText.release(voiceText.value);
        voiceAdding.clear();
        setVoiceNotice("cleared");
      }
    } catch (error) {
      if (activeRef.current) setVoiceNotice(saveFailure(error, labels.voiceSaveFailed, problemLabels));
    } finally {
      if (activeRef.current) setVoiceClearing(false);
    }
  };

  /*
   * Records the player's choice of which companion this installation plays.
   *
   * The request is the contract's own shape and nothing more: the opaque handle as the route
   * parameter, `{ apiVersion }` as the body. No companionId, no continuity, no revision - a switch
   * names the INSTALLATION's choice, whose compare-and-set is the companion the Host already holds
   * as in play, and a `switched` claim is not an operation this Host can perform. The answer is
   * checked for its one status literal (`recorded`) by the wire validator, so a response that
   * claimed a switch would be a protocol error rather than a success this panel rendered.
   *
   * What the player is told afterwards is therefore exactly what happened: her choice is recorded
   * and a restart applies it. The restart is the product's own tray (`TrayShell`), which serves no
   * browser route, so the affordance is the sentence that names it rather than a button that
   * could only fail.
   */
  const handleChooseCompanion = async (handle: string): Promise<void> => {
    if (choosingHandle !== null) return;
    setChoosingHandle(handle);
    setActivationNotice(null);
    try {
      const recorded: CompanionActivationV1 = await api.activateCompanion(handle, csrfToken);
      // The validator already refused anything but `recorded`; re-stating it here is what keeps
      // this panel's success branch tied to the contract rather than to the absence of an error.
      if (recorded.status !== "recorded") throw new Error("companion_activation_not_recorded");
      if (activeRef.current) {
        setChosenHandle(recorded.handle);
        setActivationSessionBlocked(false);
      }
    } catch (error) {
      const refusal = companionActivationRefusal(labels, error, problemLabels);
      if (activeRef.current) {
        // The route is served by no part of this build, so every row withdraws the control: a
        // control that could only fail on press is the trap the composition rule exists to stop.
        if (refusal.routeAbsent) setActivationUnsupported(true);
        // A game session owns the companion it started with. Every unmarked row keeps its control
        // and says to stop the game first, which is the step the refusal names.
        if (refusal.sessionBlocked) setActivationSessionBlocked(true);
        setActivationNotice(refusal.text);
      }
    } finally {
      if (activeRef.current) setChoosingHandle(null);
    }
  };

  const handleCreate = async (): Promise<void> => {
    const name = createName.value.trim();
    if (name.length === 0 || creating) return;
    setCreating(true);
    setCreateNotice(null);
    try {
      await api.createCompanion(name, csrfToken);
      const list = await api.listCompanions();
      if (activeRef.current) {
        setCompanionList(list);
        createName.release(createName.value);
        setCreateNotice("saved");
      }
    } catch (error) {
      if (activeRef.current) setCreateNotice(saveFailure(error, labels.saveFailed, problemLabels));
    } finally {
      if (activeRef.current) setCreating(false);
    }
  };

  const handleSavePersona = async (): Promise<void> => {
    if (personaSaving || persona === "loading" || persona === "unavailable") return;
    const current = persona.present ? persona.revision : 0;
    setPersonaSaving(true);
    setPersonaNotice(null);
    try {
      const saved = await api.updatePersona(
        {
          expectedRevision: current ?? 0,
          name: personaName.value.trim(),
          ...(personaDescription.value.trim().length === 0 ? {} : { description: personaDescription.value.trim() }),
        },
        csrfToken,
      );
      if (activeRef.current) {
        setPersona(saved);
        personaName.release(personaName.value);
        personaDescription.release(personaDescription.value);
        // The accepted read-back is the new baseline too: the next render's seed is what the Host
        // now holds, not what it held before this save.
        setPersonaText({
          name: saved.present ? (saved.name ?? "") : "",
          description: saved.present ? (saved.description ?? "") : "",
        });
        setPersonaNotice("saved");
      }
    } catch (error) {
      const notice = saveFailure(error, labels.saveFailed, problemLabels);
      // `persona_conflict` is the Host stating that her persona moved under this save. The
      // refusal alone leaves the field CASed on the revision that already lost, so every
      // retry resends it and is refused identically until the panel remounts; the read-back
      // is the revision to save against. Her typed words are NOT taken from it - the read is
      // only the record's identity, and replacing the text would silently discard what she
      // is in the middle of writing.
      if (error instanceof TavernProblemError && error.code === "persona_conflict") {
        try {
          const fresh = await api.readPersona();
          if (activeRef.current) setPersona(fresh);
        } catch {
          // The refusal stands on its own; the next save is CASed on the revision shown.
        }
      }
      if (activeRef.current) setPersonaNotice(notice);
    } finally {
      if (activeRef.current) setPersonaSaving(false);
    }
  };

  const handleSaveScenario = async (): Promise<void> => {
    if (scenarioSaving || scenario === "loading" || scenario === "unavailable") return;
    const current = scenario.present ? scenario.revision : 0;
    setScenarioSaving(true);
    setScenarioNotice(null);
    try {
      const saved = await api.updateScenario(
        {
          expectedRevision: current ?? 0,
          name: scenarioName.value.trim(),
          description: scenarioDescription.value.trim(),
        },
        csrfToken,
      );
      if (activeRef.current) {
        setScenario(saved);
        scenarioName.release(scenarioName.value);
        scenarioDescription.release(scenarioDescription.value);
        setScenarioText({
          name: saved.present ? (saved.name ?? "") : "",
          description: saved.present ? (saved.description ?? "") : "",
        });
        setScenarioNotice("saved");
      }
    } catch (error) {
      const notice = saveFailure(error, labels.saveFailed, problemLabels);
      // A stale scenario needs the same treatment as a stale persona: adopt the revision the
      // Host holds and keep the player's text, so the next save is a fresh compare-and-set.
      if (error instanceof TavernProblemError && error.code === "scenario_conflict") {
        try {
          const fresh = await api.readScenario();
          if (activeRef.current) setScenario(fresh);
        } catch {
          // The refusal stands on its own; the next save is CASed on the revision shown.
        }
      }
      if (activeRef.current) setScenarioNotice(notice);
    } finally {
      if (activeRef.current) setScenarioSaving(false);
    }
  };

  const handleSaveOpening = async (): Promise<void> => {
    if (openingSaving || opening === "loading" || opening === "unavailable") return;
    const allowedVariants = openingVariants.value
      .map((variant) => ({ label: variant.label.trim(), text: variant.text.trim() }))
      .filter((variant) => variant.text.length > 0);
    if (allowedVariants.length === 0) return;
    setOpeningSaving(true);
    setOpeningNotice(null);
    try {
      const saved = await api.updateGreeting(
        {
          expectedRevision: (opening.present ? opening.revision : 0) ?? 0,
          ...(openingLabel.value.trim().length === 0 ? {} : { label: openingLabel.value.trim() }),
          variants: allowedVariants.map((variant) => ({
            ...(variant.label.length === 0 ? {} : { label: variant.label }),
            text: variant.text,
          })),
        },
        csrfToken,
      );
      if (activeRef.current) {
        setOpening(saved);
        openingLabel.release(openingLabel.value);
        openingVariants.release(openingVariants.value);
        setOpeningText({
          label: saved.present ? (saved.label ?? "") : "",
          variants:
            saved.present && saved.variants.length > 0
              ? saved.variants.map((variant) => ({ label: variant.label ?? "", text: variant.text }))
              : [{ label: "", text: "" }],
        });
        setOpeningNotice("saved");
      }
    } catch (error) {
      const notice = saveFailure(error, labels.saveFailed, problemLabels);
      // The opening's own version of the same fix: the read-back becomes the record this form
      // CASes on, while `openingLabel` and `openingVariants` - the two states the player actually
      // types into - are left untouched, so her words are what the next save carries.
      if (error instanceof TavernProblemError && error.code === "greeting_conflict") {
        try {
          const fresh = await api.readGreeting();
          if (activeRef.current) setOpening(fresh);
        } catch {
          // The refusal stands on its own; the next save is CASed on the revision shown.
        }
      }
      if (activeRef.current) setOpeningNotice(notice);
    } finally {
      if (activeRef.current) setOpeningSaving(false);
    }
  };

  // The chosen companion's own name, for the recorded-choice sentence. Derived once so the
  // sentence names her from the roster rather than from a second copy of the fact.
  const chosenName =
    chosenHandle === null || companionList === "loading" || companionList === "unavailable"
      ? ""
      : (companionList.companions.find((entry) => entry.handle === chosenHandle)?.name ?? "");

  return (
    <section className="management-settings-section" aria-label={labels.personaTitle} data-characters-panel>
      {companionList === "unavailable" ? (
        <p>{labels.unavailable}</p>
      ) : (
        <>
          {/* The companion library comes FIRST, above the card import, and that order is a
              decision rather than an accident: choosing who plays is one of this surface's
              primary actions and the project gates primary actions inside the first viewport,
              while importing a card is how you ADD to the library rather than what the
              surface is about. Measured at 400x800 and 1440x900 in
              `companion-activation.spec.ts`. */}
          <section aria-label={labels.companionsTitle} data-companion-list-section>
            <h3>{labels.companionsTitle}</h3>
            {companionList === "loading" ? (
              <p className="loading-text">{labels.loading}</p>
            ) : companionList.companions.length === 0 ? (
              <p>{labels.companionsEmpty}</p>
            ) : (
              <ul data-companion-list>
                {companionList.companions.map((entry) => {
                  // What this row offers is one derivation, shared with the gate that proves every
                  // phase has a forward action: the row never decides for itself whether a
                  // companion can be chosen, and the mark it draws cannot drift from the control.
                  const controls = deriveCompanionActivationControls({
                    isCurrent: entry.isCurrent,
                    chosenHandle,
                    handle: entry.handle,
                    activationServed: !activationUnsupported,
                    blockedBySession: activationSessionBlocked,
                  });
                  return (
                    <li key={entry.handle} data-companion-entry data-companion-phase={controls.phase}>
                      {/* The row is how the player READS a companion: it opens the
                          read-only inspector for the companion it names. It is a
                          control for the keyboard, and its accessible name says
                          what it does, so it can never read as an activation
                          control this Host has no operation for. */}
                      <button
                        type="button"
                        className="companion-entry-open"
                        data-companion-inspect
                        aria-label={labels.companionInspect.replace("{{name}}", entry.name)}
                        onClick={(event) => {
                          inspectorOpener.current = event.currentTarget;
                          onInspect({ handle: entry.handle, name: entry.name, isCurrent: entry.isCurrent });
                          setInspectorOpen(true);
                        }}
                      >
                        <CompanionAvatar
                          handle={entry.handle}
                          name={entry.name}
                          className="avatar-small"
                          digest={avatarDigests[entry.handle]}
                        />
                        {/* The row's own name, in its own element: the monogram beside it is
                            decoration, so the control's text is not the companion's name and a
                            reader that wants the name must not have to subtract a glyph. */}
                        <span data-companion-entry-name>{entry.name}</span>
                      </button>
                      <span className="companion-entry-actions">
                        {controls.markedInPlay && (
                          <em className="companion-current-badge">{labels.companionCurrent}</em>
                        )}
                        {controls.markedChosen && (
                          <em className="companion-chosen-badge" data-companion-chosen>
                            {labels.companionChosen}
                          </em>
                        )}
                        {/* The choice control belongs to the ROW, beside the read control and
                            never instead of it: reading her and choosing her are two different
                            acts, and merging them would make opening the inspector record a
                            choice nobody asked for. */}
                        {controls.chooseOffered && (
                          <button
                            type="button"
                            className="small-button companion-choose"
                            data-companion-choose
                            aria-label={labels.companionActivateFor.replace("{{name}}", entry.name)}
                            disabled={choosingHandle !== null}
                            onClick={() => void handleChooseCompanion(entry.handle)}
                          >
                            {choosingHandle === entry.handle ? labels.companionActivateBusy : labels.companionActivate}
                          </button>
                        )}
                        {controls.stopGameFirst && (
                          <em className="companion-stop-game" data-companion-stop-game>
                            {labels.companionStopGameBadge}
                          </em>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* What the player reads BEFORE choosing anything: what a choice does to her data, so
                a correct switch never reads as data loss, and what actually applies it. Both sit
                with the roster the control lives on rather than behind a disclosure - a hint the
                player must open before pressing is a hint they will read afterwards. */}
            <p className="management-settings-hint" data-companion-in-play>
              {labels.companionInPlay}
            </p>
            <p className="management-settings-hint" data-companion-activation-hint>
              {labels.companionActivationHint}
            </p>
            {/* The recorded choice's own two lines: which companion it is for, and the step that
                applies it. The restart is the product's tray, which serves no browser route, so
                the control here is the sentence that names it - a button that could only fail
                would be the same lie in a different shape. */}
            {chosenHandle !== null && (
              <div role="status" className="success-banner" data-companion-activation-recorded>
                <p>{labels.companionActivationRecorded.replace("{{name}}", chosenName)}</p>
                <p className="management-settings-hint" data-companion-activation-restart>
                  {labels.companionActivationRestart}
                </p>
              </div>
            )}
            {activationNotice !== null && (
              <p role="status" className="error-banner" data-companion-activation-notice>
                {activationNotice}
              </p>
            )}
            <p className="management-settings-hint">{labels.newCompanionHint}</p>
            <div className="composer-actions">
              <input
                type="text"
                className="form-input"
                aria-label={labels.newCompanionTitle}
                value={createName.value}
                maxLength={128}
                onChange={(event) => createName.type(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCreate();
                }}
              />
              <button
                type="button"
                className="small-button"
                disabled={creating || createName.value.trim().length === 0}
                onClick={() => void handleCreate()}
              >
                {creating ? labels.saving : labels.newCompanionCreate}
              </button>
            </div>
            {removedName !== null && (
              <p role="status" className="success-banner" data-companion-removed>
                {labels.companionDeleted.replace("{{name}}", removedName)}
              </p>
            )}
            {createNotice !== null && (
              <p role="status" className={createNotice === "saved" ? "success-banner" : "error-banner"}>
                {createNotice === "saved" ? labels.saved : createNotice.failure}
              </p>
            )}
          </section>
          {/* Importing a card ADDS to the library above; it is not what this surface is about,
              so it follows the roster rather than pushing it down the page. */}
          <CharacterCardImport
            api={api}
            csrfToken={csrfToken}
            locale={locale}
            onCreated={() => {
              void (async () => {
                try {
                  const list = await api.listCompanions();
                  if (activeRef.current) setCompanionList(list);
                } catch {
                  // keep the already-rendered library
                }
              })();
            }}
          />
          {/* A cleared (or never-authored) directive reads as ABSENT. The section
              stays mounted so the player still has an entry point for one, but it
              never leaves an empty editor behind: absent renders an explicit add
              control, and the provenance line appears only when a directive is
              really there. */}
          {voice.kind === "ready" && (
            <section aria-label={labels.voiceTitle} data-character-voice>
              <h3>{labels.voiceTitle}</h3>
              <p className="management-settings-hint">
                {voice.value.characterVoice === null ? labels.voiceEmptyHint : labels.voiceHint}
              </p>
              {voice.value.characterVoice !== null ? (
                <>
                  <p data-character-voice-source>
                    {voice.value.characterVoice.source === "card" ? labels.voiceFromCard : labels.voiceEditedByYou}
                  </p>
                  <label className="management-settings-label" htmlFor="character-voice-text">
                    {labels.voiceText}
                  </label>
                  <textarea
                    id="character-voice-text"
                    className="form-textarea"
                    rows={4}
                    maxLength={8192}
                    value={voiceText.value}
                    onChange={(event) => voiceText.type(event.target.value)}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      data-character-voice-save
                      disabled={voiceSaving || voiceClearing || voiceText.value.trim().length === 0}
                      onClick={() => void handleSaveVoice()}
                    >
                      {voiceSaving ? labels.saving : labels.voiceSave}
                    </button>
                    <button
                      type="button"
                      className="small-button"
                      data-character-voice-clear
                      disabled={voiceSaving || voiceClearing}
                      onClick={() => void handleClearVoice()}
                    >
                      {voiceClearing ? labels.saving : labels.voiceClear}
                    </button>
                  </div>
                </>
              ) : voiceAdding.value ? (
                <>
                  <label className="management-settings-label" htmlFor="character-voice-text">
                    {labels.voiceText}
                  </label>
                  <textarea
                    id="character-voice-text"
                    className="form-textarea"
                    rows={4}
                    maxLength={8192}
                    value={voiceText.value}
                    onChange={(event) => voiceText.type(event.target.value)}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      data-character-voice-save
                      disabled={voiceSaving || voiceText.value.trim().length === 0}
                      onClick={() => void handleSaveVoice()}
                    >
                      {voiceSaving ? labels.saving : labels.voiceSave}
                    </button>
                    <button
                      type="button"
                      className="small-button"
                      data-character-voice-cancel
                      disabled={voiceSaving}
                      onClick={() => {
                        voiceAdding.clear();
                        voiceText.clear();
                        setVoiceNotice(null);
                      }}
                    >
                      {labels.voiceCancel}
                    </button>
                  </div>
                </>
              ) : (
                <div className="composer-actions">
                  <button
                    type="button"
                    className="small-button"
                    data-character-voice-add
                    onClick={() => {
                      voiceAdding.type(true);
                      voiceText.clear();
                      setVoiceNotice(null);
                    }}
                  >
                    {labels.voiceAdd}
                  </button>
                </div>
              )}
              {voiceNotice !== null && (
                <p
                  role="status"
                  className={voiceNotice === "saved" || voiceNotice === "cleared" ? "success-banner" : "error-banner"}
                  data-character-voice-notice
                >
                  {voiceNotice === "saved"
                    ? labels.saved
                    : voiceNotice === "cleared"
                      ? labels.voiceCleared
                      : voiceNotice.failure}
                </p>
              )}
            </section>
          )}

          {persona !== "unavailable" && (
            <section aria-label={labels.personaTitle} data-persona-editor>
              <h3>{labels.personaTitle}</h3>
              <p className="management-settings-hint">{labels.personaHint}</p>
              {persona === "loading" ? (
                <p className="loading-text">{labels.loading}</p>
              ) : persona.present ? (
                <p>{labels.personaPresent}</p>
              ) : (
                <p>{labels.personaAbsent}</p>
              )}
              {persona !== "loading" && (
                <>
                  <label className="management-settings-label" htmlFor="persona-name">
                    {labels.personaName}
                  </label>
                  <input
                    id="persona-name"
                    type="text"
                    className="form-input"
                    value={personaName.value}
                    maxLength={128}
                    onChange={(event) => personaName.type(event.target.value)}
                  />
                  <label className="management-settings-label" htmlFor="persona-description">
                    {labels.personaDescription}
                  </label>
                  <textarea
                    id="persona-description"
                    className="form-textarea"
                    rows={4}
                    value={personaDescription.value}
                    maxLength={4096}
                    onChange={(event) => personaDescription.type(event.target.value)}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      disabled={personaSaving || personaName.value.trim().length === 0}
                      onClick={() => void handleSavePersona()}
                    >
                      {personaSaving ? labels.saving : labels.personaSave}
                    </button>
                  </div>
                  {personaNotice !== null && (
                    <p role="status" className={personaNotice === "saved" ? "success-banner" : "error-banner"}>
                      {personaNotice === "saved" ? labels.saved : personaNotice.failure}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {scenario !== "unavailable" && (
            <section aria-label={labels.scenarioTitle} data-scenario-editor>
              <h3>{labels.scenarioTitle}</h3>
              <p className="management-settings-hint">{labels.scenarioHint}</p>
              {scenario === "loading" ? (
                <p className="loading-text">{labels.loading}</p>
              ) : !scenario.present ? (
                <p>{labels.scenarioAbsent}</p>
              ) : null}
              {scenario !== "loading" && (
                <>
                  <label className="management-settings-label" htmlFor="scenario-name">
                    {labels.scenarioName}
                  </label>
                  <input
                    id="scenario-name"
                    type="text"
                    className="form-input"
                    value={scenarioName.value}
                    maxLength={128}
                    onChange={(event) => scenarioName.type(event.target.value)}
                  />
                  <label className="management-settings-label" htmlFor="scenario-description">
                    {labels.scenarioDescription}
                  </label>
                  <textarea
                    id="scenario-description"
                    className="form-textarea"
                    rows={4}
                    value={scenarioDescription.value}
                    maxLength={8192}
                    onChange={(event) => scenarioDescription.type(event.target.value)}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      disabled={
                        scenarioSaving ||
                        scenarioName.value.trim().length === 0 ||
                        scenarioDescription.value.trim().length === 0
                      }
                      onClick={() => void handleSaveScenario()}
                    >
                      {scenarioSaving ? labels.saving : labels.scenarioSave}
                    </button>
                  </div>
                  {scenarioNotice !== null && (
                    <p role="status" className={scenarioNotice === "saved" ? "success-banner" : "error-banner"}>
                      {scenarioNotice === "saved" ? labels.saved : scenarioNotice.failure}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {opening !== "unavailable" && (
            <section aria-label={labels.openingTitle} data-opening-editor>
              {" "}
              <h3>{labels.openingTitle}</h3>
              <p className="management-settings-hint">{labels.openingHint}</p>
              {opening === "loading" ? (
                <p className="loading-text">{labels.loading}</p>
              ) : !opening.present ? (
                <p>{labels.openingAbsent}</p>
              ) : null}
              {opening !== "loading" && (
                <>
                  <label className="management-settings-label" htmlFor="opening-label">
                    {labels.openingLabel}
                  </label>
                  <input
                    id="opening-label"
                    type="text"
                    className="form-input"
                    value={openingLabel.value}
                    maxLength={128}
                    onChange={(event) => openingLabel.type(event.target.value)}
                  />
                  {openingVariants.value.map((variant, index) => (
                    <div key={index} className="opening-variant-row">
                      <label className="management-settings-label" htmlFor={`opening-variant-${index}-text`}>
                        {labels.openingVariantText} #{index + 1}
                      </label>
                      <textarea
                        id={`opening-variant-${index}-text`}
                        className="form-textarea"
                        rows={2}
                        value={variant.text}
                        maxLength={8192}
                        onChange={(event) =>
                          openingVariants.type(
                            openingVariants.value.map((item, itemIndex) =>
                              itemIndex === index ? { label: item.label, text: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <div className="composer-actions">
                        <button
                          type="button"
                          className="small-button"
                          disabled={openingVariants.value.length <= 1}
                          onClick={() =>
                            openingVariants.type(openingVariants.value.filter((_, itemIndex) => itemIndex !== index))
                          }
                        >
                          {labels.discard}
                        </button>
                      </div>
                    </div>
                  ))}
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      onClick={() => openingVariants.type([...openingVariants.value, { label: "", text: "" }])}
                    >
                      {labels.openingAdd}
                    </button>
                  </div>
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      disabled={
                        openingSaving || openingVariants.value.every((variant) => variant.text.trim().length === 0)
                      }
                      onClick={() => void handleSaveOpening()}
                    >
                      {openingSaving ? labels.saving : labels.openingSave}
                    </button>
                  </div>
                  {openingNotice !== null && (
                    <p role="status" className={openingNotice === "saved" ? "success-banner" : "error-banner"}>
                      {openingNotice === "saved" ? labels.saved : openingNotice.failure}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {/* The inspector is the drawer's own read of the clicked companion; it
              edits nothing, and it is the only place an archived companion's
              authored facts can be read at all. */}
          <CompanionInspectorDrawer
            api={api}
            csrfToken={csrfToken}
            companion={inspectorOpen ? inspected : null}
            locale={locale}
            onClose={() => setInspectorOpen(false)}
            onAvatarUpdated={(handle, digest) => {
              // Report upward when the shell owns the map (the bar and the transcript re-key on it), and
              // keep a local copy either way: a panel mounted on its own still draws its own roster.
              setOwnDigests((current) => ({ ...current, [handle]: digest }));
              onAvatarUpdated?.(handle, digest);
            }}
            onDeleted={(deletedHandle, name) => {
              // The row goes, the drawer closes, and the notice names her: a companion that was
              // deleted must not stay on screen as a row whose inspector answers 404.
              setCompanionList((current) =>
                typeof current === "string"
                  ? current
                  : Object.freeze({
                      ...current,
                      companions: current.companions.filter((entry) => entry.handle !== deletedHandle),
                    }),
              );
              setInspectorOpen(false);
              setCreateNotice(null);
              setRemovedName(name);
            }}
            restoreFocusTo={inspectorOpener}
          />
        </>
      )}
    </section>
  );
}
