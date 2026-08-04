/**
 * Process-global registry of AbortControllers to abort on process exit, backed
 * by a SINGLE `process.once("exit")` listener no matter how many controllers
 * register.
 *
 * Why this exists: the plugin factory runs once per plugin instance, and
 * OpenCode Desktop loads many instances in one Node process (one per open
 * project). Registering a `process.once("exit")` per instance added one listener
 * each, so past Node's default 10-listener cap it logged a
 * `MaxListenersExceededWarning` ("11 exit listeners added to [process]"). One
 * module-global listener that fans out to every registered controller keeps the
 * count at one.
 */

const controllers = new Set<AbortController>();
let listenerRegistered = false;

function abortAll(): void {
    for (const controller of controllers) {
        try {
            controller.abort();
        } catch {
            // best-effort: the process is exiting anyway
        }
    }
}

/**
 * Abort `controller` when the process exits. The underlying `process.once("exit")`
 * listener is installed on the first call only; subsequent calls just add to the
 * fan-out set.
 */
export function registerExitAbort(controller: AbortController): void {
    controllers.add(controller);
    if (listenerRegistered) return;
    listenerRegistered = true;
    process.once("exit", abortAll);
}

/**
 * Stop tracking `controller` (e.g. when its plugin instance is disposed) so the
 * set doesn't grow without bound as Desktop opens and closes projects.
 */
export function unregisterExitAbort(controller: AbortController): void {
    controllers.delete(controller);
}
