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
      await bridge.presentCompanionText({
        expressionId: expression.expressionId,
        sourceEventId: expression.sourceEventId,
        text: expression.text,
        locale: expression.locale,
        expectedRevision: snapshot.revision,
        presentationEpoch: epoch.epoch,
      });
    },
  });
}
