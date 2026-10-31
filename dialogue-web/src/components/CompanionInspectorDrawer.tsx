import { ChevronDown, UserRound } from "lucide-react";
import { type ReactElement, type RefObject, useEffect, useRef, useState } from "react";
import { type Locale, type Messages, messages } from "../i18n";
import { problemTextWithCode } from "../composed-problem-view";
import type { CompanionProfileV1, ManagementPipelineApi } from "../management-pipeline-api";
import { MAX_AVATAR_FILE_BYTES, TavernProblemError } from "../management-pipeline-api";
import { useArmedConfirmation } from "./armed-confirmation";
import { CompanionAvatar } from "./CompanionAvatar";
import { ContextDrawer } from "./ContextDrawer";
import { characterLabels, type CharacterLabels } from "./character-domain-labels";
import { canonicalBase64Of, pngBytesOfPickedPicture } from "./png-character-card";

/**
 * The read-only companion inspector (design/28 §2).
 *
 * The Characters surface lists every companion the library holds, but only the
 * MOUNTED one had a panel: the persona/scenario/opening/directive editors all
 * read the mounted companion (and `persona.read` is the PLAYER's own record), so
 * an archived companion's authored facts were on disk and unreadable. This drawer
 * is the one place they are read, and it edits none of them: it renders the projection
 * `companion.profile.read` returns.
 *
 * It opens in the shell's one contextual drawer primitive, so the focus trap,
 * Escape and focus restoration to the row that opened it are the shell's own
 * mechanics rather than a second implementation.
 *
 * Two facts make it honest rather than a wall of empty boxes:
 *
 *  - a group the companion was provisioned without says so ("she was made without
 *    one"), which is a different fact from a group that exists and is empty, and
 *    the projection carries that difference as its own `present` flag;
 *  - the in-play statement is stated, never offered: choosing which companion plays is the
 *    roster's own control (`companion.activate`, which only RECORDS the choice for the next
 *    start), so this drawer contains no control that claims to switch, select or enable
 *    anything.
 *
 * Its writes are two, not the records it reads: her picture
 * (`CompanionAvatarSection`) and her removal (`CompanionRemovalSection`). The drawer is the
 * only per-companion surface that shows every companion, so it is where a player gives an
 * authorless one a face - that control writes to the same file the runtime asset face
 * serves at her own URL, and edits none of the records this drawer reads, and the roster's
 * own read (`companion.list`) is untouched by an upload - and it is also the only place a
 * roster companion can be removed at all.
 */
export type InspectedCompanion = Readonly<{ handle: string; name: string; isCurrent: boolean }>;

/** What the drawer knows about the read: no profile yet, a failed read, or one. */
type CompanionProfileView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; profile: CompanionProfileV1 }>;

