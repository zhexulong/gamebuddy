import type { CompanionInterruption, InterruptionSnapshot } from "./companion-interruption.js";
import { stripInlineAudioTags } from "./companion-speech-dehydration.js";
import type { CompanionTextPort, GameCompanionTextExpression, PresentationCommitAdmission } from "./presentation.js";
import { RUN_SPAN_NAMES, type RunTrace } from "./run-trace.js";
import type { StopSystemNotice } from "./system-notices.js";

/** Adapter-owned narrow surface needed for Farmhand native text presentation. */
export type FarmhandPresentationBridge = Readonly<{
  state: Readonly<{ snapshot: Readonly<{ revision: number }> | null }>;
  presentCompanionText(request: Readonly<Record<string, unknown>>): Promise<void>;
  presentSystemNotice(request: Readonly<Record<string, unknown>>): Promise<void>;
}>;

/** Host-owned interruption epoch proof for the Farmhand presentation surface. */
export interface FarmhandPresentationEpochAdmission {
  capture(): Readonly<{ binding: object; epoch: number; assertCurrent(binding: object): void }>;
}

/** Derives presentation epoch only from the runtime-owned interruption authority. */
export function createFarmhandPresentationEpochAdmission(
  interruption: CompanionInterruption,
): FarmhandPresentationEpochAdmission {
  return Object.freeze({
    capture() {
      const snapshot: InterruptionSnapshot = interruption.capture();
      const binding = Object.freeze({});
      return Object.freeze({
        binding,
        epoch: snapshot.epoch,
        assertCurrent(candidate: object) {
          if (candidate !== binding) throw new Error("stale_farmhand_presentation_epoch");
          interruption.assertCurrent(snapshot);
        },
      });
    },
  });
}

/** One Magic Context `§N§` self-tag, with the space the model put after it. */
const MAGIC_CONTEXT_SELF_TAG = /§\d+§\s*/g;

/**
 * Strip Magic Context's `§N§` self-tag from companion text before the player sees it.
 *
 * Magic Context's own instructions tell the model to prefix every reply with a `§N§`
 * tag, and LLMs frequently mimic it into a fresh response - a real Game run presented
 * "§43§ 已经进屋了，被窝那边我去占着。" verbatim to the player. The tag is internal
 * prompt notation, never companion speech. The Chat row is scrubbed where it is
 * persisted, but the Game bubble is a live projection that does not pass through that
 * path, so this is the last Host boundary before the text lands in the bubble and the
 * one place it is removed. It is never stripped from what the model receives: there
 * it is Magic Context's own prompt marker and removing it changes the prompt contract.
 */
export function stripMagicContextSelfTag(text: string): string {
  return text.replace(MAGIC_CONTEXT_SELF_TAG, "").trim();
}

/**
 * Narrow direct Host presentation port. It has no arbitrary transport method,
 * no action authority, and reasserts both Host admissions immediately before
 * the typed bridge request.
 */
export function createFarmhandSystemNoticePresenter(
  bridge: FarmhandPresentationBridge,
): (notice: StopSystemNotice, noticeId: string) => Promise<void> {
  return async (notice, noticeId) => {
    await bridge.presentSystemNotice({
      noticeId,
      key: notice.key,
      text: notice.text,
      locale: notice.locale,
    });
  };
}

export function createFarmhandCompanionPresentationPort(
  bridge: FarmhandPresentationBridge,
  epochAdmission: FarmhandPresentationEpochAdmission,
  onTextPresented?: (text: string, locale: string) => void,
  trace?: RunTrace,
): CompanionTextPort {
  return Object.freeze({
    async present(expression: GameCompanionTextExpression, admission: PresentationCommitAdmission): Promise<void> {
      admission.assertHostCurrent(admission.hostBinding);
      const epoch = epochAdmission.capture();
      epoch.assertCurrent(epoch.binding);
      // This adapter is Game-only; the discriminated expression type requires
      // a source-owned event before any bridge write.
      if (
        expression.surface !== "game" ||
        !("sourceEventId" in expression) ||
        !(expression as { sourceEventId?: string }).sourceEventId
      ) {
        throw new Error("farmhand_presentation_source_event_required");
      }
      const sourceEventId = expression.sourceEventId;
      // Reassert immediately before the only write. The Mod independently
      // checks its own current locale and presentation epoch on its game thread.
      admission.assertHostCurrent(admission.hostBinding);
      epoch.assertCurrent(epoch.binding);
      // The last Host boundary before the text becomes player-visible: the Game
      // bubble is a live projection, so the Magic Context `§N§` self-tag the model
      // mimicked into its reply is removed here, once, for both the bubble and the
      // companion-language hook.
      const text = stripMagicContextSelfTag(expression.text);
      // The two channels take that one utterance differently, and this is where they diverge.
      // A bracketed group is a prosody direction the voice performs instead of speaking
      // (`（轻声）`, `(softly)`, `[pause]`); the bubble has no voice to perform with, so it
      // prints the direction as her words. Only the bubble loses it - `text` below is handed
      // to the hook unchanged, because dropping the tag there would delete the emotion
      // channel it exists for.
      const bubbleText = stripInlineAudioTags(text);
      // Nothing but a direction is nothing to show, and the strip above is what can empty a
      // piece that was not empty before. The Mod refuses empty text
      // (`companion_presentation_text_empty`) and this presenter ends the turn's whole
      // admission on a failed commit, so no write is attempted; the hook below still runs.
      if (bubbleText.length > 0) {
        // No world revision is claimed. Presentation mutates no world state, and the Mod mints a new
        // action-transaction revision for every receipt it publishes — progress receipts and
        // auto-collected program nodes included — so the Host's last admitted revision is a cached
        // projection, not the Mod's current one. Claiming it exactly refused eight successful tool
        // selections' closing line in a live run (2026-10-22, `invalid_or_stale_companion_presentation`)
        // with no way to tell which of six conditions had refused it. The STOP epoch is the ordering
        // claim that does matter, and `expressionId` plus the Mod's fingerprint already make replay exact.
        const write = () =>
          bridge.presentCompanionText({
            expressionId: expression.expressionId,
            sourceEventId,
            text: bubbleText,
            locale: expression.locale,
            presentationEpoch: epoch.epoch,
          });
        // One span per player-visible commit: its end is the moment the bubble landed, which is what the run's
        // presentation evidence used to record by hand.
        await (trace === undefined
          ? write()
          : trace.span(
              RUN_SPAN_NAMES.present,
              {
                expressionId: expression.expressionId,
                sourceEventId,
                locale: expression.locale,
              },
              write,
            ));
      }
      // Fire-and-forget companion-language hook (e.g. streaming TTS). A
      // throwing listener must never fail a presentation that already landed.
      if (onTextPresented !== undefined) {
        try {
          onTextPresented(text, expression.locale);
        } catch {
          // Presentation already committed; keep the voice lane optional.
        }
      }
    },
  });
}
