import { useEffect, useState, type ReactElement } from "react";
import type { Messages } from "../i18n";
import {
  ComposedReferenceGameProblemError,
  type ComposedReferenceGameBrowserApi,
  type StardewPlayerSettingsV1,
} from "../composed-reference-game-browser-api";

/**
 * The player's own Stardew settings, on the Game surface.
 *
 * This is the only place a player learns these settings exist. Before it, the only
 * way to change any of them was to hand-edit `Mods/GameBuddy/config.json` inside a
 * directory the player would never find - and which the Host deletes when a session
 * settles. So the section is a plain part of the Game surface, not something behind
 * a disclosure.
 *
 * What it offers is deliberately one field group. The action consent is the
 * decision a player actually makes about the companion ("what may you touch"), and
 * it is the group whose change reaches a RUNNING game: the Mod re-reads its action
 * policy from the config every 120 ticks. The co-op night floor is offered beside it
 * with its own, different sentence, because it is read once at embodiment
 * initialisation and a shared promise would be false for one of them. The world
 * identity fields (farm name, player name, favourite thing) are not here at all: the
 * Mod consumes them from a one-shot creation form at the main menu, so a field for
 * them could not rename a world that already exists.
 *
 * Saving is a revision compare-and-swap, exactly like every other settings surface
 * in this product. A save that lost the race is not a fault: the field list is
 * re-read and the player is told someone else changed it first.
 */

/**
 * The bilingual sentence for one family, keyed by the contract's own family id.
 *
 * The catalogue is read by literal key rather than through an index: the i18n
 * parity gate holds every declared key to a source that reads it, and a table of
 * key NAMES would leave all twenty-one of these declared-and-unread. So each entry
 * names its own label, and the map is what turns a wire family id into words.
 */
const FAMILY_LABELS: Readonly<Record<string, (labels: Messages) => string>> = Object.freeze({
  farming_crops: (labels) => labels.gameFamilyFarmingCrops,
  resource_gathering: (labels) => labels.gameFamilyResourceGathering,
  animals_pets: (labels) => labels.gameFamilyAnimalsPets,
  machines_processing: (labels) => labels.gameFamilyMachinesProcessing,
  crafting_cooking: (labels) => labels.gameFamilyCraftingCooking,
  buildings_farm_management: (labels) => labels.gameFamilyBuildingsFarmManagement,
  inventory_items: (labels) => labels.gameFamilyInventoryItems,
  body_tools: (labels) => labels.gameFamilyBodyTools,
  movement_navigation: (labels) => labels.gameFamilyMovementNavigation,
  world_navigation: (labels) => labels.gameFamilyWorldNavigation,
  world_perception: (labels) => labels.gameFamilyWorldPerception,
  transport_warps: (labels) => labels.gameFamilyTransportWarps,
  water_travel: (labels) => labels.gameFamilyWaterTravel,
  animal_transport: (labels) => labels.gameFamilyAnimalTransport,
  npc_social: (labels) => labels.gameFamilyNpcSocial,
  shops_economy: (labels) => labels.gameFamilyShopsEconomy,
  quests_journal: (labels) => labels.gameFamilyQuestsJournal,
  world_lifecycle: (labels) => labels.gameFamilyWorldLifecycle,
  facility_storage_lighting: (labels) => labels.gameFamilyFacilityStorageLighting,
  modal_handling: (labels) => labels.gameFamilyModalHandling,
  expression: (labels) => labels.gameFamilyExpression,
});

