import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { problemTextWithCode } from "../composed-problem-view";
import { type Locale, messages } from "../i18n";
import {
  MAX_LOREBOOK_FILE_BYTES,
  type ManagementPipelineApi,
  type WorldInfoContentV1,
  type WorldInfoStateV1,
} from "../management-pipeline-api";
import type { WorldInfoBindingSource } from "../world-info-binding-source";
import { useArmedConfirmation } from "./armed-confirmation";
import { type CharacterLabels, characterLabels } from "./character-domain-labels";
import { downloadFile } from "./download-file";
import { useRecordDraft } from "./surface-drafts";
import { parseTriggerWords } from "./world-book-trigger-words";

type WorldBookView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error" }>
  | Readonly<{ kind: "unavailable" }>
  /**
   * The selection the shell shows and the selection the World Info read names are different, so there is no
   * pair this panel may act on. It is not `unavailable` (the mount does declare a `world-info.read`) and not
   * an error (nothing failed): it is `selection_generation_conflict`, and the panel sends nothing until the
   * shell has adopted the selection the read named.
   */
  | Readonly<{
      kind: "selection_generation_conflict";
      mountedSelectionGeneration: number;
      liveSelectionGeneration: number;
    }>
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
  /**
   * The entry's second trigger words, typed the same way as `keys`.
   *
   * They never bring the entry in on their own: the per-turn selection applies them
   * only after a trigger word matched, through `selectiveLogic`.
   */
  secondaryKeys: string;
  /**
   * SillyTavern's mode for the second words (0 AND ANY, 1 NOT ALL, 2 NOT ANY, 3 AND
   * ALL), or null when the entry states none.
   *
   * Null is a value of its own, not 0: the Host distinguishes an entry with no mode
   * from one that names AND ANY, so the form's "no choice" has to send neither.
   */
  selectiveLogic: 0 | 1 | 2 | 3 | null;
  /**
   * Whether the entry takes part at all. It is always sent (the switch is always drawn), so the
   * library never has to guess whether an absent field meant "on" or "not published here".
   */
  enabled: boolean;
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
    secondaryKeys: "",
    selectiveLogic: null,
    enabled: true,
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

/**
 * The entry's second-condition mode, from the selector's own value.
 *
 * The empty value is the "no choice" option and yields null, which the save sends as
 * nothing at all: the library tells an entry that states no mode from one that names
 * AND ANY, so the form can never turn "not stated" into `0`.
 */
