/**
 * The frames the Game surface's own channel carries.
 *
 * The Host encodes a cursor as base64url of `[epoch, sequence]` (`host/src/game-browser/game-event-stream.ts`). The
 * journeys need to mint one the same way rather than import a Host module: this file IS the browser's copy, and a
 * cursor it invents must be indistinguishable from a real one or the journey proves nothing about the real route.
 */
import type { GameFactPatchV1, GameEventV1 } from "../src/composed-reference-game-browser-api";

export function gameStreamCursor(epoch: string, sequence: number): string {
  return Buffer.from(JSON.stringify([epoch, sequence]), "utf8").toString("base64url");
}

export function composeGameEvent(input: Readonly<{
  epoch: string;
  sequence: number;
  fact: GameFactPatchV1["fact"];
  connectionStatus?: "connected_idle" | "reconnecting" | "failed" | "disconnected";
  selectedWorld?: string | null;
}>): GameEventV1 {
  return {
    apiVersion: 1,
    epoch: input.epoch,
    sequence: input.sequence,
    eventType: "game.fact_changed",
    payload: patchFor(input),
  };
}

function patchFor(input: Parameters<typeof composeGameEvent>[0]): GameFactPatchV1 {
  switch (input.fact) {
    case "attachment":
      // Only the connection word matters to the waits: the generation and the catalog count stay the ones the
      // snapshot published, so a frame can never be read as a different attachment than the one it belongs to.
      return {
        fact: "attachment",
        game: {
          attachment: { status: "attached", generation: 1 },
          connectionStatus: input.connectionStatus ?? "connected_idle",
          capabilitySummary: { available: false, count: 0 },
        },
      };
    case "instance":
      return {
        fact: "instance",
        game: {
          instance: { status: "stopped", gameTitle: "Stardew Valley", generation: 0, playerHostExitCode: 0 },
          compatibility: { status: "unchecked", message: null },
          latestOutcome: "none",
        },
      };
    case "selectedWorld":
      return { fact: "selectedWorld", game: { selectedWorld: input.selectedWorld ?? "Farm_1" } };
  }
}
