import { type ReactElement, useEffect, useState } from "react";
import { type Locale, messages } from "../i18n";
import { memoryNotebookLabels } from "./memory-notebook-labels";
import {
  CONNECTION_API_SHAPES,
  type MemoryChapterV1,
  type MemoryItemV1,
  problemTextWithCode,
  TavernProblemError,
  type TavernConnectionApiShapeV1,
  type TavernConnectionStateV1,
  type TavernConnectionThinkingLevelV1,
  type TavernConnectionV1,
  type TavernModelProfileV1,
  type TavernModelProfilesV1,
  type TavernRecommendedModelV1,
  type TavernVoiceDevicesV1,
  type TavernVoicePreferenceV1,
} from "../management-pipeline-api";

/**
 * The management panels (design/26 §4.2, design/28 §2), moved out of
 * ManagementApp so the composed player shell composes the same components
 * instead of re-implementing them. Nothing here decides capability: every panel
 * takes the validated Host read-back it must show and calls back for each
 * mutation, so an unpublished route renders as unavailable instead of as a
 * control the Host cannot serve.
 */
export type VoiceView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{
      kind: "ready";
      preference: TavernVoicePreferenceV1;
      devices: TavernVoiceDevicesV1 | null;
      pending: boolean;
    }>;

/**
 * The MIMO voice personas the picker offers, in the extension's own ids.
 *
 * The set is the vendored Voice extension's `MIMO_TTS_PERSONAS`
 * (vendor/pi-koe/src/mimo.ts:50): dialogue-web cannot import across that
 * submodule boundary at runtime, so this is the display-time mirror of it and
 * `tests/persona-catalogue-gate.test.mjs` pins the two identical - the list
 * can never drift silently. A persona the extension grows but this UI does not
 * know is still shown as its own id rather than lost (see the panel).
 */
export const MIMO_PERSONA_IDS = ["soft_maid", "gentle_maid", "energetic_youth", "steady_mature"] as const;

type MimoPersonaId = (typeof MIMO_PERSONA_IDS)[number];

/**
 * The catalogue's label per persona id. Each branch reads its key through
 * `labels.<key>` so the i18n parity gate can see the read; the union return type
 * makes a persona added without a label a compile error, the same way the `zh`
 * catalogue is pinned to the `en` keys.
 */
function personaLabel(personaId: MimoPersonaId, labels: ReturnType<typeof messages>): string {
  switch (personaId) {
    case "soft_maid":
      return labels.voicePersonaSoftMaid;
    case "gentle_maid":
      return labels.voicePersonaGentleMaid;
    case "energetic_youth":
      return labels.voicePersonaEnergeticYouth;
    case "steady_mature":
      return labels.voicePersonaSteadyMature;
  }
}

/** True when the id is one this picker knows, used only to keep an unknown id visible. */
function isKnownPersona(id: string): boolean {
  return (MIMO_PERSONA_IDS as readonly string[]).includes(id);
}

/**
 * Companion language state. The Host preference is the authority: the panel
 * adopts whatever it holds (so two browsers agree) and writes through it, never
 * keeping a local selection the durable store did not accept. The revision it
 * writes with is the one record's, held once (see `settingsRevisionRef`).
 */
export type LanguageView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "ready"; locale: string | null; pending: boolean }>;

/**
 * The languages the panel suggests for the companion. Suggestions only: the companion
 * language is the player's own BCP-47 tag, and the Host accepts any bounded tag. These
 * two are the ones this UI is itself localized for, so they are the useful starting
 * points. */
export const COMPANION_LANGUAGE_SUGGESTIONS = ["zh-CN", "en-US"] as const;

/**
 * The companion tag that corresponds to the UI's own language, used only to seed the
 * preference the first time (so the companion speaks what the player already sees).
 * Not a mapping the panel keeps applying: the two languages are separate choices. */
export function companionLocaleForUiLocale(locale: Locale): string {
  return locale === "en" ? "en-US" : "zh-CN";
}

/**
 * Connection panel state. `pending` is the one-management-mutation-at-a-time
 * guard: the durable document revision every mutation carries as its
 * compare-and-swap would otherwise turn a double click into a conflict.
 */
export type ConnectionView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "ready";
      state: TavernConnectionStateV1;
      pending: boolean;
      notice: "activation" | "busy" | "conflict" | null;
    }>;

/**
 * Model profiles state (design/28 §2.3). `pending` names the one surface whose
 * write is in flight: a second click would reuse the same durable revision and
 * manufacture a `settings_revision_conflict`. `notice` carries only closed
 * categories, and the panel always shows the durable read-back, never the local
 * choice.
 */
export type ModelProfilesView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{
      kind: "ready";
      profiles: TavernModelProfilesV1;
      pending: "chat" | "game" | null;
      notice: "conflict" | null;
    }>;

export type MemoryView =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{
      kind: "empty";
      projectionRevision: string;
      /** The continuity's narrative chapters; they exist independently of the Memory rows. */
      chapters: readonly MemoryChapterV1[];
    }>
  | Readonly<{
      kind: "ready";
      rows: readonly MemoryItemV1[];
      projectionRevision: string;
      chapters: readonly MemoryChapterV1[];
    }>;
export type ConnectionForm = Readonly<{
  providerId: string;
  apiKey: string;
  baseUrl: string;
  /** Player-supplied API shape, used only by the escape hatch. */
  apiShape: TavernConnectionApiShapeV1;
  /** Player-supplied model id, used only by the escape hatch. */
  modelId: string;
  /** Catalog model selection for every other provider. */
  catalogModelId: string;
  thinkingLevel: TavernConnectionThinkingLevelV1;
}>;