export function CompanionInspectorDrawer({
  api,
  csrfToken,
  companion,
  locale,
  onClose,
  onAvatarUpdated,
  onDeleted,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  /** The broker's own CSRF fact; the two writes here are the picture and the removal. */
  csrfToken: string;
  /** The roster row that opened the drawer, or null when it is closed. */
  companion: InspectedCompanion | null;
  locale: Locale;
  onClose: () => void;
  /**
   * A picture the player just stored for `companion`, told to the surface that draws the
   * roster row. The row cannot learn it any other way: an upload writes the file her face
   * serves, so `companion.list` - the roster's own read - is untouched and re-reading it
   * carries no digest. The upload's own reply is the one fact the row has a new picture.
   */
  onAvatarUpdated: (handle: string, digest: string) => void;
  /**
   * Her removal succeeded. The surface drops exactly this row and closes the drawer: the
   * companion the drawer was describing no longer exists, so re-reading her would answer 404
   * and re-rendering the drawer would show a page about nobody.
   */
  onDeleted: (handle: string, name: string) => void;
  /** The row's own control; focus returns here on close. */
  restoreFocusTo: RefObject<HTMLElement | null>;
}): ReactElement | null {
  const labels = characterLabels(locale);
  const [view, setView] = useState<CompanionProfileView>({ kind: "loading" });
  const handle = companion === null ? null : companion.handle;

  useEffect(() => {
    if (handle === null) return;
    let active = true;
    setView({ kind: "loading" });
    void (async () => {
      try {
        const profile = await api.readCompanionProfile(handle);
        if (active) setView({ kind: "ready", profile });
      } catch {
        if (active) setView({ kind: "unavailable" });
      }
    })();
    return () => {
      active = false;
    };
  }, [api, handle]);

  if (companion === null) return null;

  return (
    <ContextDrawer
      title={companion.name}
      closeLabel={labels.companionInspectorClose}
      onClose={onClose}
      testId="companion-inspector"
      icon={UserRound}
      restoreFocusTo={restoreFocusTo}
    >
      {/* The same condition the roster states, in the inspector's own words: a
          state of the deployment, never a control this Host cannot honour. */}
      <p className="management-settings-hint" data-companion-inspector-state>
        {companion.isCurrent
          ? labels.companionInspectorInPlay
          : labels.companionInspectorNotInPlay.replace("{{name}}", companion.name)}
      </p>
      {/* The removal entry sits directly under that state line, BEFORE her picture and
          the authored groups. It used to be the drawer's last child, after a profile
          body that is several screens tall at 420x900, which meant a player opening an
          archived companion never saw that removal existed - and a player opening the
          one in play never saw the sentence explaining why it does not apply. A
          destructive control the player cannot find is not safer, only undiscoverable;
          and the explanatory paragraph is exactly what has to be read before the
          control, not after it. */}
      <CompanionRemovalSection
        api={api}
        csrfToken={csrfToken}
        companion={companion}
        revision={view.kind === "ready" ? view.profile.revision : null}
        labels={labels}
        problemLabels={messages(locale)}
        onDeleted={onDeleted}
      />
      <CompanionAvatarSection
        api={api}
        csrfToken={csrfToken}
        companion={companion}
        labels={labels}
        problemLabels={messages(locale)}
        onAvatarUpdated={onAvatarUpdated}
      />
      {view.kind === "loading" ? (
        <p className="loading-text">{labels.loading}</p>
      ) : view.kind === "unavailable" ? (
        <p data-companion-inspector-unavailable>{labels.companionInspectorUnavailable}</p>
      ) : (
        <CompanionProfileBody profile={view.profile} labels={labels} />
      )}
    </ContextDrawer>
  );
}

/**
 * Her picture: the drawer's other write, and the whole reason it is no longer
 * read-only.
 *
 * The drawer shows every companion the roster listed, so this is where an imported or
 * hand-made one stops being a monogram - the route behind the control resolves ANY
 * listed companion, not only the one in play. Everywhere else here reads the records
 * `companion.profile.read` projects; a picture is not one of those records (it is a file
 * the runtime asset face serves at her own URL), so this section reads nothing and
 * claims nothing it cannot see - the avatar ITSELF is what tells the player whether she
 * has one, by drawing her picture or her initial.
 *
 * The `digest` an upload answers with is the reload key: the image is rebuilt under it
 * and the browser revalidates the URL it already holds, so the new picture is on screen
 * the moment the Host confirms it. Re-choosing the same file changes nothing, because
 * the digest does not change.
 *
 * The picker takes a PNG, a JPEG or a WebP picture, because those are the pictures a
 * player has; the Host still takes a PNG and nothing else, so the file is converted
 * (`pngBytesOfPickedPicture`) before it is sent. Two facts follow, and both are the point:
 * the Host's boundary did not move, and a player with a JPEG portrait can give her a face.
 */
