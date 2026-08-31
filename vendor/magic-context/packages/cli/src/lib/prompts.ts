/**
 * Unified prompts wrapper around @clack/prompts.
 *
 * Maintains backward-compatible API surface for both the previous OpenCode
 * plugin CLI (`selectOne(message, [{label, value, recommended}])`) and Pi
 * plugin CLI (`PromptIO`/`SelectOption` interfaces with `recommended` flag).
 *
 * The CLI ships with `#!/usr/bin/env node` and is invoked via `npx`, which
 * runs it on Node. `install.sh` redirects stdin from `/dev/tty` so Clack's
 * raw-mode `select()` prompt still works under `curl | bash`.
 */
import {
    autocomplete as clackAutocomplete,
    cancel as clackCancel,
    confirm as clackConfirm,
    intro as clackIntro,
    log as clackLog,
    multiselect as clackMultiselect,
    note as clackNote,
    outro as clackOutro,
    select as clackSelect,
    spinner as clackSpinner,
    text as clackText,
    isCancel,
} from "@clack/prompts";

export interface SelectOption {
    label: string;
    value: string;
    /** Mark this option as the recommended default; rendered as " (recommended)". */
    recommended?: boolean;
    /** Optional Clack hint string. Mutually exclusive with `recommended`. */
    hint?: string;
}

export interface PromptLog {
    info(message: string): void;
    success(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    message(message: string): void;
    step(message: string): void;
}

export interface PromptSpinner {
    start(message?: string): void;
    stop(message?: string): void;
    message(message: string): void;
}

export interface PromptIO {
    intro(message: string): void;
    outro(message: string): void;
    note(message: string, title?: string): void;
    log: PromptLog;
    spinner(): PromptSpinner;
    confirm(message: string, defaultYes?: boolean): Promise<boolean>;
    text(
        message: string,
        options?: {
            placeholder?: string;
            initialValue?: string;
            validate?: (value: string) => string | undefined;
        },
    ): Promise<string>;
    selectOne(message: string, options: SelectOption[]): Promise<string>;
    selectMany(message: string, options: SelectOption[], initial?: string[]): Promise<string[]>;
    /**
     * Scrollable list you can also narrow by typing (type-ahead filter). Used
     * for long lists like the full model catalog: the user sees options AND can
     * type a fragment (e.g. "sonnet") to filter. `placeholder` shows before any
     * input. Returns the selected `value`.
     */
    selectAutocomplete(
        message: string,
        options: SelectOption[],
        opts?: { placeholder?: string; maxItems?: number },
    ): Promise<string>;
}

export class PromptCancelledError extends Error {
    constructor(message = "Cancelled.") {
        super(message);
        this.name = "PromptCancelledError";
    }
}

export function isPromptCancelledError(error: unknown): error is PromptCancelledError {
    return error instanceof PromptCancelledError;
}

function handleCancel(value: unknown, cancelMessage = "Cancelled."): void {
    if (isCancel(value)) {
        clackCancel(cancelMessage);
        // Let the command unwind normally so setup can avoid later writes and
        // close any resources it owns instead of terminating the process here.
        throw new PromptCancelledError(cancelMessage);
    }
}

export const log: PromptLog = {
    info(message) {
        clackLog.info(message);
    },
    success(message) {
        clackLog.success(message);
    },
    warn(message) {
        clackLog.warn(message);
    },
    error(message) {
        clackLog.error(message);
    },
    message(message) {
        clackLog.message(message);
    },
    step(message) {
        clackLog.step(message);
    },
};

export function intro(title: string): void {
    clackIntro(title);
}

export function outro(message: string): void {
    clackOutro(message);
}

export function note(message: string, title?: string): void {
    clackNote(message, title);
}

export function spinner(): PromptSpinner {
    const s = clackSpinner();
    return {
        start(message?: string) {
            s.start(message);
        },
        stop(message?: string) {
            s.stop(message);
        },
        message(message: string) {
            s.message(message);
        },
    };
}

export async function confirm(message: string, defaultYes = true): Promise<boolean> {
    const result = await clackConfirm({ message, initialValue: defaultYes });
    handleCancel(result);
    return result as boolean;
}

export async function text(
    message: string,
    options: {
        placeholder?: string;
        initialValue?: string;
        validate?: (value: string) => string | undefined;
    } = {},
): Promise<string> {
    const result = await clackText({
        message,
        placeholder: options.placeholder,
        initialValue: options.initialValue,
        validate: options.validate
            ? (value) => {
                  const str = typeof value === "string" ? value : "";
                  const err = options.validate?.(str);
                  return err ?? undefined;
              }
            : undefined,
    });
    handleCancel(result);
    return result as string;
}

// Clack's Option<T> is a distributed conditional that resolves differently
// for primitive vs object values; the structural shape we build is correct
// at runtime, so we cast at the boundary. See toClackOption below.
// biome-ignore lint/suspicious/noExplicitAny: structural cast at clack boundary.
type ClackOptionsArray = any;

function toClackOption(opt: SelectOption): { label: string; value: string; hint?: string } {
    // `recommended` renders as a label suffix ONLY. It must NOT also set the
    // clack `hint`, or the active row shows "(recommended)" twice (label suffix +
    // hint). `recommended` and `hint` are mutually exclusive (see SelectOption).
    const label = opt.recommended ? `${opt.label} (recommended)` : opt.label;
    const hint = opt.recommended ? undefined : opt.hint;
    return hint === undefined ? { label, value: opt.value } : { label, value: opt.value, hint };
}

export async function selectOne(message: string, options: SelectOption[]): Promise<string> {
    const result = await clackSelect<string>({
        message,
        options: options.map(toClackOption) as ClackOptionsArray,
    });
    handleCancel(result);
    return result as string;
}

export async function selectMany(
    message: string,
    options: SelectOption[],
    initial?: string[],
): Promise<string[]> {
    const result = await clackMultiselect<string>({
        message,
        options: options.map(toClackOption) as ClackOptionsArray,
        required: false,
        initialValues: initial,
    });
    handleCancel(result);
    return result as string[];
}

export async function selectAutocomplete(
    message: string,
    options: SelectOption[],
    opts: { placeholder?: string; maxItems?: number } = {},
): Promise<string> {
    const result = await clackAutocomplete<string>({
        message,
        options: options.map(toClackOption) as ClackOptionsArray,
        placeholder: opts.placeholder,
        maxItems: opts.maxItems ?? 10,
    });
    handleCancel(result);
    return result as string;
}

/** Default PromptIO implementation backed by @clack/prompts. */
export const promptIO: PromptIO = {
    intro,
    outro,
    note,
    log,
    spinner,
    confirm,
    text,
    selectOne,
    selectMany,
    selectAutocomplete,
};

export { isCancel };
