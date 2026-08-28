const schema = "gamebuddy-production-generation-recheck/v1";
const resultKind = "recheck_current_generation_result";
const timeoutMs = 5_000;
let nextRequestId = 0;

/** Requests a redacted recheck from the exact production wrapper parent.
 * The request id only correlates a reply; wrapper ownership of its directly
 * spawned child is the authority for a verified verdict. */
export async function recheckPinnedProductionGeneration(phase: "pre" | "post"): Promise<void> {
  if (typeof process.send !== "function" || process.connected !== true) throw unavailable();
  const requestId = `stardew-${(++nextRequestId).toString(36)}`;
  await new Promise<void>((resolveCheck, rejectCheck) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("message", onMessage);
      process.removeListener("disconnect", onDisconnect);
      error === undefined ? resolveCheck() : rejectCheck(error);
    };
    const onDisconnect = () => finish(unavailable());
    const onMessage = (message: unknown) => {
      if (!isResult(message, requestId, phase)) return;
      finish(message.verdict === "verified" ? undefined : unavailable());
    };
    const timer = setTimeout(() => finish(unavailable()), timeoutMs);
    timer.unref();
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    try {
      process.send?.(Object.freeze({
        schema,
        kind: "recheck_current_generation",
        requestId,
        phase,
      }), undefined, undefined, (error: Error | null) => {
        if (error !== null) finish(unavailable());
      });
    } catch { finish(unavailable()); }
  });
}

function isResult(value: unknown, requestId: string, phase: "pre" | "post"): value is Readonly<{ verdict: "verified" | "rejected" }> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 5
    && ["schema", "kind", "requestId", "phase", "verdict"].every((key) => Object.hasOwn(message, key))
    && message.schema === schema && message.kind === resultKind && message.requestId === requestId
    && message.phase === phase && (message.verdict === "verified" || message.verdict === "rejected");
}
function unavailable(): Error { return new Error("stardew_private_launch_admission_failed"); }
