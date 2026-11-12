/**
 * Regeneration's three projections: the accepted turn still running, the settled variant,
 * and the idle conversation both are read against. `turn-settling.spec.ts` and
 * `surface-chrome.spec.ts` drive the same three, so they are built in one place.
 */
import { chat, root } from "./composed-reference-game-fixtures";

export const regenerationPlayerHandle = `${"P".repeat(42)}A`;
export const regenerationCompanionHandle = `${"D".repeat(42)}A`;
export const regenerationTurnHandle = `${"T".repeat(42)}A`;
export const regenerationOldVariant = "The game projection is read-only.";
export const regenerationNewVariant = "The projection is a reading, not the valley itself.";

export function regenerationProjections(): {
  idleRoot: typeof root;
  runningRoot: typeof root;
  settledRoot: typeof root;
} {
  const idleOperations = [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ];
  const idleChat = {
    ...chat,
    operations: idleOperations,
    chat: {
      ...chat.chat,
      transcript: [
        { handle: regenerationPlayerHandle, role: "player", text: "Where are we?", locale: "und", order: 0, revision: 1 },
        { handle: regenerationCompanionHandle, role: "companion", text: regenerationOldVariant, locale: "und", order: 1, revision: 1 },
      ],
      turn: null,
    },
  };
  return {
    idleRoot: { ...root, chat: idleChat },
    // The accepted, still-running projection: the transcript is unchanged and
    // `chat.submit` is busy, exactly as the Host projects a live turn.
    runningRoot: {
      ...root,
      chat: {
        ...idleChat,
        operations: [{ ...idleOperations[0], availability: "busy" }],
        chat: {
          ...idleChat.chat,
          turn: { handle: regenerationTurnHandle, state: "running", projectionRevision: 1, canCancel: false },
        },
      },
    },
    // The terminal projection: the same companion message now carries the
    // regenerated variant, and the turn has settled.
    settledRoot: {
      ...root,
      chat: {
        ...idleChat,
        chat: {
          ...idleChat.chat,
          transcript: [
            idleChat.chat.transcript[0],
            { ...idleChat.chat.transcript[1], text: regenerationNewVariant },
          ],
          turn: { handle: regenerationTurnHandle, state: "completed", projectionRevision: 2, canCancel: false },
        },
      },
    },
  };
}
