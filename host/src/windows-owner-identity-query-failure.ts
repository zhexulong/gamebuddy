/**
 * Why an owner-identity query failed, in one place.
 *
 * Both Windows owner-identity ports (the Game one and the Chat one) spawn PowerShell to read this exact process's
 * OS creation time, and both used to answer every possible failure with the same blind
 * `windows_runtime_owner_identity_query_failed`. That message is the only report of the failure, and it costs a live
 * run to discover that it says nothing: a real ladder run failed with it and left no way to tell a timeout from a
 * missing executable, a PowerShell error, or a stderr write.
 *
 * The classification is deliberately tiny and total: it never throws, it always returns a bounded token, and it is
 * shared by both ports so the two cannot drift apart.
 */

const EXCERPT_LIMIT = 120;

function excerpt(value: string): string {
  const flattened = value.replace(/\s+/gu, " ").trim();
  return flattened.length <= EXCERPT_LIMIT ? flattened : `${flattened.slice(0, EXCERPT_LIMIT)}…`;
}

/**
 * A bounded, non-secret token describing a failed owner-identity query:
 * `timeout`, `no_executable`, `code:<code>`, `stderr:<excerpt>`, `message:<excerpt>`, or `unknown`.
 */
export function describeOwnerIdentityQueryFailure(error: unknown): string {
  // Reporting a cause must never be less reliable than the failure it reports, so this function is total: a hostile
  // object (one whose `code` getter throws, say) degrades to `unknown` instead of throwing a second error inside a
  // catch block.
  try {
    if (typeof error !== "object" || error === null) return "unknown";
    const record = error as {
      code?: unknown;
      killed?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    // `execFile` reports its own timeout as a kill, which is worth its own name: it is the case where the machine
    // was too slow or PowerShell too busy, not a programming error.
    if (record.killed === true) return "timeout";
    // `execFile` uses a string code for spawn failures (`ENOENT`) and a NUMBER for a non-zero exit, so both shapes
    // matter: dropping the numeric one reported a PowerShell exit as a bare message.
    const rawCode = record.code;
    const code = typeof rawCode === "string" || typeof rawCode === "number" ? String(rawCode) : undefined;
    if (code === "ENOENT") return "no_executable";
    if (typeof record.stderr === "string" && record.stderr.trim().length > 0) return `stderr:${excerpt(record.stderr)}`;
    if (code !== undefined) return `code:${code}`;
    if (typeof record.message === "string" && record.message.trim().length > 0)
      return `message:${excerpt(record.message)}`;
    return "unknown";
  } catch {
    return "unknown";
  }
}
