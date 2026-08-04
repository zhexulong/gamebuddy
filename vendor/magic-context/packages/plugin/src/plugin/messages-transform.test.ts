/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    createFailClosedController,
    FAIL_CLOSED_DOCTOR_COMMAND,
    isFailClosedBlockingError,
} from "../features/magic-context/fail-closed-block";
import { createMessagesTransformHandler } from "./messages-transform";

// Minimal fake message shape — just needs info + parts.
function makeOutput(overrides?: { agent?: string; sessionID?: string }): any {
    return {
        messages: [
            {
                info: {
                    id: "m1",
                    role: "user",
                    sessionID: overrides?.sessionID ?? "ses_test",
                    ...(overrides?.agent ? { agent: overrides.agent } : {}),
                },
                parts: [{ type: "text", text: "hello" }],
            },
        ],
    };
}

describe("createMessagesTransformHandler — error boundary (issue #23)", () => {
    it("swallows SQLITE_BUSY from inner transform so prompt loop proceeds", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    const err = new Error("database is locked") as Error & {
                        code: string;
                        errno: number;
                    };
                    err.code = "SQLITE_BUSY";
                    err.errno = 5;
                    throw err;
                },
            },
        });

        const output = makeOutput();
        // Should NOT throw — wrapper catches all errors.
        await expect(handler({}, output)).resolves.toBeDefined();

        // Messages are left untouched when transform fails.
        expect(output.messages).toHaveLength(1);
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("swallows unexpected non-SQLITE errors too", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    throw new TypeError("unexpected undefined access");
                },
            },
        });

        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeDefined();
    });

    it("passes through non-error transforms normally", async () => {
        let called = false;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async (_input, out) => {
                    called = true;
                    (out.messages as any).push({
                        info: { id: "injected", role: "user", sessionID: "ses_test" },
                        parts: [{ type: "text", text: "injected" }],
                    });
                },
            },
        });

        const output = makeOutput();
        await handler({}, output);
        expect(called).toBe(true);
        expect(output.messages).toHaveLength(2);
    });

    it("no-ops when magicContext is null (disabled plugin path)", async () => {
        const handler = createMessagesTransformHandler({ magicContext: null });
        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeDefined();
        expect(output.messages).toHaveLength(1);
    });
});

describe("createMessagesTransformHandler — fail-closed blocking (note #906)", () => {
    it("throws fence mismatch with both versions + recovery command on primary sessions", async () => {
        const failClosed = createFailClosedController();
        failClosed.arm({
            kind: "schema_fence",
            persistedVersion: 65,
            supportedVersion: 64,
        });
        let innerCalled = false;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    innerCalled = true;
                },
            },
            failClosed,
            failClosedBlockingEnabled: true,
        });

        let thrown: unknown;
        try {
            await handler({}, makeOutput());
        } catch (error) {
            thrown = error;
        }
        expect(isFailClosedBlockingError(thrown)).toBe(true);
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        expect(message).toContain("v65");
        expect(message).toContain("v64");
        expect(message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
        expect(innerCalled).toBe(false);
    });

    it("bypasses magic-context child sessions and OpenCode title/summary agents", async () => {
        const failClosed = createFailClosedController();
        failClosed.arm({
            kind: "schema_fence",
            persistedVersion: 65,
            supportedVersion: 64,
        });
        const internalChildSessions = new Set<string>(["ses_mc_child"]);
        let calls = 0;
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    calls += 1;
                },
            },
            failClosed,
            failClosedBlockingEnabled: true,
            internalChildSessions,
        });

        await expect(handler({}, makeOutput({ sessionID: "ses_mc_child" }))).resolves.toBeDefined();
        await expect(handler({}, makeOutput({ agent: "title" }))).resolves.toBeDefined();
        await expect(handler({}, makeOutput({ agent: "summary" }))).resolves.toBeDefined();
        expect(calls).toBe(3);
    });

    it("still passes SQLITE_BUSY through unmodified while fail-closed is unarmed", async () => {
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": async () => {
                    const err = new Error("database is locked") as Error & { code: string };
                    err.code = "SQLITE_BUSY";
                    throw err;
                },
            },
            failClosed: createFailClosedController(),
            failClosedBlockingEnabled: true,
        });
        const output = makeOutput();
        await expect(handler({}, output)).resolves.toBeDefined();
        expect(output.messages[0].info.id).toBe("m1");
    });

    it("re-probe heals and resumes the inner transform without restart", async () => {
        const failClosed = createFailClosedController({ reprobeEveryN: 1 });
        failClosed.arm({ kind: "storage_failure", cause: "migration lock" });
        let openAttempts = 0;
        let innerCalls = 0;
        const handler = createMessagesTransformHandler({
            magicContext: null,
            getMagicContext: () =>
                openAttempts >= 1
                    ? {
                          "experimental.chat.messages.transform": async () => {
                              innerCalls += 1;
                          },
                      }
                    : null,
            failClosed,
            failClosedBlockingEnabled: true,
            tryReopenStorage: async () => {
                openAttempts += 1;
                return openAttempts >= 1;
            },
        });

        await expect(handler({}, makeOutput())).resolves.toBeDefined();
        expect(openAttempts).toBe(1);
        expect(innerCalls).toBe(1);
        expect(failClosed.isArmed()).toBe(false);
    });

    it("fail_closed_blocking=false restores degrade-silently pass-through", async () => {
        const failClosed = createFailClosedController();
        failClosed.arm({
            kind: "schema_fence",
            persistedVersion: 65,
            supportedVersion: 64,
        });
        const handler = createMessagesTransformHandler({
            magicContext: null,
            failClosed,
            failClosedBlockingEnabled: false,
        });
        await expect(handler({}, makeOutput())).resolves.toBeDefined();
    });
});
