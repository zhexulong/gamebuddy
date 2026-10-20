import type { CompanionInterruption, InterruptionSnapshot } from "./companion-interruption.js";
import type { CompanionTextPort, GameCompanionTextExpression, PresentationCommitAdmission } from "./presentation.js";
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
      const snapshot = bridge.state.snapshot;
      if (snapshot === null) throw new Error("farmhand_presentation_snapshot_unavailable");
      // Reassert immediately before the only write. The Mod independently
      // checks its own current revision and presentation epoch on its game thread.
      admission.assertHostCurrent(admission.hostBinding);
      epoch.assertCurrent(epoch.binding);
      // The last Host boundary before the text becomes player-visible: the Game
      // bubble is a live projection, so the Magic Context `§N§` self-tag the model
      // mimicked into its reply is removed here, once, for both the bubble and the
      // companion-language hook.
      const text = stripMagicContextSelfTag(expression.text);
      await bridge.presentCompanionText({
        expressionId: expression.expressionId,
        sourceEventId: expression.sourceEventId,
        text,
        locale: expression.locale,
        expectedRevision: snapshot.revision,
        presentationEpoch: epoch.epoch,
      });
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
