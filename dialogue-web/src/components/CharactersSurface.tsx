import { Users } from "lucide-react";
import type { RefObject } from "react";
import type { Locale, Messages } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import { CharactersSurfacePanel } from "./CharactersSurfacePanel";
import type { WorldInfoSurfaceSource } from "./management-surface-panels";
import { SurfaceView } from "./SurfaceView";

/**
 * The Characters peer surface: the region, its heading and the character domain
 * with its world book.
 *
 * `read` is the mount's own authoritative World Info reader, because the
 * composed Chat projection carries no World Info at all; the shell supplies it
 * from the same-origin `GET /world-info` route.
 */
export function CharactersSurface({
  api,
  csrfToken,
  labels,
  locale,
  read,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  locale: Locale;
  read: () => Promise<WorldInfoSurfaceSource>;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <SurfaceView
      title={labels.charactersPanel}
      testId="characters-surface"
      icon={Users}
      restoreFocusTo={restoreFocusTo}
    >
      <CharactersSurfacePanel api={api} csrfToken={csrfToken} locale={locale} read={read} />
    </SurfaceView>
  );
}