/**
 * The thinking levels the panel suggests. They are suggestions only: the Host
 * forwards whatever the player typed to the embedded runtime, which clamps a
 * level the chosen model does not advertise (design/28 §2.3.5).
 */
export const MODEL_PROFILE_THINKING_LEVEL_SUGGESTIONS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function modelProfileProblemText(error: unknown, labels: ReturnType<typeof messages>): string {
  if (error instanceof TavernProblemError) {
    if (error.code === "settings_revision_conflict") return labels.modelProfilesRevisionConflict;
    if (error.code === "invalid_request") return labels.modelProfilesModelRequired;
  }
  return problemTextWithCode(labels.failure, error);
}

/**
 * One surface's model editor (design/28 §2.3). The player types the model id and
 * the thinking level; the shipped catalog is offered as suggestions the player
 * may click or ignore, and typing any other model name saves just as well,
 * because a recommended model is never the upper bound of what may be chosen.
 * The controls always show the durable read-back, never the local choice.
 */
export function ModelProfileEditor({
  surface,
  surfaceLabel,
  profile,
  suggestions,
  labels,
  pending,
  onSave,
}: Readonly<{
  surface: "chat" | "game";
  surfaceLabel: string;
  profile: TavernModelProfileV1;
  suggestions: readonly TavernRecommendedModelV1[];
  labels: ReturnType<typeof messages>;
  pending: "chat" | "game" | null;
  onSave: (modelId: string, thinkingLevel: string) => void;
}>): ReactElement {
  const [modelId, setModelId] = useState(profile.modelId);
  const [thinkingLevel, setThinkingLevel] = useState(profile.thinkingLevel);
  // Adopt the durable profile whenever it changes: a save's read-back is the
  // only thing the editor ever shows.
  useEffect(() => {
    setModelId(profile.modelId);
    setThinkingLevel(profile.thinkingLevel);
  }, [profile.modelId, profile.thinkingLevel]);
  const busy = pending !== null;
  const dirty = modelId !== profile.modelId || thinkingLevel !== profile.thinkingLevel;
  const canSave = !busy && dirty && modelId.trim().length > 0 && thinkingLevel.trim().length > 0;
  return (
    <form
      className="model-profile-editor"
      data-model-profile-surface={surface}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave(modelId.trim(), thinkingLevel.trim());
      }}
    >
      <h3>{surfaceLabel}</h3>
      <label htmlFor={`model-profile-model-${surface}`}>{labels.modelProfilesModelId}</label>
      <input
        id={`model-profile-model-${surface}`}
        className="form-input"
        list={`model-profile-suggestions-${surface}`}
        value={modelId}
        disabled={busy}
        onChange={(event) => setModelId(event.target.value)}
      />
      <datalist id={`model-profile-suggestions-${surface}`}>
        {suggestions.map((model) => (
          <option key={`${model.providerId}:${model.modelId}`} value={model.modelId} />
        ))}
      </datalist>
      <label htmlFor={`model-profile-level-${surface}`}>{labels.modelProfilesThinkingLevel}</label>
      <input
        id={`model-profile-level-${surface}`}
        className="form-input"
        list={`model-profile-thinking-levels-${surface}`}
        value={thinkingLevel}
        disabled={busy}
        onChange={(event) => setThinkingLevel(event.target.value)}
      />
      <datalist id={`model-profile-thinking-levels-${surface}`}>
        {MODEL_PROFILE_THINKING_LEVEL_SUGGESTIONS.map((level) => (
          <option key={level} value={level} />
        ))}
      </datalist>
      <div className="model-profile-suggestions" data-model-profile-suggestions>
        <span>{labels.modelProfilesRecommended}</span>
        {/*
         * One chip per model id. The catalog can list the same model under more
         * than one provider, and the chip is about the id a player may type - a
         * repeated chip is noise, and it makes the same suggestion ambiguous to a
         * screen reader and to anything addressing buttons by name.
         */}
        {[...new Map(suggestions.map((model) => [model.modelId, model])).values()].map((model) => (
          <button
            key={model.modelId}
            type="button"
            className="model-profile-chip"
            disabled={busy}
            onClick={() => setModelId(model.modelId)}
          >
            {model.modelId}
          </button>
        ))}
      </div>
      {/*
       * Named after its surface. A bare "Save" here would collide with every other
       * save on the management surface, which is ambiguous for a screen reader and
       * for anything that addresses the control by name.
       */}
      <button
        type="submit"
        className="small-button"
        aria-label={`${labels.modelProfilesApply} ${surfaceLabel}`}
        disabled={!canSave}
      >
        {labels.modelProfilesApply}
      </button>
    </form>
  );
}

export function ModelProfilesPanel({
  view,
  labels,
  onSave,
}: Readonly<{
  view: Extract<ModelProfilesView, { kind: "ready" }>;
  labels: ReturnType<typeof messages>;
  onSave: (surface: "chat" | "game", modelId: string, thinkingLevel: string) => void;
}>): ReactElement {
  return (
    <section className="management-settings-section" aria-label={labels.modelProfilesTitle} data-model-profiles>
      <h2>{labels.modelProfilesTitle}</h2>
      <p className="management-settings-hint" data-model-profiles-hint>
        {labels.modelProfilesHint}
      </p>
      {view.notice === "conflict" && (
        <p className="warning-banner" data-model-profiles-conflict>
          {labels.modelProfilesRevisionConflict}
        </p>
      )}
      <ModelProfileEditor
        surface="chat"
        surfaceLabel={labels.modelProfilesChat}
        profile={view.profiles.chat}
        suggestions={view.profiles.recommendedModels}
        labels={labels}
        pending={view.pending}
        onSave={(modelId, thinkingLevel) => onSave("chat", modelId, thinkingLevel)}
      />
      <ModelProfileEditor
        surface="game"
        surfaceLabel={labels.modelProfilesGame}
        profile={view.profiles.game}
        suggestions={view.profiles.recommendedModels}
        labels={labels}
        pending={view.pending}
        onSave={(modelId, thinkingLevel) => onSave("game", modelId, thinkingLevel)}
      />
    </section>
  );
}

