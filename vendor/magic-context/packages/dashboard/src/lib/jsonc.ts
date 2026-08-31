import { parse, stringify } from "comment-json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsoncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertPrototypeSafe(value: unknown, path = "$root"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertPrototypeSafe(entry, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) return;

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error(`unsafe prototype-pollution key at ${path}.__proto__`);
  }
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      throw new Error(`unsafe prototype-pollution key at ${path}.${key}`);
    }
    assertPrototypeSafe(value[key], `${path}.${key}`);
  }
}

function parseRoot(text: string): Record<string, unknown> {
  const source = text.trim() === "" ? "{}\n" : text;
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    throw new Error(`Config JSONC parse failed: ${jsoncErrorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("Config JSONC root must be an object");
  }
  assertPrototypeSafe(parsed);
  return parsed;
}

/** Parse JSONC into an object. Throws on malformed JSONC instead of returning a destructive fallback. */
export function parseJsonc(text: string): Record<string, unknown> {
  return parseRoot(text);
}

function stringifyJsonc(root: Record<string, unknown>): string {
  const rendered = stringify(root, null, 2);
  if (typeof rendered !== "string") {
    throw new Error("Failed to serialize config JSONC");
  }
  return `${rendered}\n`;
}

/** Pretty-print a new JSONC object. Existing files should use patch helpers to preserve comments. */
export function formatJsonc(value: unknown): string {
  if (!isRecord(value)) {
    throw new Error("Config JSONC root must be an object");
  }
  return stringifyJsonc(value);
}

/**
 * Patch dreamer schedules and, when requested, one harness's task model block.
 * Throws on malformed input so the caller can refuse the save without clobbering the file.
 */
export function patchDreamerTasksJsonc(
  text: string,
  tasks: Record<string, unknown>,
  harness?: "opencode" | "pi",
  modelTasks?: Record<string, unknown>,
): string {
  const root = parseRoot(text);
  const dreamer = isRecord(root.dreamer) ? root.dreamer : {};
  root.dreamer = dreamer;
  dreamer.tasks = tasks;
  if (harness) {
    const harnessBlock = isRecord(dreamer[harness]) ? dreamer[harness] : {};
    if (modelTasks && Object.keys(modelTasks).length > 0) harnessBlock.tasks = modelTasks;
    else delete harnessBlock.tasks;
    if (Object.keys(harnessBlock).length > 0) dreamer[harness] = harnessBlock;
    else delete dreamer[harness];
  }
  return stringifyJsonc(root);
}

/** Remove the project-level dreamer override while preserving the rest of the config file. */
export function removeDreamerBlockJsonc(text: string): string {
  const root = parseRoot(text);
  delete root.dreamer;
  return stringifyJsonc(root);
}
