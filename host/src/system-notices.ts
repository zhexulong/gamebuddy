export type StopOutcome = "active_turn_cancelled" | "queued_turn_cancelled" | "no_active_turn";

/**
 * The closed set of Host-authored lines a player can be shown, by key.
 *
 * A key is a promise the game thread can check: the Mod validates the copy that arrives
 * under each key (`BridgeSession.IsValidSystemNoticeCopy`), so a line the Host invents
 * under a registered key is refused rather than drawn. Every member here has a matching
 * branch there, and the two lists are the same set.
 */
export type SystemNoticeKey =
  | "system.stop.active_turn_cancelled"
  | "system.stop.queued_turn_cancelled"
  | "system.stop.no_active_turn"
  | "system.provider.waiting"
  | "system.provider.unavailable";

export type SystemNotice = Readonly<{
  key: SystemNoticeKey;
  /**
   * The locale this line is delivered in.
   *
   * For registered Host copy it is also the language the words are written in. The one
   * exception is `system.provider.unavailable`, whose tail is the provider's own text:
   * that text is not translatable, so the locale names the surface it is written to -
   * which is the value the game thread compares against its own current locale.
   */
  locale: string;
  text: string;
}>;

const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/;

function assertLocale(locale: string): void {
  if (!LOCALE_PATTERN.test(locale)) throw new Error("invalid_system_notice_locale");
}

/**
 * The registered copy for the provider lane, in the two languages this product ships.
 *
 * The provider's own text cannot be translated, so it is appended to a registered
 * sentence rather than replacing it: the player reads why the companion is not answering
 * in their own language, followed by the words the endpoint actually sent.
 */
const PROVIDER_COPY = Object.freeze({
  zh: Object.freeze({
    waiting: "已连上游戏，正在等待模型服务…",
    unavailable: "模型服务暂时用不了：",
  }),
  en: Object.freeze({
    waiting: "Connected. Waiting for the provider…",
    unavailable: "The provider can't answer: ",
  }),
});

/**
 * Locale selection is intentionally deterministic. The released zh-CN Preview locale uses
 * its exact registered copy; other valid locales fall back to English rather than
 * presenting a mismatched script.
 */
function providerCopy(locale: string): Readonly<{ waiting: string; unavailable: string }> {
  return locale === "zh-CN" ? PROVIDER_COPY.zh : PROVIDER_COPY.en;
}

/**
 * Resolves Host-owned system copy without involving Pi or the model.
 */
export function resolveStopSystemNotice(outcome: StopOutcome, locale: string): SystemNotice {
  assertLocale(locale);
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

/**
 * The line that dates the start of a provider wait.
 *
 * MEASURED 2026-11-06: a 48-minute Game run put nothing at all in front of the player for
 * 709 seconds. The run's first act is to ask the model for a plan, so the provider wait is
 * the first thing that happens - and it happened silently, because a Host with nothing to
 * say said nothing. This is that silence, named: one line, once, before the first request.
 */
export function resolveProviderWaitSystemNotice(locale: string): SystemNotice {
  assertLocale(locale);
  return Object.freeze({ key: "system.provider.waiting", locale, text: providerCopy(locale).waiting });
}

/**
 * The provider's own words, behind a registered sentence.
 *
 * `providerLine` is already one bounded line (`boundProviderFailureLine`), never the raw
 * refusal: that module owns the reading of Pi's `errorMessage` and is the only place the
 * text is prepared for a surface.
 */
export function resolveProviderFailureSystemNotice(locale: string, providerLine: string): SystemNotice {
  assertLocale(locale);
  return Object.freeze({
    key: "system.provider.unavailable",
    locale,
    text: `${providerCopy(locale).unavailable}${providerLine}`,
  });
}
