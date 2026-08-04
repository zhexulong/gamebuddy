import { describe, expect, test } from "bun:test";
import { createEventHandler } from "./event";

/**
 * createEventHandler routes the OpenCode `event` hook to the auto-update checker,
 * the magic-context event handler, and (new) an orderly per-instance cleanup on
 * `server.instance.disposed`. These tests pin the dispose wiring:
 *   1. cleanup fires only on server.instance.disposed, with the disposed directory
 *   2. cleanup does NOT fire on unrelated events
 *   3. a throwing cleanup is swallowed (never propagates into the event loop)
 *   4. magic-context + auto-update handlers still run for every event
 */
describe("createEventHandler — instance dispose cleanup", () => {
    test("fires onInstanceDisposed with the directory on server.instance.disposed", async () => {
        const calls: string[] = [];
        const handler = createEventHandler({
            magicContext: null,
            onInstanceDisposed: (dir) => {
                calls.push(dir);
            },
        });

        await handler({
            event: {
                type: "server.instance.disposed",
                properties: { directory: "/proj/a" },
            } as any,
        });

        expect(calls).toEqual(["/proj/a"]);
    });

    test("does not fire onInstanceDisposed for unrelated events", async () => {
        let fired = false;
        const handler = createEventHandler({
            magicContext: null,
            onInstanceDisposed: () => {
                fired = true;
            },
        });

        await handler({ event: { type: "message.updated", properties: {} } as any });
        await handler({ event: { type: "session.deleted", properties: {} } as any });

        expect(fired).toBe(false);
    });

    test("swallows a throwing cleanup without rejecting", async () => {
        const handler = createEventHandler({
            magicContext: null,
            onInstanceDisposed: () => {
                throw new Error("cleanup boom");
            },
        });

        // Must resolve, not reject.
        await expect(
            handler({
                event: {
                    type: "server.instance.disposed",
                    properties: { directory: "/proj/b" },
                } as any,
            }),
        ).resolves.toBeUndefined();
    });

    test("still runs auto-update + magic-context handlers for every event", async () => {
        const seen: string[] = [];
        const handler = createEventHandler({
            magicContext: {
                event: async (input) => {
                    seen.push(`mc:${input.event.type}`);
                },
            },
            autoUpdateChecker: async (input) => {
                seen.push(`au:${input.event.type}`);
            },
        });

        await handler({ event: { type: "message.updated", properties: {} } as any });

        expect(seen).toEqual(["au:message.updated", "mc:message.updated"]);
    });
});
