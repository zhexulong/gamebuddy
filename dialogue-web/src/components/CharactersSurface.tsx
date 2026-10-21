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
  avatarDigests,
  onAvatarUpdated,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  locale: Locale;
  read: () => Promise<WorldInfoSurfaceSource>;
  /**
   * The picture digest each companion was last handed, keyed by handle: the roster rows' avatar
   * reload key. It belongs to the shell, not to this surface, because an upload here must also be
   * the picture the app bar and the transcript draw once the player leaves (see
   * `ComposedReferenceGameApp`).
   */
  avatarDigests: Readonly<Record<string, string>>;
  /** An upload's own answer, told to whoever owns `avatarDigests`. */
  onAvatarUpdated: (handle: string, digest: string) => void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <SurfaceView
      title={labels.charactersPanel}
      testId="characters-surface"
      icon={Users}
      restoreFocusTo={restoreFocusTo}
    >
      <CharactersSurfacePanel
        api={api}
        csrfToken={csrfToken}
        locale={locale}
        read={read}
        avatarDigests={avatarDigests}
        onAvatarUpdated={onAvatarUpdated}
      />
    </SurfaceView>
  );
}
