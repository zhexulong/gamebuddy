import { WindowsNamedMutexBroker } from "../windows-named-mutex-broker.js";

const name = process.argv[2];
if (typeof name !== "string") {
  process.exitCode = 1;
} else {
  const broker = new WindowsNamedMutexBroker();
  void broker.acquire(name, { timeoutMs: 5_000 }).then(async (lease) => {
    if (lease.disposition !== "abandoned") throw new Error("expected_abandoned_lease");
    await lease.safetySealAfterAbandonedQuarantineFailure();
    process.send?.({ type: "sealed", name });
    process.once("message", (message: unknown) => {
      if (message === "exit") process.exit(0);
    });
  }).catch((error: unknown) => {
    process.send?.({ type: "failed", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