function CompanionAvatarSection({
  api,
  csrfToken,
  companion,
  labels,
  problemLabels,
  onAvatarUpdated,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  companion: InspectedCompanion;
  labels: CharacterLabels;
  /** The product catalogue, which is where a refusal's own sentence is worded. */
  problemLabels: Messages;
  onAvatarUpdated: (handle: string, digest: string) => void;
}): ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [digest, setDigest] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Readonly<{ ok: boolean; text: string }> | null>(null);

  const choose = async (file: File): Promise<void> => {
    setNotice(null);
    setBusy(true);
    try {
      // The bytes that leave this surface are the browser's own PNG encoding of the picked
      // picture, so the ceiling is checked on exactly those bytes - the ones the Host is
      // handed - and not on the file the player happened to have. A 40 MB JPEG that encodes
      // to a 450 KB PNG is accepted, because 450 KB is what she would be storing.
      const bytes = await pngBytesOfPickedPicture(file);
      if (bytes === null) {
        // A file this browser cannot read as a picture never becomes a request: the Host's
        // answer to bytes that are not a picture is about ITS boundary, and the player's
        // fault is earlier than that.
        setNotice({ ok: false, text: labels.avatarUndecodable });
        return;
      }
      if (bytes.length > MAX_AVATAR_FILE_BYTES) {
        setNotice({ ok: false, text: labels.avatarTooLarge });
        return;
      }
      const saved = await api.uploadCompanionAvatar(companion.handle, canonicalBase64Of(bytes), csrfToken);
      setDigest(saved.digest);
      onAvatarUpdated(companion.handle, saved.digest);
      setNotice({ ok: true, text: labels.avatarSaved });
    } catch (error) {
      setNotice({ ok: false, text: companionAvatarRefusal(labels, error, problemLabels) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-companion-inspector-avatar>
      <h3>{labels.avatarTitle}</h3>
      <p className="management-settings-hint">{labels.avatarHint}</p>
      <div className="composer-actions">
        {/* Her picture at hero size: this drawer is the one surface where a player looks at it
            closely - and the one where they just uploaded it - so it is drawn as a portrait rather
            than as the 28 px glyph the roster row and the transcript use. It is the SAME avatar
            element (and so the same monogram fallback) with a size class, not a second renderer. */}
        <CompanionAvatar handle={companion.handle} name={companion.name} className="avatar-hero" digest={digest} />
        <button
          type="button"
          className="small-button"
          data-companion-avatar-choose
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          {busy ? labels.saving : labels.avatarChoose}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={labels.avatarChoose}
          className="card-import-file-input"
          disabled={busy}
          // The trigger beside it is the visible control and the tab stop; this input is
          // the browser's real picker behind it, out of the visual flow by the sheet's one
          // clip-path recipe (the same class the card import's input uses - taking a
          // native file input out of the flow is one recipe, not two).
          tabIndex={-1}
          data-companion-avatar-file
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Reset so choosing the same file again still fires `change`.
            event.target.value = "";
            if (file !== undefined) void choose(file);
          }}
        />
      </div>
      {notice !== null && (
        <p role="status" data-companion-avatar-notice className={notice.ok ? "success-banner" : "error-banner"}>
          {notice.text}
        </p>
      )}
    </section>
  );
}

/**
 * The player's sentence for one refused picture.
 *
 * Every way the Host refuses is a different fact about the file that was picked - it is
 * bigger than the picture ceiling, it is not a PNG at all, the companion is gone, or her
 * stored picture could not be read - and one "could not save" sentence would send the
 * player looking for the wrong fault. A code this table does not know keeps the base
 * sentence with the code appended, so an unexpected refusal is still named rather than
 * swallowed.
 */
function companionAvatarRefusal(labels: CharacterLabels, error: unknown, problemLabels: Messages): string {
  const code = error instanceof TavernProblemError ? error.code : null;
  switch (code) {
    case "companion_avatar_too_large":
      return labels.avatarTooLarge;
    case "companion_avatar_malformed":
      return labels.avatarInvalid;
    case "companion_not_found":
      return labels.avatarNotFound;
    case "companion_record_unreadable":
    case "storage_unavailable":
      return labels.avatarUnreadable;
    default:
      return problemTextWithCode(labels.avatarFailed, error, problemLabels);
  }
}

/**
 * Removing her - the one irreversible control on this surface.
 *
 * Nothing is offered for the companion in play, and the reason is stated in words a sighted
 * and a screen-reader player both read: her Chats ARE the mounted conversation, so the Host
 * refuses her by name (`companion_delete_in_play`) and a control that could only fail would
 * be a trap. For everyone else the pattern is the product's own armed pair
 * (`armed-confirmation.ts`): the trigger is replaced by the confirmation, focus moves into
 * its safe answer, Escape and `Keep her` both cancel and return focus to the trigger, and
 * the confirmation restates "for good" rather than asking whether the player is sure.
 *
 * The revision this CASes on is the one the inspector read, so a record that moved on since
 * is refused rather than deleting a companion from a stale screen. The deletion's scope is
 * the Host's own - her artifact root (record, picture, scenario, openings, examples and the
 * card additions kept beside them) plus her identity profile (persona and performance
 * directive) - and both sentences in the catalogue enumerate that whole set. Her
 * conversations stay where they are, and the hint says so rather than implying they go with
 * her.
 *
 * It renders near the TOP of the drawer, not after the profile body: the drawer is one
 * scrolling column 420 px wide, and her authored groups run several screens deep, so a
 * removal entry at the end of it was a control a player had to hunt for - and, for the
 * companion in play, a paragraph they never read.
 */
