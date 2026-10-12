import { Settings } from "lucide-react";
import type { RefObject } from "react";
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
 */
export function SettingsSurface({
  api,
  csrfToken,
  labels,
  uiLocale,
  onSelectUiLocale,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  uiLocale: Locale;
  onSelectUiLocale: (locale: Locale) => void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <SurfaceView
      title={labels.settingsPanel}
      testId="settings-surface"
      icon={Settings}
      restoreFocusTo={restoreFocusTo}
    >
      <SettingsSurfacePanel
        api={api}
        csrfToken={csrfToken}
        labels={labels}
        uiLocale={uiLocale}
        onSelectUiLocale={onSelectUiLocale}
      />
    </SurfaceView>
  );
}
