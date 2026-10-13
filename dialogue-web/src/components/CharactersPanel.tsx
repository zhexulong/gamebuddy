import { type ReactElement, useEffect, useRef, useState } from "react";
import type { Locale, Messages } from "../i18n";
import type {
  CompanionListV1,
  GreetingV1,
  ManagementPipelineApi,
  PersonaV1,
  ScenarioV1,
} from "../management-pipeline-api";
import { problemTextWithCode } from "../management-pipeline-api";
import { CharacterCardImport } from "./CharacterCardImport";
import { characterLabels } from "./character-domain-labels";

/** A save's outcome: `saved`, or the refusal's own bounded reason, or none. */
type SaveNotice = "saved" | Readonly<{ failure: string }> | null;

function saveFailure(error: unknown, saveFailed: string): Readonly<{ failure: string }> {
  return { failure: problemTextWithCode(saveFailed, error) };
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
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels?: Messages;
  locale?: Locale;
}): ReactElement {
  const labels = characterLabels(locale);
  const [companionList, setCompanionList] = useState<CompanionListV1 | "loading" | "unavailable">("loading");
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState<SaveNotice>(null);

  const [persona, setPersona] = useState<PersonaV1 | "loading" | "unavailable">("loading");
  const [personaName, setPersonaName] = useState("");
  const [personaDescription, setPersonaDescription] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaNotice, setPersonaNotice] = useState<SaveNotice>(null);

  const [scenario, setScenario] = useState<ScenarioV1 | "loading" | "unavailable">("loading");
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioDescription, setScenarioDescription] = useState("");
  const [scenarioSaving, setScenarioSaving] = useState(false);
  const [scenarioNotice, setScenarioNotice] = useState<SaveNotice>(null);

  const [opening, setOpening] = useState<GreetingV1 | "loading" | "unavailable">("loading");
  const [openingLabel, setOpeningLabel] = useState("");
  const [openingVariants, setOpeningVariants] = useState<readonly { label: string; text: string }[]>([
    { label: "", text: "" },
  ]);
  const [openingSaving, setOpeningSaving] = useState(false);
  const [openingNotice, setOpeningNotice] = useState<SaveNotice>(null);

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
        setPersonaName(value.present ? value.name ?? "" : "");
        setPersonaDescription(value.present ? value.description ?? "" : "");
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
        setScenarioName(value.present ? value.name ?? "" : "");
        setScenarioDescription(value.present ? value.description ?? "" : "");
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
        setOpeningLabel(value.present ? value.label ?? "" : "");
        setOpeningVariants(
          value.present && value.variants.length > 0
            ? value.variants.map((variant) => ({ label: variant.label ?? "", text: variant.text }))
            : [{ label: "", text: "" }],
        );
      } catch {
        if (!activeRef.current) return;
        setOpening("unavailable");
      }
    })();
    return () => {
      activeRef.current = false;
    };
  }, [api]);

  const handleCreate = async (): Promise<void> => {
    const name = createName.trim();
    if (name.length === 0 || creating) return;
    setCreating(true);
    setCreateNotice(null);
    try {
      await api.createCompanion(name, csrfToken);
      const list = await api.listCompanions();
      if (activeRef.current) {
        setCompanionList(list);
        setCreateName("");
        setCreateNotice("saved");
      }
    } catch (error) {
      if (activeRef.current) setCreateNotice(saveFailure(error, labels.saveFailed));
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
          name: personaName.trim(),
          ...(personaDescription.trim().length === 0 ? {} : { description: personaDescription.trim() }),
        },
        csrfToken,
      );
      if (activeRef.current) {
        setPersona(saved);
        setPersonaNotice("saved");
      }
    } catch (error) {
      if (activeRef.current) setPersonaNotice(saveFailure(error, labels.saveFailed));
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
          name: scenarioName.trim(),
          description: scenarioDescription.trim(),
        },
        csrfToken,
      );
      if (activeRef.current) {
        setScenario(saved);
        setScenarioNotice("saved");
      }
    } catch (error) {
      if (activeRef.current) setScenarioNotice(saveFailure(error, labels.saveFailed));
    } finally {
      if (activeRef.current) setScenarioSaving(false);
    }
  };

  const handleSaveOpening = async (): Promise<void> => {
    if (openingSaving || opening === "loading" || opening === "unavailable") return;
    const allowedVariants = openingVariants
      .map((variant) => ({ label: variant.label.trim(), text: variant.text.trim() }))
      .filter((variant) => variant.text.length > 0);
    if (allowedVariants.length === 0) return;
    setOpeningSaving(true);
    setOpeningNotice(null);
    try {
      const saved = await api.updateGreeting(
        {
          expectedRevision: (opening.present ? opening.revision : 0) ?? 0,
          ...(openingLabel.trim().length === 0 ? {} : { label: openingLabel.trim() }),
          variants: allowedVariants.map((variant) => ({
            ...(variant.label.length === 0 ? {} : { label: variant.label }),
            text: variant.text,
          })),
        },
        csrfToken,
      );
      if (activeRef.current) {
        setOpening(saved);
        setOpeningNotice("saved");
      }
    } catch (error) {
      if (activeRef.current) setOpeningNotice(saveFailure(error, labels.saveFailed));
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
                    <span>{entry.name}</span>
                    {entry.isCurrent && <em className="companion-current-badge">{labels.companionCurrent}</em>}
                  </li>
                ))}
              </ul>
            )}
            <p className="management-settings-hint">{labels.newCompanionHint}</p>
            <div className="composer-actions">
              <input
                type="text"
                className="form-input"
                aria-label={labels.newCompanionTitle}
                value={createName}
                maxLength={128}
                onChange={(event) => setCreateName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCreate();
                }}
              />
              <button
                type="button"
                className="small-button"
                disabled={creating || createName.trim().length === 0}
                onClick={() => void handleCreate()}
              >
                {creating ? labels.saving : labels.newCompanionCreate}
              </button>
            </div>
            {createNotice !== null && (
              <p role="status" className={createNotice === "saved" ? "success-banner" : "error-banner"}>
                {createNotice === "saved" ? labels.saved : createNotice.failure}
              </p>
            )}
          </section>

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
                    value={personaName}
                    maxLength={128}
                    onChange={(event) => setPersonaName(event.target.value)}
                  />
                  <label className="management-settings-label" htmlFor="persona-description">
                    {labels.personaDescription}
                  </label>
                  <textarea
                    id="persona-description"
                    className="form-textarea"
                    rows={4}
                    value={personaDescription}
                    maxLength={4096}
                    onChange={(event) => setPersonaDescription(event.target.value)}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      disabled={personaSaving || personaName.trim().length === 0}
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
                    value={scenarioName}
                    maxLength={128}
                    onChange={(event) => setScenarioName(event.target.value)}
                  />
                  <label className="management-settings-label" htmlFor="scenario-description">
                    {labels.scenarioDescription}
                  </label>
                  <textarea
                    id="scenario-description"
                    className="form-textarea"
                    rows={4}
                    value={scenarioDescription}
                    maxLength={8192}
                    onChange={(event) => setScenarioDescription(event.target.value)}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      disabled={
                        scenarioSaving || scenarioName.trim().length === 0 || scenarioDescription.trim().length === 0
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
                    value={openingLabel}
                    maxLength={128}
                    onChange={(event) => setOpeningLabel(event.target.value)}
                  />
                  {openingVariants.map((variant, index) => (
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
                          setOpeningVariants((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? { label: item.label, text: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <div className="composer-actions">
                        <button
                          type="button"
                          className="small-button"
                          disabled={openingVariants.length <= 1}
                          onClick={() =>
                            setOpeningVariants((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
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
                      onClick={() => setOpeningVariants((current) => [...current, { label: "", text: "" }])}
                    >
                      {labels.openingAdd}
                    </button>
                  </div>
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      disabled={
                        openingSaving || openingVariants.every((variant) => variant.text.trim().length === 0)
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
        </>
      )}
    </section>
  );
}
