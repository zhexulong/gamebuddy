import { ChevronDown } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import type { Locale } from "../i18n";
import {
  MAX_CARD_FILE_BYTES,
  type ManagementPipelineApi,
  type StCardImportHistoryV1,
  type StCardImportOmittedEntryV1,
  type StCardImportOmittedMacroV1,
  type StCardImportStageResultV1,
  type StageStCardImportCommandV1,
} from "../management-pipeline-api";
import { characterFieldLabel, characterLabels, type CharacterLabels } from "./character-domain-labels";
import { canonicalBase64Of, isPngCardFile } from "./png-character-card";
import { useDraft, useRecordDraft } from "./surface-drafts";

/** The JSON arm's own ceiling: the decoder's text input bound (StageStCardImportCommandV1). */
const MAX_CARD_TEXT_LENGTH = 2_097_152;

/**
 * The Host's own staged facts for one card, in the one shape both the
 * pre-confirm review and the post-confirm result render. Every value comes from
 * the `character.import.stage` response; nothing is re-parsed from the card.
 */
type StagedReport = Readonly<{
  /** The field names the Host marked `profile_eligible_after_explicit_review`. */
  keptFields: readonly string[];
  lorebookCount: number;
  preserved: number;
  notUsed: readonly string[];
  longFieldChars: number | null;
  /** The card carried its own performance directive and it was kept. */
  voiceCarried: boolean;
  /** The card's directive was dropped by the decoder's own loss ledger. */
  voiceDropped: boolean;
  /**
   * World-book entries the importer could not render, each with the macros that kept it out.
   *
   * `lorebookCount` above says how many arrived; this says how many did NOT and why. A count of lost
   * entries is not actionable - the player cannot search a card for "3" - so the Host names the entry
   * and the macro, and this row repeats both.
   */
  omittedWorldBookEntries: readonly StCardImportOmittedEntryV1[];
  /**
   * The macros behind the closing direction the companion's context will omit WHOLE.
   *
   * The card's `post_history_instructions` is stored verbatim, so the loss is decided at
   * assembly, not at import - and the Host reports it here so the player can edit the card
   * instead of wondering why she never closes a reply the way the card asked.
   */
  closingDirectionMacros: readonly StCardImportOmittedMacroV1[];
}>;

type ImportOutcome =
  | Readonly<{ kind: "created"; name: string; report: StagedReport }>
  | Readonly<{ kind: "error"; message: string }>;

/** The Host's staged report, read from its own field/disposition output. */
function reportOf(staged: StCardImportStageResultV1): StagedReport {
  const keptFields = staged.fields
    .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
    .map((field) => field.field);
  const notUsed = staged.dispositions
    .filter(
      (disposition) =>
        disposition.classification === "dropped_unsupported" || disposition.classification === "rejected_invalid",
    )
    .map((disposition) => disposition.field)
    .filter((field, index, all) => all.indexOf(field) === index);
  const longField = staged.fields.find((field) => field.field === "persona_core" && field.chars > 4_000);
  return {
    keptFields,
    lorebookCount: staged.fields.filter((field) => field.field.startsWith("worldbook_")).length,
    preserved: staged.dispositions.filter((disposition) => disposition.classification === "preserved_opaque").length,
    notUsed,
    longFieldChars: longField?.chars ?? null,
    // The card's own performance directive is a profile-eligible field like the
    // persona: carrying it is reported from the field list, and the decoder's own
    // loss ledger is what reports a directive it had to refuse.
    voiceCarried: staged.fields.some((field) => field.field === "system_prompt"),
    voiceDropped: (staged.losses ?? []).some(
      (loss) => loss.field === "system_prompt" && loss.reason === "character_voice_too_long",
    ),
    omittedWorldBookEntries: (staged.losses ?? [])
      .filter((loss) => loss.reason === "unrenderable_worldbook_entry")
      .flatMap((loss) => loss.omitted ?? []),
    closingDirectionMacros: (staged.losses ?? [])
      .filter((loss) => loss.reason === "unrenderable_post_history_instructions")
      .flatMap((loss) => loss.macros ?? []),
  };
}

/**
 * The staged-report rows the review and the result share, so the two can never
 * disagree about what the Host kept or could not use.
 *
 * A row is one sentence, which is why the block these render into is a list of
 * sentences rather than a description list: a `dt`/`dd` pair is a term and its
 * definition, and "Could not use: Regular expressions." is neither.
 */
