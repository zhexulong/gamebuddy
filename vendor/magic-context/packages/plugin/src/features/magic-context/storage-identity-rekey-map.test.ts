import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { initializeDatabase } from "./storage-db";
import {
    deleteIdentityRekeyMap,
    getIdentityRekeyMap,
    listIdentityRekeyMaps,
    upsertIdentityRekeyMap,
} from "./storage-identity-rekey-map";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

afterEach(() => {
    if (db) {
        closeQuietly(db);
        db = null;
    }
});

describe("storage-identity-rekey-map", () => {
    test("upserts, lists, and deletes v22 identity rekey mappings", () => {
        const database = makeDb();

        expect(upsertIdentityRekeyMap(database, "dir:old", "dir:new", 10)).toEqual({
            oldProjectPath: "dir:old",
            newProjectPath: "dir:new",
            rekeyedAt: 10,
        });
        expect(upsertIdentityRekeyMap(database, "dir:old", "git:root", 20)).toEqual({
            oldProjectPath: "dir:old",
            newProjectPath: "git:root",
            rekeyedAt: 20,
        });
        expect(listIdentityRekeyMaps(database)).toEqual([
            { oldProjectPath: "dir:old", newProjectPath: "git:root", rekeyedAt: 20 },
        ]);
        expect(deleteIdentityRekeyMap(database, "dir:old")).toBe(true);
        expect(getIdentityRekeyMap(database, "dir:old")).toBeNull();
    });
});