function CompanionRemovalSection({
  api,
  csrfToken,
  companion,
  revision,
  labels,
  problemLabels,
  onDeleted,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  companion: InspectedCompanion;
  /** Her `companion.json` revision as the inspector read it; null when the read carried none. */
  revision: number | null;
  labels: CharacterLabels;
  /** The product catalogue, which is where a refusal's own sentence is worded. */
  problemLabels: Messages;
  onDeleted: (handle: string, name: string) => void;
}): ReactElement | null {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Readonly<{ ok: boolean; text: string }> | null>(null);
  const pair = useArmedConfirmation(armed, () => setArmed(false));

  if (companion.isCurrent) {
    return (
      <section data-companion-removal>
        <h3>{labels.companionDeleteTitle}</h3>
        <p className="management-settings-hint" data-companion-removal-in-play>
          {labels.companionDeleteInPlay}
        </p>
      </section>
    );
  }
  // No revision to CAS on means her own record could not be read, so there is nothing to
  // remove on the player's behalf; the section says nothing rather than offering it.
  if (revision === null) return null;

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    void (async () => {
      let next: Readonly<{ ok: boolean; text: string }>;
      try {
        await api.deleteCompanion(companion.handle, revision, csrfToken);
        onDeleted(companion.handle, companion.name);
        return;
      } catch (error) {
        next = { ok: false, text: companionRemovalRefusal(labels, error, problemLabels) };
      }
      setBusy(false);
      setArmed(false);
      setNotice(next);
    })();
  };

  return (
    <section data-companion-removal>
      <h3>{labels.companionDeleteTitle}</h3>
      <p className="management-settings-hint">{labels.companionDeleteHint}</p>
      {armed ? (
        <div data-companion-removal-confirm onKeyDown={pair.onConfirmKeyDown}>
          <p role="status">{labels.companionDeleteConfirm.replace("{{name}}", companion.name)}</p>
          <div className="composer-actions">
            <button
              type="button"
              className="small-button danger"
              data-companion-removal-confirm-yes
              disabled={busy}
              onClick={confirm}
            >
              {busy ? labels.saving : labels.companionDeleteConfirmYes}
            </button>
            {/* The safe answer is the one focus lands on when the pair opens, so a stray
                Enter cancels instead of deleting her. */}
            <button
              ref={pair.cancelRef}
              type="button"
              className="small-button"
              data-companion-removal-confirm-no
              disabled={busy}
              onClick={pair.cancel}
            >
              {labels.companionDeleteCancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-actions">
          <button
            ref={pair.triggerRef}
            type="button"
            className="small-button danger"
            data-companion-removal-arm
            disabled={busy}
            onClick={() => {
              setNotice(null);
              setArmed(true);
            }}
          >
            {labels.companionDelete}
          </button>
        </div>
      )}
      {notice !== null && (
        <p role="status" data-companion-removal-notice className={notice.ok ? "success-banner" : "error-banner"}>
          {notice.text}
        </p>
      )}
    </section>
  );
}

/**
 * The player's sentence for one refused removal.
 *
 * Every way the Host refuses is a different fact - her record moved on, she is gone, her
 * record could not be read, she is the companion in play - and one "could not delete"
 * would point at the wrong fault. A code this table does not know keeps the base sentence,
 * so an unexpected refusal is still named rather than swallowed.
 */
function companionRemovalRefusal(labels: CharacterLabels, error: unknown, problemLabels: Messages): string {
  const code = error instanceof TavernProblemError ? error.code : null;
  switch (code) {
    case "companion_conflict":
      return labels.companionDeleteConflict;
    case "companion_delete_in_play":
      return labels.companionDeleteInPlay;
    case "companion_not_found":
      return labels.companionDeleteNotFound;
    case "companion_record_unreadable":
    case "storage_unavailable":
      return labels.companionDeleteUnreadable;
    default:
      return problemTextWithCode(labels.companionDeleteFailed, error, problemLabels);
  }
}

