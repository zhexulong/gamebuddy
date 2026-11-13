import { ChevronDown } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { problemTextWithCode } from "../composed-problem-view";
import { type Locale, type Messages, messages } from "../i18n";
import {
  type CompanionWorldBookV1,
  type ManagementPipelineApi,
  TavernProblemError,
  TavernProtocolError,
} from "../management-pipeline-api";
import { useArmedConfirmation } from "./armed-confirmation";
import { type CharacterLabels, characterLabels } from "./character-domain-labels";
import { useRecordDraft } from "./surface-drafts";
import { parseTriggerWords } from "./world-book-trigger-words";

type CompanionWorldBookView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "unreadable" }>
  | Readonly<{ kind: "ready"; handle: string; worldBook: CompanionWorldBookV1 }>;

/**
 * The outcome of one read of the book: the projection, or the fact that there is none.
 *
 * `absent` projects as "she has no book" and renders no block; the two failure states are not book
 * states at all. `failed` is a read the Host refused or never served, and `unreadable` is a reply it
 * DID serve that the client mirror refuses - a different fault, with a different sentence, because
 * the first is answered by reading again and the second by a build that knows what the Host now says.
 *
 * Neither borrows the other's words: reporting a parse failure as a read failure sent the player to
 * retry a read that had already succeeded.
 *
 * A re-read's failure (either kind) leaves a ready view alone rather than taking the mount's failure
 * branch, because re-rendering a ready surface as `absent` would unmount the editor and the player's
 * unsigned entries with it.
 */
type CompanionWorldBookRead = CompanionWorldBookView;

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
  /** The switch that decides whether this entry takes part; a switched-off one stays in the book. */
  enabled: boolean;
  content: string;
}>;

type CompanionWorldBookDraft = Readonly<{
  handle: string;
  /**
   * The durable revision the next save CASes on: the one the read carried, and after a
   * conflict refusal the one the re-read carries. It follows the book; the entries below
   * never do, because they are what the player wrote.
   */
  expectedRevision: number;
  entries: readonly CompanionWorldBookEntryDraft[];
  /**
   * The titles the book carried when this editor opened, so a conflict can name the rows the
   * book no longer has while the player's version of them stays in the editor. Empty for a
   * fresh editor over an empty book, and never rewritten: it is the snapshot the edit is
   * measured against, not a projection of the book.
   */
  openedTitles: readonly string[];
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
    enabled: entry.enabled,
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
    enabled: true,
    content: "",
  };
}

/**
 * Which of the two failure states a read that produced no book is.
 *
 * `TavernProtocolError` is the client's one "the reply did not conform" fact - a 200 whose body the
 * mirror refuses, a body that is not JSON at all, a success status the route does not answer with.
 * Everything else (a problem envelope the Host sent, a transport that never reached it) is the Host
 * not serving the read. The mirror's strictness is not negotiable here: the published contract makes
 * an entry's `enabled` required, and a client that accepted a book without it would render every such
 * entry as switched off. What the panel may not do is call the second fact the first one's name.
 */
