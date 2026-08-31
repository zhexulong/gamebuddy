function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Format the UTC ISO-8601 timestamp written by the plugin for local display.
 * Invalid timestamps are returned unchanged so malformed log lines remain readable.
 */
export function formatLogTimestamp(timestamp: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    return timestamp;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return (
    [pad(date.getFullYear(), 4), pad(date.getMonth() + 1, 2), pad(date.getDate(), 2)].join("-") +
    ` ${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`
  );
}
