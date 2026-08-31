import { describe, expect, it } from "bun:test";
import {
  assertConfigSaveAllowed,
  CONFIG_SAVE_REFUSAL_MESSAGE,
  configSaveBlocker,
} from "./config-save-guard";

describe("dashboard structured config save guard", () => {
  it("#given no existing config #when creating a fresh file #then saving is allowed", () => {
    expect(
      configSaveBlocker({ exists: false, readError: "missing", parseError: "bad" }),
    ).toBeNull();
    expect(() => assertConfigSaveAllowed({ exists: false, readError: "missing" })).not.toThrow();
  });

  it("#given an existing config read error #when structured save is requested #then it is refused", () => {
    const message = configSaveBlocker({ exists: true, readError: "permission denied" });

    expect(message).toContain(CONFIG_SAVE_REFUSAL_MESSAGE);
    expect(message).toContain("permission denied");
    expect(() => assertConfigSaveAllowed({ exists: true, readError: "permission denied" })).toThrow(
      CONFIG_SAVE_REFUSAL_MESSAGE,
    );
  });

  it("#given an existing config parse error #when structured save is requested #then it is refused", () => {
    const message = configSaveBlocker({ exists: true, parseError: "unexpected end of JSON" });

    expect(message).toContain(CONFIG_SAVE_REFUSAL_MESSAGE);
    expect(message).toContain("unexpected end of JSON");
  });

  it("#given an existing config without read or parse errors #when structured save is requested #then saving is allowed", () => {
    expect(configSaveBlocker({ exists: true })).toBeNull();
  });
});
