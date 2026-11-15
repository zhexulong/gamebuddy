import { type ReactElement, useEffect, useState } from "react";
import { type Locale, messages } from "../i18n";
import { problemTextWithCode } from "../composed-problem-view";
import {
  type CompanionExamplePairV1,
  type ManagementPipelineApi,
  TavernProblemError,
} from "../management-pipeline-api";
import { characterLabels } from "./character-domain-labels";
import { useRowsDraft } from "./surface-drafts";

/** One row as the editor holds it: the two halves the prompt prints, plus its own identity. */
type ExampleRowDraft = CompanionExamplePairV1 & Readonly<{ rowId: string }>;

/** What this section knows about the read: a failed read, or the record. */
type ExamplesView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; profileRevision: number; examples: readonly CompanionExamplePairV1[] }>;

/**
 * One row's own identity while it is being edited.
 *
 * Keying editable rows by position is what makes React reconcile a keystroke into the wrong row
 * the moment one above it is removed, so every row carries a client-only id, minted once - never
 * by position, never sent (the contract's pair is two fields).
 */
let rowSequence = 0;
function mintRow(row: CompanionExamplePairV1): ExampleRowDraft {
  rowSequence += 1;
  return Object.freeze({ rowId: `example-row-${rowSequence}`, user: row.user, companion: row.companion });
}

/** The editor's rows for one record: one blank row is how a companion with no examples starts one. */
function rowsFor(examples: readonly CompanionExamplePairV1[]): readonly ExampleRowDraft[] {
  return examples.length === 0 ? [mintRow({ user: "", companion: "" })] : examples.map(mintRow);
}

/**
 * The example dialogues editor: the few-shot rows that decide how she talks.
 *
 * These are the card's `mes_example` rows, and the prompt renders them under `[Dialogue
 * Examples]` right after her persona (`renderIdentityProfile`, reached from
 * `buildChatCompanionSystemPrompt`). They are also the only place the SHAPE of a turn is
 * taught - the system prompt owns the floor and deliberately says nothing about form, because a
 * written shape rule beats a card that teaches the opposite shape - so a companion the player
 * made directly, who inherited the shipped default's rows, had no way to be taught her own
 * register at all until this control existed.
 *
 * It is the directive editor's sibling, one durable member over: the same mounted companion's
 * identity profile, the same compare-and-set on its revision, and the same rule that an
 * untouched row keeps the AUTHOR's text - the save sends what this editor painted, and the Host
 * turns a value that still renders to the authored one back into the author's own macros.
 *
 * Absence is stated rather than implied: a companion with no rows says so, and the blank row is
 * the way to write the first one. Saving with every row blank clears the set, which is a real
 * thing to want (she then has no examples, the state the card export writes no `mes_example`
 * for) and is said in the hint rather than left to be discovered.
 */
