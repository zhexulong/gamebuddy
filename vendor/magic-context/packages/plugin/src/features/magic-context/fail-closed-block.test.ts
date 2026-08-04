/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";

import {
    createFailClosedBlockingError,
    createFailClosedController,
    FAIL_CLOSED_DOCTOR_COMMAND,
    type FailClosedReason,
    formatFailClosedBlockingMessage,
    isFailClosedBlockingError,
    resolveAgentNameFromMessages,
    shouldBypassFailClosedBlock,
} from "./fail-closed-block";

const fenceReason: FailClosedReason = {
    kind: "schema_fence",
    persistedVersion: 65,
    supportedVersion: 64,
};

const storageReason: FailClosedReason = {
    kind: "storage_failure",
    cause: "disk full",
};

describe("formatFailClosedBlockingMessage", () => {
    it("includes both schema versions and the doctor recovery command", () => {
        const message = formatFailClosedBlockingMessage(fenceReason);
        expect(message).toContain("v65");
        expect(message).toContain("v64");
        expect(message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
    });

    it("includes the storage cause and recovery command", () => {
        const message = formatFailClosedBlockingMessage(storageReason);
        expect(message).toContain("disk full");
        expect(message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
    });
});

describe("shouldBypassFailClosedBlock", () => {
    it("bypasses OpenCode internal agents and Magic Context hidden children", () => {
        expect(shouldBypassFailClosedBlock({ agent: "title" })).toBe(true);
        expect(shouldBypassFailClosedBlock({ agent: "summary" })).toBe(true);
        expect(shouldBypassFailClosedBlock({ agent: "compaction" })).toBe(true);
        expect(shouldBypassFailClosedBlock({ agent: "historian" })).toBe(true);
        expect(shouldBypassFailClosedBlock({ agent: "dreamer-docs" })).toBe(true);
        expect(shouldBypassFailClosedBlock({ agent: "sidekick" })).toBe(true);
        expect(shouldBypassFailClosedBlock({ isInternalChildSession: true })).toBe(true);
        expect(shouldBypassFailClosedBlock({ isPiSubagentEnv: true })).toBe(true);
    });

    it("does not bypass primary build agents", () => {
        expect(shouldBypassFailClosedBlock({ agent: "build" })).toBe(false);
        expect(shouldBypassFailClosedBlock({})).toBe(false);
    });
});

describe("createFailClosedController", () => {
    it("throws FailClosedBlockingError with both versions when armed", async () => {
        const gate = createFailClosedController({ reprobeEveryN: 5 });
        gate.arm(fenceReason);
        let thrown: unknown;
        try {
            await gate.enforce({ blockingEnabled: true, exempt: false });
        } catch (error) {
            thrown = error;
        }
        expect(isFailClosedBlockingError(thrown)).toBe(true);
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        expect(message).toContain("v65");
        expect(message).toContain("v64");
        expect(message).toContain(FAIL_CLOSED_DOCTOR_COMMAND);
    });

    it("no-ops when blocking is disabled (degrade-silently escape hatch)", async () => {
        const gate = createFailClosedController();
        gate.arm(fenceReason);
        await expect(
            gate.enforce({ blockingEnabled: false, exempt: false }),
        ).resolves.toBeUndefined();
    });

    it("no-ops for exempt child sessions", async () => {
        const gate = createFailClosedController();
        gate.arm(fenceReason);
        await expect(
            gate.enforce({ blockingEnabled: true, exempt: true }),
        ).resolves.toBeUndefined();
    });

    it("re-probes and clears when storage heals without restart", async () => {
        const gate = createFailClosedController({ reprobeEveryN: 2 });
        gate.arm(storageReason);
        let opens = 0;
        const tryReopen = async () => {
            opens += 1;
            return opens >= 2;
        };

        await expect(
            gate.enforce({ blockingEnabled: true, exempt: false, tryReopen }),
        ).rejects.toBeInstanceOf(Error);
        expect(gate.isArmed()).toBe(true);

        // Second blocked pass hits reprobeEveryN=2 and heals.
        await expect(
            gate.enforce({ blockingEnabled: true, exempt: false, tryReopen }),
        ).resolves.toBeUndefined();
        expect(gate.isArmed()).toBe(false);
        expect(opens).toBe(2);

        // Subsequent passes stay unblocked without another reopen.
        await expect(
            gate.enforce({ blockingEnabled: true, exempt: false, tryReopen }),
        ).resolves.toBeUndefined();
        expect(opens).toBe(2);
    });
});

describe("resolveAgentNameFromMessages", () => {
    it("reads the newest message agent field", () => {
        expect(
            resolveAgentNameFromMessages([
                { info: { agent: "build" } },
                { info: { agent: "title" } },
            ]),
        ).toBe("title");
    });
});

describe("createFailClosedBlockingError", () => {
    it("sets a stable name and code for wrapper instanceof checks", () => {
        const error = createFailClosedBlockingError(fenceReason);
        expect(error.name).toBe("FailClosedBlockingError");
        expect(error.code).toBe("FAIL_CLOSED_BLOCKING");
        expect(isFailClosedBlockingError(error)).toBe(true);
    });
});
