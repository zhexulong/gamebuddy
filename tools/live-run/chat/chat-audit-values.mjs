/**
 * The shared value helpers of the chat live audit: one digest spelling, the plain-object shape test the trace
 * validators are written in terms of, a delay, a bounded non-empty string, and a JSON file read that answers `null`
 * instead of throwing.
 *
 * They live in one file because every other audit module needs them and a second copy of any of them is a second
 * spelling of the same fact.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function safeReasonCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : "chat_audit_runner_internal_error";
}

export const nonEmpty = (value) => (typeof value === "string" && value.length > 0 ? value : null);

export async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
