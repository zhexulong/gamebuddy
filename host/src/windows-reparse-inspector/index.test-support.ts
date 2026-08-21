import { createInspectorCapability, type CustomInspect, type WindowsReparseInspectorCapability } from "./internal.js";

/** Test-compilation-only capability factory; production entry neither imports nor exposes it. */
export function createTestWindowsReparseInspector(
  helper?: CustomInspect | ((...args: any[]) => any),
): WindowsReparseInspectorCapability {
  if (typeof helper === "function") {
    return createInspectorCapability({
      customInspect: async (path: string) => {
        const result = helper(path);
        if (result && typeof result === "object" && "stdin" in result) {
          const input = Buffer.from(JSON.stringify({ schemaVersion: 1, operation: "inspect", path }), "utf8");
          (result as any).stdin.emit("data", input);
          return "regular";
        }
        if (result === "regular" || result === "reparse") return result;
        return "regular";
      },
    });
  }
  return createInspectorCapability();
}
