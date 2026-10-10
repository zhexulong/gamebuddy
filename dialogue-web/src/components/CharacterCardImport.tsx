import { type ReactElement, useEffect, useRef, useState } from "react";
import type { Messages } from "../i18n";
import type {
  ManagementPipelineApi,
  StCardImportHistoryV1,
  StCardImportStageResultV1,
} from "../management-pipeline-api";

/** The decoder's closed disposition classes, in the order the loss report reads. */
const DISPOSITION_CLASSES = [
  "accepted_typed",
  "preserved_opaque",
  "dropped_unsupported",
  "rejected_invalid",
] as const;

/**
 * Import Character Card (design/26 §4.6, design/28 §2 Import/export row).
 *
 * The staged flow is exactly the documented one: paste a supported card, review
 * every returned field classification in player language, sign the reviewable
 * set, then confirm. Confirm is only legal on a signed review credential, so the
 * product never provisions a card nobody approved, and the panel describes the
 * result as created - never as active.
 *
 * The loss report is the Host's durable read-back; the panel never re-derives a
 * disposition and renders no card body text. Both the Characters panel and the
 * Import/Export drawer mount this one component, so the flow exists once.
 */
export function CharacterCardImport({
  api,
  csrfToken,
  labels,
  onCreated,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  /** Lets a parent surface refresh what a confirmed import changed. */
  onCreated?: () => void;
}): ReactElement {
  const [importCardText, setImportCardText] = useState("");
  const [importStaged, setImportStaged] = useState<StCardImportStageResultV1 | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState<"created" | "error" | null>(null);
  // The durable loss report of every confirmed import. It is read back from the
  // Host verbatim, and an absent route leaves the section out entirely.
  const [importHistory, setImportHistory] = useState<StCardImportHistoryV1 | "failed" | "unavailable">(
    "unavailable",
  );

  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    void (async () => {
      try {
        const value = await api.readStCardImportHistory();
        if (!activeRef.current) return;
        setImportHistory(value);
      } catch {
        if (!activeRef.current) return;
        setImportHistory("unavailable");
      }
    })();
    return () => {
      activeRef.current = false;
    };
  }, [api]);

  const handleStageImport = async (): Promise<void> => {
    const card = importCardText.trim();
    if (card.length === 0 || importBusy) return;
    setImportBusy(true);
    setImportNotice(null);
    try {
      const staged = await api.stageStCardImport(card, csrfToken);
      if (activeRef.current) {
        setImportStaged(staged);
        setImportNotice(null);
      }
    } catch {
      if (activeRef.current) setImportNotice("error");
    } finally {
      if (activeRef.current) setImportBusy(false);
    }
  };

  const handleConfirmImport = async (): Promise<void> => {
    if (importStaged === null || importBusy) return;
    setImportBusy(true);
    setImportNotice(null);
    try {
      const reviewable = importStaged.fields
        .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
        .map((field) => field.field);
      if (reviewable.length > 0)
        await api.reviewStCardImport(importStaged.importId, reviewable, Date.now(), csrfToken);
      await api.confirmStCardImport(importStaged.importId, csrfToken);
      if (activeRef.current) {
        setImportStaged(null);
        setImportCardText("");
        setImportNotice("created");
      }
      onCreated?.();
      // The confirmed import is durable evidence by the time confirm returns, so
      // the loss report shows it without waiting for a reload. A failed history
      // read is reported as exactly that; it never turns a created companion
      // into a failed import.
      try {
        const history = await api.readStCardImportHistory();
        if (activeRef.current) setImportHistory(history);
      } catch {
        if (activeRef.current) setImportHistory("failed");
      }
    } catch {
      if (activeRef.current) setImportNotice("error");
    } finally {
      if (activeRef.current) setImportBusy(false);
    }
  };

  return (
    <>
      <section aria-label={labels.cardImportTitle} data-card-import>
        <h3>{labels.cardImportTitle}</h3>
        <p className="management-settings-hint">{labels.cardImportHint}</p>
        {importStaged === null ? (
          <>
            <textarea
              className="form-textarea"
              aria-label={labels.cardImportTitle}
              rows={5}
              placeholder='{"spec":"chara_card_v3","data":{"name":"…"}}'
              value={importCardText}
              onChange={(event) => setImportCardText(event.target.value)}
            />
            <div className="composer-actions">
              <button
                type="button"
                className="small-button"
                disabled={importBusy || importCardText.trim().length === 0}
                onClick={() => void handleStageImport()}
              >
                {importBusy ? labels.cardImportStaging : labels.cardImportStage}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              <strong>{importStaged.name}</strong>
            </p>
            <details>
              <summary>{labels.cardImportFieldsTitle}</summary>
              <ul data-import-fields>
                {importStaged.fields.map((field) => (
                  <li key={field.field}>
                    {field.field} · {field.eligibility} · {field.chars} chars
                    {field.field === "persona_core" && field.chars > 4000 && (
                      <em className="management-settings-hint">
                        {labels.cardImportLongHint.replace("{{chars}}", String(field.chars))}
                      </em>
                    )}
                  </li>
                ))}
              </ul>
            </details>
            {importStaged.dispositions.length > 0 && (
              <details>
                <summary>{labels.cardImportDispositionsTitle}</summary>
                <ul data-import-dispositions>
                  {importStaged.dispositions.map((disposition) => (
                    <li key={`${disposition.field}-${disposition.reason}`}>
                      {disposition.field} · {disposition.classification} · {disposition.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="composer-actions">
              <button
                type="button"
                className="small-button"
                disabled={importBusy}
                onClick={() => void handleConfirmImport()}
              >
                {importBusy ? labels.cardImportConfirming : labels.cardImportReviewSelected}
              </button>
            </div>
          </>
        )}
        {importNotice !== null && (
          <p role="status" className={importNotice === "created" ? "success-banner" : "error-banner"}>
            {importNotice === "created" ? labels.cardImportCreated : labels.cardImportError}
          </p>
        )}
      </section>

      {importHistory !== "unavailable" && (
        <section aria-label={labels.cardImportHistoryTitle} data-card-import-history>
          <h3>{labels.cardImportHistoryTitle}</h3>
          <p className="management-settings-hint">{labels.cardImportHistoryHint}</p>
          {importHistory === "failed" ? (
            <p className="error-banner" role="status">
              {labels.cardImportHistoryFailed}
            </p>
          ) : importHistory.entries.length === 0 ? (
            <p>{labels.cardImportHistoryEmpty}</p>
          ) : (
            <ul data-import-history-entries>
              {importHistory.entries.map((entry) => (
                <li key={entry.importId} data-import-history-entry>
                  <span>{entry.cardName}</span>
                  <span className="management-settings-hint">
                    {new Date(entry.occurredAtMs).toLocaleString()}
                  </span>
                  <ul data-import-history-counts>
                    {DISPOSITION_CLASSES.map((classification) => (
                      <li key={classification}>
                        {classification} · {entry.counts[classification]}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
