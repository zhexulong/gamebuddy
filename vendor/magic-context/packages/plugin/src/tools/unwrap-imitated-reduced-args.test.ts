import { describe, expect, test } from "bun:test";
import { type ImitatedArgsSchema, unwrapImitatedReducedArgs } from "./unwrap-imitated-reduced-args";

const cases: Array<{
    name: string;
    primary: string[];
    schema: ImitatedArgsSchema;
    valid: Record<string, unknown>;
    wrong: Record<string, unknown>;
}> = [
    {
        name: "memory",
        primary: ["action"],
        schema: {
            action: { type: "enum", values: ["write", "get"] },
            content: "string",
            ids: { type: "array", items: "number", maxItems: 100 },
        },
        valid: { action: "write", content: "fact" },
        wrong: { action: 7 },
    },
    {
        name: "note",
        primary: ["action", "content"],
        schema: {
            action: { type: "enum", values: ["write", "read"] },
            content: "string",
        },
        valid: { content: "follow up" },
        wrong: { content: {} },
    },
    {
        name: "reduce",
        primary: ["drop"],
        schema: { drop: "string" },
        valid: { drop: "1-3" },
        wrong: { drop: [1] },
    },
    {
        name: "search",
        primary: ["query"],
        schema: { query: "string", limit: "number" },
        valid: { query: "needle", limit: 3 },
        wrong: { query: {} },
    },
    {
        name: "expand",
        primary: ["message", "start"],
        schema: { message: "number", start: "number", end: "number" },
        valid: { start: 1, end: 2 },
        wrong: { start: "one", end: 2 },
    },
];

describe("imitated reduced argument revalidation", () => {
    for (const arm of cases) {
        test(`${arm.name} accepts only schema-valid decoded fields`, () => {
            const validOuter = { reduced: true, summary: JSON.stringify(arm.valid) };
            expect(unwrapImitatedReducedArgs(validOuter, arm.primary, arm.schema)).toEqual(
                arm.valid,
            );

            for (const invalid of [
                arm.wrong,
                { ...arm.valid, unknown: true },
                { ...arm.valid, ids: Array.from({ length: 101 }, (_, index) => index) },
                { ...arm.valid, content: "x".repeat(1024 * 1024 + 1) },
            ]) {
                const outer = { reduced: true, summary: JSON.stringify(invalid) };
                expect(() =>
                    unwrapImitatedReducedArgs(outer, arm.primary, arm.schema),
                ).not.toThrow();
                expect(unwrapImitatedReducedArgs(outer, arm.primary, arm.schema)).toBe(outer);
            }
        });

        test(`${arm.name} keeps explicit valid primary fields`, () => {
            const primary = arm.primary[0] ?? "action";
            const outer = {
                [primary]: arm.valid[primary] ?? "explicit",
                reduced: true,
                summary: JSON.stringify(arm.wrong),
            };
            expect(unwrapImitatedReducedArgs(outer, arm.primary, arm.schema)).toBe(outer);
        });
    }
});