function companionWorldBookReadFailure(error: unknown): "failed" | "unreadable" {
  return error instanceof TavernProtocolError ? "unreadable" : "failed";
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
 * Whether this refusal is the one the editor can move on from: the book changed under a save
 * whose revision was already stale, which the Host states as `companion_world_book_conflict`.
 */
function isCompanionWorldBookConflict(error: unknown): boolean {
  return error instanceof TavernProblemError && error.code === "companion_world_book_conflict";
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

/**
 * The companion's own world book, which the player reads AND edits.
 *
 * This is the book that belongs to the character - the reviewed card's `character_book`, which the
 * Host persisted under her runtime root - and not the managed library beside it: a different list,
 * from a different store, with a different verb. Every write here goes through
 * `companion.worldbook.update` as one whole-list CAS on the revision this read carried.
 *
 * `absent` is "she has no book" and renders no block: the surface never invents one, and an empty
 * book it did not read would be a book it made up. The two failure states are the OTHER fact - no
 * book came back - and each renders its own line with the read again, because collapsing either into
 * `absent` made a read the Host never answered look exactly like a companion who has no world book:
 * the block simply was not there, and nothing on the surface said why. `failed` is the Host not
 * serving the read; `unreadable` is a reply the client mirror refuses - a condition the button under
 * it does not clear - so the two are told apart in the words AND in the weight of the line, which is
 * what a player reads; the `data-` attributes are what a journey reads. A book that
 * exists is editable even when it carries no entries: an empty book is exactly the one a player has
 * to be able to add to.
 *
 * The draft carries two different things with two different owners: the revision its save
 * CASes on, which follows the book (`submit` moves it to the revision a conflict re-read
 * returns), and the entries, which belong to the player and are never taken from a read.
 *
 * Which is why the draft is the SHELL's and not this block's: the block is rendered only while
 * Characters is the selected surface, so leaving for Settings unmounted it and an editor that
 * came back CLOSED put every entry the player had written out of reach. The record is held whole
 * - one draft with its revision and its rows - so the rows keep their own `rowId` and cannot
 * land on each other.
 */
export function CompanionWorldBookSection({
  api,
  csrfToken,
  locale,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  locale: Locale;
}): ReactElement | null {
  const labels = characterLabels(locale);
  // The retry's own words are the catalogue's, the same control the shell draws over a problem view.
  const problemLabels = messages(locale);
  const [view, setView] = useState<CompanionWorldBookView>({ kind: "loading" });
  const bookDraft = useRecordDraft<CompanionWorldBookDraft>("characters.companion-world-book", null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<CompanionWorldBookNotice>(null);
  // The row whose removal is armed. Arming is per row and per section, so a second arm
  // replaces the first and no stale arm can fire on another entry.
  const [armed, setArmed] = useState<string | null>(null);

  const readOnce = async (): Promise<CompanionWorldBookRead> => {
    try {
      // The book belongs to the mounted companion, exactly as the persona,
      // scenario, opening and directive do: the surface reads the current
      // library entry's own book and no other companion's.
      const list = await api.listCompanions();
      const current = list.companions.find((entry) => entry.isCurrent);
      if (current === undefined) return { kind: "absent" };
      const worldBook = await api.readCompanionWorldBook(current.handle);
      return worldBook.present ? { kind: "ready", handle: current.handle, worldBook } : { kind: "absent" };
    } catch (error) {
      return { kind: companionWorldBookReadFailure(error) };
    }
  };

  const reload = (): void => {
    setView({ kind: "loading" });
    void (async () => setView(await readOnce()))();
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      const next = await readOnce();
      // The mount has no earlier view to keep, so a failed first read says so - it is not a book
      // state, and rendering no block was indistinguishable from a companion who has no book.
      if (active) setView(next);
    })();
    return () => {
      active = false;
    };
    // The client is the mount's own authority and is stable for the life of the surface.
  }, [api]);

  const beginEdit = (): void => {
    if (view.kind !== "ready" || view.worldBook.revision === null) return;
    bookDraft.type({
      handle: view.handle,
      expectedRevision: view.worldBook.revision,
      entries: view.worldBook.entries.map(toCompanionWorldBookEntryDraft),
      openedTitles: view.worldBook.entries.map((entry) => entry.title),
    });
    setArmed(null);
    setNotice(null);
  };

  /**
   * Saves the whole list. The Host's own reply is the new projection, so a saved book
   * is re-rendered from what it returned rather than from what the editor asked for; a
   * refusal re-reads the book BEFORE it is reported, so the surface shows the truth.
   *
   * A conflict is the one refusal the editor moves on from: the re-read's revision becomes the
   * revision the next save CASes on, so pressing save again lands instead of resending a
   * revision that already lost. The entries are not taken from that read - they are the
   * player's, and a rebase that replaced them would answer a refusal by deleting her work.
   */
  const submit = (): void => {
    const target = bookDraft.value;
    if (target === null || !companionWorldBookDraftIsComplete(target)) return;
    const entries = target.entries.map((entry) => ({
      title: entry.title.trim(),
      keys: parseTriggerWords(entry.keys),
      constant: entry.constant,
      enabled: entry.enabled,
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
        bookDraft.clear();
      } catch (error) {
        failure = companionWorldBookRefusal(labels, error, messages(locale));
        const reread = await readOnce();
        // A re-read that failed - refused or unreadable - leaves the surface as it was: the editor and
        // the player's entries stay, and the refusal is reported on its own.
        const rereadView = reread.kind === "failed" || reread.kind === "unreadable" ? null : reread;
        if (rereadView !== null) setView(rereadView);
        if (isCompanionWorldBookConflict(error) && rereadView !== null && rereadView.kind === "ready") {
          const revision = rereadView.worldBook.revision;
          if (revision !== null) {
            bookDraft.amend((current) => (current === null ? null : { ...current, expectedRevision: revision }));
            const removed = target.openedTitles.filter(
              (title) => !rereadView.worldBook.entries.some((entry) => entry.title === title),
            );
            if (removed.length > 0)
              failure = `${failure} ${labels.companionWorldBookConflictEntryGone.replace(
                "{{titles}}",
                removed.join(labels.companionWorldBookKeySeparator),
              )}`;
          }
        }
      } finally {
        setSaving(false);
      }
      setNotice(failure === null ? { kind: "success", text: labels.saved } : { kind: "failure", text: failure });
    })();
  };

  const remove = (rowId: string): void => {
    const current = bookDraft.value;
    if (current === null) return;
    setArmed(null);
    bookDraft.type({ ...current, entries: current.entries.filter((entry) => entry.rowId !== rowId) });
  };

  if (view.kind === "failed" || view.kind === "unreadable") {
    // One shell for both, because both offer the same one action - the read again - and two facts,
    // because the player needs to know which side broke. Each sentence carries its own next action,
    // and the one the button beneath it does not clear is said in the louder face: a weight step is
    // the only channel here that means what it is ("read this first") rather than a colour invented
    // to stand for a state.
    const unreadable = view.kind === "unreadable";
    return (
      <section
        aria-label={labels.companionWorldBookTitle}
        data-companion-world-book
        data-companion-world-book-failed={unreadable ? undefined : true}
        data-companion-world-book-unreadable={unreadable ? true : undefined}
      >
        <h3>{labels.companionWorldBookTitle}</h3>
        <p className="management-settings-hint">{labels.companionWorldBookHint}</p>
        <p>
          {unreadable ? (
            <strong>{labels.companionWorldBookReplyUnreadable}</strong>
          ) : (
            labels.companionWorldBookReadFailed
          )}
        </p>
        <button type="button" className="small-button" data-companion-world-book-retry onClick={reload}>
          {problemLabels.problemRetryRead}
        </button>
      </section>
    );
  }
  if (view.kind !== "ready") return null;
  const entries = view.worldBook.entries;
  const draft = bookDraft.value;
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
                {/* A switched-off entry is still hers and still listed; saying so is the whole
                    difference between an entry she parked and one the book lost. */}
                {!entry.enabled && <p data-companion-world-book-entry-disabled>{labels.companionWorldBookDisabled}</p>}
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
          {/* The editor's own entry control, declared so the draft gate opens it rather than
              enumerating a surface with the player's newest editor outside the population. */}
          <button
            type="button"
            className="small-button"
            data-companion-world-book-edit
            data-draft-revealer
            onClick={beginEdit}
          >
            {labels.companionWorldBookEdit}
          </button>
        </div>
      ) : (
        <CompanionWorldBookEditor
          labels={labels}
          draft={draft}
          saving={saving}
          armed={armed}
          onChange={bookDraft.type}
          onArm={setArmed}
          onRemove={remove}
          onSubmit={submit}
          onCancel={() => {
            bookDraft.clear();
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
          {/* The other switch about the same entry, and the one that decides whether it is read
              at all: switched off, the entry stays here (and in her book) and reaches nothing. */}
          <label className="companion-world-book-constant">
            <input
              id={`companion-world-book-entry-${index}-enabled`}
              className="companion-world-book-constant-box"
              type="checkbox"
              data-companion-world-book-entry-enabled
              checked={entry.enabled}
              onChange={(event) => updateEntry(index, { ...entry, enabled: event.target.checked })}
            />
            <span>{labels.worldBookEntryEnabled}</span>
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
 * item's removal in the library panel follow ONE shape - arm, confirm, cancel - and both take their
 * keyboard path from `useArmedConfirmation`: the trigger is unmounted by the press that arms it, so
 * focus would otherwise fall to `<body>` on open and not come back on cancel.
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
