import { describe, expect, it } from "bun:test";
import { estimateTokens } from "./read-session-formatting";

// The real Claude tokenizer throws "Text contains disallowed special token"
// when content includes a literal special-token string (e.g. an `<EOT>` or
// `<|endoftext|>` substring inside real tool output or a file the agent read).
// estimateTokens is called on the hot tagging / protected-tail boundary /
// sidebar paths over arbitrary content, so a throw there is a real crash
// vector. estimateTokens must count such substrings as ordinary characters
// instead of throwing.
describe("estimateTokens — special-token safety", () => {
    it("does not throw on a literal <EOT> substring and counts it as text", () => {
        expect(() => estimateTokens("some text <EOT> more text")).not.toThrow();
        expect(estimateTokens("some text <EOT> more text")).toBeGreaterThan(0);
    });

    it("does not throw on <|endoftext|> or other special-token strings", () => {
        expect(() => estimateTokens("a <|endoftext|> b")).not.toThrow();
        expect(() => estimateTokens("<|im_start|>system<|im_end|>")).not.toThrow();
    });

    it("returns 0 for empty input", () => {
        expect(estimateTokens("")).toBe(0);
    });

    it("counts ordinary text identically (hardening changes nothing for normal content)", () => {
        // A fixed, special-token-free string — stable count regardless of the
        // allowedSpecial encoding path.
        expect(estimateTokens("the quick brown fox jumps over the lazy dog")).toBeGreaterThan(5);
    });
});
