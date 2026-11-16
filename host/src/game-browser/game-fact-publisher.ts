import type { GameFactPatchV1 } from "../game-browser-contract/index.js";
import type { GameEventStream } from "./game-event-stream.js";

/** One fact that can change without a player acting, named the way the contract names it. */
export type GameFact = GameFactPatchV1["fact"];

export type GameFactPublisher = Readonly<{
  /**
   * Announces that a fact moved. It is synchronous and never throws: it is called from inside the lifecycle
   * coordinator's own assignments, which have already decided their outcome.
   */
  publish(fact: GameFact): void;
  /** Stops publishing. A frame already being read is dropped rather than written to a closed stream. */
  close(): void;
}>;

/**
 * Turns the coordinator's transitions into frames, one authoritative read per transition.
 *
 * The read is asynchronous (the projection reads the role lifecycle and the bound world through their own
 * contracts), so two transitions can be in flight at once. Two rules keep the stream coherent:
 *
 * - ONE read at a time, in the order the transitions arrived. Frames carry full fact groups, so an out-of-order
 *   frame would move the browser's projection backwards.
 * - A fact already waiting is not queued twice. A burst of assignments to the same fact (a teardown clearing the
 *   attachment and the generation together, for instance) is one frame carrying the state after all of them, which
 *   is also the only state a reader could observe.
 *
 * A read that fails publishes nothing. That is not a lost change the browser has to be told about: `/game` is the
 * authority and the very next confirmation read - the one every Game command already makes - answers the same fact.
 */
export function createGameFactPublisher(
  stream: GameEventStream,
  readFact: (fact: GameFact) => Promise<GameFactPatchV1>,
): GameFactPublisher {
  const queued: GameFact[] = [];
  let draining = false;
  let closed = false;

  const drain = async (): Promise<void> => {
    try {
      while (!closed && queued.length > 0) {
        const fact = queued.shift()!;
        let patch: GameFactPatchV1;
        try {
          patch = await readFact(fact);
        } catch {
          continue;
        }
        if (closed) return;
        try {
          stream.publish(patch);
        } catch {
          // The stream refused the frame (it validates every frame). Nothing is published, and the snapshot still
          // answers this fact; a push channel is not where a projection defect may take down a command.
        }
      }
    } finally {
      draining = false;
    }
  };

  return Object.freeze({
    publish(fact) {
      if (closed || queued.includes(fact)) return;
      queued.push(fact);
      if (draining) return;
      draining = true;
      void drain();
    },
    close() {
      closed = true;
      queued.length = 0;
    },
  });
}
