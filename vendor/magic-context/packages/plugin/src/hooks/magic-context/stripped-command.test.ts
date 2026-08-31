/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { matchStrippedMagicContextCommand } from "./stripped-command";

const textPrompt = (text: string) => [{ type: "text", text }];

describe("matchStrippedMagicContextCommand", () => {
    it("matches a bare registered command after trimming", () => {
        expect(matchStrippedMagicContextCommand(textPrompt("  ctx-status\t"))).toEqual({
            command: "ctx-status",
            arguments: "",
        });
    });

    it("matches accepted arguments and preserves the native handler input", () => {
        expect(matchStrippedMagicContextCommand(textPrompt("ctx-wrapup 2"))).toEqual({
            command: "ctx-wrapup",
            arguments: "2",
        });
        expect(matchStrippedMagicContextCommand(textPrompt("ctx-dream classify-memories"))).toEqual(
            {
                command: "ctx-dream",
                arguments: "classify-memories",
            },
        );
    });

    it("does not match unsupported trailing prose", () => {
        expect(
            matchStrippedMagicContextCommand(textPrompt("ctx-status extra prose sentence")),
        ).toBeNull();
    });

    it("does not match prose containing a command name", () => {
        expect(
            matchStrippedMagicContextCommand(
                textPrompt("Please explain what ctx-status reports before continuing."),
            ),
        ).toBeNull();
    });

    it("rejects multiline, partial, case-changed, and slash-prefixed forms", () => {
        for (const text of [
            "ctx-status\ncontinue",
            "ctx-status-extra",
            "CTX-STATUS",
            "/ctx-status",
        ]) {
            expect(matchStrippedMagicContextCommand(textPrompt(text))).toBeNull();
        }
    });

    it("rejects attachments and model-invisible notification parts", () => {
        expect(
            matchStrippedMagicContextCommand([
                { type: "text", text: "ctx-status" },
                { type: "file" },
            ]),
        ).toBeNull();
        expect(
            matchStrippedMagicContextCommand([{ type: "text", text: "ctx-status", ignored: true }]),
        ).toBeNull();
        expect(
            matchStrippedMagicContextCommand([
                { type: "text", text: "ctx-status", synthetic: true },
            ]),
        ).toBeNull();
    });
});