export function GamePlayerSettings({
  api,
  labels,
}: Readonly<{ api: ComposedReferenceGameBrowserApi; labels: Messages }>): ReactElement {
  const [settings, setSettings] = useState<StardewPlayerSettingsV1 | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set());
  const [minimum, setMinimum] = useState(1);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"saved" | "conflict" | "error" | null>(null);

  const apply = (next: StardewPlayerSettingsV1): void => {
    setSettings(next);
    setDenied(new Set(next.families.filter((family) => family.denied).map((family) => family.familyId)));
    setMinimum(next.advanceDayMinimumOnlineFarmers);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const read = await api.readStardewPlayerSettings();
        if (!cancelled) apply(read);
      } catch {
        // A route this build does not serve, or a record that cannot be read: say so
        // instead of rendering a control that would silently do nothing.
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const familyLabel = (familyId: string): string => FAMILY_LABELS[familyId]?.(labels) ?? familyId;

  const toggle = (familyId: string, withheld: boolean): void => {
    setDenied((previous) => {
      const next = new Set(previous);
      if (withheld) next.add(familyId);
      else next.delete(familyId);
      return next;
    });
    setNotice(null);
  };

  const save = async (): Promise<void> => {
    if (settings === null || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const saved = await api.saveStardewPlayerSettings({
        apiVersion: 1,
        expectedRevision: settings.revision,
        deniedActionFamilies: [...denied],
        advanceDayMinimumOnlineFarmers: minimum,
      });
      apply(saved);
      setNotice("saved");
    } catch (error) {
      // A record that moved is the one refusal the player can act on: read it again
      // and show what it now says, never overwrite it with the stale form.
      if (error instanceof ComposedReferenceGameProblemError && error.code === "stardew_settings_revision_conflict") {
        setNotice("conflict");
        try {
          apply(await api.readStardewPlayerSettings());
        } catch {
          setUnavailable(true);
        }
      } else {
        setNotice("error");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="surface-model-settings game-player-settings" aria-label={labels.gameSettingsTitle}>
      <h3 className="surface-model-settings-title">{labels.gameSettingsTitle}</h3>
      <p className="surface-model-settings-hint">{labels.gameSettingsIntro}</p>

      {unavailable ? (
        <p className="state-placeholder">{labels.gameSettingsUnavailable}</p>
      ) : settings === null ? (
        <p className="state-placeholder">{labels.loading}</p>
      ) : (
        <>
          <h4 className="game-player-settings-group">{labels.gameSettingsActionPolicyTitle}</h4>
          <p className="surface-model-settings-hint">{labels.gameSettingsActionPolicyHint}</p>
          <ul className="game-player-settings-families">
            {settings.families.map((family) => {
              const familyText = familyLabel(family.familyId);
              return (
                <li key={family.familyId}>
                  {/* The label is the painted row and the input is the a11y node, the
                      same recipe the delivery-pacing row uses, so the browser's own
                      checkbox face never appears inside a themed card. */}
                  <label className="game-player-settings-family">
                    <span>{familyText}</span>
                    <input
                      type="checkbox"
                      className="surface-delivery-pacing-input"
                      // Checked means the player LET the companion do it, so the box the
                      // player unticks is the action they are withholding.
                      checked={!family.denied}
                      disabled={saving}
                      aria-label={familyText}
                      onChange={(event) => toggle(family.familyId, !event.target.checked)}
                    />
                  </label>
                </li>
              );
            })}
          </ul>

          <label className="surface-model-field">
            <span>{labels.gameSettingsCoopTitle}</span>
            <select
              className="form-select"
              value={minimum}
              disabled={saving}
              aria-label={labels.gameSettingsCoopTitle}
              onChange={(event) => {
                setMinimum(Number(event.target.value));
                setNotice(null);
              }}
            >
              {[1, 2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <p className="surface-model-settings-hint">{labels.gameSettingsCoopHint}</p>

          <div className="surface-model-actions">
            <button type="button" className="small-button" disabled={saving} onClick={() => void save()}>
              {labels.gameSettingsSave}
            </button>
            {notice !== null && (
              <span className="surface-model-notice" role="status" data-settings-notice={notice}>
                {notice === "saved"
                  ? labels.gameSettingsSaved
                  : notice === "conflict"
                    ? labels.gameSettingsConflict
                    : labels.gameSettingsSaveFailed}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
