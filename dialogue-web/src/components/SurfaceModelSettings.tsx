import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { ManagementPipelineApi, TavernConnectionThinkingLevelV1, TavernModelProfileV1, TavernModelProfilesV1 } from "../management-pipeline-api";
import { advancedPiSettingsText, applyAdvancedPiSettingsEdit } from "../pi-settings-model";
import type { Locale, Messages } from "../i18n";

/**
 * One surface's model settings (design/104 §3; the owner's ruling that the model a
 * surface uses belongs on that surface rather than only in a global Settings view).
 *
 * Two halves, and the split is the owner's own:
 *
 *  - **Necessary**, and therefore a control: which model this surface uses, and at
 *    which thinking level. The player may type any model id their endpoint serves -
 *    the Host never checks it against the recommended catalog - and the suggestion
 *    list is guidance, not a restriction. A save is a durable revision CAS: the
 *    saved value is what the Host re-reads, and a revision that moved underneath is
 *    reported as a conflict rather than shown as saved.
 *
 *  - **Advanced**, and therefore Pi's own JSON: `models.json` in exactly Pi's shape.
 *    This section is capability-gated rather than faked: this Host publishes no route
 *    that reads or writes the raw document (the provider store merges one entry under
 *    `providers`), so the editor states that plainly instead of offering a textarea
 *    whose save would go nowhere. When a Host route appears, it passes a writer here
 *    and the same validation path (`applyAdvancedPiSettingsEdit`) becomes live.
 *
 * Reading is the browser session's; writing carries the mounted session's CSRF token,
 * so both halves move on the same broker session as the rest of the surface.
 */

