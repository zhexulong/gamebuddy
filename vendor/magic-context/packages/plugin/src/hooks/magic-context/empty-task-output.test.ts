import { describe, expect, test } from "bun:test";
import { annotateEmptyTaskOutput, EMPTY_TASK_OUTPUT_SENTINEL } from "./empty-task-output";

describe("annotateEmptyTaskOutput", () => {
    test("surfaces a completed native task that returned no final text", () => {
        const output = {
            output: '<task id="ses-child" state="completed">\n<task_result>\n\n</task_result>\n</task>',
        };

        annotateEmptyTaskOutput("task", output);

        expect(output.output).toContain(EMPTY_TASK_OUTPUT_SENTINEL);
    });

    test("leaves non-empty and non-task outputs unchanged", () => {
        const taskOutput = { output: "completed" };
        const toolOutput = { output: "" };

        annotateEmptyTaskOutput("task", taskOutput);
        annotateEmptyTaskOutput("read", toolOutput);

        expect(taskOutput.output).toBe("completed");
        expect(toolOutput.output).toBe("");
    });

    test("leaves bare empty and non-completed task results unchanged", () => {
        const outputs = [
            { output: "" },
            { output: '<task id="error" state="error"><task_result></task_result></task>' },
            { output: '<task id="aborted" state="aborted"><task_result></task_result></task>' },
            { output: '<task id="running" state="running"><task_result></task_result></task>' },
        ];

        for (const output of outputs) annotateEmptyTaskOutput("task", output);

        expect(outputs.every(({ output }) => !output.includes(EMPTY_TASK_OUTPUT_SENTINEL))).toBe(
            true,
        );
    });

    test("does not throw when a completed empty task output is frozen", () => {
        const output = Object.freeze({
            output: '<task id="frozen" state="completed"><task_result></task_result></task>',
        });

        expect(() => annotateEmptyTaskOutput("task", output)).not.toThrow();
        expect(output.output).not.toContain(EMPTY_TASK_OUTPUT_SENTINEL);
    });
});