export function connectionProblemText(error: unknown, labels: ReturnType<typeof messages>): string {
  if (error instanceof TavernProblemError) {
    if (error.code === "dialogue_busy") return labels.connectionBusy;
    if (error.code === "connection_conflict") return labels.connectionRevisionConflict;
    if (error.code === "connection_not_ready") return labels.connectionActivateRequiresReady;
  }
  return problemTextWithCode(labels.failure, error);
}

export function connectionReadinessText(
  readiness: TavernConnectionV1["readiness"],
  labels: ReturnType<typeof messages>,
): string {
  if (readiness === "ready") return labels.connectionReadinessReady;
  if (readiness === "failed") return labels.connectionReadinessFailed;
  if (readiness === "unconfigured") return labels.connectionReadinessUnconfigured;
  return labels.connectionReadinessConfigured;
}

/**
 * Maps one closed probe category to its player notice. The category is the
 * whole vocabulary a failed probe may produce; raw provider text never reaches
 * the browser in the first place.
 */
export function connectionFailureText(
  failure: TavernConnectionV1["failure"],
  labels: ReturnType<typeof messages>,
): string | null {
  if (failure === null) return null;
  const suffix = failure
    .split("_")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join("");
  const key = `connectionFailure${suffix}` as
    | "connectionFailureInvalidEndpoint"
    | "connectionFailureNotConfigured"
    | "connectionFailureUnauthorized"
    | "connectionFailureNotFound"
    | "connectionFailureUnreachable"
    | "connectionFailureTimeout"
    | "connectionFailureInvalidResponse";
  return labels[key];
}

