import { ChevronDown } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { type Locale, type Messages, messages } from "../i18n";
import {
  type CompanionWorldBookV1,
  MAX_LOREBOOK_FILE_BYTES,
  type ManagementPipelineApi,
  type WorldInfoContentV1,
  type WorldInfoStateV1,
} from "../management-pipeline-api";
import { problemTextWithCode, TavernProblemError } from "../management-pipeline-api";
import { useArmedConfirmation } from "./armed-confirmation";
import { CharactersPanel } from "./CharactersPanel";
import { type CharacterLabels, characterLabels } from "./character-domain-labels";
import type { InspectedCompanion } from "./CompanionInspectorDrawer";
import type { WorldInfoSurfaceSource } from "./management-surface-panels";

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
 *  - `CompanionWorldBookSection`: the companion's OWN world book, read from
 *    `companion.worldbook.read` (the reviewed card's `character_book`, which the
 *    Host persisted under her runtime root). This is the one that belongs to the
 *    character, and it carries that book's entries and their trigger words.
 *  - `CharacterWorldBookPanel`: the managed World Info library, whose items a
 *    conversation may ATTACH (`world-info.read` / `world-info.bind`) and which
 *    the player AUTHORS here: read an item's own entries, create one, edit one,
 *    delete one. A different list, from a different store, with a different verb.
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
  read: () => Promise<WorldInfoSurfaceSource>;
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

/**
 * The character-card export: two controls that save the companion in play as a
 * standard Tavern V3 card, one per form.
 *
 * The card is produced by the Host (`companion.card.export`) and delivered as the
 * bytes it returned - the browser is the download surface, so this control hands
 * the Host's own payload to a `Blob` and lets the browser save it under the
 * filename the Host minted. Nothing is rebuilt on this side: the JSON form is the
 * Host's own card text, and the PNG form is the Host's own card file (her picture
 * with the card inside it), so what lands is exactly the card the Host built and
 * the import route accepts.
 *
 * The two forms are named controls, not one control with a choice hidden behind a
 * filename: a player asks for the JSON card or the PNG card and the request says
 * which. The PNG card contains her own picture, so a companion without one gets her
 * own refusal rather than a silently blank or invented image.
 *
 * The companion addressed is the one the player is looking at: the roster row whose
 * inspector she opened, which the drawer named and the surface remembered. Only when
 * the player has named no companion at all - nothing inspected since the surface
 * mounted - is her card the one in play. Both are the roster's own opaque handle -
 * the same handle every other companion read is addressed by - and the route resolves
 * any listed companion.
 *
 * The selection outlives the drawer because the drawer is modal: while it is open the
 * backdrop stands between the player and this control, so the export she asks for is
 * the one she presses after reading her. The control therefore follows what she was
 * reading rather than reverting to the companion in play - reverting is what made
 * saving an archived companion's card silently save the active one's.
 *
 * Every way the Host can refuse has its own sentence: there is no
 * companion to export, her records could not be read, they will not fit a card our
 * import accepts, or she has no picture for the PNG form.
 */
function CompanionCardExportSection({
  api,
  locale,
  inspected,
}: {
  api: ManagementPipelineApi;
  locale: Locale;
  inspected: InspectedCompanion | null;
}): ReactElement | null {
  const labels = characterLabels(locale);
  const [inPlay, setInPlay] = useState<
    Readonly<{ handle: string; name: string }> | "loading" | "absent" | "unavailable"
  >("loading");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Readonly<{ ok: boolean; text: string }> | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await api.listCompanions();
        if (!active) return;
        const current = list.companions.find((entry) => entry.isCurrent);
        setInPlay(current === undefined ? "absent" : { handle: current.handle, name: current.name });
      } catch {
        // A read that fails renders nothing rather than fabricating a capability.
        if (active) setInPlay("unavailable");
      }
    })();
    return () => {
      active = false;
    };
    // The client is the mount's own authority and is stable for the life of the surface.
  }, [api]);

  /**
   * The companion this control saves.
   *
   * The companion the player is looking at wins; the one in play is only the
   * fallback for a surface where nothing has been named yet. A roster read still in
   * flight - or one that failed - names nothing, so the control is not offered on
   * the strength of a companion it has not read; an inspection the drawer already
   * named needs no roster read at all.
   */
  const target: Readonly<{ handle: string; name: string }> | "absent" | null =
    inspected !== null ? inspected : inPlay === "loading" || inPlay === "unavailable" ? null : inPlay;

  if (target === null) return null;

  /**
   * Saves the Host's own card bytes through the browser's download surface: one
   * object URL, one click on an anchor carrying the Host's filename, and the URL
   * released on a later task so the download has already begun reading it.
   */
  const download = (fileName: string, blob: Blob): void => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const exportCard = (format: "json" | "png"): void => {
    if (target === "absent" || busy) return;
    const handle = target.handle;
    setBusy(true);
    setNotice(null);
    void (async () => {
      let next: Readonly<{ ok: boolean; text: string }>;
      try {
        const card = await api.exportCompanionCard(handle, format);
        // The Host's own bytes, in the Host's own file kind: the JSON card is its
        // text, the PNG card is the whole file the Host built.
        if (card.format === "png")
          download(card.fileName, new Blob([base64Bytes(card.cardFileBase64)], { type: "image/png" }));
        else download(card.fileName, new Blob([card.card], { type: "application/json" }));
        next = { ok: true, text: labels.exportSaved.replace("{{file}}", card.fileName) };
      } catch (error) {
        next = { ok: false, text: exportRefusal(labels, error, messages(locale)) };
      }
      setBusy(false);
      setNotice(next);
    })();
  };

  return (
    <section className="management-settings-section" aria-label={labels.exportTitle} data-companion-card-export-section>
      <h3>{labels.exportTitle}</h3>
      <p className="management-settings-hint">{labels.exportHint}</p>
      {target === "absent" ? (
        <p data-companion-card-export-nothing>{labels.exportNothing}</p>
      ) : (
        // Two controls, each named for the form it saves. Their 44 px hit targets
        // are the shared button's own floor (`--touch-target-min`), so they match
        // every other control on this surface rather than a size invented here.
        <div className="composer-actions">
          <button
            type="button"
            className="small-button"
            data-companion-card-export-json
            aria-label={`${labels.exportJsonCard}: ${target.name}`}
            disabled={busy}
            onClick={() => exportCard("json")}
          >
            {busy ? labels.exportBusy : labels.exportJsonCard}
          </button>
          <button
            type="button"
            className="small-button"
            data-companion-card-export-png
            aria-label={`${labels.exportPngCard}: ${target.name}`}
            disabled={busy}
            onClick={() => exportCard("png")}
          >
            {busy ? labels.exportBusy : labels.exportPngCard}
          </button>
        </div>
      )}
      {notice !== null && (
        <p role="status" data-companion-card-export-notice className={notice.ok ? "success-banner" : "error-banner"}>
          {notice.text}
        </p>
      )}
    </section>
  );
}

