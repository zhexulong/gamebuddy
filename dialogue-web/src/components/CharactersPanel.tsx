import { type ReactElement, useEffect, useRef, useState } from "react";
import { type Locale, type Messages, messages } from "../i18n";
import type {
  CompanionListV1,
  CompanionVoiceV1,
  GreetingV1,
  ManagementPipelineApi,
  PersonaV1,
  ScenarioV1,
} from "../management-pipeline-api";
import { problemTextWithCode } from "../composed-problem-view";
import { TavernProblemError } from "../management-pipeline-api";
import { CharacterCardImport } from "./CharacterCardImport";
import { CompanionAvatar } from "./CompanionAvatar";
import { CompanionInspectorDrawer, type InspectedCompanion } from "./CompanionInspectorDrawer";
import { characterLabels } from "./character-domain-labels";
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
   * Every field the player types into is a DRAFT held by the shell, not by this panel.
   *
   * The shell renders this surface only while it is the selected one, so leaving it unmounts
   * everything below - and a `useState` here dies with it, which is how a typed persona, scenario,
   * opening or directive was silently emptied by a trip to Settings. Each field is handed the
   * authority's own value as its seed on every render; the store answers with the player's text
   * whenever there is any, so a read-back still seeds a field they have not touched and can never
   * replace one they have.
   */
  const createName = useDraft("characters.new-companion-name", "");
  const personaName = useDraft(
    "characters.persona-name",
    persona === "loading" || persona === "unavailable" ? "" : (persona.name ?? ""),
  );
  const personaDescription = useDraft(
    "characters.persona-description",
    persona === "loading" || persona === "unavailable" ? "" : (persona.description ?? ""),
  );
  const voiceText = useDraft(
    "characters.voice-text",
    voice.kind === "ready" && voice.value.characterVoice !== null ? voice.value.characterVoice.text : "",
  );
  // The directive's editor is a disclosure: absent reads as absent, so the player asks for one.
  // The fact that they asked belongs with the text it is for - a form that reopened collapsed put
  // the words out of reach, which costs them the same work as losing them.
  const voiceAdding = useOpenDraft("characters.voice-editor-open", false);
  const scenarioName = useDraft(
    "characters.scenario-name",
    scenario === "loading" || scenario === "unavailable" ? "" : (scenario.name ?? ""),
  );
  const scenarioDescription = useDraft(
    "characters.scenario-description",
    scenario === "loading" || scenario === "unavailable" ? "" : (scenario.description ?? ""),
  );
  const openingLabel = useDraft(
    "characters.opening-label",
    opening === "loading" || opening === "unavailable" ? "" : (opening.label ?? ""),
  );
  // The variants are a LIST the player adds to and removes from, so they are held whole: a row's
  // text keyed by its position lands on a different row once the list is reordered or shortened.
  const openingVariants = useRowsDraft<{ label: string; text: string }>(
    "characters.opening-variants",
    opening !== "loading" && opening !== "unavailable" && opening.present && opening.variants.length > 0
      ? opening.variants.map((variant) => ({ label: variant.label ?? "", text: variant.text }))
      : [{ label: "", text: "" }],
  );

  const activeRef = useRef(true);
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

  return (
    <section className="management-settings-section" aria-label={labels.personaTitle} data-characters-panel>
      {companionList === "unavailable" ? (
        <p>{labels.unavailable}</p>
      ) : (
        <>
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

          <section aria-label={labels.companionsTitle} data-companion-list-section>
            <h3>{labels.companionsTitle}</h3>
            {companionList === "loading" ? (
              <p className="loading-text">{labels.loading}</p>
            ) : companionList.companions.length === 0 ? (
              <p>{labels.companionsEmpty}</p>
            ) : (
              <ul data-companion-list>
                {companionList.companions.map((entry) => (
                  <li key={entry.handle} data-companion-entry>
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
                    {entry.isCurrent && <em className="companion-current-badge">{labels.companionCurrent}</em>}
                  </li>
                ))}
              </ul>
            )}
            {/* The companion in play is a deployment fact of the run GameBuddy
                started with, and the Host serves no activation operation, so the
                surface states the condition rather than offering a control it
                cannot honour. */}
            <p className="management-settings-hint" data-companion-in-play>
              {labels.companionInPlay}
            </p>
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
