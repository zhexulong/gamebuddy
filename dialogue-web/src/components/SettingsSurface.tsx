import { Settings } from "lucide-react";
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
 * Which block sits in which of the surface's two tracks is the panel's decision
 * (`SettingsSurfacePanel`), and so is the preset readout's place at the end of the
 * second one: `presets` is handed down as the control that opens the read-only
 * page, so the mount keeps the focus ref it restores.
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
        presets={presets}
      />
    </SurfaceView>
  );
}