export function ConnectionSettingsPanel({
  connectionView,
  labels,
  onCreate,
  onTest,
  onActivate,
  onSelectModel,
  onRemove,
}: Readonly<{
  connectionView: Extract<ConnectionView, { kind: "ready" }>;
  labels: ReturnType<typeof messages>;
  onCreate: (form: ConnectionForm) => Promise<boolean>;
  onTest: (connectionId: string) => void;
  onActivate: (connectionId: string) => void;
  onSelectModel: (connectionId: string, modelId: string, thinkingLevel: TavernConnectionThinkingLevelV1) => void;
  onRemove: (connectionId: string) => void;
}>): ReactElement {
  const [providerId, setProviderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  // The escape hatch is the one entry whose API shape the player chooses. The
  // OpenAI-compatible default is preselected because that is the entry's own
  // name; the value is always sent, never inferred by the Host.
  const [apiShape, setApiShape] = useState<TavernConnectionApiShapeV1>("openai-completions");
  const [modelId, setModelId] = useState("");
  const [catalogModelId, setCatalogModelId] = useState("");

  const providers = connectionView.state.providers;
  // The escape hatch is a catalog entry like any other; it is preselected only
  // because a player reaching this panel usually has no connection at all.
  const selected =
    providers.find((entry) => entry.providerId === providerId) ??
    providers.find((entry) => entry.escapeHatch) ??
    providers[0];
  const models = selected?.allowedPlayerModels ?? [];
  const chosenModel = models.find((model) => model.modelId === catalogModelId) ?? models[0];

  return (
    <section className="management-settings-section" aria-label={labels.connectionSettings} data-connection-settings>
      <h2>{labels.connectionSettings}</h2>
      <>
        <dl className="management-settings-details" data-connection-active>
          <div>
            <dt>{labels.connectionActiveLabel}</dt>
            <dd data-connection-active-value>
              {connectionView.state.active === null ? labels.connectionNoneActive : connectionView.state.active.label}
            </dd>
          </div>
        </dl>
        {connectionView.state.active === null && (
          <p className="warning-banner" data-connection-no-selection>
            {labels.connectionNoSelectionNotice}
          </p>
        )}
        {connectionView.notice === "activation" && (
          <p className="success-banner" data-connection-activated>
            {labels.connectionActivationNotice}
          </p>
        )}
        {connectionView.notice === "busy" && (
          <p className="warning-banner" data-connection-busy>
            {labels.connectionBusy}
          </p>
        )}
        {connectionView.notice === "conflict" && (
          <p className="warning-banner" data-connection-conflict>
            {labels.connectionRevisionConflict}
          </p>
        )}

        <form
          className="connection-form"
          data-connection-form
          onSubmit={(event) => {
            event.preventDefault();
            if (selected === undefined) return;
            void onCreate({
              providerId: selected.providerId,
              apiKey,
              baseUrl,
              apiShape,
              modelId,
              catalogModelId: chosenModel?.modelId ?? catalogModelId,
              thinkingLevel: chosenModel?.defaultThinkingLevel ?? "high",
            }).then((saved) => {
              // The credential is write-only: a saved connection is never
              // readable back, so once it is stored the field must not keep
              // the secret in the document (the test's outerHTML scan finds
              // it there). Only a durable save clears it; a rejected save
              // keeps the typed value so the player can retry.
              if (saved) setApiKey("");
            });
          }}
        >
          <label htmlFor="connection-provider">{labels.connectionProvider}</label>
          <select
            id="connection-provider"
            className="form-select"
            disabled={connectionView.pending}
            value={selected?.providerId ?? ""}
            onChange={(event) => {
              setProviderId(event.target.value);
              setCatalogModelId("");
            }}
          >
            {providers.map((provider) => (
              <option key={provider.providerId} value={provider.providerId}>
                {provider.escapeHatch ? labels.connectionEscapeHatch : provider.label}
                {provider.environmentManaged ? ` — ${labels.connectionEnvironmentManaged}` : ""}
              </option>
            ))}
          </select>
          {selected?.escapeHatch === true && <p className="field-hint">{labels.connectionEscapeHatchHint}</p>}

          {selected?.setupFields.includes("baseUrl") === true && (
            <>
              <label htmlFor="connection-base-url">{labels.connectionBaseUrl}</label>
              <input
                id="connection-base-url"
                className="form-input"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                disabled={connectionView.pending}
                placeholder={labels.connectionBaseUrlHint}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </>
          )}

          {selected?.setupFields.includes("apiShape") === true && (
            <>
              <label htmlFor="connection-api-shape">{labels.connectionApiShape}</label>
              <select
                id="connection-api-shape"
                className="form-select"
                disabled={connectionView.pending}
                value={apiShape}
                onChange={(event) => setApiShape(event.target.value as TavernConnectionApiShapeV1)}
              >
                {CONNECTION_API_SHAPES.map((shape) => (
                  <option key={shape} value={shape}>
                    {shape}
                  </option>
                ))}
              </select>
              <p className="field-hint">{labels.connectionApiShapeHint}</p>
            </>
          )}

          {selected?.setupFields.includes("apiKey") === true && (
            <>
              <label htmlFor="connection-api-key">{labels.connectionApiKey}</label>
              <input
                id="connection-api-key"
                className="form-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={connectionView.pending}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <p className="field-hint">{labels.connectionApiKeyWriteOnly}</p>
            </>
          )}

          {/*
           * A local server that needs no credential still needs a value here, because the runtime
           * rejects a provider with no key at all. pi's own documentation answers this with a
           * placeholder ("the dummy key makes the model available to Pi; Ollama ignores it"), so the
           * panel says that instead of leaving the player to guess.
           */}
          {selected?.escapeHatch === true && <p className="field-hint">{labels.connectionApiKeyLocalHint}</p>}

          {selected?.escapeHatch === true ? (
            <>
              <label htmlFor="connection-model-id">{labels.connectionModelId}</label>
              <input
                id="connection-model-id"
                className="form-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                disabled={connectionView.pending}
                placeholder={labels.connectionModelIdHint}
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              />
            </>
          ) : (
            <>
              <label htmlFor="connection-model">{labels.connectionModel}</label>
              <select
                id="connection-model"
                className="form-select"
                disabled={connectionView.pending || models.length === 0}
                value={chosenModel?.modelId ?? ""}
                onChange={(event) => setCatalogModelId(event.target.value)}
              >
                {models.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.modelLabel}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="composer-actions">
            <button type="submit" className="small-button" disabled={connectionView.pending}>
              {labels.connectionSave}
            </button>
          </div>
        </form>

        {connectionView.state.connections.length > 0 && (
          <div data-connection-list>
            <h3>{labels.connectionListTitle}</h3>
            <ul className="connection-rows">
              {connectionView.state.connections.map((connection) => (
                <ConnectionRow
                  key={connection.connectionId}
                  connection={connection}
                  pending={connectionView.pending}
                  labels={labels}
                  onTest={onTest}
                  onActivate={onActivate}
                  onSelectModel={onSelectModel}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          </div>
        )}
      </>
    </section>
  );
}

/**
 * One saved connection. `connectionId` is never rendered: every control keys
 * off it, but the player reads the provider label, the model and their own
 * base URL (design/28 §1, §5.1).
 */
export function ConnectionRow({
  connection,
  pending,
  labels,
  onTest,
  onActivate,
  onSelectModel,
  onRemove,
}: Readonly<{
  connection: TavernConnectionV1;
  pending: boolean;
  labels: ReturnType<typeof messages>;
  onTest: (connectionId: string) => void;
  onActivate: (connectionId: string) => void;
  onSelectModel: (connectionId: string, modelId: string, thinkingLevel: TavernConnectionThinkingLevelV1) => void;
  onRemove: (connectionId: string) => void;
}>): ReactElement {
  const failure = connectionFailureText(connection.failure, labels);
  // Offer exactly what the chosen model accepts. The Host refuses a level the model
  // does not advertise, so listing every level would hand the player options that
  // cannot be saved. The record's own `allowedThinkingLevels` is the authority.
  const levels: readonly TavernConnectionThinkingLevelV1[] =
    connection.allowedThinkingLevels.length > 0 ? connection.allowedThinkingLevels : ["high"];
  return (
    <li className="connection-row" data-connection-row data-readiness={connection.readiness}>
      <dl className="management-settings-details">
        <div>
          <dt>{labels.connectionProvider}</dt>
          <dd>{connection.providerLabel}</dd>
        </div>
        <div>
          <dt>{labels.connectionModel}</dt>
          <dd>{connection.modelLabel}</dd>
        </div>
        {connection.baseUrl !== null && (
          <div>
            <dt>{labels.connectionBaseUrl}</dt>
            <dd data-connection-base-url>{connection.baseUrl}</dd>
          </div>
        )}
        <div>
          <dt>{labels.connectionReadiness}</dt>
          <dd>{connectionReadinessText(connection.readiness, labels)}</dd>
        </div>
        {failure !== null && (
          <div>
            <dt>—</dt>
            <dd data-connection-failure>{failure}</dd>
          </div>
        )}
      </dl>
      <div className="composer-actions">
        <label className="visually-hidden-input-label" htmlFor={`connection-level-${connection.connectionId}`}>
          {labels.connectionThinkingLevel}
        </label>
        <select
          id={`connection-level-${connection.connectionId}`}
          className="form-select"
          disabled={pending}
          value={connection.thinkingLevel}
          onChange={(event) =>
            onSelectModel(
              connection.connectionId,
              connection.modelId,
              event.target.value as TavernConnectionThinkingLevelV1,
            )
          }
        >
          {levels.map((level) => (
            <option key={level} value={level}>
              {
                {
                  off: labels.connectionLevelOff,
                  minimal: labels.connectionLevelMinimal,
                  low: labels.connectionLevelLow,
                  medium: labels.connectionLevelMedium,
                  high: labels.connectionLevelHigh,
                  xhigh: labels.connectionLevelXHigh,
                  max: labels.connectionLevelMax,
                }[level]
              }
            </option>
          ))}
        </select>
        <button
          type="button"
          className="small-button"
          disabled={pending}
          onClick={() => onTest(connection.connectionId)}
        >
          {labels.connectionTest}
        </button>
        <button
          type="button"
          className="small-button"
          disabled={pending || connection.readiness !== "ready" || connection.active}
          title={connection.readiness === "ready" ? undefined : labels.connectionActivateRequiresReady}
          onClick={() => onActivate(connection.connectionId)}
        >
          {labels.connectionActivate}
        </button>
        <button
          type="button"
          className="small-button"
          disabled={pending || connection.active}
          title={connection.active ? labels.connectionRemoveActiveRefused : undefined}
          onClick={() => onRemove(connection.connectionId)}
        >
          {labels.connectionRemove}
        </button>
      </div>
    </li>
  );
}

/**
 * Human-readable name for a companion language tag. Tags this UI has a name for get it;
 * any other bounded tag is shown as the tag itself, because the panel must not claim a
 * language is one of two when the player chose something else.
 */
export function companionLanguageLabel(tag: string, labels: ReturnType<typeof messages>): string {
  const normalized = tag.toLowerCase();
  if (normalized === "zh-cn" || normalized === "zh") return labels.languageChinese;
  if (normalized === "en-us" || normalized === "en") return labels.languageEnglish;
  return tag;
}

export function LanguageSettingsPanel({
  languageView,
  uiLocale,
  labels,
  onSelectLanguage,
  onSelectUiLanguage,
}: Readonly<{
  languageView: LanguageView;
  uiLocale: Locale;
  labels: ReturnType<typeof messages>;
  onSelectLanguage: (locale: string) => void;
  onSelectUiLanguage: (locale: Locale) => void;
}>): ReactElement {
  const companionTag = languageView.kind === "ready" ? languageView.locale : null;
  const [draft, setDraft] = useState<string | null>(null);
  const submit = (): void => {
    const next = draft?.trim();
    setDraft(null);
    if (next !== undefined && next.length > 0 && next !== companionTag) onSelectLanguage(next);
  };
  return (
    <section className="management-settings-section" aria-label={labels.languageSettings} data-language-settings>
      <h2>{labels.languageSettings}</h2>
      <p>{labels.languageHint}</p>
      {languageView.kind === "loading" && <p>{labels.loading}</p>}
      {languageView.kind === "unavailable" && <p>{labels.languageUnavailable}</p>}
      {languageView.kind === "error" && <p>{labels.failure}</p>}
      {languageView.kind === "ready" && (
        <div className="voice-device-selector">
          <label htmlFor="companion-language">{labels.languageCompanionField}</label>
          {/*
           * A tag the player can type, not a two-option list. The suggestions name the
           * two languages this UI is itself localized for; any other bounded BCP-47 tag
           * saves just as well, and the committed value is shown as the tag itself.
           */}
          <input
            id="companion-language"
            className="form-input"
            list="companion-language-suggestions"
            disabled={languageView.pending}
            value={draft ?? companionTag ?? ""}
            placeholder={labels.languageCompanionPlaceholder}
            data-companion-language-value={companionTag ?? ""}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={submit}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
          />
          <datalist id="companion-language-suggestions">
            {COMPANION_LANGUAGE_SUGGESTIONS.map((tag) => (
              <option key={tag} value={tag}>
                {tag === "zh-CN" ? labels.languageChinese : labels.languageEnglish}
              </option>
            ))}
          </datalist>
          {companionTag !== null && (
            <p className="management-settings-hint" data-companion-language-current>
              {companionLanguageLabel(companionTag, labels)}
            </p>
          )}
        </div>
      )}
      {/* The interface's own display language: a separate choice from the companion's. */}
      <div className="voice-device-selector">
        <label htmlFor="ui-language">{labels.languageUiField}</label>
        <select
          id="ui-language"
          className="form-select"
          value={uiLocale}
          onChange={(event) => onSelectUiLanguage(event.target.value === "en" ? "en" : "zh-CN")}
        >
          <option value="zh-CN">{labels.languageChinese}</option>
          <option value="en">{labels.languageEnglish}</option>
        </select>
        <p className="management-settings-hint">{labels.languageUiHint}</p>
      </div>
    </section>
  );
}

export function VoiceSettingsPanel({
  voiceView,
  labels,
  onAccept,
  onRevoke,
  onSelectDevice,
  onSelectPersona,
}: Readonly<{
  voiceView: VoiceView;
  labels: ReturnType<typeof messages>;
  onAccept: () => void;
  onRevoke: () => void;
  onSelectDevice: (deviceId: string | null) => void;
  onSelectPersona: (persona: string | null) => void;
}>): ReactElement {
  return (
    <section className="management-settings-section" aria-label={labels.voiceSettings} data-voice-settings>
      <h2>{labels.voiceSettings}</h2>
      <p>{labels.voiceDisclosure}</p>
      {voiceView.kind === "loading" && <p>{labels.loading}</p>}
      {voiceView.kind === "unavailable" && <p>{labels.voiceSettingsUnavailable}</p>}
      {voiceView.kind === "error" && <p>{labels.failure}</p>}
      {voiceView.kind === "ready" && (
        <>
          <dl className="management-settings-details">
            <div>
              <dt>{labels.voiceConsent}</dt>
              <dd>
                {
                  labels[
                    `voiceConsent${voiceView.preference.consent[0].toUpperCase()}${voiceView.preference.consent.slice(1)}` as
                      | "voiceConsentUndecided"
                      | "voiceConsentAccepted"
                      | "voiceConsentRevoked"
                  ]
                }
              </dd>
            </div>
            <div>
              <dt>{labels.voiceDisclosureVersion}</dt>
              <dd>{voiceView.preference.disclosureVersion ?? labels.voiceDisclosureUndisclosed}</dd>
            </div>
          </dl>
          <div className="composer-actions">
            <button
              type="button"
              className="small-button"
              onClick={onAccept}
              disabled={voiceView.pending || voiceView.preference.consent === "accepted"}
            >
              {labels.voiceAccept}
            </button>
            <button
              type="button"
              className="small-button"
              onClick={onRevoke}
              disabled={voiceView.pending || voiceView.preference.consent === "revoked"}
            >
              {labels.voiceRevoke}
            </button>
          </div>
          <div className="voice-device-selector">
            <label htmlFor="voice-output-device">{labels.voiceOutputDevice}</label>
            <select
              id="voice-output-device"
              className="form-select"
              disabled={voiceView.pending}
              value={voiceView.preference.outputDevice ?? ""}
              onChange={(event) => onSelectDevice(event.target.value === "" ? null : event.target.value)}
            >
              {/* The Windows default endpoint is always selectable and maps
                  to `outputDevice: null` (resolve at each open), so a pinned
                  endpoint can always be released — even when enumeration
                  currently returns nothing. */}
              <option value="">{labels.voiceDefaultOutput}</option>
              {(voiceView.devices?.devices ?? []).map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
              {voiceView.preference.outputDevice !== null &&
                !(voiceView.devices?.devices ?? []).some(
                  (device) => device.id === voiceView.preference.outputDevice,
                ) && (
                  // The persisted pin outlives one enumeration (endpoint
                  // unplugged or the gateway is temporarily unavailable). The
                  // effective selection must stay visible instead of silently
                  // rendering an empty select; it is shown, not re-offered.
                  <option key={voiceView.preference.outputDevice} value={voiceView.preference.outputDevice} disabled>
                    {labels.voicePinnedOutputUnlisted}
                  </option>
                )}
            </select>
          </div>
          <div className="voice-device-selector">
            <label htmlFor="voice-persona">{labels.voicePersona}</label>
            <select
              id="voice-persona"
              className="form-select"
              disabled={voiceView.pending}
              value={voiceView.preference.persona ?? ""}
              onChange={(event) => onSelectPersona(event.target.value === "" ? null : event.target.value)}
            >
              {/* No persona leaves the gateway variable unset, which the
                  extension distinguishes from an empty string. */}
              <option value="">{labels.voicePersonaDefault}</option>
              {MIMO_PERSONA_IDS.map((personaId) => (
                <option key={personaId} value={personaId}>
                  {personaLabel(personaId, labels)}
                </option>
              ))}
              {voiceView.preference.persona !== null && !isKnownPersona(voiceView.preference.persona) && (
                // The extension can grow a persona this UI does not know: the
                // persisted selection stays visible as its own id instead of
                // rendering an empty select. Shown, not re-offered.
                <option key={voiceView.preference.persona} value={voiceView.preference.persona}>
                  {voiceView.preference.persona}
                </option>
              )}
            </select>
            <p className="management-settings-hint">{labels.voicePersonaHint}</p>
          </div>
        </>
      )}
    </section>
  );
}

export const MEMORY_STATUS_LABELS: Readonly<Record<string, { en: string; zh: string }>> = {
  active: { en: "Active", zh: "活跃" },
  permanent: { en: "Permanent", zh: "长期" },
  archived: { en: "Archived", zh: "已归档" },
};

/**
 * The one dimension the Memory audit filters on. The Host has separated
 * `origin: "player" | "companion"` all along, so the panel offers exactly that
 * split and nothing else: a player asking "what did she remember on her own"
 * reads one list instead of scanning a mixed one. No other dimension is
 * invented here, because the Host publishes no other one.
 */
type MemoryOriginFilter = "all" | "player" | "companion";

/** The panel heading, which also names the filter group below it. */
const MEMORY_TITLE_ID = "tavern-memory-title";

export function MemoryPanel({
  memoryView,
  labels,
  locale,
  onRefresh,
  mutationAvailable,
  onMutate,
}: Readonly<{
  memoryView: MemoryView;
  labels: ReturnType<typeof messages>;
  locale: Locale;
  onRefresh: () => void;
  mutationAvailable: boolean;
  onMutate: (
    input:
      | { operation: "create"; content: string }
      | { operation: "update"; handle: string; content: string }
      | { operation: "archive"; handle: string }
      | { operation: "update_chapter"; handle: string; content: string }
      | { operation: "delete_chapter"; handle: string },
  ) => void;
}>): ReactElement {
  const statusText = (status: string, pinned: boolean): string => {
    const base = MEMORY_STATUS_LABELS[status]?.[locale === "zh-CN" ? "zh" : "en"] ?? status;
    const pinnedLabel = locale === "zh-CN" ? "固定" : "Pinned";
    return pinned ? `${base} · ${pinnedLabel}` : base;
  };
  // The filter is presentation state, not a projection: switching it re-reads
  // nothing, and the mounted rows are what it narrows.
  const [originFilter, setOriginFilter] = useState<MemoryOriginFilter>("all");
  // Manual authoring is real (`memory.mutate`) but secondary: it is the one
  // control a player has to open, so the surface reads as the companion's own
  // notebook rather than as a form the player fills.
  const [authoringOpen, setAuthoringOpen] = useState(false);
  // Which chapter is being corrected, and the player's draft for it. The draft is
  // per-open, so switching chapters never carries one draft into another.
  const [correctingHandle, setCorrectingHandle] = useState<string | null>(null);
  const [chapterDraft, setChapterDraft] = useState("");
  const rows = memoryView.kind === "ready" ? memoryView.rows : [];
  const chapters = memoryView.kind === "ready" || memoryView.kind === "empty" ? memoryView.chapters : [];
  const visibleRows = originFilter === "all" ? rows : rows.filter((item) => item.origin === originFilter);
  // The notebook's own words, selected by this mount's locale.
  const notebook = memoryNotebookLabels(locale);

  // The notebook card is the surface's first line, and its number is the
  // projection the Host just returned - never an optimistic local count. With
  // nothing written yet the card still says what the notebook is and how it
  // fills - the player asking her to keep something - so an empty projection
  // reads as "not yet" rather than as a blank form or as a promise of a writer
  // production does not run. Both sentences carry that number as text, because
  // a count that exists only as an element attribute is not something a player
  // can read.
  const notebookState: "ready" | "loading" | "empty" | "unavailable" | "error" =
    memoryView.kind === "loading"
      ? "loading"
      : memoryView.kind === "unavailable"
        ? "unavailable"
        : memoryView.kind === "error"
          ? "error"
          : memoryView.kind === "empty"
            ? "empty"
            : "ready";
  const notebookText =
    notebookState === "loading"
      ? labels.loading
      : notebookState === "unavailable"
        ? notebook.unavailable
        : notebookState === "error"
          ? notebook.failed
          : notebookState === "empty"
            ? notebook.empty.replace("{{count}}", String(rows.length))
            : notebook.count.replace("{{count}}", String(rows.length));
  return (
    <section className="tavern-memory-section" aria-label={notebook.title} data-memory-panel>
      <div className="tavern-memory-header">
        <h2 className="tavern-memory-title" id={MEMORY_TITLE_ID}>
          {notebook.title}
        </h2>
        <button type="button" className="small-button" onClick={onRefresh} title={labels.refreshMemory}>
          {labels.refreshMemory}
        </button>
      </div>
      {/*
        The notebook card: the notebook, its promise, and the real accumulated
        count. The same card whether the notebook has entries or not, so a player
        who has just started still learns how it fills - the feature says it
        exists by behaving, not by explaining itself.
      */}
      <aside className="memory-notebook" data-memory-notebook>
        <p className="memory-notebook-promise">{notebook.promise}</p>
        <p
          className="memory-notebook-count"
          data-memory-state={notebookState === "ready" ? undefined : notebookState}
          data-memory-count={notebookState === "ready" || notebookState === "empty" ? rows.length : undefined}
        >
          {notebookText}
        </p>
      </aside>
      {chapters.length > 0 && (
        <section className="memory-chapters" aria-label={labels.memoryChapters} data-memory-chapters>
          <h3 className="memory-chapters-title">{labels.memoryChapters}</h3>
          <p className="memory-chapters-hint">{labels.memoryChaptersHint}</p>
          <ul className="memory-chapter-list">
            {chapters.map((chapter) => {
              const badge =
                chapter.status === "deleted"
                  ? labels.memoryChapterDeleted
                  : chapter.status === "edited"
                    ? labels.memoryChapterEdited
                    : labels.memoryChapterSealed;
              return (
                <li key={chapter.handle} className="memory-chapter" data-memory-chapter={chapter.status}>
                  <div className="memory-chapter-head">
                    <h4 className="memory-chapter-name">{chapter.title}</h4>
                    <span className="memory-chapter-span">{chapter.span}</span>
                    <span className="memory-chapter-badge" data-memory-chapter-badge={chapter.status}>
                      {badge}
                    </span>
                  </div>
                  {correctingHandle === chapter.handle ? (
                    <div className="memory-chapter-correct">
                      <textarea
                        className="form-textarea"
                        aria-label={labels.memoryChapterEdit}
                        value={chapterDraft}
                        onChange={(event) => setChapterDraft(event.target.value)}
                        rows={3}
                      />
                      <div className="memory-chapter-actions">
                        <button
                          type="button"
                          className="small-button"
                          disabled={chapterDraft.trim().length === 0}
                          onClick={() => {
                            onMutate({ operation: "update_chapter", handle: chapter.handle, content: chapterDraft });
                            setCorrectingHandle(null);
                          }}
                        >
                          {labels.memoryChapterSave}
                        </button>
                        <button type="button" className="small-button" onClick={() => setCorrectingHandle(null)}>
                          {labels.memoryChapterCancel}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="memory-chapter-body">{chapter.content}</p>
                  )}
                  {/*
                    A removed chapter keeps its place and its body, so the removal is a fact the player can
                    see rather than a row that quietly disappeared - and it offers no action, because bringing
                    it back would be a new act, not an undo.
                  */}
                  {mutationAvailable && chapter.status !== "deleted" && correctingHandle !== chapter.handle && (
                    <div className="memory-chapter-actions">
                      <button
                        type="button"
                        className="small-button"
                        onClick={() => {
                          setChapterDraft(chapter.content);
                          setCorrectingHandle(chapter.handle);
                        }}
                      >
                        {labels.memoryChapterEdit}
                      </button>
                      <button
                        type="button"
                        className="small-button"
                        onClick={() => onMutate({ operation: "delete_chapter", handle: chapter.handle })}
                      >
                        {labels.memoryChapterRemove}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {memoryView.kind === "ready" && (
        // The group is named by the panel's own heading, so no string exists only
        // for the filter and the two origin chips keep the labels the rows
        // themselves already use.
        <div className="memory-filter" role="group" aria-labelledby={MEMORY_TITLE_ID} data-memory-filter-group>
          {(
            [
              ["all", labels.memoryFilterAll],
              ["player", labels.originPlayer],
              ["companion", labels.originCompanion],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="memory-filter-chip"
              data-memory-filter={value}
              aria-pressed={originFilter === value}
              // A pressed chip is its own release: pressing it again clears the
              // filter back to All, so the player is never stuck inside a slice.
              onClick={() => setOriginFilter(originFilter === value ? "all" : value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {memoryView.kind === "ready" && visibleRows.length === 0 && (
        // Still the one "nothing recorded" line: under an active filter it reads
        // as "none of these", and the pressed chip says which slice is shown.
        <div className="state-placeholder" data-memory-state="filtered-empty">
          <p className="loading-text">{labels.noMemories}</p>
        </div>
      )}
      {memoryView.kind === "ready" && visibleRows.length > 0 && (
        <div className="memory-list" role="list" data-memory-state="ready" data-memory-filter={originFilter}>
          {visibleRows.map((item) => (
            <MemoryRow
              key={item.handle}
              item={item}
              statusText={statusText(item.status, item.pinned)}
              originText={item.origin === "player" ? labels.originPlayer : labels.originCompanion}
              categoryText={item.category === "semantic" ? notebook.categorySemantic : notebook.categoryInteraction}
              labels={labels}
              mutationAvailable={mutationAvailable}
              onUpdate={(content) => onMutate({ operation: "update", handle: item.handle, content })}
              onArchive={() => onMutate({ operation: "archive", handle: item.handle })}
            />
          ))}
        </div>
      )}
      {mutationAvailable && (
        <div className="memory-authoring" data-memory-authoring>
          <button
            type="button"
            className="memory-authoring-toggle"
            data-memory-authoring-toggle
            aria-expanded={authoringOpen}
            onClick={() => setAuthoringOpen((open) => !open)}
          >
            {authoringOpen ? notebook.authoringClose : notebook.authoringOpen}
          </button>
          {authoringOpen && (
            <MemoryCreateForm
              label={labels.create}
              contentLabel={labels.memoryContent}
              onCreate={(content) => onMutate({ operation: "create", content })}
            />
          )}
        </div>
      )}
    </section>
  );
}

export function MemoryCreateForm({
  label,
  contentLabel,
  onCreate,
}: Readonly<{ label: string; contentLabel: string; onCreate: (content: string) => void }>): ReactElement {
  const [content, setContent] = useState("");
  return (
    <div className="composer-actions">
      <textarea
        aria-label={contentLabel}
        className="form-textarea"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={2}
      />
      <button
        type="button"
        className="small-button"
        disabled={content.trim().length === 0}
        onClick={() => {
          onCreate(content.trim());
          setContent("");
        }}
      >
        {label}
      </button>
    </div>
  );
}

export function MemoryRow({
  item,
  statusText,
  originText,
  categoryText,
  labels,
  mutationAvailable,
  onUpdate,
  onArchive,
}: Readonly<{
  item: MemoryItemV1;
  statusText: string;
  originText: string;
  categoryText: string;
  labels: ReturnType<typeof messages>;
  mutationAvailable: boolean;
  onUpdate: (content: string) => void;
  onArchive: () => void;
}>): ReactElement {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(item.content);
  const beginEditing = (): void => {
    // A conflict replaces the item with the authoritative reread. Reset this
    // local draft at the transition into edit mode so a previous rejected
    // value can never be submitted against the fresh projection revision.
    setContent(item.content);
    setEditing(true);
  };
  return (
    <div className="memory-item-card" role="listitem" data-memory-handle={item.handle}>
      <div className="memory-header">
        <span className="memory-item-badge" data-memory-category={item.category}>
          {categoryText}
        </span>
        <span className="memory-item-origin" data-memory-origin={item.origin}>
          {originText}
        </span>
        <span className="memory-item-meta">{statusText}</span>
      </div>
      {editing ? (
        <textarea
          aria-label={`${labels.memoryContent}: ${item.title}`}
          className="form-textarea"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={2}
        />
      ) : (
        <p>{item.content}</p>
      )}
      {mutationAvailable && item.status !== "archived" && (
        <div className="composer-actions">
          {editing ? (
            <button
              type="button"
              className="small-button"
              disabled={content.trim().length === 0}
              onClick={() => {
                onUpdate(content.trim());
                setEditing(false);
              }}
            >
              {labels.save}
            </button>
          ) : (
            <button type="button" className="small-button" onClick={beginEditing}>
              {labels.editMemory}
            </button>
          )}
          <button type="button" className="small-button" onClick={onArchive}>
            {labels.archiveMemory}
          </button>
        </div>
      )}
    </div>
  );
}