function reportRows(report: StagedReport, labels: CharacterLabels): ReactElement[] {
  return [
    <li key="notUsed">
      {report.notUsed.length === 0
        ? labels.importAllUsed
        : labels.importNotUsed.replace("{{fields}}", fieldNames(report.notUsed, labels))}
    </li>,
    ...(report.lorebookCount > 0
      ? [<li key="lorebook">{labels.importLorebookCount.replace("{{count}}", String(report.lorebookCount))}</li>]
      : []),
    ...(report.preserved > 0
      ? [<li key="preserved">{labels.importPreserved.replace("{{count}}", String(report.preserved))}</li>]
      : []),
    ...(report.longFieldChars !== null
      ? [<li key="longField">{labels.importLongField.replace("{{chars}}", String(report.longFieldChars))}</li>]
      : []),
    ...(report.voiceCarried
      ? [
          <li key="voiceCarried" data-card-import-voice="carried">
            {labels.importVoiceCarried}
          </li>,
        ]
      : []),
    ...(report.voiceDropped
      ? [
          <li key="voiceDropped" data-card-import-voice="dropped">
            {labels.importVoiceDropped}
          </li>,
        ]
      : []),
    /*
     * One row per omitted world-book entry, naming the entry AND the macro that kept it out.
     *
     * The Host already reports the count, and a count is not actionable: "3 entries lost" gives the
     * player nothing to search for in the card they are importing. Naming both things turns the same
     * fact into an edit they can make.
     */
    ...report.omittedWorldBookEntries.map((entry, index) => (
      <li key={`${entry.title}\u0000${index}`} data-card-import-omitted-entry>
        {labels.importWorldBookOmitted
          .replace("{{entry}}", entry.title)
          .replace(
            "{{macros}}",
            entry.macros.map((macro) => omittedMacroLabel(macro, labels)).join(labels.fieldSeparator),
          )}
      </li>
    )),
    /*
     * The card's closing direction is stored verbatim and omitted whole at assembly, so the loss
     * happens far from here. Naming the macro now is what turns "her closing direction is missing"
     * into an edit the player can make in the card they just imported.
     */
    ...(report.closingDirectionMacros.length === 0
      ? []
      : [
          <li key="closingDirectionOmitted" data-card-import-closing-direction="omitted">
            {labels.importClosingDirectionOmitted.replace(
              "{{macros}}",
              report.closingDirectionMacros
                .map((macro) => omittedMacroLabel(macro, labels))
                .join(labels.fieldSeparator),
            )}
          </li>,
        ]),
  ];
}

/** One macro in an omitted-entry row, in the player's words, told apart from an unrecognised token. */
function omittedMacroLabel(macro: StCardImportOmittedMacroV1, labels: CharacterLabels): string {
  return (
    macro.standard ? labels.importWorldBookOmittedStandardMacro : labels.importWorldBookOmittedUnknownMacro
  ).replace("{{macro}}", macro.token);
}

/** The player's words for a set of the Host's own field identifiers, one sentence. */
function fieldNames(fields: readonly string[], labels: CharacterLabels): string {
  // The list is the DISTINCT things the import keeps. One card routinely carries
  // several fields the domain names the same way - seven `example_N` entries are
  // seven `对话示例` - and printing the word once per entry told the player the
  // list held seven different things when it held seven of one. The count beside
  // it stays the entries kept, which is what its own label says.
  const names = fields.map((field) => characterFieldLabel(field, labels));
  return [...new Set(names)].join(labels.fieldSeparator);
}

