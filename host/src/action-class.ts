/**
 * Semantic class of an integration action/capability.
 *
 * This is catalog metadata, not an authorization token and not a field in the
 * bridge execution request. `coordinated` and `content_operation` describe
 * gameplay coverage contracts; they do not turn a generic dispatcher into a
 * permitted wire action.
 */
export const ACTION_CLASSES = [
  "primitive",
  "composite",
  "coordinated",
  "content_operation",
] as const;

export type ActionClass = typeof ACTION_CLASSES[number];

const ACTION_CLASS_SET = new Set<string>(ACTION_CLASSES);

export function isActionClass(value: unknown): value is ActionClass {
  return typeof value === "string" && ACTION_CLASS_SET.has(value);
}