function selectiveLogicOf(value: string): 0 | 1 | 2 | 3 | null {
  return value === "0" || value === "1" || value === "2" || value === "3" ? (Number(value) as 0 | 1 | 2 | 3) : null;
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

/**
 * The managed World Info library, whose items a conversation may ATTACH and whose entries the
 * player authors here.
 *
 * This is the library, not the companion's own book beside it: a different list, from a different
 * store, with a different verb. Every write goes through `world-info.*` against the selection
 * generation and library revision the mount's own read named, and a refusal re-reads the library
 * before it is reported, because the next command CASes on the revision that read-back carries.
 */
export function CharacterWorldBookPanel({
  api,
  csrfToken,
  locale,
  read,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  locale: Locale;
  read: () => Promise<WorldInfoBindingSource>;
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
  // The authored item is the shell's draft, like her own book's: leaving Characters unmounts this
  // panel, and an item whose title, summary and entries were being written is not the panel's to
  // throw away. Held whole, so its `handle` and `itemRevision` travel with the text they belong to.
  const itemDraft = useRecordDraft<WorldBookDraft>("characters.world-book-item", null);
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
  // The item whose export is in flight. One at a time, so the row that was pressed is the row that
  // reports, and a second press cannot download the same book twice.
  const [exporting, setExporting] = useState<string | null>(null);
  const lorebookInputRef = useRef<HTMLInputElement>(null);

  const readOnce = useCallback(async (): Promise<WorldBookView> => {
    try {
      const source = await read();
      if (source.kind === "selection_generation_conflict") {
        // The generation and the revision came from one read, and that read named a selection the shell is
        // not showing. Neither side is preferred: nothing is sent, and the panel says so.
        return {
          kind: "selection_generation_conflict",
          mountedSelectionGeneration: source.mountedSelectionGeneration,
          liveSelectionGeneration: source.liveSelectionGeneration,
        };
      }
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
    itemDraft.type({
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
      itemDraft.type({
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
          secondaryKeys: (entry.secondaryKeys ?? []).join(labels.companionWorldBookKeySeparator),
          selectiveLogic: entry.selectiveLogic ?? null,
          enabled: entry.enabled !== false,
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
    const draft = itemDraft.value;
    if (view.kind !== "ready" || draft === null || !worldBookDraftIsComplete(draft)) return;
    const expectedRevision = view.worldInfo.revision;
    const target = draft.handle;
    const authored = {
      publicTitle: draft.publicTitle.trim(),
      summary: draft.summary.trim(),
      entries: draft.entries.map((entry) => {
        const keys = parseTriggerWords(entry.keys);
        const secondaryKeys = parseTriggerWords(entry.secondaryKeys);
        return {
          scope: entry.scope,
          publicTitle: entry.publicTitle.trim(),
          summary: entry.summary.trim(),
          ...(keys.length === 0 ? {} : { keys }),
          // Absent stays absent: an entry with no second words gains no empty list,
          // and an entry with no chosen mode gains no mode at all - the library
          // tells "no gate" from "AND ANY", which are 0 and nothing.
          ...(secondaryKeys.length === 0 ? {} : { secondaryKeys }),
          ...(entry.selectiveLogic === null ? {} : { selectiveLogic: entry.selectiveLogic }),
          enabled: entry.enabled,
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
        itemDraft.clear();
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
        if (itemDraft.value !== null && itemDraft.value.handle === itemHandle) itemDraft.clear();
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

  /**
   * Saves one item as the lorebook file the import reads back.
   *
   * The file is the Host's own bytes under the Host's own name, so the round trip is the Host's
   * round trip: what the player keeps is exactly what this product would import, and this side
   * never re-serializes a book it did not author.
   */
  const exportItem = (itemHandle: string): void => {
    if (view.kind !== "ready" || exporting !== null) return;
    const expectedRevision = view.worldInfo.revision;
    setExporting(itemHandle);
    void (async () => {
      let failure: string | null = null;
      let saved: string | null = null;
      try {
        const exported = await api.exportWorldInfo({
          apiVersion: 1,
          selectionGeneration: generation,
          expectedRevision,
          itemHandle,
        });
        downloadFile(exported.fileName, new Blob([exported.document], { type: "application/json" }));
        saved = exported.fileName;
      } catch (error) {
        failure = problemTextWithCode(labels.worldBookExportFailed, error, problemLabels);
      } finally {
        setExporting(null);
      }
      setNotice(
        failure === null
          ? { kind: "success", text: labels.worldBookExportSaved.replace("{{file}}", saved ?? "") }
          : { kind: "failure", text: failure },
      );
    })();
  };

  if (view.kind === "loading") return null;
  if (view.kind === "error") {
    return (
      <section aria-label={labels.worldBookTitle} data-world-book data-world-book-read-failed>
        <h3>{labels.worldBookTitle}</h3>
        <p className="management-settings-hint">{labels.worldBookHint}</p>
        <p>{labels.worldBookReadFailed}</p>
        <button
          type="button"
          className="small-button"
          data-world-book-retry
          onClick={() => {
            setView({ kind: "loading" });
            void (async () => setView(await readOnce()))();
          }}
        >
          {problemLabels.problemRetryRead}
        </button>
      </section>
    );
  }
  if (view.kind === "selection_generation_conflict") {
    return (
      <section aria-label={labels.worldBookTitle} data-world-book>
        <h3>{labels.worldBookTitle}</h3>
        <p className="management-settings-hint">{labels.worldBookHint}</p>
        <p data-world-book-selection-conflict={`${view.mountedSelectionGeneration}->${view.liveSelectionGeneration}`}>
          {labels.worldBookSelectionConflict}
        </p>
        <button
          type="button"
          className="small-button"
          data-world-book-selection-conflict-read
          onClick={() => {
            setView({ kind: "loading" });
            void (async () => setView(await readOnce()))();
          }}
        >
          {problemLabels.problemRetryRead}
        </button>
      </section>
    );
  }
  if (view.kind === "unavailable") {
    return (
      <section aria-label={labels.worldBookTitle} data-world-book>
        <h3>{labels.worldBookTitle}</h3>
        <p className="management-settings-hint">{labels.worldBookHint}</p>
        <p>{labels.worldBookUnavailable}</p>
      </section>
    );
  }

  const items = view.worldInfo.items;
  const draft = itemDraft.value;
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
              exporting={exporting}
              labels={labels}
              onBind={bind}
              onToggleEntries={toggleEntries}
              onBeginEdit={beginEdit}
              onExport={exportItem}
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
          <button
            type="button"
            className="small-button"
            data-world-book-create
            data-draft-revealer
            onClick={beginCreate}
          >
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
          onChange={itemDraft.type}
          onSubmit={submitDraft}
          onCancel={() => itemDraft.clear()}
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
  exporting,
  labels,
  onBind,
  onToggleEntries,
  onBeginEdit,
  onExport,
  onArm,
  onDisarm,
  onRemove,
}: {
  item: WorldInfoStateV1["items"][number];
  opened: WorldInfoContentV1 | null;
  isArmed: boolean;
  /** The item whose export is in flight, or null. */
  exporting: string | null;
  labels: ReturnType<typeof characterLabels>;
  onBind: (sourceHandle: string | null) => void;
  onToggleEntries: (itemHandle: string) => void;
  onBeginEdit: (itemHandle: string) => void;
  onExport: (itemHandle: string) => void;
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
            data-draft-revealer
            aria-label={`${labels.worldBookEdit}: ${item.title}`}
            onClick={() => onBeginEdit(item.handle)}
          >
            {labels.worldBookEdit}
          </button>
          <button
            type="button"
            className="small-button"
            data-world-book-export
            aria-label={`${labels.worldBookExport}: ${item.title}`}
            disabled={exporting !== null}
            onClick={() => onExport(item.handle)}
          >
            {exporting === item.handle ? labels.worldBookExportBusy : labels.worldBookExport}
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
                  {entry.enabled === false && (
                    <p className="management-settings-hint" data-world-book-entry-disabled>
                      {labels.companionWorldBookDisabled}
                    </p>
                  )}
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
 * scope, a title, a summary, optional trigger words, optional second-condition words
 * and the mode that applies them on each entry - because what the wire validates is
 * what the player is offered.
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
          <label className="management-settings-label" htmlFor={`world-book-entry-${index}-secondary-keys`}>
            {labels.worldBookEntrySecondaryKeys}
          </label>
          <input
            id={`world-book-entry-${index}-secondary-keys`}
            className="form-input"
            type="text"
            data-world-book-entry-secondary-keys
            value={entry.secondaryKeys}
            onChange={(event) => updateEntry(index, { ...entry, secondaryKeys: event.target.value })}
          />
          <p className="management-settings-hint">{labels.worldBookEntrySecondaryKeysHint}</p>
          <label className="management-settings-label" htmlFor={`world-book-entry-${index}-selective-logic`}>
            {labels.worldBookEntrySelectiveLogic}
          </label>
          <select
            id={`world-book-entry-${index}-selective-logic`}
            className="form-select"
            data-world-book-entry-selective-logic
            value={entry.selectiveLogic === null ? "" : String(entry.selectiveLogic)}
            onChange={(event) => updateEntry(index, { ...entry, selectiveLogic: selectiveLogicOf(event.target.value) })}
          >
            <option value="">{labels.worldBookEntrySelectiveLogicNone}</option>
            <option value="0">{labels.worldBookEntrySelectiveLogicAndAny}</option>
            <option value="1">{labels.worldBookEntrySelectiveLogicNotAll}</option>
            <option value="2">{labels.worldBookEntrySelectiveLogicNotAny}</option>
            <option value="3">{labels.worldBookEntrySelectiveLogicAndAll}</option>
          </select>
          <p className="management-settings-hint">{labels.worldBookEntrySelectiveLogicHint}</p>
          {/* The switch that decides whether the entry takes part at all. A switched-off entry
              stays in the item and in this list, and reaches neither the always-on block nor a
              per-turn candidate, which is how a player parks it without losing it. */}
          <label className="companion-world-book-constant">
            <input
              id={`world-book-entry-${index}-enabled`}
              className="companion-world-book-constant-box"
              type="checkbox"
              data-world-book-entry-enabled
              checked={entry.enabled}
              onChange={(event) => updateEntry(index, { ...entry, enabled: event.target.checked })}
            />
            <span>{labels.worldBookEntryEnabled}</span>
          </label>
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
