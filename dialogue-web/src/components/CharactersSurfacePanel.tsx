import { type ReactElement, useEffect, useState } from "react";
import type { Locale } from "../i18n";
import type { ManagementPipelineApi, WorldInfoStateV1 } from "../management-pipeline-api";
import type { WorldInfoSurfaceSource } from "./management-surface-panels";
import { CharactersPanel } from "./CharactersPanel";
import { characterLabels } from "./character-domain-labels";

/**
 * The product's Characters surface: the character domain and its world book in
 * one place.
 *
 * "Cards and world books live where the character is managed": the companion's
 * lorebook is read from the same surface that manages the companion, so World
 * Info is no longer a peer surface of the shell. The world-book state machine
 * below is the same frozen one the standalone World Info surface used -
 * `read` -> bind with the exact opaque revision -> both outcomes re-read the
 * authoritative revision before anything is reported - rendered in the
 * character domain's vocabulary ("World book").
 *
 * The read is the mount's own: the composed Chat projection carries no World
 * Info, so the composed shell passes its dedicated `GET /world-info` reader.
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
      <CharacterWorldBookPanel api={api} csrfToken={csrfToken} locale={locale} read={read} />
    </>
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
}): ReactElement {
  const labels = characterLabels(locale);
  const [view, setView] = useState<WorldBookView>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState<"saved" | "failed" | null>(null);

  const readOnce = async (): Promise<WorldBookView> => {
    try {
      const source = await read();
      setGeneration(source.selectionGeneration);
      return source.worldInfo === null
        ? { kind: "unavailable" }
        : { kind: "ready", worldInfo: source.worldInfo };
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

  return (
    <section aria-label={labels.worldBookTitle} data-world-book>
      <h3>{labels.worldBookTitle}</h3>
      <p className="management-settings-hint">{labels.worldBookHint}</p>
      {view.kind === "loading" ? (
        <p className="loading-text">{labels.loading}</p>
      ) : view.kind !== "ready" ? (
        <p>{labels.worldBookUnavailable}</p>
      ) : view.worldInfo.items.length === 0 ? (
        <p>{labels.worldBookEmpty}</p>
      ) : (
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
      )}
      {view.kind === "ready" && view.worldInfo.state === "pending" && <p>{labels.worldBookPending}</p>}
      {notice !== null && (
        <p role="status" className={notice === "saved" ? "success-banner" : "error-banner"}>
          {notice === "saved" ? labels.saved : labels.worldBookFailed}
        </p>
      )}
    </section>
  );
}
