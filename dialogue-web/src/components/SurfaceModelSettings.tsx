import { useCallback, useEffect, useState, type ReactElement } from "react";
import type {
  ManagementPipelineApi,
  TavernConnectionThinkingLevelV1,
  TavernModelProfileV1,
  TavernModelProfilesV1,
} from "../management-pipeline-api";
import type { Messages } from "../i18n";

/**
 * One surface's model settings (design/104 §3; the owner's ruling that the model a
 * surface uses belongs on that surface rather than only in a global Settings view).
 *
 * Which model this surface uses, and at which thinking level. The player may type
 * any model id their endpoint serves - the Host never checks it against the
 * recommended catalog - and the suggestion list is guidance, not a restriction. A
 * save is a durable revision CAS: the saved value is what the Host re-reads, and a
 * revision that moved underneath is reported as a conflict rather than shown as
 * saved.
 *
 * Reading is the browser session's; writing carries the mounted session's CSRF token,
 * so the surface moves on the same broker session as the rest of it.
 */

export function SurfaceModelSettings({
  surface,
  api,
  csrfToken,
  labels,
}: Readonly<{
  surface: "chat" | "game";
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
}>): ReactElement {
  const [profiles, setProfiles] = useState<TavernModelProfilesV1 | "loading" | "unavailable">("loading");
  const [modelId, setModelId] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<TavernConnectionThinkingLevelV1>("off");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"saved" | "conflict" | "model_required" | "error" | null>(null);

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
          className="form-select"
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

      <div className="surface-model-recommended" data-surface-model-recommended>
        <span>{labels.modelProfilesRecommended}</span>
        {recommendedFor(profiles, surface).map((entry) => (
          <button
            key={`${entry.providerId}/${entry.modelId}`}
            type="button"
            className="surface-model-chip"
            disabled={saving}
            // Two providers can publish the same model id, and the chip used to
            // print the id alone - two suggestions reading one identical word,
            // with nothing to say which endpoint each one came from. The chip
            // names the provider's own label (`providerLabel`), because that is
            // the word the player sees in the connection settings; the raw
            // `providerId` stays in the suggestion list above, which already
            // keys on the pair. Neither entry is dropped: they are different
            // models that happen to share an id.
            title={`${entry.providerLabel} (${entry.providerId})`}
            onClick={() => setModelId(entry.modelId)}
          >
            {`${entry.modelId} · ${entry.providerLabel}`}
          </button>
        ))}
      </div>

      <div className="surface-model-actions">
        <button type="button" className="small-button" disabled={saving} onClick={() => void apply()}>
          {labels.modelProfilesApply}
        </button>
        {notice !== null && (
          <span className="surface-model-notice" role="status" data-model-notice={notice}>
            {notice === "saved"
              ? labels.modelProfilesApplied
              : notice === "conflict"
                ? labels.modelProfilesRevisionConflict
                : notice === "model_required"
                  ? labels.modelProfilesModelRequired
                  : labels.failure}
          </span>
        )}
      </div>
    </section>
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
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  )
    return (error as { code: string }).code;
  return null;
}
