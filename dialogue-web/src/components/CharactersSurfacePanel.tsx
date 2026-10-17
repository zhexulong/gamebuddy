import { ChevronDown } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import type { Locale } from "../i18n";
import type {
  CompanionWorldBookV1,
  ManagementPipelineApi,
  WorldInfoContentV1,
  WorldInfoStateV1,
} from "../management-pipeline-api";
import { problemTextWithCode } from "../management-pipeline-api";
import type { WorldInfoSurfaceSource } from "./management-surface-panels";
import { CharactersPanel } from "./CharactersPanel";
import { characterLabels, type CharacterLabels } from "./character-domain-labels";

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
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  locale: Locale;
  read: () => Promise<WorldInfoSurfaceSource>;
}): ReactElement {
  return (
    <>
      <CharactersPanel api={api} csrfToken={csrfToken} locale={locale} />
      <CompanionWorldBookSection api={api} locale={locale} />
      <CharacterWorldBookPanel api={api} csrfToken={csrfToken} locale={locale} read={read} />
    </>
  );
}

/**
 * The companion's own world book. `absent` is both "she has no book" and "the
 * read could not be served": neither is a book, so neither renders a block - the
 * surface never invents one, and a failed read never reads as an empty book.
 */
type CompanionWorldBookView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "ready"; worldBook: CompanionWorldBookV1 }>;

function CompanionWorldBookSection({
  api,
  locale,
}: {
  api: ManagementPipelineApi;
  locale: Locale;
}): ReactElement | null {
  const labels = characterLabels(locale);
  const [view, setView] = useState<CompanionWorldBookView>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // The book belongs to the mounted companion, exactly as the persona,
        // scenario, opening and directive do: the surface reads the current
        // library entry's own book and no other companion's.
        const list = await api.listCompanions();
        const current = list.companions.find((entry) => entry.isCurrent);
        if (current === undefined) {
          if (active) setView({ kind: "absent" });
          return;
        }
        const worldBook = await api.readCompanionWorldBook(current.handle);
        if (!active) return;
        setView(worldBook.present ? { kind: "ready", worldBook } : { kind: "absent" });
      } catch {
        if (active) setView({ kind: "absent" });
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

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
    </section>
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
  scope: "companion" | "setting";
  publicTitle: string;
  summary: string;
  keys: string;
}>;

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
const EMPTY_WORLD_BOOK_ENTRY: WorldBookEntryDraft = Object.freeze({
  scope: "setting" as const,
  publicTitle: "",
  summary: "",
  keys: "",
});

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

  const readOnce = async (): Promise<WorldBookView> => {
    try {
      const source = await read();
      setGeneration(source.selectionGeneration);
      return source.worldInfo === null ? { kind: "unavailable" } : { kind: "ready", worldInfo: source.worldInfo };
    } catch {
      return { kind: "error" };
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
    // The reader is the mount's own authority for its World Info revision and is
    // stable for the life of the surface; a re-read is driven by the bind below.
  }, []);

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
        failure = problemTextWithCode(labels.worldBookFailed, error);
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
      setNotice({ kind: "failure", text: problemTextWithCode(labels.worldBookDetailFailed, error) });
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
        if (opened !== null && opened.handle === itemHandle) setOpened(null);
      } catch (error) {
        failure = problemTextWithCode(labels.worldBookDeleteFailed, error);
        setView(await readOnce());
      }
      setNotice(
        failure === null ? { kind: "success", text: labels.worldBookDeleted } : { kind: "failure", text: failure },
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
          {items.map((item) => {
            const isOpen = opened !== null && opened.handle === item.handle;
            const isArmed = armed === item.handle;
            return (
              <div key={item.handle} role="listitem" data-world-book-item={item.handle}>
                <strong>{item.title}</strong>
                {item.summary !== null && <p>{item.summary}</p>}
                <div className="composer-actions">
                  {item.selected || item.pending ? (
                    <button
                      type="button"
                      className="small-button"
                      aria-label={`${labels.worldBookDetach}: ${item.title}`}
                      onClick={() => bind(null)}
                    >
                      {labels.worldBookDetach}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="small-button"
                      aria-label={`${labels.worldBookAttach}: ${item.title}`}
                      onClick={() => bind(item.handle)}
                    >
                      {labels.worldBookAttach}
                    </button>
                  )}
                </div>
                {/* The row's own authoring strip, and while its delete is armed
                    the strip steps aside: the confirmation is the row's only
                    action until it is answered, and it never shares a line with
                    the controls it replaces. */}
                {isArmed ? (
                  <div data-world-book-confirm>
                    <p role="status" data-world-book-confirm-prompt>
                      {labels.worldBookDeleteConfirm.replace("{{title}}", item.title)}
                    </p>
                    <div className="composer-actions">
                      <button
                        type="button"
                        className="small-button danger"
                        data-world-book-confirm-yes
                        onClick={() => remove(item.handle)}
                      >
                        {labels.worldBookDelete}
                      </button>
                      <button
                        type="button"
                        className="small-button"
                        data-world-book-confirm-no
                        onClick={() => setArmed(null)}
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
                      onClick={() => toggleEntries(item.handle)}
                    >
                      {isOpen ? labels.worldBookHideEntries : labels.worldBookShowEntries}
                    </button>
                    <button
                      type="button"
                      className="small-button"
                      data-world-book-edit
                      aria-label={`${labels.worldBookEdit}: ${item.title}`}
                      onClick={() => beginEdit(item.handle)}
                    >
                      {labels.worldBookEdit}
                    </button>
                    <button
                      type="button"
                      className="small-button"
                      data-world-book-delete
                      aria-label={`${labels.worldBookDelete}: ${item.title}`}
                      onClick={() => {
                        setArmed(item.handle);
                        setDraft(null);
                      }}
                    >
                      {labels.worldBookDelete}
                    </button>
                  </div>
                )}
                {isOpen && (
                  <div data-world-book-content>
                    <p className="management-settings-hint">{labels.worldBookEntriesLabel}</p>
                    {opened.content.entries.length === 0 ? (
                      <p className="management-settings-hint" data-world-book-content-empty>
                        {labels.worldBookEntriesEmpty}
                      </p>
                    ) : (
                      <div role="list" data-world-book-entry-list>
                        {opened.content.entries.map((entry, index) => (
                          // An entry has no durable id here: its title and its
                          // index are what a list of entries keys by, and a
                          // title is not unique inside one item.
                          <div key={`${entry.publicTitle}\u0000${index}`} role="listitem" data-world-book-entry>
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
          })}
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
        <div key={index} data-world-book-entry-draft>
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
      <div className="composer-actions">
        <button
          type="button"
          className="small-button"
          data-world-book-submit
          disabled={saving || !worldBookDraftIsComplete(draft)}
          onClick={onSubmit}
        >
          {saving ? labels.saving : editing ? labels.worldBookSave : labels.worldBookCreateSubmit}
        </button>
        <button type="button" className="small-button" data-world-book-cancel disabled={saving} onClick={onCancel}>
          {labels.worldBookCancel}
        </button>
      </div>
    </section>
  );
}
