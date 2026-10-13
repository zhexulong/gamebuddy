import { ChevronDown } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import type { Locale } from "../i18n";
import type {
  ManagementPipelineApi,
  StCardImportHistoryV1,
} from "../management-pipeline-api";
import { characterLabels } from "./character-domain-labels";
import { extractCharacterCardJsonFromPng, isPngBytes } from "./png-character-card";

/** The stage route accepts card JSON text up to 2 MiB (StageStCardImportCommandV1). */
const MAX_CARD_TEXT_LENGTH = 2_097_152;
/** Do not pull an unbounded file into memory just to look for a card chunk. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

type ImportOutcome =
  | Readonly<{
      kind: "created";
      name: string;
      kept: number;
      lorebookCount: number;
      preserved: number;
      notUsed: readonly string[];
      longFieldChars: number | null;
      /** The card carried its own performance directive and it was kept. */
      voiceCarried: boolean;
      /** The card's directive was dropped by the decoder's own loss ledger. */
      voiceDropped: boolean;
    }>
  | Readonly<{ kind: "error"; message: string }>;

/**
 * Import a character card (design/28 §2).
 *
 * The primary path is the player choosing a `.json` / `.png` file from disk:
 * the browser reads that file locally and posts the card text. Pasting card
 * text stays available as a secondary path. There is no multi-step
 * classification review: the player choosing a card is the approval, so the
 * component stages, records the eligible fields the Host itself marked, and
 * confirms in one action.
 *
 * Nothing is claimed as created until `confirm` returns the Host's own name for
 * the provisioned companion, and the summary of what was kept or could not be
 * used is read from the Host's staged field/disposition report - never derived
 * locally.
 */
