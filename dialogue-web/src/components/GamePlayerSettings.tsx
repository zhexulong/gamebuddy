import { useEffect, useState, type ReactElement } from "react";
import type { Messages } from "../i18n";
import {
  ComposedReferenceGameProblemError,
  type ComposedReferenceGameBrowserApi,
  type StardewPlayerSettingsV1,
  type StardewWindowModeV1,
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
 * initialisation and a shared promise would be false for one of them.
 *
 * The world identity fields (farm name, player name, favourite thing) are not here
 * at all, and that is a finding rather than an omission. The farm name is written
 * once, in `WorldCreationBootstrap.CreateNewWorld` (`WorldCreationBootstrap.cs:250`),
 * on the branch that drives the game's own new-game entry; the branch that enters a
 * world this request already created writes nothing to the save. The game itself has
 * exactly one farm-name writer a player can reach - the new-game form's
 * `farmnameBox`, which is drawn only for `Source.NewGame`/`Source.HostNewFarm`
 * (`CharacterCustomization.cs:485`) - and the post-creation character screen the
 * Wizard's shrine opens explicitly hides that box (`CharacterCustomization.cs:1118`)
 * while its farm-name write stays guarded by `if (farmnameBoxCC.visible)`
 * (`CharacterCustomization.cs:2849`). So no field here could rename a world that
 * already exists, and a control that appeared to try would be a dead switch.
 *
 * What a player gets instead is one sentence, always rendered, saying when the name
 * is chosen. It sits outside the loaded/unavailable branch on purpose: the fact is
 * about the game, not about whether this Host could reach the settings route, so a
 * player who came here looking for a rename learns the truth either way.
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

/** The four behaviours `WindowModeManagement` implements. One spelling: the contract's union names the same four. */
const WINDOW_MODE_KEYS = ["visible", "minimized", "hidden", "background"] as const;

export function GamePlayerSettings({
  api,
  labels,
}: Readonly<{ api: ComposedReferenceGameBrowserApi; labels: Messages }>): ReactElement {
  const [settings, setSettings] = useState<StardewPlayerSettingsV1 | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [denied, setDenied] = useState<ReadonlySet<string>>(() => new Set());
  const [minimum, setMinimum] = useState(1);
  /**
   * The window behaviour, or null when the player has never chosen one.
   *
   * Null is a real answer here - the Mod runs visibly by default - so the surface must be able to say "no preference" rather
   * than pick a value on the player's behalf. The same holds for the denial list below.
   */
  const [windowMode, setWindowMode] = useState<StardewWindowModeV1 | null>(null);
  /** Actions withheld individually, on top of the families. Sorted, deduplicated, and empty when the player chose none. */
  const [deniedActions, setDeniedActions] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"saved" | "conflict" | "error" | null>(null);

  const apply = (next: StardewPlayerSettingsV1): void => {
    setSettings(next);
    setDenied(new Set(next.families.filter((family) => family.denied).map((family) => family.familyId)));
    setMinimum(next.advanceDayMinimumOnlineFarmers);
    setWindowMode(next.windowMode ?? null);
    setDeniedActions(next.deniedActions ?? []);
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
  /**
   * One label per mode, read by name.
   *
   * The catalogue gate can only follow a named read, and a `labels[someMap[mode]]` lookup is invisible to it - the four
   * sentences would look unread. Naming them keeps the check honest and the intent obvious.
   */
  const windowModeLabels = Object.freeze({
    visible: labels.gameSettingsWindowModeVisible,
    minimized: labels.gameSettingsWindowModeMinimized,
    hidden: labels.gameSettingsWindowModeHidden,
    background: labels.gameSettingsWindowModeBackground,
  });

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
        ...(windowMode === null ? {} : { windowMode }),
        deniedActions: [...deniedActions],
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

          <label className="surface-model-field">
            <span>{labels.gameSettingsWindowModeTitle}</span>
            <select
              className="form-select"
              value={windowMode ?? ""}
              disabled={saving}
              aria-label={labels.gameSettingsWindowModeTitle}
              onChange={(event) => {
                // The select's options ARE the union, so the cast states what the markup already guarantees rather than
                // widening the state to arbitrary text.
                setWindowMode(event.target.value === "" ? null : (event.target.value as StardewWindowModeV1));
                setNotice(null);
              }}
            >
              {/* The empty option is the Mod's own default, named as what it is rather than hidden. */}
              <option value="">{labels.gameSettingsWindowModeDefault}</option>
              {WINDOW_MODE_KEYS.map((mode) => (
                <option key={mode} value={mode}>
                  {windowModeLabels[mode]}
                </option>
              ))}
            </select>
          </label>
          <p className="surface-model-settings-hint">{labels.gameSettingsWindowModeHint}</p>

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

      {/* The one thing a player would come to this section looking for and not
          find. Rendered unconditionally: it is a fact about the created world, not
          about this route, so it must not disappear with the route. */}
      <p className="surface-model-settings-hint" data-settings-note="world-name">
        {labels.gameSettingsWorldNameNote}
      </p>
    </section>
  );
}
