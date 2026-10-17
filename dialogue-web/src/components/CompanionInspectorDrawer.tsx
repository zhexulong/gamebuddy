import { ChevronDown, UserRound } from "lucide-react";
import { type ReactElement, type RefObject, useEffect, useState } from "react";
import type { Locale } from "../i18n";
import type { CompanionProfileV1, ManagementPipelineApi } from "../management-pipeline-api";
import { ContextDrawer } from "./ContextDrawer";
import { characterLabels, type CharacterLabels } from "./character-domain-labels";

/**
 * The read-only companion inspector (design/28 §2).
 *
 * The Characters surface lists every companion the library holds, but only the
 * MOUNTED one had a panel: the persona/scenario/opening/directive editors all
 * read the mounted companion (and `persona.read` is the PLAYER's own record), so
 * an archived companion's authored facts were on disk and unreadable. This drawer
 * is the one place they are read, and it is read-only: it renders the projection
 * `companion.profile.read` returns and edits nothing.
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
 *  - the in-play statement is stated, never offered: the companion in play is
 *    chosen by the start-up configuration and the Host serves no activation
 *    operation, so this drawer contains no control that claims to switch, select
 *    or enable anything.
 */
export type InspectedCompanion = Readonly<{ handle: string; name: string; isCurrent: boolean }>;

/** What the drawer knows about the read: no profile yet, a failed read, or one. */
type CompanionProfileView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; profile: CompanionProfileV1 }>;

export function CompanionInspectorDrawer({
  api,
  companion,
  locale,
  onClose,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  /** The roster row that opened the drawer, or null when it is closed. */
  companion: InspectedCompanion | null;
  locale: Locale;
  onClose: () => void;
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
