import { isRecord } from "../../shared/record-type-guard";

export const EMPTY_TASK_OUTPUT_SENTINEL = "<magic-context-empty-task-output>";
const EMPTY_COMPLETED_TASK_RESULT =
    /^<task\b[^>]*\bstate="completed"[^>]*>[\s\S]*<task_result>\s*<\/task_result>\s*<\/task>\s*$/;

/**
 * Surface a completed native `task` tool result that returned no final text.
 *
 * A subagent can complete with an empty `<task_result>` when its provider
 * emitted reasoning only (or context-fill truncation dropped the final output).
 * OpenCode would otherwise hand the caller a silently-empty result, which is
 * indistinguishable from a tool that legitimately returned nothing. Annotate
 * such outputs with a diagnostic sentinel so the caller can tell the two apart.
 *
 * Only a completed native task with an empty result is touched; non-task tools,
 * non-empty outputs, and non-completed task states are left unchanged. The
 * mutation is done via `Reflect.set` so a frozen output object cannot throw.
 */
export function annotateEmptyTaskOutput(tool: string, output: unknown): void {
    if (tool !== "task" || !isRecord(output)) return;
    if (typeof output.output !== "string") return;
    if (output.output.includes(EMPTY_TASK_OUTPUT_SENTINEL)) return;
    if (!EMPTY_COMPLETED_TASK_RESULT.test(output.output)) return;

    Reflect.set(
        output,
        "output",
        `${output.output}\n${EMPTY_TASK_OUTPUT_SENTINEL}
The subagent completed without a final text response. Context-fill truncation may have omitted its final output, or its provider may have emitted reasoning only; inspect the child session and retry with a low-reasoning model or variant.`,
    );
}
