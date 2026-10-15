import { ChevronDown } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import type { Locale } from "../i18n";
import type { CompanionWorldBookV1, ManagementPipelineApi, WorldInfoStateV1 } from "../management-pipeline-api";
import type { WorldInfoSurfaceSource } from "./management-surface-panels";
import { CharactersPanel } from "./CharactersPanel";
import { characterLabels } from "./character-domain-labels";

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
 *    conversation may ATTACH (`world-info.read` / `world-info.bind`). A different
 *    list, from a different store, with a different verb.
 *
 * Empty is honest on both: a companion with no book renders no block, an empty
 * library renders no block, and a book that is present but carries no entries
 * says exactly that rather than showing a zero that reads as "nothing here".
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
  const [notice, setNotice] = useState<"saved" | "failed" | null>(null);

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
      let failed = false;
      try {
        await api.setWorldInfoBinding(
          { apiVersion: 1, selectionGeneration: generation, expectedRevision, sourceHandle },
          csrfToken,
        );
      } catch {
        failed = true;
      }
      const next = await readOnce();
      setView(next);
      setNotice(failed ? "failed" : "saved");
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
  // Nothing to attach: there is no control, no list and no fact here, so there is
  // no block. An empty box would only read as the companion having no book at all.
  if (view.worldInfo.items.length === 0) return null;

  return (
    <section aria-label={labels.worldBookTitle} data-world-book>
      <h3>{labels.worldBookTitle}</h3>
      <p className="management-settings-hint">{labels.worldBookHint}</p>
      <div role="list" data-world-book-list>
        {view.worldInfo.items.map((item) => (
          <div key={item.handle} role="listitem">
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
          </div>
        ))}
      </div>
      {view.worldInfo.state === "pending" && <p>{labels.worldBookPending}</p>}
      {notice !== null && (
        <p role="status" className={notice === "saved" ? "success-banner" : "error-banner"}>
          {notice === "saved" ? labels.saved : labels.worldBookFailed}
        </p>
      )}
    </section>
  );
}