/**
 * The bytes a base64 payload names, decoded in this browser.
 *
 * `atob` is fed the whole string at once - the PNG card is a file, and it is the
 * same size the player will save - and the per-character copy is the only loop.
 */
function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The player's sentence for one refused export. Each way the Host refuses is a
 * different fact - there is no companion, her records could not be read, they will
 * not fit a card, or she has no picture for the PNG form - and one "could not
 * export" would send her looking for the wrong fault. A code this table does not
 * know keeps the base sentence with the code appended.
 */
function exportRefusal(labels: CharacterLabels, error: unknown, problemLabels: Messages): string {
  const code = error instanceof TavernProblemError ? error.code : null;
  switch (code) {
    case "companion_not_found":
      return labels.exportNothing;
    case "companion_record_unreadable":
      return labels.exportUnreadable;
    case "companion_card_too_large":
      return labels.exportTooLarge;
    case "companion_card_image_absent":
      return labels.exportImageAbsent;
    default:
      return problemTextWithCode(labels.exportFailed, error, problemLabels);
  }
}

/**
 * The companion's own world book, which the player reads AND edits.
 *
 * `absent` is both "she has no book" and "the read could not be served": neither is a
 * book, so neither renders a block - the surface never invents one, and a failed read
 * never reads as an empty book. A book that exists is editable even when it carries no
 * entries: an empty book is exactly the one a player has to be able to add to.
 *
 * The draft PINS the revision the read carried. A save that would overwrite a change
 * the player never saw must keep failing until she reopens the editor on the book that
 * is actually there, so the editor's CAS is never silently rebased by a read-back.
 */
type CompanionWorldBookView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "ready"; handle: string; worldBook: CompanionWorldBookV1 }>;

/** One entry being edited, with its trigger words as the player typed them. */
type CompanionWorldBookEntryDraft = Readonly<{
  /**
   * The row's own identity while it is being edited, and the handle its removal is
   * armed on. It is client-only - the save builds the wire payload field by field, so
   * it cannot be sent - and it is minted per row, so adding or removing rows never
   * reuses one. Keying editable rows by position is what makes React reconcile a
   * keystroke into the wrong row.
   */
  rowId: string;
  title: string;
  keys: string;
  constant: boolean;
  content: string;
}>;

type CompanionWorldBookDraft = Readonly<{
  handle: string;
  /** The durable revision the editor was opened on; the save CASes on exactly this. */
  expectedRevision: number;
  entries: readonly CompanionWorldBookEntryDraft[];
}>;

/** The one outcome line this section reports, so two operations never print two notices. */
type CompanionWorldBookNotice = Readonly<{ kind: "success" | "failure"; text: string }> | null;

/**
 * The next authoring row's identity. A module counter rather than a uuid: the id never
 * leaves the browser, and a counter keeps a test deterministic.
 */
let nextCompanionWorldBookRowId = 0;

function toCompanionWorldBookEntryDraft(entry: CompanionWorldBookV1["entries"][number]): CompanionWorldBookEntryDraft {
  nextCompanionWorldBookRowId += 1;
  return {
    rowId: `companion-world-book-row-${nextCompanionWorldBookRowId}`,
    title: entry.title,
    keys: entry.keys.join(", "),
    constant: entry.constant,
    content: entry.content,
  };
}

function newCompanionWorldBookEntryDraft(): CompanionWorldBookEntryDraft {
  nextCompanionWorldBookRowId += 1;
  return {
    rowId: `companion-world-book-row-${nextCompanionWorldBookRowId}`,
    title: "",
    keys: "",
    constant: false,
    content: "",
  };
}

/**
 * Whether the draft is what the Host accepts: every entry carries a title and a body.
 *
 * The two are the durable validator's own required fields, so an incomplete draft is
 * not a refusal - the save control is simply not offered yet. Offering it and letting
 * the Host refuse would tell the player only that her save failed, when the fact is
 * that an entry is still missing the one thing it must have.
 */
function companionWorldBookDraftIsComplete(draft: CompanionWorldBookDraft): boolean {
  return draft.entries.every((entry) => entry.title.trim().length > 0 && entry.content.trim().length > 0);
}

/**
 * The player's sentence for one refused save.
 *
 * Every way the Host refuses this save is a different fact - the book moved on since she
 * read it, she has no book, an entry is not something the Host will keep, the durable
 * thread store could not follow - and one "could not save" sentence would send her
 * looking for the wrong fault. A code this table does not know keeps the base sentence
 * with the code appended, so an unexpected refusal is still named rather than swallowed.
 */
function companionWorldBookRefusal(labels: CharacterLabels, error: unknown, problemLabels: Messages): string {
  const code = error instanceof TavernProblemError ? error.code : null;
  switch (code) {
    case "companion_world_book_conflict":
      return labels.companionWorldBookConflict;
    case "companion_world_book_absent":
      return labels.companionWorldBookAbsent;
    case "authored_content_invalid":
    case "invalid_request":
      return labels.companionWorldBookInvalid;
    case "companion_record_unreadable":
      return labels.companionWorldBookUnreadable;
    case "companion_world_book_binding_partial":
      return labels.companionWorldBookBindingPartial;
    case "storage_unavailable":
      return labels.companionWorldBookNotSaved;
    default:
      return problemTextWithCode(labels.worldBookSaveFailed, error, problemLabels);
  }
}

