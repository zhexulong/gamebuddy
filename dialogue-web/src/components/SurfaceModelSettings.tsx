import { useCallback, useEffect, useState, type ReactElement } from "react";
import type {
  ManagementPipelineApi,
  TavernConnectionThinkingLevelV1,
  TavernModelProfileV1,
  TavernModelProfilesV1,
} from "../management-pipeline-api";
import type { Messages } from "../i18n";
import { MODEL_PROFILE_THINKING_LEVEL_SUGGESTIONS } from "./management-panels";

/**
 * One surface's model settings (design/104 §3; the owner's ruling that the model a
 * surface uses belongs on that surface rather than only in a global Settings view).
 *
 * What a surface owns here is the thinking level it reasons at. The model itself is
 * not a surface choice and never was this product's to name: it comes from the
 * player's own active connection, the one thing that knows a provider, a model and
 * an endpoint together. This panel used to offer a model id field, which could only
 * disagree with the connection it was sent through.
 *
 * A save is a durable revision CAS: the saved value is what the Host re-reads, and a
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
  const [thinkingLevel, setThinkingLevel] = useState<TavernConnectionThinkingLevelV1>("off");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"saved" | "conflict" | "error" | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const read = await api.readModelProfiles();
      setProfiles(read);
      const mine: TavernModelProfileV1 = surface === "chat" ? read.chat : read.game;
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
    setSaving(true);
    setNotice(null);
    try {
      const updated = await api.updateModelProfile(
        {
          apiVersion: 1,
          surface,
          expectedRevision: mine.revision,
          thinkingLevel,
        },
        csrfToken,
      );
      setProfiles(updated);
      const settled: TavernModelProfileV1 = surface === "chat" ? updated.chat : updated.game;
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

      {/*
       * A read-only list of what this endpoint offers. A model id is still chosen where the endpoint that
       * serves it is configured (the connection form), and this surface cannot set one: it reasons at a
       * level, through the connection the player activated. But which models that connection serves is a
       * fact the player asked to see, and two providers can serve the same id - so the chips name the
       * provider's own label and nothing here is clickable, which is the difference between "here is what
       * is available" and "pick one for this surface".
       */}
      {/*
       * What this endpoint offers, read back. It is empty until an endpoint has answered
       * `/models`, and then it says only that: GameBuddy ships no model endpoint, so it never
       * publishes a model id for one it does not run. A caption over an empty list would be the
       * same guess as the ids that used to sit under it.
       */}
      {recommendedFor(profiles, surface).length > 0 && (
        <div className="surface-model-recommended" data-surface-model-recommended>
          <p className="surface-model-recommended-label">{labels.modelProfilesRecommended}</p>
          {recommendedFor(profiles, surface).map((entry) => (
            <span
              key={`${entry.providerId}/${entry.modelId}`}
              className="surface-model-chip"
              title={`${entry.providerLabel} (${entry.providerId})`}
            >
              {`${entry.modelId} · ${entry.providerLabel}`}
            </span>
          ))}
        </div>
      )}

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
                : labels.failure}
          </span>
        )}
      </div>

      {/* Chat only: a game bubble is always paced, and a switch there would be a
          control that changes nothing. */}
      {surface === "chat" && <DeliveryPacingToggle api={api} csrfToken={csrfToken} labels={labels} />}
    </section>
  );
}

/**
 * Whether replies arrive in short pieces or as one message.
 *
 * The Host answers the preference; this control writes it through the same
 * broker session and CSRF token as the rest of the panel, so there is no second
 * store and no browser-local copy that could disagree with the runtime. While the
 * route is absent the control is disabled AND says so, because a dead switch with
 * no explanation is worse than no switch. The explanation is conditional on the
 * route really being missing, so it disappears the moment Host ships.
 */
function DeliveryPacingToggle({
  api,
  csrfToken,
  labels,
}: Readonly<{ api: ManagementPipelineApi; csrfToken: string; labels: Messages }>): ReactElement {
  const [state, setState] = useState<DeliveryPreferenceState>("loading");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const read = await api.readDeliveryPreference();
        if (!cancelled) setState({ paced: read.paced, revision: read.revision });
      } catch {
        // Absent or unavailable route: the control is shown disabled with a named
        // reason rather than silently doing nothing when pressed.
        if (!cancelled) setState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const toggle = async (): Promise<void> => {
    if (state === "loading" || state === "unavailable" || saving) return;
    const next = !state.paced;
    setSaving(true);
    try {
      const updated = await api.updateDeliveryPreference({ expectedRevision: state.revision, paced: next }, csrfToken);
      setState({ paced: updated.paced, revision: updated.revision });
    } catch {
      // A conflict or a refusal leaves the switch where the Host says it is: the
      // next read is the authority, never the click.
      try {
        const read = await api.readDeliveryPreference();
        setState({ paced: read.paced, revision: read.revision });
      } catch {
        setState("unavailable");
      }
    } finally {
      setSaving(false);
    }
  };

  const unavailable = state === "loading" || state === "unavailable";
  const paced = state !== "loading" && state !== "unavailable" ? state.paced : false;
  return (
    <div
      className="surface-delivery-pacing"
      data-delivery-pacing={state === "unavailable" ? "unavailable" : paced ? "on" : "off"}
    >
      <label className="surface-model-field surface-delivery-pacing-trigger">
        <span>{labels.chatDeliveryPacedTitle}</span>
        {/* Visually retired, exactly like the card-import trigger: the browser's own
            checkbox face is not themed, and the row the player presses is this
            label. The input stays in the a11y tree as a real checkbox. */}
        <input
          type="checkbox"
          className="surface-delivery-pacing-input"
          checked={paced}
          disabled={unavailable || saving}
          aria-label={labels.chatDeliveryPacedTitle}
          onChange={() => void toggle()}
        />
      </label>
      <p className="surface-model-settings-hint">
        {state === "unavailable"
          ? labels.chatDeliveryPacedUnavailable
          : paced
            ? labels.chatDeliveryPacedHint
            : labels.chatDeliveryPacedOff}
      </p>
    </div>
  );
}

type DeliveryPreferenceState = "loading" | "unavailable" | Readonly<{ paced: boolean; revision: number }>;

function recommendedFor(profiles: TavernModelProfilesV1, surface: "chat" | "game") {
  void surface;
  return profiles.recommendedModels;
}

/**
 * The contract's levels for this surface, plus whatever the profile already holds.
 *
 * The levels a connection publishes depend on which model it names, and a player-typed model has no
 * published levels at all, so the fallback is the runtime's whole vocabulary rather than a subset:
 * offering five of seven would hide the ones a model that does support them can be given. The list
 * is the one this panel already declares, not a second copy.
 */
function levelsFor(profiles: TavernModelProfilesV1, surface: "chat" | "game", current: string): readonly string[] {
  const recommended = recommendedFor(profiles, surface);
  const allowed = recommended.flatMap((entry) => entry.allowedThinkingLevels);
  const levels = new Set<string>(allowed);
  levels.add(current);
  for (const fallback of MODEL_PROFILE_THINKING_LEVEL_SUGGESTIONS) levels.add(fallback);
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