export function CharacterCardImport({
  api,
  csrfToken,
  locale,
  onCreated,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  locale: Locale;
  /** Lets a parent surface refresh what a confirmed import changed. */
  onCreated?: () => void;
}): ReactElement {
  const labels = characterLabels(locale);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [pasted, setPasted] = useState("");
  const [history, setHistory] = useState<StCardImportHistoryV1 | "failed" | "unavailable">("unavailable");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const value = await api.readStCardImportHistory();
        if (active) setHistory(value);
      } catch {
        if (active) setHistory("unavailable");
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);

  const refreshHistory = async (): Promise<void> => {
    try {
      setHistory(await api.readStCardImportHistory());
    } catch {
      setHistory("failed");
    }
  };

  const runImport = async (cardText: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const staged = await api.stageStCardImport(cardText, csrfToken);
      const eligible = staged.fields
        .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
        .map((field) => field.field);
      if (eligible.length > 0)
        await api.reviewStCardImport(staged.importId, eligible, Date.now(), csrfToken);
      const confirmed = await api.confirmStCardImport(staged.importId, csrfToken);
      if (confirmed.name.trim().length === 0) throw new Error("import_not_confirmed");
      const notUsed = staged.dispositions
        .filter(
          (disposition) =>
            disposition.classification === "dropped_unsupported" ||
            disposition.classification === "rejected_invalid",
        )
        .map((disposition) => disposition.field)
        .filter((field, index, all) => all.indexOf(field) === index);
      const preserved = staged.dispositions.filter(
        (disposition) => disposition.classification === "preserved_opaque",
      ).length;
      const longField = staged.fields.find((field) => field.field === "persona_core" && field.chars > 4_000);
      const lorebookCount = staged.fields.filter((field) => field.field.startsWith("worldbook_")).length;
      // The card's own performance directive is a profile-eligible field like the
      // persona: carrying it is reported from the field list, and the decoder's
      // own loss ledger is what reports a directive it had to refuse.
      const voiceCarried = staged.fields.some((field) => field.field === "system_prompt");
      const voiceDropped = (staged.losses ?? []).some(
        (loss) => loss.field === "system_prompt" && loss.reason === "character_voice_too_long",
      );
      setOutcome({
        kind: "created",
        name: confirmed.name,
        kept: eligible.length,
        lorebookCount,
        preserved,
        notUsed,
        longFieldChars: longField?.chars ?? null,
        voiceCarried,
        voiceDropped,
      });
      onCreated?.();
      await refreshHistory();
    } catch {
      setOutcome({ kind: "error", message: labels.importFailed });
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (
    file: File,
  ): Promise<{ ok: true; text: string } | { ok: false; message: string }> => {
    if (file.size > MAX_FILE_BYTES) return { ok: false, message: labels.importFailedTooLarge };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = isPngBytes(bytes)
      ? await extractCharacterCardJsonFromPng(bytes)
      : new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/u, "");
    if (text === undefined || text.trim().length === 0)
      return { ok: false, message: isPngBytes(bytes) ? labels.importFailedPng : labels.importFailedText };
    if (text.length > MAX_CARD_TEXT_LENGTH) return { ok: false, message: labels.importFailedTooLarge };
    return { ok: true, text };
  };

  const handleFile = async (file: File): Promise<void> => {
    setOutcome(null);
    const read = await readFile(file);
    if (!read.ok) {
      setOutcome({ kind: "error", message: read.message });
      return;
    }
    await runImport(read.text);
  };

  return (
    <section aria-label={labels.importTitle} data-card-import>
      <h3>{labels.importTitle}</h3>
      <p className="management-settings-hint">{labels.importHint}</p>

      <button
        type="button"
        className="small-button"
        data-card-import-trigger
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
      >
        {labels.importChooseFile}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.png,application/json,image/png"
        aria-label={labels.importFileLabel}
        className="card-import-file-input"
        disabled={busy}
        // The trigger above is the surface's visible control and its tab stop;
        // this input is the browser's real picker behind it, taken out of the
        // visual flow (`.card-import-file-input`) but never out of the form.
        tabIndex={-1}
        data-card-import-file
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so choosing the same file again still fires `change`.
          event.target.value = "";
          if (file !== undefined) void handleFile(file);
        }}
      />
      {busy && <p className="loading-text">{labels.importBusy}</p>}

      <details className="custom-disclosure">
        <summary>
          <ChevronDown size={16} aria-hidden="true" />
          {labels.importPasteLabel}
        </summary>
        <p className="management-settings-hint">{labels.importPasteHint}</p>
        <textarea
          className="form-textarea"
          aria-label={labels.importPasteLabel}
          rows={4}
          placeholder='{"spec":"chara_card_v3","data":{"name":"…"}}'
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="small-button"
            disabled={busy || pasted.trim().length === 0}
            onClick={() => void runImport(pasted.trim())}
          >
            {busy ? labels.importBusy : labels.importSubmit}
          </button>
        </div>
      </details>

      {outcome !== null && (
        <div role="status" className={outcome.kind === "created" ? "success-banner" : "error-banner"} data-card-import-result={outcome.kind}>
          {outcome.kind === "created" ? (
            <dl className="management-settings-details" data-card-import-details>
              <div><dd>{labels.importCreated.replace("{{name}}", outcome.name)}</dd></div>
              <div><dd>{labels.importCreatedDetail}</dd></div>
              <div><dd>{labels.importKept.replace("{{count}}", String(outcome.kept))}</dd></div>
              {outcome.lorebookCount > 0 && (
                <div><dd>{labels.importLorebookCount.replace("{{count}}", String(outcome.lorebookCount))}</dd></div>
              )}
              {outcome.preserved > 0 && (
                <div><dd>{labels.importPreserved.replace("{{count}}", String(outcome.preserved))}</dd></div>
              )}
              <div>
                <dd>
                  {outcome.notUsed.length === 0
                    ? labels.importAllUsed
                    : labels.importNotUsed.replace("{{fields}}", outcome.notUsed.join(", "))}
                </dd>
              </div>
              {outcome.longFieldChars !== null && (
                <div><dd>{labels.importLongField.replace("{{chars}}", String(outcome.longFieldChars))}</dd></div>
              )}
              {outcome.voiceCarried && (
                <div data-card-import-voice="carried"><dd>{labels.importVoiceCarried}</dd></div>
              )}
              {outcome.voiceDropped && (
                <div data-card-import-voice="dropped"><dd>{labels.importVoiceDropped}</dd></div>
              )}
            </dl>
          ) : (
            <p>{outcome.message}</p>
          )}
        </div>
      )}

      {history !== "unavailable" && (
        <section aria-label={labels.historyTitle} data-card-import-history>
          <h4>{labels.historyTitle}</h4>
          <p className="management-settings-hint">{labels.historyHint}</p>
          {history === "failed" ? (
            <p className="error-banner" role="status">
              {labels.historyFailed}
            </p>
          ) : history.entries.length === 0 ? (
            <p>{labels.historyEmpty}</p>
          ) : (
            <ul data-import-history-entries>
              {history.entries.map((entry) => (
                <li key={entry.importId} data-import-history-entry>
                  <span>{entry.cardName}</span>
                  <span className="management-settings-hint">
                    {new Date(entry.occurredAtMs).toLocaleString()}
                  </span>
                  <ul data-import-history-counts>
                    <li>
                      {labels.dispositionAccepted} · {entry.counts.accepted_typed}
                    </li>
                    <li>
                      {labels.dispositionPreserved} · {entry.counts.preserved_opaque}
                    </li>
                    <li>
                      {labels.dispositionDropped} · {entry.counts.dropped_unsupported}
                    </li>
                    <li>
                      {labels.dispositionRejected} · {entry.counts.rejected_invalid}
                    </li>
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
