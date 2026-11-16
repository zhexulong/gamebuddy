// The one language a live run tests.
//
// `GAMEBUDDY_COMPANION_LOCALE` mirrors the frontend-set language preference, and four
// different consumers derived it independently: the game live run's Agent session
// language and prompt key, and the native-local fixture's ModConfig
// `PresentationLocale` (twice, in two builders). The frontend live run now needs the
// same value for the player's one stored preference - which the Host projects into that
// same ModConfig field - so the four spellings become one. A run whose prompts spoke one
// language while its game preference named another would be measuring two runs at once,
// and that is exactly the defect this module exists to prevent.
export const COMPANION_LOCALE = process.env.GAMEBUDDY_COMPANION_LOCALE === "en-US" ? "en-US" : "zh-CN";

/**
 * The scenario/prompt key for that language (`zh` / `en`).
 *
 * The prompt tables are keyed by this short word rather than by the BCP-47 locale because
 * the prompts are written per language, not per region.
 */
export const COMPANION_LOCALE_KEY = COMPANION_LOCALE === "zh-CN" ? "zh" : "en";
