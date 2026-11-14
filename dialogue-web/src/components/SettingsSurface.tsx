import { ScrollText, Settings } from "lucide-react";
import type { RefObject } from "react";
import type { AppearanceChoice } from "../appearance";
import type { Locale, Messages } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import { SettingsSurfacePanel } from "./management-surface-panels";
import { SurfaceView } from "./SurfaceView";

/**
 * The Settings peer surface: the region, its heading and the panel that owns the
 * companion language, the voice preference, the connection records and the two
 * model profiles.
 *
 * The interface's own display language is the shell's, not this panel's (the
 * shell persists it and applies the document locale), so `uiLocale` and
 * `onSelectUiLocale` are the only language facts it takes.
 *
 * The preset assembly readout is not a peer surface's entry in the bar: it is the
 * disclosure below the settings groups, and `presets` is the control that opens the
 * read-only page. A player who wants to know how a preset assembles a request comes
 * through Settings, which is where the product's other read-only inspection surfaces
 * are reached from, and the bar keeps one control per place a player goes on purpose.
 */
export function SettingsSurface({
  api,
  csrfToken,
  labels,
  uiLocale,
  onSelectUiLocale,
  onSelectAppearance,
  presets,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  uiLocale: Locale;
  onSelectUiLocale: (locale: Locale) => void;
  onSelectAppearance: (appearance: AppearanceChoice) => void;
  /** Opens the preset readout, and the button focus returns to when it is left. */
  presets: Readonly<{ open: () => void; ref: RefObject<HTMLButtonElement | null> }>;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <SurfaceView
      title={labels.settingsPanel}
      testId="settings-surface"
      icon={Settings}
      className="surface-panel"
      restoreFocusTo={restoreFocusTo}
    >
      <SettingsSurfacePanel
        api={api}
        csrfToken={csrfToken}
        labels={labels}
        uiLocale={uiLocale}
        onSelectUiLocale={onSelectUiLocale}
        onSelectAppearance={onSelectAppearance}
      />
      <details className="custom-disclosure" data-settings-presets-disclosure>
        <summary>
          <ScrollText size={16} aria-hidden="true" />
          {labels.presetsPanel}
        </summary>
        <p className="management-settings-hint">{labels.presetReadOnlyHint}</p>
        <div className="composer-actions">
          <button type="button" className="small-button" ref={presets.ref} onClick={presets.open}>
            {labels.presetsOpen}
          </button>
        </div>
      </details>
    </SurfaceView>
  );
}
