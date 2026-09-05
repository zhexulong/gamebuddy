export type StopOutcome = "active_turn_cancelled" | "queued_turn_cancelled" | "no_active_turn";

type StopSystemNoticeKey =
  | "system.stop.active_turn_cancelled"
  | "system.stop.queued_turn_cancelled"
  | "system.stop.no_active_turn";

export type StopSystemNotice = Readonly<{
  key: StopSystemNoticeKey;
  /** Exact authenticated game locale; copy selection may use a language-family fallback. */
  locale: string;
  text: string;
}>;

const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/;

/**
 * Resolves Host-owned system copy without involving Pi or the model.
 * Locale selection is intentionally deterministic. The released zh-CN Preview
 * locale uses its exact registered copy; other valid locales fall back to
 * English rather than presenting a mismatched script.
 */
export function resolveStopSystemNotice(outcome: StopOutcome, locale: string): StopSystemNotice {
  if (!LOCALE_PATTERN.test(locale)) throw new Error("invalid_system_notice_locale");
  const isSimplifiedChinesePreview = locale === "zh-CN";
  if (outcome === "active_turn_cancelled" || outcome === "queued_turn_cancelled") {
    const text = isSimplifiedChinesePreview ? "已停止生成。" : "Generation stopped.";
    const key =
      outcome === "active_turn_cancelled" ? "system.stop.active_turn_cancelled" : "system.stop.queued_turn_cancelled";
    return Object.freeze({ key, locale, text });
  }
  const text = isSimplifiedChinesePreview ? "当前没有正在生成的回复。" : "No reply is currently being generated.";
  return Object.freeze({ key: "system.stop.no_active_turn", locale, text });
}
