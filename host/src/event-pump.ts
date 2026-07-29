/** Product-neutral Host event pump. It forwards labelled facts; it never plans or interprets receipts. */
export type WorldFact = Readonly<{ source: "stardew_mod"; kind: "snapshot" | "execution_receipt" | "lifecycle"; correlationId: string; revision: number; payload: Readonly<Record<string, unknown>> }>;
export type PlayerInput = Readonly<{ source: "player_text" | "voice_final"; inputId: string; text: string; locale: string; timestampMs: number }>;
export interface CompanionTurnSink { deliver(text: string): Promise<void>; }

export class CompanionEventPump {
  #snapshot: WorldFact | undefined;
  readonly #receipts = new Map<string, WorldFact>();
  readonly #lifecycle = new Map<string, WorldFact>();
  readonly #inputs: PlayerInput[] = [];
  #delivering = false;

  public enqueueFact(fact: WorldFact): void {
    if (fact.source !== "stardew_mod") throw new Error("untrusted_world_fact_source");
    const frozen = Object.freeze({ ...fact });
    if (fact.kind === "snapshot") { if (this.#snapshot === undefined || fact.revision >= this.#snapshot.revision) this.#snapshot = frozen; return; }
    const destination = fact.kind === "execution_receipt" ? this.#receipts : this.#lifecycle;
    const previous = destination.get(fact.correlationId);
    if (previous === undefined || fact.revision >= previous.revision) destination.set(fact.correlationId, frozen);
  }
  public enqueuePlayerInput(input: PlayerInput): void {
    if (input.text.length === 0) throw new Error(input.source === "voice_final" ? "empty_final_voice_input" : "empty_player_input");
    this.#inputs.push(Object.freeze({ ...input }));
  }
  public get pendingCount(): number { return (this.#snapshot === undefined ? 0 : 1) + this.#receipts.size + this.#lifecycle.size + this.#inputs.length; }
  public async flush(sink: CompanionTurnSink): Promise<void> {
    if (this.#delivering || this.pendingCount === 0) return;
    this.#delivering = true;
    const inputs = this.#inputs.splice(0);
    const snapshot = this.#snapshot; this.#snapshot = undefined;
    const receipts = [...this.#receipts.values()]; this.#receipts.clear();
    const lifecycle = [...this.#lifecycle.values()]; this.#lifecycle.clear();
    const facts = [...(snapshot === undefined ? [] : [snapshot]), ...receipts, ...lifecycle].sort((a, b) => a.kind.localeCompare(b.kind) || a.correlationId.localeCompare(b.correlationId));
    try { await sink.deliver(JSON.stringify({ kind: "gamebuddy_fact_batch", playerInputs: inputs, worldFacts: facts })); }
    catch (error) { if (snapshot !== undefined) this.enqueueFact(snapshot); for (const fact of receipts) this.enqueueFact(fact); for (const fact of lifecycle) this.enqueueFact(fact); this.#inputs.unshift(...inputs); throw error; }
    finally { this.#delivering = false; }
  }
}
