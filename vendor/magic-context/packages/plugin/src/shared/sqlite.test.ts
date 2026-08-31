import { describe, expect, it } from "bun:test";
import { loadSqliteModule, SqliteRuntimeUnavailableError } from "./sqlite";

describe("SQLite runtime selector", () => {
    it("wraps a missing node:sqlite module with the detected runtime and cause", async () => {
        const cause = Object.assign(new Error("No such built-in module: node:sqlite"), {
            code: "ERR_UNKNOWN_BUILTIN_MODULE",
            name: "ResolveMessage",
        });
        let requestedSpecifier = "";
        let thrown: unknown;

        try {
            await loadSqliteModule("Node.js", async (specifier) => {
                requestedSpecifier = specifier;
                throw cause;
            });
        } catch (error) {
            thrown = error;
        }

        expect(requestedSpecifier).toBe("node:sqlite");
        expect(thrown).toBeInstanceOf(SqliteRuntimeUnavailableError);
        const compatibilityError = thrown as SqliteRuntimeUnavailableError;
        expect(compatibilityError.runtime).toBe("Node.js");
        expect(compatibilityError.specifier).toBe("node:sqlite");
        expect(compatibilityError.message).toContain("Node.js >= 24");
        expect(compatibilityError.message).toContain("Bun with bun:sqlite");
        expect(compatibilityError.message).toContain("node:sqlite");
        expect(compatibilityError.cause).toBe(cause);
    });
});
