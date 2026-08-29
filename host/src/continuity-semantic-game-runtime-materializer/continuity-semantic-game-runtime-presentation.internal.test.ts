import assert from "node:assert/strict";
import test from "node:test";

import { createLineageBoundNativeGamePresenter } from "./continuity-semantic-game-runtime-presentation.internal.js";

test("native Game presenter binds captured source lineage and commit admission", async () => {
  const admission = Object.freeze({ hostBinding: Object.freeze({}), assertHostCurrent() {} });
  const presented: unknown[] = [];
  const presenter = createLineageBoundNativeGamePresenter(
    Object.freeze({
      surface: "game" as const,
      sessionId: "game_session_01",
      profile: Object.freeze({ locale: "en-US" }),
      admissionProvider: Object.freeze({
        capture: () => Object.freeze({ surface: "game" as const, sourceEventId: "source_01", admission }),
      }),
      textPort: Object.freeze({
        present: async (expression: unknown, capturedAdmission: unknown) => {
          presented.push(Object.freeze({ expression, admission: capturedAdmission }));
        },
      }),
    }) as never,
    () => "expression_0123456789abcdef0123456789abcdef",
  );

  await presenter(Object.freeze({ sourceEventId: "source_01", text: "Morning." }));
  assert.deepEqual(presented, [
    Object.freeze({
      expression: Object.freeze({
        surface: "game",
        expressionId: "expression_0123456789abcdef0123456789abcdef",
        sessionId: "game_session_01",
        sourceEventId: "source_01",
        text: "Morning.",
        locale: "en-US",
      }),
      admission,
    }),
  ]);
});

test("native Game presenter rejects mismatched lineage and invalid expression identity before presentation", async () => {
  let presented = 0;
  const presentation = Object.freeze({
    surface: "game" as const,
    sessionId: "game_session_01",
    profile: Object.freeze({ locale: "en-US" }),
    admissionProvider: Object.freeze({
      capture: () =>
        Object.freeze({
          surface: "game" as const,
          sourceEventId: "source_01",
          admission: Object.freeze({ hostBinding: Object.freeze({}), assertHostCurrent() {} }),
        }),
    }),
    textPort: Object.freeze({ present: async () => void (presented += 1) }),
  }) as never;

  await assert.rejects(
    createLineageBoundNativeGamePresenter(presentation, () => "expression_0123456789abcdef0123456789abcdef")(
      Object.freeze({ sourceEventId: "foreign_source", text: "No." }),
    ),
    /game_presentation_source_lineage_mismatch/,
  );
  await assert.rejects(
    createLineageBoundNativeGamePresenter(presentation, () => "source_01")(
      Object.freeze({ sourceEventId: "source_01", text: "No." }),
    ),
    /invalid_game_expression_id/,
  );
  assert.equal(presented, 0);
});