/**
 * Import a character card (design/28 §2, design/26 §4.6).
 *
 * The primary path is the player choosing a `.json` / `.png` file from disk:
 * the browser reads that file locally and posts the card text. Pasting card
 * text stays available as a secondary path. Choosing a card is the *staging*
 * step, not the approval: the Host answers `character.import.stage` with its own
 * field/disposition report, the component shows that report - what the Host will
 * keep and what it could not use - and the companion is provisioned only when
 * the player confirms (design/26 §4.6: "Review every returned field
 * classification ... Confirm `Create New Character`"). Cancelling sends
 * nothing, so the durable companion list is unchanged.
 *
 * Everything the review shows is read from the Host's staged field/disposition
 * report - never re-parsed from the card. Nothing is claimed as created until
 * `confirm` returns the Host's own name for the provisioned companion.
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
  /**
   * The staged review and its heading: where the player is taken when a card is staged.
   *
   * The heading carries the focus (`tabIndex={-1}`), the way this shell already moves a
   * keyboard player to a surface's own title (`SurfaceView`) and to a drawer's title
   * (`ContextDrawer`): moving the scrollport without moving the focus leaves a keyboard
   * user reading the wrong region while the screen shows another.
   */
  const reviewRef = useRef<HTMLElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  /** The staged card the player has already been taken to, so a re-render cannot yank them back. */
  const revealedImportId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  /**
   * The Host's staged report, held until the player confirms or cancels it - by the shell, not here.
   *
   * A staged card IS a decision the player is in the middle of making: leaving Characters for
   * another surface unmounts this form, and a report held in a `useState` went with it, so the
   * review they had not yet approved vanished and the card had to be staged again. The `importId`
   * is the whole record (see `useRecordDraft`), and `null` is "nothing is staged".
   */
  const staged = useRecordDraft<StCardImportStageResultV1>("characters.card-import-staged", null);
  /**
   * The pasted card text, held by the shell rather than by this form.
   *
   * It was `useState` here, and this form lives on the Characters surface, which
   * `ComposedReferenceGameApp` renders conditionally - so leaving for another surface unmounted the
   * whole subtree and took a card body the player was part-way through pasting with it. The words
   * are the player's, not this projection's, which is the one rule `surface-drafts.tsx` states.
   */
  const pasted = useDraft("characters.card-import-paste", "");
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

  /**
   * A staged card is a decision, so the decision is brought to the player.
   *
   * The import card is not the top of this surface: the companion roster comes first,
   * and on the paste path the open paste box sits inside this card as well. Measured at
   * 1440x900 with the report capped and the decision row pinned, the review began at
   * y 737 on a three-companion roster - partly visible - and at y 873 with five, which
   * is past the 844 px scrollport, so `position: sticky` could no longer reach the
   * control (it is clamped to its own card) and `导入此角色卡` read y 882..926 against a
   * 900 px window. The roster's length is the player's data, so no rule inside the card
   * can bound it: what is left is to bring the review into view when it appears.
   *
   * It fires on the transition into a NEW staged card, never on re-render: a player who
   * has scrolled away and is reading the roster is not dragged back while they look.
   * `block: "nearest"` is the smallest move that makes the whole review (heading, capped
   * report and pinned decision row) fit the region - measured after this reveal at five
   * companions: the review reads y 389..844 and the confirm control y 800..844, where
   * `block: "start"` would scroll the review to the very top and hide the roster it came
   * from for no gain. Focus rides along (`preventScroll` first, then one explicit scroll)
   * so the scrollport and the caret land in the same place.
   */
  const stagedCard = staged.value;
  useEffect(() => {
    if (stagedCard === null) {
      revealedImportId.current = null;
      return;
    }
    if (revealedImportId.current === stagedCard.importId) return;
    revealedImportId.current = stagedCard.importId;
    const review = reviewRef.current;
    if (review === null) return;
    reviewHeadingRef.current?.focus({ preventScroll: true });
    review.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [stagedCard]);

  const refreshHistory = async (): Promise<void> => {
    try {
      setHistory(await api.readStCardImportHistory());
    } catch {
      setHistory("failed");
    }
  };

  /**
   * Staging is not importing: this posts the card's own text as
   * `character.import.stage` and keeps the Host's report until the player
   * decides. No companion exists and the durable list is untouched either way.
   */
  const stageCard = async (command: StageStCardImportCommandV1): Promise<void> => {
    if (busy) return;
    setBusy(true);
    staged.clear();
    setOutcome(null);
    try {
      staged.type(await api.stageStCardImport(command, csrfToken));
    } catch {
      setOutcome({ kind: "error", message: labels.importFailed });
    } finally {
      setBusy(false);
    }
  };

  /**
   * The player's approval: record the explicit review over exactly the fields the
   * Host itself marked eligible, then provision. The created companion is named
   * only from the Host's own confirm read-back.
   */
  const confirmStaged = async (): Promise<void> => {
    if (busy || stagedCard === null) return;
    setBusy(true);
    try {
      const report = reportOf(stagedCard);
      // The staged card always offers at least its own `name` for review - the
      // Host pushes it unconditionally and keeps a field whose text is empty
      // (`st-card-import-service.ts:candidateFromReport`, pinned by that module's
      // own test), so a review is always recordable and this call is always made.
      // The guard spelling is not what makes the flow safe: the Host refuses a
      // confirm with no review on file, so a card that ever came back empty would
      // fail the import here instead of silently creating her without approval.
      if (report.keptFields.length > 0)
        await api.reviewStCardImport(stagedCard.importId, report.keptFields, Date.now(), csrfToken);
      const confirmed = await api.confirmStCardImport(stagedCard.importId, csrfToken);
      if (confirmed.name.trim().length === 0) throw new Error("import_not_confirmed");
      staged.clear();
      setOutcome({ kind: "created", name: confirmed.name, report });
      onCreated?.();
      await refreshHistory();
    } catch {
      // The staged record is spent either way: a confirm that did not return a name is not a card
      // the player may press again, and the Host's own refusal sentence is what they get instead.
      staged.clear();
      setOutcome({ kind: "error", message: labels.importFailed });
    } finally {
      setBusy(false);
    }
  };

  /** Cancelling drops the staged card client-side; no route is called. */
  const cancelStaged = (): void => {
    staged.clear();
  };

  /**
   * The picked file as one arm of the stage command.
   *
   * A PNG card is sent as the WHOLE file, base64: the picture and the card are
   * the same object, so the Host's decoder owns both and there is no pairing for
   * this side to assert. Anything else is read as text here, which is all a
   * `.json` card is. Nothing about the card's CONTENT is decided on this side -
   * this reads bytes, picks an arm, and stops.
   */
  const readFile = async (
    file: File,
  ): Promise<{ ok: true; command: StageStCardImportCommandV1 } | { ok: false; message: string }> => {
    if (file.size > MAX_CARD_FILE_BYTES) return { ok: false, message: labels.importFailedTooLarge };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isPngCardFile(bytes))
      return { ok: true, command: { apiVersion: 1, cardSource: "png", cardFileBase64: canonicalBase64Of(bytes) } };
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/u, "");
    if (text.trim().length === 0) return { ok: false, message: labels.importFailedText };
    if (text.length > MAX_CARD_TEXT_LENGTH) return { ok: false, message: labels.importFailedTooLarge };
    return { ok: true, command: { apiVersion: 1, cardSource: "json", card: text } };
  };

  const handleFile = async (file: File): Promise<void> => {
    setOutcome(null);
    const read = await readFile(file);
    if (!read.ok) {
      setOutcome({ kind: "error", message: read.message });
      return;
    }
    await stageCard(read.command);
  };

  const stagedReport = stagedCard === null ? null : reportOf(stagedCard);

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
          value={pasted.value}
          onChange={(event) => pasted.type(event.target.value)}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="small-button"
            disabled={busy || pasted.value.trim().length === 0}
            onClick={() => void stageCard({ apiVersion: 1, cardSource: "json", card: pasted.value.trim() })}
          >
            {busy ? labels.importBusy : labels.importSubmit}
          </button>
        </div>
      </details>

      {stagedCard !== null && stagedReport !== null && (
        <section aria-label={labels.importReviewTitle} data-card-import-review ref={reviewRef}>
          <h4 ref={reviewHeadingRef} tabIndex={-1}>
            {labels.importReviewTitle}
          </h4>
          <p className="management-settings-hint">{labels.importReviewHint}</p>
          {/* One sentence per row, in the player's words. The list role is
              explicit because the block is styled without markers
              (`list-style: none` drops list semantics in Safari). */}
          <ul role="list" className="card-import-report" data-card-import-review-details>
            <li>{labels.importReviewName.replace("{{name}}", stagedCard.name)}</li>
            <li>
              {labels.importReviewWillKeep
                .replace("{{count}}", String(stagedReport.keptFields.length))
                .replace("{{fields}}", fieldNames(stagedReport.keptFields, labels))}
            </li>
            {reportRows(stagedReport, labels)}
          </ul>
          <div className="composer-actions">
            <button
              type="button"
              className="small-button primary"
              data-card-import-review-confirm
              disabled={busy}
              onClick={() => void confirmStaged()}
            >
              {busy ? labels.importBusy : labels.importReviewConfirm}
            </button>
            <button
              type="button"
              className="small-button"
              data-card-import-review-cancel
              disabled={busy}
              onClick={cancelStaged}
            >
              {labels.importReviewCancel}
            </button>
          </div>
        </section>
      )}

      {outcome !== null && (
        <div
          role="status"
          className={outcome.kind === "created" ? "success-banner" : "error-banner"}
          data-card-import-result={outcome.kind}
        >
          {outcome.kind === "created" ? (
            <ul role="list" className="card-import-report" data-card-import-details>
              <li>{labels.importCreated.replace("{{name}}", outcome.name)}</li>
              <li>{labels.importCreatedDetail}</li>
              <li>{labels.importKept.replace("{{count}}", String(outcome.report.keptFields.length))}</li>
              {reportRows(outcome.report, labels)}
            </ul>
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
                  <span className="management-settings-hint">{new Date(entry.occurredAtMs).toLocaleString()}</span>
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
