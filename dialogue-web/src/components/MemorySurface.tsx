import { Brain } from "lucide-react";
import type { RefObject } from "react";
import type { Locale, Messages } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import { MemorySurfacePanel } from "./management-surface-panels";
import { SurfaceView } from "./SurfaceView";

/**
 * The Memory peer surface: the region, its heading and the player's authoring
 * panel over `memory.mutate`.
 *
 * It takes only what it renders: the management client and its CSRF token, the
 * display language, the labels and the control focus returns to when this
 * surface is replaced. The panel owns its own read/mutation revisions, so the
 * shell holds nothing of Memory's state.
 */
export function MemorySurface({
  api,
  csrfToken,
  labels,
  locale,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  locale: Locale;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <SurfaceView
      title={labels.memoryPanel}
      testId="memory-surface"
      icon={Brain}
      restoreFocusTo={restoreFocusTo}
    >
      <MemorySurfacePanel api={api} csrfToken={csrfToken} labels={labels} locale={locale} />
    </SurfaceView>
  );
}