function CompanionWorldBookSection({
  api,
  csrfToken,
  locale,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  locale: Locale;
}): ReactElement | null {
  const labels = characterLabels(locale);
  const [view, setView] = useState<CompanionWorldBookView>({ kind: "loading" });
  const [draft, setDraft] = useState<CompanionWorldBookDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<CompanionWorldBookNotice>(null);
  // The row whose removal is armed. Arming is per row and per section, so a second arm
  // replaces the first and no stale arm can fire on another entry.
  const [armed, setArmed] = useState<string | null>(null);

  const readOnce = async (): Promise<CompanionWorldBookView> => {
    try {
      // The book belongs to the mounted companion, exactly as the persona,
      // scenario, opening and directive do: the surface reads the current
      // library entry's own book and no other companion's.
      const list = await api.listCompanions();
      const current = list.companions.find((entry) => entry.isCurrent);
      if (current === undefined) return { kind: "absent" };
      const worldBook = await api.readCompanionWorldBook(current.handle);
      return worldBook.present ? { kind: "ready", handle: current.handle, worldBook } : { kind: "absent" };
    } catch {
      return { kind: "absent" };
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await readOnce();
      if (active) setView(next);
    })();
    return () => {
      active = false;
    };
    // The client is the mount's own authority and is stable for the life of the surface.
  }, [api]);

  const beginEdit = (): void => {
    if (view.kind !== "ready" || view.worldBook.revision === null) return;
    setDraft({
      handle: view.handle,
      expectedRevision: view.worldBook.revision,
      entries: view.worldBook.entries.map(toCompanionWorldBookEntryDraft),
    });
    setArmed(null);
    setNotice(null);
  };

  /**
   * Saves the whole list. The Host's own reply is the new projection, so a saved book
   * is re-rendered from what it returned rather than from what the editor asked for; a
   * refusal re-reads the book BEFORE it is reported, so the surface shows the truth and
   * the editor keeps the revision it was opened on.
   */
  const submit = (): void => {
    if (draft === null || !companionWorldBookDraftIsComplete(draft)) return;
    const target = draft;
    const entries = target.entries.map((entry) => ({
      title: entry.title.trim(),
      keys: parseTriggerWords(entry.keys),
      constant: entry.constant,
      content: entry.content,
    }));
    setSaving(true);
    setArmed(null);
    void (async () => {
      let failure: string | null = null;
      try {
        const updated = await api.updateCompanionWorldBook(
          target.handle,
          { apiVersion: 1, expectedRevision: target.expectedRevision, entries },
          csrfToken,
        );
        setView({ kind: "ready", handle: target.handle, worldBook: updated });
        setDraft(null);
      } catch (error) {
        failure = companionWorldBookRefusal(labels, error, messages(locale));
        setView(await readOnce());
      } finally {
        setSaving(false);
      }
      setNotice(failure === null ? { kind: "success", text: labels.saved } : { kind: "failure", text: failure });
    })();
  };

  const remove = (rowId: string): void => {
    if (draft === null) return;
    setArmed(null);
    setDraft({ ...draft, entries: draft.entries.filter((entry) => entry.rowId !== rowId) });
  };

  if (view.kind !== "ready") return null;
  const entries = view.worldBook.entries;
  return (
    <section aria-label={labels.companionWorldBookTitle} data-companion-world-book>
      <h3>{labels.companionWorldBookTitle}</h3>
      <p className="management-settings-hint">{labels.companionWorldBookHint}</p>
      {entries.length === 0 ? (
        // Present but empty says so in words: a count of zero rendered as a list
        // header is the shape a player reads as "nothing was kept".
        <p data-companion-world-book-empty>{labels.companionWorldBookNoEntries}</p>
      ) : (
        // The trigger list is what this section is for, so its count is the
        // disclosure's own summary and the entries open on request. At 400x800 the
        // single Characters column stacks six sections and this was another 714 px
        // of unwrapped trigger words below them; the rows stay in the DOM, so the
        // count and every key remain readable once the disclosure opens.
        <details className="custom-disclosure" data-companion-world-book-disclosure>
          <summary>
            <ChevronDown size={16} aria-hidden="true" />
            <span data-companion-world-book-count>
              {labels.companionWorldBookCount.replace("{{count}}", String(entries.length))}
            </span>
          </summary>
          <div role="list" data-companion-world-book-list>
            {entries.map((entry, index) => (
              // A world book's entry id is a durable storage fact the browser is
              // never handed; the title and the index are what a list of entries
              // has to key by, and the title is not unique in a card.
              <div key={`${entry.title}\u0000${index}`} role="listitem" data-companion-world-book-entry>
                <strong>{entry.title}</strong>
                <p>
                  {entry.constant
                    ? labels.companionWorldBookAlwaysOn
                    : labels.companionWorldBookTriggerWords.replace(
                        "{{keys}}",
                        entry.keys.join(labels.companionWorldBookKeySeparator),
                      )}
                </p>
                {/* The entry's own text. It is what the player came to read: a row
                    that shows which words reach it but not what it says is a row
                    they can deliberately reach and still cannot read. Folded shut
                    by default so the list stays scannable, and rendered from the
                    Host's own projection - the `{{user}}`/`{{char}}` macros in the
                    card's text are already resolved by the time it arrives. */}
                <details className="custom-disclosure" data-companion-world-book-entry-text>
                  <summary>
                    <ChevronDown size={14} aria-hidden="true" />
                    {labels.companionWorldBookEntryText}
                  </summary>
                  <p className="companion-world-book-body">{entry.content}</p>
                </details>
              </div>
            ))}
          </div>
        </details>
      )}
      {/* The editor is offered whether or not the book carries entries: an empty
          book is the one a player most needs to add to. */}
      {draft === null ? (
        <div className="composer-actions">
          <button type="button" className="small-button" data-companion-world-book-edit onClick={beginEdit}>
            {labels.companionWorldBookEdit}
          </button>
        </div>
      ) : (
        <CompanionWorldBookEditor
          labels={labels}
          draft={draft}
          saving={saving}
          armed={armed}
          onChange={setDraft}
          onArm={setArmed}
          onRemove={remove}
          onSubmit={submit}
          onCancel={() => {
            setDraft(null);
            setArmed(null);
            setNotice(null);
          }}
        />
      )}
      {notice !== null && (
        <p
          role="status"
          data-companion-world-book-notice
          className={notice.kind === "success" ? "success-banner" : "error-banner"}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}

/**
 * The one editor for her own book: every entry's title, trigger words and body, plus
 * adding a row and removing one.
 *
 * Removal follows the product's destructive-row shape - arm, then confirm - because a
 * bare delete on a row beside a save control is a control a player fires by accident,
 * and an entry she wrote is not recoverable after the save. The body is the row's last
 * field and its own textarea rather than a fold: this is the one screen where the text
 * is being written, so hiding it would hide the field being edited.
 */
function CompanionWorldBookEditor({
  labels,
  draft,
  saving,
  armed,
  onChange,
  onArm,
  onRemove,
  onSubmit,
  onCancel,
}: Readonly<{
  labels: CharacterLabels;
  draft: CompanionWorldBookDraft;
  saving: boolean;
  armed: string | null;
  onChange: (draft: CompanionWorldBookDraft) => void;
  onArm: (rowId: string | null) => void;
  onRemove: (rowId: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}>): ReactElement {
  const updateEntry = (index: number, entry: CompanionWorldBookEntryDraft): void =>
    onChange({ ...draft, entries: draft.entries.map((item, itemIndex) => (itemIndex === index ? entry : item)) });
  return (
    <section data-companion-world-book-draft>
      <h3>{labels.companionWorldBookEditTitle}</h3>
      <p className="management-settings-hint">{labels.companionWorldBookEditHint}</p>
      {draft.entries.map((entry, index) => (
        <div key={entry.rowId} data-companion-world-book-entry-draft>
          <label className="management-settings-label" htmlFor={`companion-world-book-entry-${index}-title`}>
            {labels.worldBookEntryTitle}
          </label>
          <input
            id={`companion-world-book-entry-${index}-title`}
            className="form-input"
            type="text"
            maxLength={256}
            value={entry.title}
            onChange={(event) => updateEntry(index, { ...entry, title: event.target.value })}
          />
          <label className="management-settings-label" htmlFor={`companion-world-book-entry-${index}-keys`}>
            {labels.worldBookEntryKeys}
          </label>
          <input
            id={`companion-world-book-entry-${index}-keys`}
            className="form-input"
            type="text"
            value={entry.keys}
            onChange={(event) => updateEntry(index, { ...entry, keys: event.target.value })}
          />
          {/* The sentence belongs to the field above it. It used to be emitted after the switch
              below, where it read as that switch's caption while the field it describes sat two
              controls above. */}
          <p className="management-settings-hint">{labels.companionWorldBookEntryKeysHint}</p>
          {/* The one fact about an entry that is a switch rather than a string, beside
              the trigger words it overrides: an entry marked always with her is carried
              whether or not the player's words match, so a player who writes her own
              entry can say so here instead of leaving the words to decide. The draft
              carries the value to the save, which is the only thing the Host reads. */}
          <label className="companion-world-book-constant">
            <input
              id={`companion-world-book-entry-${index}-constant`}
              className="companion-world-book-constant-box"
              type="checkbox"
              data-companion-world-book-entry-constant
              checked={entry.constant}
              onChange={(event) => updateEntry(index, { ...entry, constant: event.target.checked })}
            />
            <span>{labels.companionWorldBookAlwaysOn}</span>
          </label>
          <label className="management-settings-label" htmlFor={`companion-world-book-entry-${index}-body`}>
            {labels.companionWorldBookEntryBody}
          </label>
          <textarea
            id={`companion-world-book-entry-${index}-body`}
            className="form-textarea"
            rows={4}
            maxLength={4096}
            value={entry.content}
            onChange={(event) => updateEntry(index, { ...entry, content: event.target.value })}
          />
          {/* The row's own removal, and only while it is armed: the confirmation is the
              row's only action until it is answered, and it never shares a line with the
              control it replaces. */}
          <CompanionWorldBookEntryRemove
            labels={labels}
            title={entry.title}
            armed={armed === entry.rowId}
            onArm={() => onArm(entry.rowId)}
            onCancel={() => onArm(null)}
            onRemove={() => onRemove(entry.rowId)}
          />
        </div>
      ))}
      <div className="composer-actions">
        <button
          type="button"
          className="small-button"
          data-companion-world-book-add
          onClick={() => onChange({ ...draft, entries: [...draft.entries, newCompanionWorldBookEntryDraft()] })}
        >
          {labels.companionWorldBookAddEntry}
        </button>
      </div>
      <div className="composer-actions">
        <button
          type="button"
          className="small-button"
          data-companion-world-book-save
          disabled={saving || !companionWorldBookDraftIsComplete(draft)}
          onClick={onSubmit}
        >
          {saving ? labels.saving : labels.companionWorldBookSave}
        </button>
        <button
          type="button"
          className="small-button"
          data-companion-world-book-cancel
          disabled={saving}
          onClick={onCancel}
        >
          {labels.worldBookCancel}
        </button>
      </div>
    </section>
  );
}

/**
 * One entry's removal: the control that arms it, and the confirmation that replaces it.
 *
 * It is a component of its own because the pair owns focus refs: the editor renders one of these per
 * authored row from inside a map, where a hook cannot be called once per row. A row's removal and the
 * item's removal below follow ONE shape - arm, confirm, cancel - and both take their keyboard path
 * from `useArmedConfirmation`: the trigger is unmounted by the press that arms it, so focus would
 * otherwise fall to `<body>` on open and not come back on cancel.
 */
function CompanionWorldBookEntryRemove({
  labels,
  title,
  armed,
  onArm,
  onCancel,
  onRemove,
}: Readonly<{
  labels: CharacterLabels;
  title: string;
  armed: boolean;
  onArm: () => void;
  onCancel: () => void;
  onRemove: () => void;
}>): ReactElement {
  const pair = useArmedConfirmation(armed, onCancel);
  return armed ? (
    <div data-companion-world-book-remove-confirm onKeyDown={pair.onConfirmKeyDown}>
      <p role="status" data-companion-world-book-remove-prompt>
        {labels.companionWorldBookRemoveConfirm.replace("{{title}}", title)}
      </p>
      <div className="composer-actions">
        <button type="button" className="small-button danger" data-companion-world-book-remove-yes onClick={onRemove}>
          {labels.companionWorldBookRemove}
        </button>
        <button
          ref={pair.cancelRef}
          type="button"
          className="small-button"
          data-companion-world-book-remove-no
          onClick={pair.cancel}
        >
          {labels.worldBookCancel}
        </button>
      </div>
    </div>
  ) : (
    <div className="composer-actions">
      <button
        ref={pair.triggerRef}
        type="button"
        className="small-button"
        data-companion-world-book-remove
        onClick={onArm}
      >
        {labels.companionWorldBookRemove}
      </button>
    </div>
  );
}

type WorldBookView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; worldInfo: WorldInfoStateV1 }>;

/** The one outcome line the panel reports, so two operations never print two notices. */
type WorldBookNotice = Readonly<{ kind: "success" | "failure"; text: string }> | null;

/** One entry being authored: the entry's own facts, with its trigger words as the player typed them. */
type WorldBookEntryDraft = Readonly<{
  /**
   * The row's own identity while it is being authored.
   *
   * It exists because the editor's rows are editable: keying them by position
   * makes React reconcile an edit into the wrong row and remount the input
   * mid-keystroke, which is what an index key is warned about. It is client-only
   * - `submitDraft` builds the wire payload field by field, so it cannot be sent -
   * and it is minted per row, so adding or removing rows never reuses one.
   */
  rowId: string;
  scope: "companion" | "setting";
  publicTitle: string;
  summary: string;
  keys: string;
}>;

/**
 * The next authoring row's identity. A module counter rather than a uuid: the id
 * never leaves the browser, and a counter keeps a test deterministic.
 */
let nextWorldBookRowId = 0;

function newWorldBookEntryDraft(): WorldBookEntryDraft {
  nextWorldBookRowId += 1;
  return {
    rowId: `world-book-row-${nextWorldBookRowId}`,
    scope: "setting",
    publicTitle: "",
    summary: "",
    keys: "",
  };
}

/**
 * The item being authored. `handle` is null while creating one; `itemRevision`
 * is the item's own content revision that `world-info.update` CASes on, which
 * only a content read can supply, so a create draft carries none.
 */
type WorldBookDraft = Readonly<{
  handle: string | null;
  itemRevision: number | null;
  publicTitle: string;
  summary: string;
  entries: readonly WorldBookEntryDraft[];
}>;

/** The entry a new draft starts with: a setting fact, which is what the importer's own fallback is. */
const EMPTY_WORLD_BOOK_ENTRY: WorldBookEntryDraft = Object.freeze(newWorldBookEntryDraft());

/** The entry's trigger words, comma-separated in any of the three comma shapes a player types. */
function parseTriggerWords(value: string): string[] {
  return value
    .split(/[,，、]/u)
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/**
 * Whether the draft is what the Host accepts: a title, a summary and at least
 * one entry, each with its own title and summary. An incomplete draft is not a
 * refusal - the submit control is simply not offered yet - because the Host
 * refuses an empty title or summary with `invalid_request`, which names nothing
 * a player can act on.
 */
/**
 * The submit control's own words: it says what pressing it will do, and while the
 * request is in flight it says that instead. A nested conditional in the JSX reads
 * as the three cases stacked in one line; naming them keeps each one legible.
 */
function worldBookSubmitLabel(
  saving: boolean,
  editing: boolean,
  labels: { saving: string; worldBookSave: string; worldBookCreateSubmit: string },
): string {
  if (saving) return labels.saving;
  return editing ? labels.worldBookSave : labels.worldBookCreateSubmit;
}

function worldBookDraftIsComplete(draft: WorldBookDraft): boolean {
  return (
    draft.publicTitle.trim().length > 0 &&
    draft.summary.trim().length > 0 &&
    draft.entries.length > 0 &&
    draft.entries.every((entry) => entry.publicTitle.trim().length > 0 && entry.summary.trim().length > 0)
  );
}

function CharacterWorldBookPanel({
  api,
  csrfToken,
  locale,
  read,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  locale: Locale;
  read: () => Promise<WorldInfoSurfaceSource>;
}): ReactElement | null {
  const labels = characterLabels(locale);
  // The sentence for a refusal is the product catalogue's, the same vocabulary the Chat view
  // words a refusal with; `labels` above is this panel's own field and control vocabulary.
  const problemLabels = messages(locale);
  const [view, setView] = useState<WorldBookView>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState<WorldBookNotice>(null);
  // The item whose own content is open, and the draft being authored (null when
  // no editor is open). The two are separate: reading an item never opens an
  // editor, and an editor can be open over a closed item.
  const [opened, setOpened] = useState<Readonly<{ handle: string; content: WorldInfoContentV1 }> | null>(null);
  const [draft, setDraft] = useState<WorldBookDraft | null>(null);
  const [saving, setSaving] = useState(false);
  // The item whose delete is armed. Arming is per item and per panel, so a
  // second arm replaces the first and no stale arm can fire on another row.
  const [armed, setArmed] = useState<string | null>(null);
  // The picked lorebook file waiting to be imported: a raw ST/Chub world book
  // the Host's own importer turns into a library item. Held client-side until the
  // player presses Import, so picking a file is not itself a durable change.
  const [pickedLorebook, setPickedLorebook] = useState<Readonly<{
    name: string;
    lorebook: Record<string, unknown>;
  }> | null>(null);
  const [importing, setImporting] = useState(false);
  const lorebookInputRef = useRef<HTMLInputElement>(null);

  const readOnce = useCallback(async (): Promise<WorldBookView> => {
    try {
      const source = await read();
      setGeneration(source.selectionGeneration);
      return source.worldInfo === null ? { kind: "unavailable" } : { kind: "ready", worldInfo: source.worldInfo };
    } catch {
      return { kind: "error" };
    }
  }, [read]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await readOnce();
      if (active) setView(next);
    })();
    return () => {
      active = false;
    };
    // The reader is the mount's own authority for its World Info revision and is
    // stable for the life of the surface, so this is the mount's one read; a
    // re-read is driven by the bind below.
  }, [readOnce]);

  const bind = (sourceHandle: string | null): void => {
    if (view.kind !== "ready") return;
    const expectedRevision = view.worldInfo.revision;
    void (async () => {
      let failure: string | null = null;
      try {
        await api.setWorldInfoBinding(
          { apiVersion: 1, selectionGeneration: generation, expectedRevision, sourceHandle },
          csrfToken,
        );
      } catch (error) {
        failure = problemTextWithCode(labels.worldBookFailed, error, problemLabels);
      }
      const next = await readOnce();
      setView(next);
      setNotice(failure === null ? { kind: "success", text: labels.saved } : { kind: "failure", text: failure });
    })();
  };

  /**
   * Reads one item's own content. Both the disclosure and the edit form need it:
   * the entries are the item's text, and the content's own revision is the CAS
   * an edit carries, so an editor never opens on a revision the panel guessed.
   */
  const readItem = async (itemHandle: string): Promise<WorldInfoContentV1 | null> => {
    if (view.kind !== "ready") return null;
    try {
      return await api.readWorldInfoItem({
        apiVersion: 1,
        selectionGeneration: generation,
        expectedRevision: view.worldInfo.revision,
        itemHandle,
      });
    } catch (error) {
      setOpened(null);
      setNotice({ kind: "failure", text: problemTextWithCode(labels.worldBookDetailFailed, error, problemLabels) });
      return null;
    }
  };

  const toggleEntries = (itemHandle: string): void => {
    if (opened !== null && opened.handle === itemHandle) {
      setOpened(null);
      return;
    }
    void (async () => {
      const content = await readItem(itemHandle);
      if (content !== null) setOpened({ handle: itemHandle, content });
    })();
  };

  const beginCreate = (): void => {
    setDraft({
      handle: null,
      itemRevision: null,
      publicTitle: "",
      summary: "",
      entries: [EMPTY_WORLD_BOOK_ENTRY],
    });
    setOpened(null);
    setArmed(null);
    setNotice(null);
  };

  const beginEdit = (itemHandle: string): void => {
    void (async () => {
      const content = await readItem(itemHandle);
      if (content === null) return;
      setDraft({
        handle: itemHandle,
        itemRevision: content.revision,
        publicTitle: content.publicTitle,
        summary: content.summary,
        entries: content.entries.map((entry) => ({
          ...newWorldBookEntryDraft(),
          scope: entry.scope,
          publicTitle: entry.publicTitle,
          summary: entry.summary,
          keys: (entry.keys ?? []).join(labels.companionWorldBookKeySeparator),
        })),
      });
      setArmed(null);
      setNotice(null);
    })();
  };

  /**
   * Creates or rewrites the draft. The Host's own reply is the new projection,
   * so a saved item is re-rendered from what it returned rather than from what
   * the panel asked for; a refusal re-reads the library BEFORE it is reported,
   * because the next command CASes on the revision that read-back carries.
   */
  const submitDraft = (): void => {
    if (view.kind !== "ready" || draft === null || !worldBookDraftIsComplete(draft)) return;
    const expectedRevision = view.worldInfo.revision;
    const target = draft.handle;
    const authored = {
      publicTitle: draft.publicTitle.trim(),
      summary: draft.summary.trim(),
      entries: draft.entries.map((entry) => {
        const keys = parseTriggerWords(entry.keys);
        return {
          scope: entry.scope,
          publicTitle: entry.publicTitle.trim(),
          summary: entry.summary.trim(),
          ...(keys.length === 0 ? {} : { keys }),
        };
      }),
    };
    setSaving(true);
    void (async () => {
      let failure: string | null = null;
      try {
        const result =
          target === null
            ? await api.createWorldInfo(
                { apiVersion: 1, selectionGeneration: generation, expectedRevision, item: authored },
                csrfToken,
              )
            : await api.updateWorldInfo(
                {
                  apiVersion: 1,
                  selectionGeneration: generation,
                  expectedRevision,
                  itemHandle: target,
                  item: { ...authored, expectedRevision: draft.itemRevision ?? 1 },
                },
                csrfToken,
              );
        setView({ kind: "ready", worldInfo: result });
        setDraft(null);
        setOpened(null);
      } catch (error) {
        failure = problemTextWithCode(
          target === null ? labels.worldBookCreateFailed : labels.worldBookSaveFailed,
          error,
          problemLabels,
        );
        setView(await readOnce());
      } finally {
        setSaving(false);
      }
      setNotice(failure === null ? { kind: "success", text: labels.saved } : { kind: "failure", text: failure });
    })();
  };

  const remove = (itemHandle: string): void => {
    if (view.kind !== "ready") return;
    const expectedRevision = view.worldInfo.revision;
    setArmed(null);
    void (async () => {
      let failure: string | null = null;
      try {
        const result = await api.deleteWorldInfo(
          { apiVersion: 1, selectionGeneration: generation, expectedRevision, itemHandle },
          csrfToken,
        );
        setView({ kind: "ready", worldInfo: result });
        // The item the removal named is gone from the library, so anything this
        // panel held open on it closes with it: an editor left open on a removed
        // item would save into `world_info_not_found`.
        if (opened !== null && opened.handle === itemHandle) setOpened(null);
        if (draft !== null && draft.handle === itemHandle) setDraft(null);
      } catch (error) {
        failure = problemTextWithCode(labels.worldBookDeleteFailed, error, problemLabels);
        setView(await readOnce());
      }
      setNotice(
        failure === null ? { kind: "success", text: labels.worldBookDeleted } : { kind: "failure", text: failure },
      );
    })();
  };

  /**
   * The picked lorebook file, read in this browser and held until Import.
   *
   * The file's interior is never inspected here: the Host's own importer is the one place that
   * translates an ST/Chub/`character_book` payload, and this side only proves the bytes are a JSON
   * object (the shape the route's schema carries) before offering them. A file that is not JSON, is
   * too large, or is not an object gets its own sentence rather than a request the Host would refuse.
   */
  const handleLorebookFile = async (file: File): Promise<void> => {
    setNotice(null);
    setPickedLorebook(null);
    if (file.size > MAX_LOREBOOK_FILE_BYTES) {
      setNotice({ kind: "failure", text: labels.worldBookImportTooLarge });
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(await file.arrayBuffer()).replace(/^\uFEFF/u, "");
      const value: unknown = JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not_object");
      setPickedLorebook({ name: file.name, lorebook: value as Record<string, unknown> });
    } catch {
      setNotice({ kind: "failure", text: labels.worldBookImportInvalid });
    }
  };

  /**
   * Imports the picked file through the library's own importer. The Host's reply is the new
   * projection, so the imported item is re-rendered from what the Host returned rather than from
   * anything this side holds; a refusal re-reads the library before it is reported.
   */
  const importLorebook = (): void => {
    if (view.kind !== "ready" || pickedLorebook === null || importing) return;
    const expectedRevision = view.worldInfo.revision;
    const lorebook = pickedLorebook.lorebook;
    setImporting(true);
    void (async () => {
      let failure: string | null = null;
      try {
        const result = await api.importWorldInfo(
          { apiVersion: 1, selectionGeneration: generation, expectedRevision, lorebook },
          csrfToken,
        );
        setView({ kind: "ready", worldInfo: result });
        setPickedLorebook(null);
      } catch (error) {
        failure = problemTextWithCode(labels.worldBookImportFailed, error, problemLabels);
        setView(await readOnce());
      } finally {
        setImporting(false);
      }
      setNotice(
        failure === null
          ? { kind: "success", text: labels.worldBookImportImported }
          : { kind: "failure", text: failure },
      );
    })();
  };

  if (view.kind === "loading") return null;
  if (view.kind === "error" || view.kind === "unavailable") {
    return (
      <section aria-label={labels.worldBookTitle} data-world-book>
        <h3>{labels.worldBookTitle}</h3>
        <p className="management-settings-hint">{labels.worldBookHint}</p>
        <p>{labels.worldBookUnavailable}</p>
      </section>
    );
  }

  const items = view.worldInfo.items;
  return (
    <section className="management-settings-section" aria-label={labels.worldBookTitle} data-world-book>
      <h3>{labels.worldBookTitle}</h3>
      <p className="management-settings-hint">{labels.worldBookHint}</p>
      {/* Empty is where every fresh product starts: the repository seeds no
          library anywhere, so a panel that rendered nothing here left the whole
          authoring path invisible and unreachable. The empty library says so
          and offers the one control that can change it. */}
      {items.length === 0 ? (
        <p className="management-settings-hint" data-world-book-empty>
          {labels.worldBookEmpty}
        </p>
      ) : (
        <div role="list" data-world-book-list>
          {items.map((item) => (
            <WorldBookItemRow
              key={item.handle}
              item={item}
              opened={opened !== null && opened.handle === item.handle ? opened.content : null}
              isArmed={armed === item.handle}
              labels={labels}
              onBind={bind}
              onToggleEntries={toggleEntries}
              onBeginEdit={beginEdit}
              onArm={() => setArmed(item.handle)}
              onDisarm={() => setArmed(null)}
              onRemove={remove}
            />
          ))}
        </div>
      )}
      {/* Creating a second item is served by the same route, so the entry point
          is here whether or not the library already holds one. */}
      {draft === null && (
        <div className="composer-actions">
          <button type="button" className="small-button" data-world-book-create onClick={beginCreate}>
            {labels.worldBookCreate}
          </button>
        </div>
      )}
      {/* Importing an existing world book file is the other way a library item appears, and it is
          the one that serves the library's own SillyTavern/Chub importer to the player: the file is
          chosen here, held locally, and posted whole only when Import is pressed. */}
      <div className="composer-actions">
        <button
          type="button"
          className="small-button"
          data-world-book-import-trigger
          disabled={importing}
          onClick={() => lorebookInputRef.current?.click()}
        >
          {labels.worldBookImport}
        </button>
        <input
          ref={lorebookInputRef}
          type="file"
          accept=".json,application/json"
          aria-label={labels.worldBookImportFileLabel}
          className="card-import-file-input"
          disabled={importing}
          tabIndex={-1}
          data-world-book-import-file
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void handleLorebookFile(file);
          }}
        />
      </div>
      {pickedLorebook !== null && (
        <div className="composer-actions" data-world-book-import-picked>
          <p className="management-settings-hint">{pickedLorebook.name}</p>
          <button
            type="button"
            className="small-button primary"
            data-world-book-import-submit
            disabled={importing}
            onClick={importLorebook}
          >
            {importing ? labels.worldBookImportBusy : labels.worldBookImport}
          </button>
          <button type="button" className="small-button" disabled={importing} onClick={() => setPickedLorebook(null)}>
            {labels.worldBookCancel}
          </button>
        </div>
      )}
      {draft !== null && (
        <WorldBookDraftEditor
          labels={labels}
          draft={draft}
          saving={saving}
          onChange={setDraft}
          onSubmit={submitDraft}
          onCancel={() => setDraft(null)}
        />
      )}
      {view.worldInfo.state === "pending" && <p>{labels.worldBookPending}</p>}
      {notice !== null && (
        <p role="status" className={notice.kind === "success" ? "success-banner" : "error-banner"}>
          {notice.text}
        </p>
      )}
    </section>
  );
}

