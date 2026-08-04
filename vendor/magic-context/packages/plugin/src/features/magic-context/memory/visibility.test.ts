import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FOREIGN_VISIBLE_SQL } from "./visibility";

test("module and TypeScript foreign visibility predicates stay byte-identical", () => {
    const source = readFileSync(
        join(import.meta.dir, "../../../../../../crates/mc-store/src/lib.rs"),
        "utf8",
    );
    const match = source.match(/pub const FOREIGN_VISIBLE_SQL: &str = "([^"]+)";/);
    expect(match?.[1]).toBe(FOREIGN_VISIBLE_SQL);
});