/** The four authored groups, each labelled, each honest about absence. */
function CompanionProfileBody({
  profile,
  labels,
}: {
  profile: CompanionProfileV1;
  labels: CharacterLabels;
}): ReactElement {
  return (
    <>
      <section data-companion-inspector-persona>
        <h3>{labels.companionInspectorPersonaTitle}</h3>
        {profile.persona.present ? (
          <>
            {profile.persona.core === null ? null : (
              <>
                <p className="management-settings-hint">{labels.companionInspectorPersonaCore}</p>
                <p data-companion-inspector-persona-core>{profile.persona.core}</p>
              </>
            )}
            {profile.persona.interactionStyle === null ? null : (
              <>
                <p className="management-settings-hint">{labels.fieldPersonaInteractionStyle}</p>
                <p data-companion-inspector-persona-interaction-style>{profile.persona.interactionStyle}</p>
              </>
            )}
            {profile.persona.expressionStyle === null ? null : (
              <>
                <p className="management-settings-hint">{labels.fieldPersonaExpressionStyle}</p>
                <p data-companion-inspector-persona-expression-style>{profile.persona.expressionStyle}</p>
              </>
            )}
          </>
        ) : (
          <p data-companion-inspector-absent>{labels.companionInspectorAbsent}</p>
        )}
      </section>

      <section data-companion-inspector-scenario>
        <h3>{labels.scenarioTitle}</h3>
        {profile.scenario.present ? (
          <>
            <p className="management-settings-hint">{labels.scenarioName}</p>
            <p data-companion-inspector-scenario-name>{profile.scenario.name}</p>
            {/* The scenario's own text is authored prose and can be long; it sits
                one fold down so the drawer stays scannable. */}
            <details className="custom-disclosure" data-companion-inspector-scenario-text>
              <summary>
                <ChevronDown size={14} aria-hidden="true" />
                {labels.scenarioDescription}
              </summary>
              <p>{profile.scenario.description}</p>
            </details>
          </>
        ) : (
          <p data-companion-inspector-absent>{labels.companionInspectorScenarioAbsent}</p>
        )}
      </section>

      <section data-companion-inspector-openings>
        <h3>{labels.companionInspectorOpeningsTitle}</h3>
        {profile.greetings.present ? (
          <>
            {profile.greetings.label === null ? null : (
              <>
                <p className="management-settings-hint">{labels.openingLabel}</p>
                <p data-companion-inspector-openings-label>{profile.greetings.label}</p>
              </>
            )}
            <div role="list" data-companion-inspector-opening-list>
              {profile.greetings.variants.map((variant, index) => (
                // An opening has no durable id on this wire, and two openings can
                // share a label or even a first sentence; the position in the set
                // is what a list of openings has to key by, and it is not an
                // identity claim about the record.
                <div key={`${variant.label ?? ""}\u0000${index}`} role="listitem" data-companion-inspector-opening>
                  {variant.label === null ? null : <strong>{variant.label}</strong>}
                  <details className="custom-disclosure" data-companion-inspector-opening-text>
                    <summary>
                      <ChevronDown size={14} aria-hidden="true" />
                      {labels.openingVariantText}
                    </summary>
                    <p>{variant.text}</p>
                  </details>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p data-companion-inspector-absent>{labels.companionInspectorGreetingsAbsent}</p>
        )}
      </section>

      <section data-companion-inspector-world-book>
        <h3>{labels.companionInspectorWorldBookTitle}</h3>
        {profile.worldBook.present ? (
          profile.worldBook.entries.length === 0 ? (
            // Present but empty says so in words: a bare zero reads as a book whose
            // entries were lost.
            <p data-companion-inspector-world-book-empty>{labels.companionWorldBookNoEntries}</p>
          ) : (
            <details className="custom-disclosure" data-companion-inspector-world-book-disclosure>
              <summary>
                <ChevronDown size={14} aria-hidden="true" />
                <span data-companion-inspector-world-book-count>
                  {labels.companionWorldBookCount.replace("{{count}}", String(profile.worldBook.entries.length))}
                </span>
              </summary>
              <div role="list" data-companion-inspector-world-book-list>
                {profile.worldBook.entries.map((entry, index) => (
                  <div key={`${entry.title}\u0000${index}`} role="listitem" data-companion-inspector-world-book-entry>
                    <strong>{entry.title}</strong>
                    <p>
                      {entry.constant
                        ? labels.companionWorldBookAlwaysOn
                        : labels.companionWorldBookTriggerWords.replace(
                            "{{keys}}",
                            entry.keys.join(labels.companionWorldBookKeySeparator),
                          )}
                    </p>
                    <details className="custom-disclosure" data-companion-inspector-world-book-entry-text>
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
          )
        ) : (
          <p data-companion-inspector-absent>{labels.companionInspectorWorldBookAbsent}</p>
        )}
      </section>
    </>
  );
}
