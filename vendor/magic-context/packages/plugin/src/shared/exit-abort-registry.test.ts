import { describe, expect, it } from "bun:test";
import { registerExitAbort, unregisterExitAbort } from "./exit-abort-registry";

// Captured before any registration so we can isolate the ONE listener the
// registry installs process-wide (it intentionally never removes it, mirroring
// production, so the suite must not strip it either).
const baseline = process.listenerCount("exit");

/** The registry's single 'exit' listener (the first one added past baseline). */
function registryListener(): () => void {
    return process.listeners("exit").slice(baseline)[0] as () => void;
}

describe("exit-abort-registry", () => {
    it("adds exactly ONE process exit listener no matter how many controllers register", () => {
        registerExitAbort(new AbortController());
        registerExitAbort(new AbortController());
        registerExitAbort(new AbortController());
        expect(process.listenerCount("exit") - baseline).toBe(1);
    });

    it("aborts every registered controller when the exit listener fires", () => {
        const a = new AbortController();
        const b = new AbortController();
        registerExitAbort(a);
        registerExitAbort(b);

        // Invoke the registry's listener directly (emitting 'exit' would end the
        // test process).
        registryListener()();

        expect(a.signal.aborted).toBe(true);
        expect(b.signal.aborted).toBe(true);
        // Still exactly one listener after firing.
        expect(process.listenerCount("exit") - baseline).toBe(1);
    });

    it("does not abort a controller that was unregistered before exit", () => {
        const keep = new AbortController();
        const drop = new AbortController();
        registerExitAbort(keep);
        registerExitAbort(drop);
        unregisterExitAbort(drop);

        registryListener()();

        expect(keep.signal.aborted).toBe(true);
        expect(drop.signal.aborted).toBe(false);
    });
});
