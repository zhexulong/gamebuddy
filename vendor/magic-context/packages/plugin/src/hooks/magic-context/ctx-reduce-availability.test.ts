/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    clearCtxReduceAvailability,
    clearTodowriteAvailability,
    resolveCtxReduceAvailabilityFromMessages,
    resolveTodowriteAvailabilityFromMessages,
} from "./ctx-reduce-availability";

function userMsg(tools?: Record<string, unknown>) {
    return { info: { role: "user", ...(tools !== undefined ? { tools } : {}) } };
}

describe("ctx_reduce availability (spawn tools map)", () => {
    it("resolves false for an explicit allow-list without ctx_reduce", () => {
        clearCtxReduceAvailability("ses-allow");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-allow", [
            userMsg({ "*": false, read: true, grep: true }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("resolves true when ctx_reduce is explicitly allowed", () => {
        clearCtxReduceAvailability("ses-explicit");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-explicit", [
            userMsg({ "*": false, read: true, ctx_reduce: true }),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("fails open for sessions without a tools map (normal sessions)", () => {
        clearCtxReduceAvailability("ses-plain");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-plain", [userMsg()]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves false when ctx_reduce is explicitly denied", () => {
        clearCtxReduceAvailability("ses-deny");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-deny", [
            userMsg({ ctx_reduce: false }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("freezes the verdict per session — later, different tool maps cannot flap it", () => {
        clearCtxReduceAvailability("ses-frozen");
        const first = resolveCtxReduceAvailabilityFromMessages("ses-frozen", [
            userMsg({ "*": false, read: true }),
        ]);
        expect(first).toEqual({ callable: false, frozen: true });
        // Same session, contradictory map on a later pass: cached verdict wins
        // (per-turn maps can differ; a flapping verdict would bust the cache).
        const second = resolveCtxReduceAvailabilityFromMessages("ses-frozen", [
            userMsg({ "*": false, ctx_reduce: true }),
        ]);
        expect(second).toEqual({ callable: false, frozen: true });
    });

    it("ignores non-user messages and falls open when the first user message carries no signal", () => {
        clearCtxReduceAvailability("ses-nosignal");
        const verdict = resolveCtxReduceAvailabilityFromMessages("ses-nosignal", [
            { info: { role: "assistant" } },
            userMsg({}),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("does not freeze a fail-open verdict from an array with no user message", () => {
        clearCtxReduceAvailability("ses-no-user-yet");
        // A pass with no user message at all fails open provisionally...
        const provisional = resolveCtxReduceAvailabilityFromMessages("ses-no-user-yet", [
            { info: { role: "assistant" } },
        ]);
        expect(provisional).toEqual({ callable: true, frozen: false });
        // ...but must NOT lock the session: the real first user message (a
        // deny-list spawn) still decides the frozen verdict.
        const final = resolveCtxReduceAvailabilityFromMessages("ses-no-user-yet", [
            { info: { role: "assistant" } },
            userMsg({ "*": false, read: true }),
        ]);
        expect(final).toEqual({ callable: false, frozen: true });
    });
});

describe("todowrite availability (generalized resolver)", () => {
    it("resolves false for an explicit allow-list without todowrite", () => {
        clearTodowriteAvailability("ses-td-allow");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-allow", [
            userMsg({ "*": false, read: true, grep: true }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("resolves true when todowrite is explicitly allowed", () => {
        clearTodowriteAvailability("ses-td-explicit");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-explicit", [
            userMsg({ "*": false, read: true, todowrite: true }),
        ]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves false when todowrite is explicitly denied", () => {
        clearTodowriteAvailability("ses-td-deny");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-deny", [
            userMsg({ todowrite: false }),
        ]);
        expect(verdict).toEqual({ callable: false, frozen: true });
    });

    it("fails open for sessions without a tools map (normal sessions)", () => {
        clearTodowriteAvailability("ses-td-plain");
        const verdict = resolveTodowriteAvailabilityFromMessages("ses-td-plain", [userMsg()]);
        expect(verdict).toEqual({ callable: true, frozen: true });
    });

    it("resolves ctx_reduce and todowrite independently for the same session", () => {
        // A tools map can keep ctx_reduce but filter todowrite (or vice versa);
        // the two verdicts must not bleed into each other through the cache.
        clearCtxReduceAvailability("ses-td-mixed");
        clearTodowriteAvailability("ses-td-mixed");
        const map = userMsg({ "*": false, ctx_reduce: true });
        const reduce = resolveCtxReduceAvailabilityFromMessages("ses-td-mixed", [map]);
        const todo = resolveTodowriteAvailabilityFromMessages("ses-td-mixed", [map]);
        expect(reduce).toEqual({ callable: true, frozen: true });
        expect(todo).toEqual({ callable: false, frozen: true });
    });
});
