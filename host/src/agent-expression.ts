/** Extract final ordinary assistant text for private task summaries only. */
export function finalAssistantText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.content) ||
      message.stopReason === "error" ||
      message.stopReason === "aborted"
    )
      continue;
    const text = message.content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join("")
      .trim();
    return text.length === 0 ? null : text;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}
