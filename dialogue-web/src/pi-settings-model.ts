import type { Locale } from "./i18n";

/**
 * Pi's own configuration shape, and the necessary-versus-advanced split for this
 * product's settings.
 *
 * The owner's ruling is that this product's settings stay aligned with Pi, that a
 * player is only asked for the few things they must set, and that everything else
 * is left as JSON in Pi's own shape rather than an invented format.
 *
 * Necessary (the product carries a control for it, so the player never edits JSON):
 *   - the provider endpoint and its API key (platform services);
 *   - which model, and which thinking level, each surface uses;
 *   - the companion language;
 *   - voice consent and the output device.
 *
 * Advanced (Pi's own files, left as JSON):
 *   - `<agent-dir>/models.json`: `{ "providers": { "<providerId>": { name?,
 *     baseUrl, api, apiKey?, headers?, models?: [...], modelOverrides? } } }`.
 *   - `<agent-dir>/settings.json`: Pi's user settings (`defaultProvider`,
 *     `defaultModel`, `defaultThinkingLevel`, `modelThinkingLevels`, ...).
 *
 * This module owns the `models.json` half: the exact envelope Pi reads
 * (`providers`), a fail-closed parser, and a write path that never runs on an
 * invalid edit. The Host already writes this file itself
 * (`host/src/tavern/pi-provider-store.ts` merges one provider entry under
 * `providers`), so the shape here is not invented: it is the same document, and
 * the advanced view over it is capability-gated rather than faked while the Host
 * publishes no route that reads or writes the raw document.
 */

/** One `models.json` provider entry. Pi's own fields are passed through verbatim. */
export type PiProviderEntry = Readonly<Record<string, unknown>>;

/** Pi's `models.json` document, exactly as Pi reads it. */
export type PiModelsDocument = Readonly<{ providers: Readonly<Record<string, PiProviderEntry>> }>;

/**
 * The closed set of ways an advanced edit can be rejected. `invalid_json` is "this
 * is not JSON at all"; `invalid_shape` is "this is JSON, but it is not Pi's
 * `models.json`". The two are kept apart because they send the player to different
 * places: the first is a typo, the second is the wrong document.
 */
export type AdvancedPiSettingsProblem = "invalid_json" | "invalid_shape";

export type AdvancedPiSettingsParse =
  | Readonly<{ ok: true; document: PiModelsDocument }>
  | Readonly<{ ok: false; problem: AdvancedPiSettingsProblem }>;

const TOP_LEVEL_KEYS = ["providers"] as const;

/**
 * The advanced section's player-facing text, for a caller that holds a `Locale`.
 *
 * The surface itself reads these entries from the product's message catalogue
 * (`i18n.ts`, `advancedPiSettings*`), which is where every other string a player
 * reads lives: this accessor used to be the *only* copy, and its `locale ?? "en"`
 * default is how the block rendered English inside a Chinese surface. It stays
 * because a unit test in a file this change does not own imports it; the
 * duplicate pair here is the follow-up, not the product path.
 */
export function advancedPiSettingsText(locale: Locale): Readonly<{
  title: string;
  hint: string;
  save: string;
  applied: string;
  unavailable: string;
  invalidJson: string;
  invalidShape: string;
}> {
  if (locale === "zh-CN")
    return {
      title: "高级配置（Pi JSON）",
      hint: "直接编辑 Pi 的 models.json：providers 下每个条目就是 Pi 读取的 provider 记录（baseUrl、api、apiKey、models 等），字段与 Pi 完全一致。",
      save: "保存高级配置",
      applied: "已保存。将在下次启动运行时读取。",
      unavailable: "这是 Pi 自己的 models.json：providers 映射，每个 provider 的 baseUrl、api、apiKey、models 都在里面。该文件由 Host 根据你在上面设置的 Provider 写入；当前 Host 没有发布读写它的路由，所以这里没有可编辑的内容。",
      invalidJson: "这不是合法的 JSON：请检查括号、逗号和引号后重试。未写入任何内容。",
      invalidShape: "这不是 Pi 的 models.json：顶层只能有 providers，且每个 provider 条目必须是对象。未写入任何内容。",
    };
  return {
    title: "Advanced configuration (Pi JSON)",
    hint: "Edit Pi's own models.json directly: each entry under providers is a provider record Pi reads (baseUrl, api, apiKey, models, …), with exactly Pi's fields.",
    save: "Save advanced configuration",
    applied: "Saved. It is read the next time a runtime starts.",
    unavailable:
      "This is Pi's own models.json - the providers map, with each provider's baseUrl, api, apiKey and models. The Host writes that file itself from the provider you set above, and this Host publishes no route that reads or writes it, so there is nothing to edit here.",
    invalidJson: "This is not valid JSON. Check brackets, commas and quotes and try again. Nothing was written.",
    invalidShape:
      "This is not Pi's models.json: the only top-level key is providers, and each provider entry must be an object. Nothing was written.",
  };
}

/**
 * Parses an advanced edit into Pi's own document, or reports the closed reason it
 * is not one. It never repairs, guesses or partially accepts: a document the
 * product does not fully understand is refused whole, because writing back the
 * subset it did understand would silently delete the rest of the file.
 */
export function parseAdvancedPiSettings(text: string): AdvancedPiSettingsParse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, problem: "invalid_json" };
  }
  if (!isPlainObject(decoded)) return { ok: false, problem: "invalid_shape" };
  const keys = Object.keys(decoded);
  if (keys.length !== TOP_LEVEL_KEYS.length || !TOP_LEVEL_KEYS.every((key) => Object.hasOwn(decoded, key)))
    return { ok: false, problem: "invalid_shape" };
  const providers = decoded.providers;
  if (!isPlainObject(providers)) return { ok: false, problem: "invalid_shape" };
  for (const entry of Object.values(providers)) {
    if (!isPlainObject(entry)) return { ok: false, problem: "invalid_shape" };
  }
  return { ok: true, document: { providers: providers as Readonly<Record<string, PiProviderEntry>> } };
}

/** Validates an already-decoded document (a Host read-back) the same way. */
export function validateAdvancedPiSettingsDocument(value: unknown): PiModelsDocument | null {
  if (!isPlainObject(value)) return null;
  const parsed = parseAdvancedPiSettings(JSON.stringify(value));
  return parsed.ok ? parsed.document : null;
}

/**
 * Serializes Pi's document with Pi's own shape. Whitespace is presentation; the
 * keys and nesting are the authority, and they are the Host's own writer's:
 * `JSON.stringify({ providers }, null, 2)`.
 */
export function serializeAdvancedPiSettings(document: PiModelsDocument): string {
  return JSON.stringify({ providers: document.providers }, null, 2);
}

export type AdvancedPiSettingsWrite = (document: PiModelsDocument) => Promise<void>;

/**
 * The one advanced-edit path: validate, then write. An invalid edit returns its
 * closed problem and the writer is never called, so a rejected edit cannot reach
 * Pi's file; a valid edit hands the writer exactly Pi's document.
 */
export async function applyAdvancedPiSettingsEdit(
  text: string,
  write: AdvancedPiSettingsWrite,
): Promise<AdvancedPiSettingsParse> {
  const parsed = parseAdvancedPiSettings(text);
  if (!parsed.ok) return parsed;
  await write(parsed.document);
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
