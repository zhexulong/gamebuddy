type MessageTime = { created?: number };

type MessageInfo = {
    role?: string;
    time?: MessageTime;
};

type MessagePart = {
    type?: string;
    text?: string;
};

type SessionMessage = {
    info?: MessageInfo;
    parts?: unknown;
};

import { isRecord } from "./record-type-guard";

function asSessionMessage(value: unknown): SessionMessage | null {
    if (!isRecord(value)) return null;
    const info = value.info;
    const parts = value.parts;
    return {
        info: isRecord(info)
            ? {
                  role: typeof info.role === "string" ? info.role : undefined,
                  time: isRecord(info.time)
                      ? {
                            created:
                                typeof info.time.created === "number"
                                    ? info.time.created
                                    : undefined,
                        }
                      : undefined,
              }
            : undefined,
        parts,
    };
}

function getCreatedTime(message: SessionMessage): number {
    return message.info?.time?.created ?? 0;
}

function getTextParts(message: SessionMessage): MessagePart[] {
    if (!Array.isArray(message.parts)) return [];
    return message.parts
        .filter((part): part is Record<string, unknown> => isRecord(part))
        .map((part) => ({
            type: typeof part.type === "string" ? part.type : undefined,
            text: typeof part.text === "string" ? part.text : undefined,
        }))
        .filter((part) => part.type === "text" && Boolean(part.text));
}

export function extractLatestAssistantText(messages: unknown): string | null {
    if (!Array.isArray(messages) || messages.length === 0) return null;

    const assistantMessages = messages
        .map(asSessionMessage)
        .filter((message): message is SessionMessage => message !== null)
        .filter((message) => message.info?.role === "assistant")
        .sort((a, b) => getCreatedTime(b) - getCreatedTime(a));

    const latest = assistantMessages[0];
    if (!latest) return null;

    return (
        getTextParts(latest)
            .map((part) => part.text)
            .join("\n") || null
    );
}

export function hasLengthCappedOutput(value: unknown): boolean {
    if (Array.isArray(value)) return value.some((item) => hasLengthCappedOutput(item));
    if (!isRecord(value)) return false;

    if (value.length_capped === true || value.lengthCapped === true) return true;
    const finishReason = value.finish_reason ?? value.finishReason;
    if (typeof finishReason === "string") {
        const normalized = finishReason.toLowerCase();
        if (
            normalized === "length" ||
            normalized === "max_tokens" ||
            normalized === "max_output_tokens"
        ) {
            return true;
        }
    }

    return Object.values(value).some((item) => hasLengthCappedOutput(item));
}
