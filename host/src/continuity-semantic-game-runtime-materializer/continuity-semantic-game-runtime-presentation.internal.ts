import { randomUUID } from "node:crypto";

import type { NativeGameContentPresenter } from "../companion-loop.js";
import type { RuntimeSession } from "../runtime.js";

/**
 * Construction-zone-only composition of already-owned Game presentation authorities.
 * The source lineage is captured by the active Host admission rather than supplied by
 * the caller, and the expression receipt identity is minted independently by Host TCB.
 */
export function createLineageBoundNativeGamePresenter(
  presentation: NonNullable<RuntimeSession["presentation"]>,
  createExpressionId: () => string = () => `expression_${randomUUID().replaceAll("-", "")}`,
): NativeGameContentPresenter {
  if (
    presentation.surface !== "game" ||
    presentation.textPort === undefined ||
    presentation.admissionProvider === undefined ||
    typeof createExpressionId !== "function"
  ) {
    throw new Error("game_presentation_authority_unavailable");
  }
  return async (content) => {
    const capture = presentation.admissionProvider?.capture();
    if (capture === undefined || capture.surface !== "game" || capture.sourceEventId !== content.sourceEventId) {
      throw new Error("game_presentation_source_lineage_mismatch");
    }
    const expressionId = createExpressionId();
    if (!/^expression_[a-f0-9]{32}$/u.test(expressionId)) throw new Error("invalid_game_expression_id");
    await presentation.textPort?.present(
      Object.freeze({
        surface: "game",
        expressionId,
        sessionId: presentation.sessionId,
        sourceEventId: content.sourceEventId,
        text: content.text,
        locale: presentation.profile.locale,
      }),
      capture.admission,
    );
  };
}
