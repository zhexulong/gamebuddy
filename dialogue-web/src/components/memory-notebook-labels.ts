import type { Locale } from "../i18n";

/**
 * The Memory notebook's one vocabulary, in the companion's own voice.
 *
 * The Memory surface is the companion's scrapbook, not a database form: the copy
 * here names the notebook, says that it fills from ordinary talk and farm life,
 * and gives the contract's own `category` members (`semantic` | `interaction`)
 * a life-flavoured player label. A raw member is never rendered; see design/104
 * §10.
 *
 * The strings live in this file (not `i18n.ts`, which is a shared, append-only
 * file for the other lanes) and are selected by the mount's own locale. Each
 * message carries both languages in place, so the raw-text gate's local
 * bilingual rule holds without a second table.
 */
export type MemoryNotebookLabelKey =
  | "title"
  | "promise"
  | "count"
  | "empty"
  | "unavailable"
  | "failed"
  | "authoringOpen"
  | "authoringClose"
  | "categorySemantic"
  | "categoryInteraction";

export type MemoryNotebookLabels = Readonly<Record<MemoryNotebookLabelKey, string>>;

const MESSAGES: Readonly<Record<MemoryNotebookLabelKey, { en: string; zh: string }>> = {
  title: { en: "Your companion's notebook", zh: "伴侣的时光手札" },
  promise: {
    en: "Your companion writes this down while you talk and work the farm — you never have to fill anything in.",
    zh: "你聊天、打理农场的时候，伴侣会把这些事自己写进手札——你不用动手填。",
  },
  count: { en: "{{count}} memories written down so far.", zh: "已经悄悄记下 {{count}} 件事。" },
  empty: { en: "Nothing written down yet. It fills in as you talk.", zh: "还没有记下什么。随着你们聊天，它会慢慢填满。" },
  unavailable: { en: "The notebook is not open right now.", zh: "手札暂时打不开。" },
  failed: { en: "The notebook could not be opened.", zh: "手札没能打开。" },
  authoringOpen: { en: "+ Whisper something to your companion", zh: "+ 悄悄告诉伴侣一件事" },
  authoringClose: { en: "Never mind", zh: "先不说了" },
  categorySemantic: { en: "Things she keeps", zh: "记在心里的事" },
  categoryInteraction: { en: "Times you shared", zh: "一起经历的时光" },
};

export function memoryNotebookLabels(locale: Locale): MemoryNotebookLabels {
  const language = locale === "zh-CN" ? "zh" : "en";
  return {
    title: MESSAGES.title[language],
    promise: MESSAGES.promise[language],
    count: MESSAGES.count[language],
    empty: MESSAGES.empty[language],
    unavailable: MESSAGES.unavailable[language],
    failed: MESSAGES.failed[language],
    authoringOpen: MESSAGES.authoringOpen[language],
    authoringClose: MESSAGES.authoringClose[language],
    categorySemantic: MESSAGES.categorySemantic[language],
    categoryInteraction: MESSAGES.categoryInteraction[language],
  };
}
