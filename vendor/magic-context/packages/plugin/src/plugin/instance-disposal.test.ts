import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { isDisposedInstanceDirectory } from "./instance-disposal";

describe("isDisposedInstanceDirectory", () => {
    test("matches the concrete instance directory, not a shared project identity", () => {
        expect(isDisposedInstanceDirectory("/repo/project", "/repo/project")).toBe(true);
        expect(isDisposedInstanceDirectory("/repo/project", join("/repo/project", "."))).toBe(true);
        expect(isDisposedInstanceDirectory("/repo/project", "/repo/project-copy")).toBe(false);
    });
});
