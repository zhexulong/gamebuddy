import type { DreamRunTask } from "./types";

export type DreamRunTaskDetailTone = "error" | "neutral";

export interface DreamRunTaskDetail {
  text: string | undefined;
  tone: DreamRunTaskDetailTone;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

/**
 * Select the detail shown for a task while keeping legacy successful rows safe.
 * Old rows stored successful verify-broad progress in `error`; a run with no
 * failed tasks therefore renders that legacy value neutrally.
 */
export function getDreamRunTaskDetail(task: DreamRunTask, tasksFailed: number): DreamRunTaskDetail {
  const error = nonEmpty(task.error);
  if (tasksFailed > 0 && error !== undefined) {
    return { text: error, tone: "error" };
  }
  return {
    text: nonEmpty(task.progress) ?? error,
    tone: "neutral",
  };
}
