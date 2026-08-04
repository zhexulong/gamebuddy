import { describe, expect, test } from "bun:test";
import {
    CATEGORY_PRIORITY,
    getMemoryCategoryOrder,
    MEMORY_CATEGORY_ORDER_PRIORITY,
    MEMORY_CATEGORY_ORDER_SQL,
    MEMORY_CATEGORY_ORDER_UNKNOWN,
} from "./constants";

describe("memory constants", () => {
    test("uses one canonical category fallback for TypeScript and SQL ordering", () => {
        for (const [index, category] of CATEGORY_PRIORITY.entries()) {
            expect(MEMORY_CATEGORY_ORDER_PRIORITY[category]).toBe(index);
            expect(getMemoryCategoryOrder(category)).toBe(index);
            expect(MEMORY_CATEGORY_ORDER_SQL).toContain(`WHEN '${category}' THEN ${index}`);
        }
        expect(getMemoryCategoryOrder("UNKNOWN_CATEGORY")).toBe(MEMORY_CATEGORY_ORDER_UNKNOWN);
        expect(MEMORY_CATEGORY_ORDER_SQL).toContain(`ELSE ${MEMORY_CATEGORY_ORDER_UNKNOWN}`);
    });
});
