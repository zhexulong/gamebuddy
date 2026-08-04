/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { LATEST_MIGRATION_VERSION } from "./migrations";
import { LATEST_SUPPORTED_VERSION } from "./storage-db";

// Guards the #1 bug class the project already hit during v2 work: adding a
// migration but forgetting to bump LATEST_SUPPORTED_VERSION (the schema-fence
// ceiling). A stale ceiling makes the DB refuse to open after the new migration
// applies, silently disabling Magic Context. Keep the fence and the migration
// list in lockstep.
describe("schema version fence", () => {
    it("LATEST_SUPPORTED_VERSION equals the highest migration version", () => {
        expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
    });
});
