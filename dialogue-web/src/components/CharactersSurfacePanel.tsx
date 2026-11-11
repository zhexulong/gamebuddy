import { type ReactElement, useState } from "react";
import type { Locale } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import type { WorldInfoBindingSource } from "../world-info-binding-source";
import { CharacterWorldBookPanel } from "./CharacterWorldBookPanel";
import { CharactersPanel } from "./CharactersPanel";
import type { InspectedCompanion } from "./CompanionInspectorDrawer";
import { CompanionCardExportSection } from "./CompanionCardExportSection";
import { CompanionWorldBookSection } from "./CompanionWorldBookSection";

/**
 * The product's Characters surface: the character domain and the character's own
 * world book in one place.
 *
 * "Cards and world books live where the character is managed": World Info is no
 * longer a peer surface of the shell (design/26 §4.5's attachment list is a
 * section here now). The surface therefore renders TWO different things, and
 * says which is which, because conflating them is what a player reads as "my
 * imported entries were lost":
 *
 *  - `CompanionWorldBookSection` (`CompanionWorldBookSection.tsx`): the companion's OWN world book,
 *    read from `companion.worldbook.read` (the reviewed card's `character_book`, which the Host
 *    persisted under her runtime root). This is the one that belongs to the character, and it
 *    carries that book's entries and their trigger words.
 *  - `CharacterWorldBookPanel` (`CharacterWorldBookPanel.tsx`): the managed World Info library,
 *    whose items a conversation may ATTACH (`world-info.read` / `world-info.bind`) and which the
 *    player AUTHORS here: read an item's own entries, create one, edit one, delete one, import and
 *    export one. A different list, from a different store, with a different verb.
 *
 * Empty is honest on both: a companion with no book renders no block, and a
 * book that is present but carries no entries says exactly that rather than
 * showing a zero that reads as "nothing here". The library is the exception, and
 * deliberately so: it is empty on every fresh install (nothing seeds it), so an
 * empty library states that it is empty and offers the one control that can
 * change it - a panel that renders nothing when empty is a feature no player can
 * reach.
 *
 * Every control reflects a durable read-back: a bind succeeds only when the Host
 * re-reads the written artifact (revision CAS), so the UI never shows a local
 * value the store did not accept. A read that fails renders nothing rather than
 * fabricating a capability.
 *
 * This file is the surface's composition root and the one thing the two stores share: the selection
 * of the companion the player was reading, which the card export follows. Each section owns its own
 * store's form, handlers and draft.
 */
export function CharactersSurfacePanel({
  api,
  csrfToken,
  locale,
  read,
  avatarDigests,
  onAvatarUpdated,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  locale: Locale;
  read: () => Promise<WorldInfoBindingSource>;
  /** The picture digest each companion was last handed, and the upload that teaches it one. */
  avatarDigests: Readonly<Record<string, string>>;
  onAvatarUpdated: (handle: string, digest: string) => void;
}): ReactElement {
  // The companion the player is looking at: the roster row whose inspector was
  // opened. It outlives the drawer, because the drawer is modal and the export
  // control below it can only be pressed once it is closed - the selection is
  // what the player was looking at, and the card export follows it.
  const [inspected, setInspected] = useState<InspectedCompanion | null>(null);
  return (
    <>
      <CharactersPanel
        api={api}
        csrfToken={csrfToken}
        locale={locale}
        avatarDigests={avatarDigests}
        onAvatarUpdated={onAvatarUpdated}
        inspected={inspected}
        onInspect={setInspected}
      />
      <CompanionCardExportSection api={api} locale={locale} inspected={inspected} />
      <CompanionWorldBookSection api={api} csrfToken={csrfToken} locale={locale} />
      <CharacterWorldBookPanel api={api} csrfToken={csrfToken} locale={locale} read={read} />
    </>
  );
}