/**
 * One row of the library: what an item is, its attach/detach control, the
 * authoring strip, the armed delete confirmation, and - when the item's content is
 * open - the entries that content holds.
 *
 * It is a component rather than a block inside the panel because the panel was 395
 * lines of render and handlers: the parts that only draw are separated from the
 * parts that own state, so the panel reads as the state machine it is.
 */
function WorldBookItemRow({
  item,
  opened,
  isArmed,
  labels,
  onBind,
  onToggleEntries,
  onBeginEdit,
  onArm,
  onDisarm,
  onRemove,
}: {
  item: WorldInfoStateV1["items"][number];
  opened: WorldInfoContentV1 | null;
  isArmed: boolean;
  labels: ReturnType<typeof characterLabels>;
  onBind: (sourceHandle: string | null) => void;
  onToggleEntries: (itemHandle: string) => void;
  onBeginEdit: (itemHandle: string) => void;
  onArm: () => void;
  onDisarm: () => void;
  onRemove: (itemHandle: string) => void;
}): ReactElement {
  const isOpen = opened !== null;
  // The row's own removal pair, with the focus path its two states need
  // (`armed-confirmation.ts`): the trigger is replaced by the confirmation.
  const removal = useArmedConfirmation(isArmed, onDisarm);
  return (
    <div role="listitem" data-world-book-item={item.handle}>
      <strong>{item.title}</strong>
      {item.summary !== null && <p>{item.summary}</p>}
      <div className="composer-actions">
        {item.selected || item.pending ? (
          <button
            type="button"
            className="small-button"
            aria-label={`${labels.worldBookDetach}: ${item.title}`}
            onClick={() => onBind(null)}
          >
            {labels.worldBookDetach}
          </button>
        ) : (
          <button
            type="button"
            className="small-button"
            aria-label={`${labels.worldBookAttach}: ${item.title}`}
            onClick={() => onBind(item.handle)}
          >
            {labels.worldBookAttach}
          </button>
        )}
      </div>
      {/* The row's own authoring strip, and while its delete is armed the strip
          steps aside: the confirmation is the row's only action until it is
          answered, and it never shares a line with the controls it replaces. */}
      {isArmed ? (
        <div data-world-book-confirm onKeyDown={removal.onConfirmKeyDown}>
          <p role="status" data-world-book-confirm-prompt>
            {labels.worldBookDeleteConfirm.replace("{{title}}", item.title)}
          </p>
          <div className="composer-actions">
            <button
              type="button"
              className="small-button danger"
              data-world-book-confirm-yes
              onClick={() => onRemove(item.handle)}
            >
              {labels.worldBookDelete}
            </button>
            <button
              type="button"
              className="small-button"
              data-world-book-confirm-no
              ref={removal.cancelRef}
              onClick={removal.cancel}
            >
              {labels.worldBookCancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-actions">
          <button
            type="button"
            className="small-button"
            data-world-book-open
            aria-expanded={isOpen}
            onClick={() => onToggleEntries(item.handle)}
          >
            {isOpen ? labels.worldBookHideEntries : labels.worldBookShowEntries}
          </button>
          <button
            type="button"
            className="small-button"
            data-world-book-edit
            aria-label={`${labels.worldBookEdit}: ${item.title}`}
            onClick={() => onBeginEdit(item.handle)}
          >
            {labels.worldBookEdit}
          </button>
          <button
            ref={removal.triggerRef}
            type="button"
            className="small-button"
            data-world-book-delete
            aria-label={`${labels.worldBookDelete}: ${item.title}`}
            onClick={onArm}
          >
            {labels.worldBookDelete}
          </button>
        </div>
      )}
      {opened !== null && (
        <div data-world-book-content>
          <p className="management-settings-hint">{labels.worldBookEntriesLabel}</p>
          {opened.entries.length === 0 ? (
            <p className="management-settings-hint" data-world-book-content-empty>
              {labels.worldBookEntriesEmpty}
            </p>
          ) : (
            <div role="list" data-world-book-entry-list>
              {opened.entries.map((entry) => (
                // An entry has no durable id on this wire: the fields the player reads
                // are what distinguish one from another, so the key is built from them
                // rather than from the position in the list - a position is not an
                // identity, and keying by it is exactly what makes a reordered list
                // reconcile into the wrong rows. Two entries equal in every one of
                // these fields are the same row to the player.
                <div
                  key={`${entry.publicTitle}\u0000${entry.scope}\u0000${entry.summary}\u0000${(entry.keys ?? []).join(",")}`}
                  role="listitem"
                  data-world-book-entry
                >
                  <strong>{entry.publicTitle}</strong>
                  <p>{entry.summary}</p>
                  <p className="management-settings-hint" data-world-book-entry-facts>
                    {entry.scope === "companion"
                      ? labels.worldBookEntryScopeCompanion
                      : labels.worldBookEntryScopeSetting}
                    {entry.keys === undefined || entry.keys.length === 0
                      ? ` - ${labels.companionWorldBookAlwaysOn}`
                      : ` - ${labels.worldBookEntryKeys}: ${entry.keys.join(labels.companionWorldBookKeySeparator)}`}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The one authoring form, used for a new item and for an existing one: the same
 * content, the same fields and the same validation, so the two cannot drift.
 *
 * Every field is the Host's own shape - a title and a summary on the item, and a
 * scope, a title, a summary and optional trigger words on each entry - because
 * what the wire validates is what the player is offered; a control for a fact
 * the item does not carry (a secondary key list, a selective logic) is not here.
 */
function WorldBookDraftEditor({
  labels,
  draft,
  saving,
  onChange,
  onSubmit,
  onCancel,
}: Readonly<{
  labels: CharacterLabels;
  draft: WorldBookDraft;
  saving: boolean;
  onChange: (draft: WorldBookDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}>): ReactElement {
  const editing = draft.handle !== null;
  const updateEntry = (index: number, entry: WorldBookEntryDraft): void =>
    onChange({ ...draft, entries: draft.entries.map((item, itemIndex) => (itemIndex === index ? entry : item)) });
  return (
    <section data-world-book-draft>
      <h3>
        {editing ? labels.worldBookEditTitle.replace("{{title}}", draft.publicTitle) : labels.worldBookCreateTitle}
      </h3>
      <p className="management-settings-hint">{labels.worldBookDraftHint}</p>
      <label className="management-settings-label" htmlFor="world-book-item-title">
        {labels.worldBookItemTitle}
      </label>
      <input
        id="world-book-item-title"
        className="form-input"
        type="text"
        maxLength={128}
        value={draft.publicTitle}
        onChange={(event) => onChange({ ...draft, publicTitle: event.target.value })}
      />
      <label className="management-settings-label" htmlFor="world-book-item-summary">
        {labels.worldBookItemSummary}
      </label>
      <textarea
        id="world-book-item-summary"
        className="form-textarea"
        rows={3}
        maxLength={4000}
        value={draft.summary}
        onChange={(event) => onChange({ ...draft, summary: event.target.value })}
      />
      <p className="management-settings-label">{labels.worldBookEntriesLabel}</p>
      {draft.entries.map((entry, index) => (
        <div key={entry.rowId} data-world-book-entry-draft>
          <label className="management-settings-label" htmlFor={`world-book-entry-${index}-scope`}>
            {labels.worldBookEntryScope}
          </label>
          <select
            id={`world-book-entry-${index}-scope`}
            className="form-select"
            value={entry.scope}
            onChange={(event) =>
              updateEntry(index, { ...entry, scope: event.target.value === "companion" ? "companion" : "setting" })
            }
          >
            <option value="setting">{labels.worldBookEntryScopeSetting}</option>
            <option value="companion">{labels.worldBookEntryScopeCompanion}</option>
          </select>
          <label className="management-settings-label" htmlFor={`world-book-entry-${index}-title`}>
            {labels.worldBookEntryTitle}
          </label>
          <input
            id={`world-book-entry-${index}-title`}
            className="form-input"
            type="text"
            maxLength={128}
            value={entry.publicTitle}
            onChange={(event) => updateEntry(index, { ...entry, publicTitle: event.target.value })}
          />
          <label className="management-settings-label" htmlFor={`world-book-entry-${index}-summary`}>
            {labels.worldBookEntrySummary}
          </label>
          <textarea
            id={`world-book-entry-${index}-summary`}
            className="form-textarea"
            rows={3}
            maxLength={4000}
            value={entry.summary}
            onChange={(event) => updateEntry(index, { ...entry, summary: event.target.value })}
          />
          <label className="management-settings-label" htmlFor={`world-book-entry-${index}-keys`}>
            {labels.worldBookEntryKeys}
          </label>
          <input
            id={`world-book-entry-${index}-keys`}
            className="form-input"
            type="text"
            value={entry.keys}
            onChange={(event) => updateEntry(index, { ...entry, keys: event.target.value })}
          />
          <p className="management-settings-hint">{labels.worldBookEntryKeysHint}</p>
          <div className="composer-actions">
            <button
              type="button"
              className="small-button"
              data-world-book-entry-remove
              disabled={draft.entries.length <= 1}
              onClick={() =>
                onChange({ ...draft, entries: draft.entries.filter((_, itemIndex) => itemIndex !== index) })
              }
            >
              {labels.worldBookEntryRemove}
            </button>
          </div>
        </div>
      ))}
      <div className="composer-actions">
        <button
          type="button"
          className="small-button"
          data-world-book-entry-add
          onClick={() => onChange({ ...draft, entries: [...draft.entries, EMPTY_WORLD_BOOK_ENTRY] })}
        >
          {labels.worldBookEntryAdd}
        </button>
      </div>
      {/* The form's own act row. The draft is one column of every entry the item
          holds and a real one runs thousands of pixels, so this row follows the
          scrollport instead of the form's top: the player who is editing the
          first entry reaches 保存 without scrolling past the rest of it. The row
          keeps its place in the flow, so the form's height is unchanged and the
          row's own buttons, and what they do, are untouched. */}
      <div className="composer-actions" data-world-book-draft-actions>
        <button
          type="button"
          className="small-button"
          data-world-book-submit
          disabled={saving || !worldBookDraftIsComplete(draft)}
          onClick={onSubmit}
        >
          {worldBookSubmitLabel(saving, editing, labels)}
        </button>
        <button type="button" className="small-button" data-world-book-cancel disabled={saving} onClick={onCancel}>
          {labels.worldBookCancel}
        </button>
      </div>
    </section>
  );
}
