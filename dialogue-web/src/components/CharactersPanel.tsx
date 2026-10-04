import { type ReactElement, useEffect, useRef, useState } from "react";
import type { Messages } from "../i18n";
import type {
  CompanionListV1,
  GreetingV1,
  ManagementPipelineApi,
  PersonaV1,
  ScenarioV1,
  StCardImportStageResultV1,
} from "../management-pipeline-api";

/**
 * Characters surface (design/28 §2): companion library + Persona / Scenario /
 * Greeting management, all through the mounted management profile routes.
 *
 * Every control reflects a durable read-back: a save succeeds only when the
 * Host store re-reads the written artifact and validates it (revision CAS),
 * so the UI never shows a local value the store did not accept. Reads that
 * fail (profile without the routes, service unavailable) render the section
 * as unavailable instead of fabricating a capability.
 */
export function CharactersPanel({
  api,
  csrfToken,
  labels,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
}): ReactElement {
  const [companionList, setCompanionList] = useState<CompanionListV1 | "loading" | "unavailable">("loading");
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState<"saved" | "error" | null>(null);

  const [persona, setPersona] = useState<PersonaV1 | "loading" | "unavailable">("loading");
  const [personaName, setPersonaName] = useState("");
  const [personaDescription, setPersonaDescription] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaNotice, setPersonaNotice] = useState<"saved" | "error" | null>(null);

  const [scenario, setScenario] = useState<ScenarioV1 | "loading" | "unavailable">("loading");
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioDescription, setScenarioDescription] = useState("");
  const [scenarioSaving, setScenarioSaving] = useState(false);
  const [scenarioNotice, setScenarioNotice] = useState<"saved" | "error" | null>(null);

  const [greeting, setGreeting] = useState<GreetingV1 | "loading" | "unavailable">("loading");
  const [greetingLabel, setGreetingLabel] = useState("");
  const [greetingVariants, setGreetingVariants] = useState<readonly { label: string; text: string }[]>([
    { label: "", text: "" },
  ]);
  const [greetingSaving, setGreetingSaving] = useState(false);
  const [greetingNotice, setGreetingNotice] = useState<"saved" | "error" | null>(null);

  // Reviewed ST-card import (design/28 Import row): stage -> review -> confirm.
  const [importCardText, setImportCardText] = useState("");
  const [importStaged, setImportStaged] = useState<StCardImportStageResultV1 | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState<"created" | "error" | null>(null);

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
        setGreeting(value);
        setGreetingLabel(value.present ? value.label ?? "" : "");
        setGreetingVariants(
          value.present && value.variants.length > 0
            ? value.variants.map((variant) => ({ label: variant.label ?? "", text: variant.text }))
            : [{ label: "", text: "" }],
        );
      } catch {
        if (!activeRef.current) return;
        setGreeting("unavailable");
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
    } catch {
      if (activeRef.current) setCreateNotice("error");
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
    } catch {
      if (activeRef.current) setPersonaNotice("error");
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
    } catch {
      if (activeRef.current) setScenarioNotice("error");
    } finally {
      if (activeRef.current) setScenarioSaving(false);
    }
  };

  const handleSaveGreeting = async (): Promise<void> => {
    if (greetingSaving || greeting === "loading" || greeting === "unavailable") return;
    const allowedVariants = greetingVariants
      .map((variant) => ({ label: variant.label.trim(), text: variant.text.trim() }))
      .filter((variant) => variant.text.length > 0);
    if (allowedVariants.length === 0) return;
    setGreetingSaving(true);
    setGreetingNotice(null);
    try {
      const saved = await api.updateGreeting(
        {
          expectedRevision: (greeting.present ? greeting.revision : 0) ?? 0,
          ...(greetingLabel.trim().length === 0 ? {} : { label: greetingLabel.trim() }),
          variants: allowedVariants.map((variant) => ({
            ...(variant.label.length === 0 ? {} : { label: variant.label }),
            text: variant.text,
          })),
        },
        csrfToken,
      );
      if (activeRef.current) {
        setGreeting(saved);
        setGreetingNotice("saved");
      }
    } catch {
      if (activeRef.current) setGreetingNotice("error");
    } finally {
      if (activeRef.current) setGreetingSaving(false);
    }
  };

  const handleStageImport = async (): Promise<void> => {
    const card = importCardText.trim();
    if (card.length === 0 || importBusy) return;
    setImportBusy(true);
    setImportNotice(null);
    try {
      const staged = await api.stageStCardImport(card, csrfToken);
      if (activeRef.current) {
        setImportStaged(staged);
        setImportNotice(null);
      }
    } catch {
      if (activeRef.current) setImportNotice("error");
    } finally {
      if (activeRef.current) setImportBusy(false);
    }
  };

  const handleConfirmImport = async (): Promise<void> => {
    if (importStaged === null || importBusy) return;
    setImportBusy(true);
    setImportNotice(null);
    try {
      // Confirm is only legal on a SIGNED review credential: the product refuses
      // to provision a card nobody approved. The dialog has already shown every
      // included and excluded field, so confirming signs the reviewable set it
      // displayed and then provisions exactly that set.
      const reviewable = importStaged.fields
        .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
        .map((field) => field.field);
      if (reviewable.length > 0)
        await api.reviewStCardImport(importStaged.importId, reviewable, Date.now(), csrfToken);
      await api.confirmStCardImport(importStaged.importId, csrfToken);
      const list = await api.listCompanions();
      if (activeRef.current) {
        setCompanionList(list);
        setImportStaged(null);
        setImportCardText("");
        setImportNotice("created");
      }
    } catch {
      if (activeRef.current) setImportNotice("error");
    } finally {
      if (activeRef.current) setImportBusy(false);
    }
  };

  return (
    <section className="management-settings-section" aria-label={labels.charactersTitle} data-characters-panel>
      <h2>{labels.charactersTitle}</h2>

      {companionList === "unavailable" ? (
        <p>{labels.charactersUnavailable}</p>
      ) : (
        <>
          <section aria-label={labels.companionListTitle}>
            <h3>{labels.companionListTitle}</h3>
            {companionList === "loading" ? (
              <p className="loading-text">{labels.openingChat}</p>
            ) : companionList.companions.length === 0 ? (
              <p>{labels.companionListEmpty}</p>
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
            <p className="management-settings-hint">{labels.companionCreateHint}</p>
            <div className="composer-actions">
              <input
                type="text"
                className="form-input"
                aria-label={labels.companionCreateTitle}
                value={createName}
                maxLength={128}
                onChange={(event) => setCreateName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleCreate();
                }}
              />
              <button type="button" className="small-button" disabled={creating || createName.trim().length === 0} onClick={() => void handleCreate()}>
                {creating ? labels.authoredContentSaving : labels.companionCreateSubmit}
              </button>
            </div>
            {createNotice !== null && (
              <p role="status" className={createNotice === "saved" ? "success-banner" : "error-banner"}>
                {createNotice === "saved" ? labels.authoredContentSaved : labels.authoredContentError}
              </p>
            )}
          </section>

          <section aria-label={labels.cardImportTitle} data-card-import>
            <h3>{labels.cardImportTitle}</h3>
            <p className="management-settings-hint">{labels.cardImportHint}</p>
            {importStaged === null ? (
              <>
                <textarea
                  className="form-textarea"
                  rows={5}
                  placeholder='{"spec":"chara_card_v3","data":{"name":"…"}}'
                  value={importCardText}
                  onChange={(event) => setImportCardText(event.target.value)}
                />
                <div className="composer-actions">
                  <button
                    type="button"
                    className="small-button"
                    disabled={importBusy || importCardText.trim().length === 0}
                    onClick={() => void handleStageImport()}
                  >
                    {importBusy ? labels.cardImportStaging : labels.cardImportStage}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>
                  <strong>{importStaged.name}</strong>
                </p>
                <details>
                  <summary>{labels.cardImportFieldsTitle}</summary>
                  <ul data-import-fields>
                    {importStaged.fields.map((field) => (
                      <li key={field.field}>
                        {field.field} · {field.eligibility} · {field.chars} chars
                        {field.field === "persona_core" && field.chars > 4000 && (
                          <em className="management-settings-hint">{labels.cardImportLongHint.replace("{{chars}}", String(field.chars))}</em>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
                {importStaged.dispositions.length > 0 && (
                  <details>
                    <summary>{labels.cardImportDispositionsTitle}</summary>
                    <ul data-import-dispositions>
                      {importStaged.dispositions.map((disposition) => (
                        <li key={`${disposition.field}-${disposition.reason}`}>
                          {disposition.field} · {disposition.classification} · {disposition.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <div className="composer-actions">
                  <button
                    type="button"
                    className="small-button"
                    disabled={importBusy}
                    onClick={() => void handleConfirmImport()}
                  >
                    {importBusy ? labels.cardImportConfirming : labels.cardImportReviewSelected}
                  </button>
                </div>
              </>
            )}
            {importNotice !== null && (
              <p role="status" className={importNotice === "created" ? "success-banner" : "error-banner"}>
                {importNotice === "created" ? labels.cardImportCreated : labels.cardImportError}
              </p>
            )}
          </section>

          {persona !== "unavailable" && (
            <section aria-label={labels.personaEditTitle} data-persona-editor>
              <h3>{labels.personaEditTitle}</h3>
              <p className="management-settings-hint">{labels.personaEditHint}</p>
              {persona === "loading" ? (
                <p className="loading-text">{labels.openingChat}</p>
              ) : persona.present ? (
                <p>{labels.personaPresentHint}</p>
              ) : (
                <p>{labels.personaNotPresent}</p>
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
                    <button type="button" className="small-button" disabled={personaSaving || personaName.trim().length === 0} onClick={() => void handleSavePersona()}>
                      {personaSaving ? labels.authoredContentSaving : labels.personaSave}
                    </button>
                  </div>
                  {personaNotice !== null && (
                    <p role="status" className={personaNotice === "saved" ? "success-banner" : "error-banner"}>
                      {personaNotice === "saved" ? labels.authoredContentSaved : labels.authoredContentError}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {scenario !== "unavailable" && (
            <section aria-label={labels.scenarioEditTitle} data-scenario-editor>
              <h3>{labels.scenarioEditTitle}</h3>
              <p className="management-settings-hint">{labels.scenarioEditHint}</p>
              {scenario === "loading" ? (
                <p className="loading-text">{labels.openingChat}</p>
              ) : !scenario.present ? (
                <p>{labels.scenarioNotPresent}</p>
              ) : null}
              {scenario !== "loading" && (
                <>
                  <label className="management-settings-label" htmlFor="scenario-name">
                    {labels.personaName}
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
                    {labels.personaDescription}
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
                    <button type="button" className="small-button" disabled={scenarioSaving || scenarioName.trim().length === 0 || scenarioDescription.trim().length === 0} onClick={() => void handleSaveScenario()}>
                      {scenarioSaving ? labels.authoredContentSaving : labels.scenarioSave}
                    </button>
                  </div>
                  {scenarioNotice !== null && (
                    <p role="status" className={scenarioNotice === "saved" ? "success-banner" : "error-banner"}>
                      {scenarioNotice === "saved" ? labels.authoredContentSaved : labels.authoredContentError}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {greeting !== "unavailable" && (
            <section aria-label={labels.greetingEditTitle} data-greeting-editor>
              <h3>{labels.greetingEditTitle}</h3>
              <p className="management-settings-hint">{labels.greetingEditHint}</p>
              {greeting === "loading" ? (
                <p className="loading-text">{labels.openingChat}</p>
              ) : !greeting.present ? (
                <p>{labels.greetingNotPresent}</p>
              ) : null}
              {greeting !== "loading" && (
                <>
                  <label className="management-settings-label" htmlFor="greeting-label">
                    {labels.greetingVariantLabel}
                  </label>
                  <input
                    id="greeting-label"
                    type="text"
                    className="form-input"
                    value={greetingLabel}
                    maxLength={128}
                    onChange={(event) => setGreetingLabel(event.target.value)}
                  />
                  {greetingVariants.map((variant, index) => (
                    <div key={index} className="greeting-variant-row">
                      <label className="management-settings-label" htmlFor={`greeting-variant-${index}-text`}>
                        {labels.greetingVariantText} #{index + 1}
                      </label>
                      <textarea
                        id={`greeting-variant-${index}-text`}
                        className="form-textarea"
                        rows={2}
                        value={variant.text}
                        maxLength={8192}
                        onChange={(event) =>
                          setGreetingVariants((current) =>
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
                          disabled={greetingVariants.length <= 1}
                          onClick={() =>
                            setGreetingVariants((current) => current.filter((_, itemIndex) => itemIndex !== index))
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
                      onClick={() => setGreetingVariants((current) => [...current, { label: "", text: "" }])}
                    >
                      {labels.greetingAddVariant}
                    </button>
                  </div>
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="small-button"
                      disabled={
                        greetingSaving ||
                        greetingVariants.every((variant) => variant.text.trim().length === 0)
                      }
                      onClick={() => void handleSaveGreeting()}
                    >
                      {greetingSaving ? labels.authoredContentSaving : labels.greetingSave}
                    </button>
                  </div>
                  {greetingNotice !== null && (
                    <p role="status" className={greetingNotice === "saved" ? "success-banner" : "error-banner"}>
                      {greetingNotice === "saved" ? labels.authoredContentSaved : labels.authoredContentError}
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