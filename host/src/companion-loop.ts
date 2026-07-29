import { type AgentSession } from "@earendil-works/pi-coding-agent";
import { CompanionEventPump } from "./event-pump.js";

/**
 * Thin Host orchestration: a labelled batch becomes one ordinary Pi turn.
 * It intentionally has no goals, planner state, or game-success inference.
 */
export class CompanionLoop {
  readonly #pump = new CompanionEventPump();
  public constructor(private readonly session: Pick<AgentSession, "sendUserMessage">) {}
  public get pump(): CompanionEventPump { return this.#pump; }

  public async flush(): Promise<void> {
    await this.#pump.flush({
      deliver: async (batch) => {
        // Pi owns the actual tool loop; the Host only supplies source-labelled facts.
        await this.session.sendUserMessage(batch, { deliverAs: "followUp" });
      },
    });
  }
}