export function CompanionExamplesSection({
  api,
  csrfToken,
  handle,
  locale,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  /** The companion in play: her identity profile is the record these rows live in. */
  handle: string | null;
  locale: Locale;
}): ReactElement {
  const labels = characterLabels(locale);
  const [view, setView] = useState<ExamplesView>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Readonly<{ ok: boolean; text: string }> | null>(null);

  useEffect(() => {
    if (handle === null) {
      setView({ kind: "unavailable" });
      return;
    }
    let active = true;
    setView({ kind: "loading" });
    void (async () => {
      try {
        const read = await api.readCompanionExamples(handle);
        if (active) setView({ kind: "ready", profileRevision: read.profileRevision, examples: read.examples });
      } catch {
        if (active) setView({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
  }, [api, handle]);

  const stored = view.kind === "ready" ? view.examples : [];
  const rows = useRowsDraft<ExampleRowDraft>("characters.example-rows", rowsFor(stored));

  if (handle === null || view.kind === "unavailable") {
    return (
      <section aria-label={labels.examplesTitle} data-character-examples>
        <h3>{labels.examplesTitle}</h3>
        <p data-character-examples-unavailable>{labels.examplesUnavailable}</p>
      </section>
    );
  }

  const save = (): void => {
    if (view.kind !== "ready" || saving) return;
    const kept = rows.value
      // A row with one half written is not an example: the prompt prints both halves, so a
      // half-row would reach the model as a turn with a missing side. Neither is sent.
      .map((row) => ({ user: row.user.trim(), companion: row.companion.trim() }))
      .filter((row) => row.user.length > 0 && row.companion.length > 0);
    setSaving(true);
    setNotice(null);
    void (async () => {
      try {
        const saved = await api.updateCompanionExamples(
          handle,
          { apiVersion: 1, expectedProfileRevision: view.profileRevision, examples: kept },
          csrfToken,
        );
        setView({ kind: "ready", profileRevision: saved.profileRevision, examples: saved.examples });
        rows.release(rowsFor(saved.examples));
        setNotice({ ok: true, text: labels.saved });
      } catch (error) {
        // A stale save is the ordinary one: the words stay exactly where the player wrote them,
        // and the revision the next save CASes on becomes the one the Host holds. Adopting the
        // record's text as well would republish someone else's words as the player's.
        if (error instanceof TavernProblemError && error.code === "character_examples_conflict") {
          try {
            const fresh = await api.readCompanionExamples(handle);
            setView({ kind: "ready", profileRevision: fresh.profileRevision, examples: fresh.examples });
          } catch {
            // The refusal stands on its own; the next save is CASed on the revision shown.
          }
        }
        setNotice({ ok: false, text: problemTextWithCode(labels.examplesSaveFailed, error, messages(locale)) });
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <section aria-label={labels.examplesTitle} data-character-examples>
      <h3>{labels.examplesTitle}</h3>
      <p className="management-settings-hint">{labels.examplesHint}</p>
      {view.kind === "loading" ? (
        <p className="loading-text">{labels.loading}</p>
      ) : (
        <>
          {stored.length === 0 && <p data-character-examples-absent>{labels.examplesAbsent}</p>}
          <div data-character-example-rows>
            {rows.value.map((row) => (
              <div key={row.rowId} data-character-example-row>
                <label className="management-settings-label" htmlFor={`${row.rowId}-user`}>
                  {labels.examplesUserTurn}
                </label>
                <textarea
                  id={`${row.rowId}-user`}
                  className="form-textarea"
                  rows={2}
                  value={row.user}
                  onChange={(event) =>
                    rows.type(
                      rows.value.map((item) =>
                        item.rowId === row.rowId ? { ...item, user: event.target.value } : item,
                      ),
                    )
                  }
                />
                <label className="management-settings-label" htmlFor={`${row.rowId}-companion`}>
                  {labels.examplesCompanionTurn}
                </label>
                <textarea
                  id={`${row.rowId}-companion`}
                  className="form-textarea"
                  rows={2}
                  value={row.companion}
                  onChange={(event) =>
                    rows.type(
                      rows.value.map((item) =>
                        item.rowId === row.rowId ? { ...item, companion: event.target.value } : item,
                      ),
                    )
                  }
                />
                <div className="composer-actions">
                  <button
                    type="button"
                    className="small-button"
                    data-character-example-remove
                    disabled={rows.value.length <= 1}
                    onClick={() => rows.type(rows.value.filter((item) => item.rowId !== row.rowId))}
                  >
                    {labels.discard}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="composer-actions">
            <button
              type="button"
              className="small-button"
              data-character-example-add
              onClick={() => rows.type([...rows.value, mintRow({ user: "", companion: "" })])}
            >
              {labels.examplesAdd}
            </button>
            <button
              type="button"
              className="small-button"
              data-character-examples-save
              disabled={saving}
              onClick={save}
            >
              {saving ? labels.saving : labels.examplesSave}
            </button>
          </div>
        </>
      )}
      {notice !== null && (
        <p role="status" data-character-examples-notice className={notice.ok ? "success-banner" : "error-banner"}>
          {notice.text}
        </p>
      )}
    </section>
  );
}