export function SurfaceModelSettings({
  surface,
  api,
  csrfToken,
  labels,
  locale,
  writeAdvancedSettings,
  readAdvancedSettings,
}: Readonly<{
  surface: "chat" | "game";
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  locale?: Locale;
  /** Present only once the Host publishes a route for Pi's raw document. */
  writeAdvancedSettings?: (document: Readonly<{ providers: Readonly<Record<string, Readonly<Record<string, unknown>>>> }>) => Promise<void>;
  readAdvancedSettings?: () => Promise<unknown>;
}>): ReactElement {
  const [profiles, setProfiles] = useState<TavernModelProfilesV1 | "loading" | "unavailable">("loading");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<TavernConnectionThinkingLevelV1>("off");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"saved" | "conflict" | "model_required" | "error" | null>(null);
  const advanced = advancedPiSettingsText(locale ?? "en");

  const load = useCallback(async (): Promise<void> => {
    try {
      const read = await api.readModelProfiles();
      setProfiles(read);
      const mine: TavernModelProfileV1 = surface === "chat" ? read.chat : read.game;
      setModelId(mine.modelId);
      setThinkingLevel(mine.thinkingLevel as TavernConnectionThinkingLevelV1);
    } catch {
      setProfiles("unavailable");
    }
  }, [api, surface]);

  useEffect(() => {
    void load();
  }, [load]);

  if (profiles === "loading") return <p className="state-placeholder">{labels.loading}</p>;
  if (profiles === "unavailable") return <p className="state-placeholder">{labels.modelProfilesUnavailable}</p>;

  const mine: TavernModelProfileV1 = surface === "chat" ? profiles.chat : profiles.game;
  const levelOptions = surface === "chat" ? profiles.chat : profiles.game;

  const apply = async (): Promise<void> => {
    const trimmed = modelId.trim();
    if (trimmed.length === 0) {
      setNotice("model_required");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const updated = await api.updateModelProfile(
        {
          apiVersion: 1,
          surface,
          expectedRevision: mine.revision,
          modelId: trimmed,
          thinkingLevel,
        },
        csrfToken,
      );
      setProfiles(updated);
      const settled: TavernModelProfileV1 = surface === "chat" ? updated.chat : updated.game;
      setModelId(settled.modelId);
      setThinkingLevel(settled.thinkingLevel as TavernConnectionThinkingLevelV1);
      setNotice("saved");
    } catch (error) {
      // A revision that moved is the one failure the player can act on: it means
      // someone else wrote the same profile, so re-read instead of overwriting it.
      const code = problemCodeOf(error);
      if (code === "state_reconciliation_required" || code === "revision_conflict") {
        setNotice("conflict");
        await load();
      } else {
        setNotice("error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="surface-model-settings" data-surface={surface} aria-label={labels.modelProfilesTitle}>
      <h3 className="surface-model-settings-title">
        {surface === "chat" ? labels.modelProfilesChat : labels.modelProfilesGame}
      </h3>
      <p className="surface-model-settings-hint">{labels.modelProfilesHint}</p>

      <label className="surface-model-field">
        <span>{labels.modelProfilesModelId}</span>
        <input
          type="text"
          value={modelId}
          list={`recommended-models-${surface}`}
          onChange={(event) => setModelId(event.target.value)}
          aria-label={labels.modelProfilesModelId}
        />
      </label>
      <datalist id={`recommended-models-${surface}`}>
        {recommendedFor(profiles, surface).map((entry) => (
          <option key={`${entry.providerId}/${entry.modelId}`} value={entry.modelId} label={entry.modelLabel} />
        ))}
      </datalist>

      <label className="surface-model-field">
        <span>{labels.modelProfilesThinkingLevel}</span>
        <select
          value={thinkingLevel}
          onChange={(event) => setThinkingLevel(event.target.value as TavernConnectionThinkingLevelV1)}
          aria-label={labels.modelProfilesThinkingLevel}
        >
          {levelsFor(profiles, surface, thinkingLevel).map((level) => (
            <option key={level} value={level}>
              {levelLabel(level, labels)}
            </option>
          ))}
        </select>
      </label>

      <div className="surface-model-actions">
        <button type="button" className="small-button" disabled={saving} onClick={() => void apply()}>
          {labels.modelProfilesApply}
        </button>
      </div>
      {notice !== null && (
        <p className="surface-model-notice" role="status" data-model-notice={notice}>
          {notice === "saved"
            ? labels.modelProfilesApplied
            : notice === "conflict"
              ? labels.modelProfilesRevisionConflict
              : notice === "model_required"
                ? labels.modelProfilesModelRequired
                : labels.failure}
        </p>
      )}

      <section className="surface-advanced-settings" data-advanced-settings={writeAdvancedSettings === undefined ? "unavailable" : "available"}>
        <h4>{advanced.title}</h4>
        {writeAdvancedSettings === undefined ? (
          // Honest absence: this Host publishes no route for Pi's raw document, and a
          // textarea whose save went nowhere would be exactly the disabled lookalike
          // design/26 §1 forbids.
          <p className="state-placeholder" data-advanced-settings-state="unavailable">
            {advanced.unavailable}
          </p>
        ) : (
          <AdvancedPiSettings
            hint={advanced.hint}
            save={advanced.save}
            applied={advanced.applied}
            invalidJson={advanced.invalidJson}
            invalidShape={advanced.invalidShape}
            read={readAdvancedSettings}
            write={writeAdvancedSettings}
          />
        )}
      </section>
    </section>
  );
}

/**
 * The advanced editor, rendered only when a Host route exists. It validates through
 * the same parser the model module owns, so an edit that is not Pi's document is
 * refused whole and never reaches the file.
 */
function AdvancedPiSettings({
  hint,
  save,
  applied,
  invalidJson,
  invalidShape,
  read,
  write,
}: Readonly<{
  hint: string;
  save: string;
  applied: string;
  invalidJson: string;
  invalidShape: string;
  read?: () => Promise<unknown>;
  write: (document: Readonly<{ providers: Readonly<Record<string, Readonly<Record<string, unknown>>>> }>) => Promise<void>;
}>): ReactElement {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (read === undefined) return;
    let active = true;
    void read()
      .then((value) => {
        if (!active) return;
        const document = value === null || value === undefined ? { providers: {} } : value;
        setText(serializeAdvanced(document));
      })
      .catch(() => active && setNotice(invalidShape));
    return () => {
      active = false;
    };
  }, [read, invalidShape]);

  return (
    <>
      <p className="surface-model-settings-hint">{hint}</p>
      <textarea
        className="surface-advanced-editor"
        value={text}
        rows={12}
        spellCheck={false}
        aria-label={hint}
        onChange={(event) => {
          setText(event.target.value);
          setNotice(null);
        }}
      />
      <div className="surface-model-actions">
        <button
          type="button"
          className="small-button"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                const result = await applyAdvancedPiSettingsEdit(text, write);
                setNotice(result.ok ? applied : result.problem === "invalid_json" ? invalidJson : invalidShape);
              } catch {
                setNotice(invalidShape);
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {save}
        </button>
      </div>
      {notice !== null && (
        <p className="surface-model-notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
}

function recommendedFor(profiles: TavernModelProfilesV1, surface: "chat" | "game") {
  void surface;
  return profiles.recommendedModels;
}

/** The contract's levels for this surface, plus whatever the profile already holds. */
function levelsFor(profiles: TavernModelProfilesV1, surface: "chat" | "game", current: string): readonly string[] {
  const recommended = recommendedFor(profiles, surface);
  const allowed = recommended.flatMap((entry) => entry.allowedThinkingLevels);
  const levels = new Set<string>(allowed);
  levels.add(current);
  for (const fallback of ["off", "minimal", "low", "medium", "high"]) levels.add(fallback);
  return [...levels];
}

function levelLabel(level: string, labels: Messages): string {
  const table: Record<string, string | undefined> = {
    off: labels.connectionLevelOff,
    minimal: labels.connectionLevelMinimal,
    low: labels.connectionLevelLow,
    medium: labels.connectionLevelMedium,
    high: labels.connectionLevelHigh,
    max: labels.connectionLevelMax,
  };
  return table[level] ?? level;
}

function problemCodeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string")
    return (error as { code: string }).code;
  return null;
}

function serializeAdvanced(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}
